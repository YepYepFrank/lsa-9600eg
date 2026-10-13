/* 0.17 转换程序保险自检（ConvGuardService）：假 Docker API（HTTP）+ 假总线 + 假时钟，不碰本机容器。
 *
 *   pnpm conv-guard:verify
 *
 * 查：conv 没启用不管；读数正常不动；只有摄像机 / agent 自己的消息算「没读数」→ 重启；连续重启退避 silentS × 2^n；读数回来退避清零；
 *     总线重启（conv 在它之前起）→ 等 3 s 后重启 conv；整套一起重启（conv 在总线之后起）不动；关掉不动；审计、遥测、落盘、install.sh --status 读得出来 */
import 'reflect-metadata'
import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EgConfig } from '@lsa-eg/config'
import type { AuditService } from './audit/audit.service.js'
import type { BusService } from './bus/bus.service.js'
import { ConvGuardService } from './conv/conv-guard.service.js'
import { check, done } from './verify/lib.js'

let clock = Date.now()
const containers: Record<string, { running: boolean; startedAt: number; restarts: number } | undefined> = {}
const restartLog: { name: string; at: number }[] = []

function fakeDocker(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const m = (req.url ?? '').match(/^\/containers\/([^/]+)\/(json|restart)/)
    const c = m ? containers[decodeURIComponent(m[1]!)] : undefined
    if (!m || !c) {
      res.writeHead(404).end('{"message":"No such container"}')
      return
    }
    if (m[2] === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ State: { Status: c.running ? 'running' : 'exited', StartedAt: new Date(c.startedAt).toISOString() } }))
      return
    }
    c.startedAt = clock
    c.restarts++
    restartLog.push({ name: decodeURIComponent(m[1]!), at: clock })
    res.writeHead(204).end()
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` })))
}

async function main() {
  console.log('转换程序保险自检（假 Docker API、假总线、假时钟）\n')
  const { server, url } = await fakeDocker()
  const dir = mkdtempSync(join(tmpdir(), 'lsa-convguard-'))
  const cfg = {
    dir,
    eg: { name: 'EG-AH99', attrs: {} },
    cabinet: { code: 'AH99', group: 'mv' },
    devices: [
      { name: 'SAM-AH99-A', kind: 'sam', label: '', attrs: {} },
      { name: 'CAM-AH99', kind: 'camera', label: '', attrs: {} },
    ],
    local: {
      docker: { api: url, containers: { tb: 't', gateway: 'g', mosquitto: 'lsa-eg-mosquitto', mediamtx: 'm', conv: 'lsa-eg-conv' } },
      convGuard: { enabled: true, silentS: 10, maxBackoffS: 60 },
    },
  } as unknown as EgConfig
  let listener: ((dev: string, entries: unknown[], own: boolean) => void) | null = null
  const published: { dev: string; values: Record<string, unknown> }[] = []
  const bus = { onTelemetry: (fn: typeof listener) => (listener = fn), publish: (dev: string, values: Record<string, unknown>) => published.push({ dev, values }) } as unknown as BusService
  const audits: { action: string; ok: boolean; detail: string }[] = []
  const audit = { write: (e: { action: string; ok: boolean; detail: string }) => audits.push(e) } as unknown as AuditService
  const g = new ConvGuardService(cfg, bus, audit)
  g.now = () => clock
  g.tickMs = 1e9
  g.onModuleInit()
  const sam = () => listener!('SAM-AH99-A', [{ ts: clock, values: { 'env.t': 25 } }], false)
  const noise = () => {
    listener!('CAM-AH99', [{ ts: clock, values: { 'cam.vis': 'OK' } }], false) // eg-video 的摄像机
    listener!('SAM-AH99-A', [{ ts: clock, values: { q: '{}' } }], true) // eg-agent 自己发的
  }
  /** 推进 s 秒，每 step 秒 tick 一次（每次先调 each） */
  const run = async (s: number, each: () => void = () => undefined, step = 2) => {
    for (let t = 0; t < s; t += step) {
      clock += step * 1000
      each()
      await g.tick()
    }
  }
  const convRestarts = () => restartLog.filter(r => r.name === 'lsa-eg-conv').length
  try {
    console.log('1. conv 没启用')
    containers['lsa-eg-mosquitto'] = { running: true, startedAt: clock - 3600_000, restarts: 0 }
    await run(30)
    check(convRestarts() === 0, 'conv 容器不存在（没有 485 的样机）：30 s 没读数也不动')
    containers['lsa-eg-conv'] = { running: false, startedAt: clock - 3600_000, restarts: 0 }
    await run(30)
    check(convRestarts() === 0, 'conv 容器没在跑：不动（崩溃由 restart: unless-stopped 管）')

    console.log('2. 读数正常')
    containers['lsa-eg-conv']!.running = true
    await run(120, sam)
    check(convRestarts() === 0, '有读数（每 2 s）：120 s 不动')

    console.log('3. 长时间没有读数 → 重启，连续重启退避')
    const t0 = clock
    await run(14, noise)
    check(convRestarts() === 1 && g.state.last?.reason === 'silent', `只有摄像机 / agent 自己的消息、${Math.round((restartLog[0]!.at - t0) / 1000)} s 没有转换程序读数：重启一次（门限 10 s）`)
    check(audits.length === 1 && audits[0]!.action === '自动重启转换程序' && audits[0]!.ok, `记审计：${audits[0]?.detail}`)
    const pub = published.find(p => p.dev === 'EG-AH99' && p.values['eg.conv_restarts'] === 1)
    check(!!pub && JSON.parse(String(pub.values['eg.conv_restart'])).reason === 'silent', '上送 EG 遥测 eg.conv_restarts = 1、eg.conv_restart（原因 silent）')
    const disk = JSON.parse(readFileSync(join(dir, 'conv-guard.json'), 'utf8'))
    check(disk.restarts === 1 && disk.last?.reason === 'silent', '落盘 config/conv-guard.json')
    await run(200, noise)
    const at = restartLog.filter(r => r.name === 'lsa-eg-conv').map(r => r.at)
    const gaps = at.slice(1).map((x, i) => Math.round((x - at[i]!) / 1000))
    check(gaps.length >= 3 && gaps[0]! >= 20 && gaps[1]! >= 40 && gaps.slice(2).every(x => x >= 60 && x <= 72), `一直没有读数：重启间隔退避 ${gaps.join(' / ')} s（20、40、之后封顶 60 s）`)

    console.log('4. 读数回来')
    sam()
    check(g.state.backoffN === 0 && g.state.nextAllowedAt === 0, '收到转换程序读数：退避清零')
    const before = convRestarts()
    await run(60, sam)
    check(convRestarts() === before, '之后读数正常：不再重启')

    console.log('5. 总线重启')
    containers['lsa-eg-conv']!.startedAt = clock - 600_000
    containers['lsa-eg-mosquitto']!.startedAt = clock - 1000 // 刚重启
    const n0 = convRestarts()
    clock += 1000
    sam()
    await g.tick()
    check(convRestarts() === n0, '总线刚起来（< 3 s）：先不动')
    clock += 3000
    sam()
    await g.tick()
    check(convRestarts() === n0 + 1 && g.state.last?.reason === 'mosquitto-restart', `总线起来 3 s 后、conv 是在它之前起的：重启 conv（${g.state.last?.detail}）`)
    await run(30, sam)
    check(convRestarts() === n0 + 1, '之后不再重复重启')
    containers['lsa-eg-mosquitto']!.startedAt = clock
    containers['lsa-eg-conv']!.startedAt = clock + 2000
    clock += 10_000
    await run(10, sam)
    check(convRestarts() === n0 + 1, '整套一起重启（conv 在总线之后起）：不动')

    console.log('6. 关掉')
    ;(cfg.local as unknown as { convGuard: { enabled: boolean } }).convGuard.enabled = false
    const n1 = convRestarts()
    await run(120, noise)
    check(convRestarts() === n1, 'convGuard.enabled = false：120 s 没读数也不动')

    console.log('7. install.sh --status 读得出来')
    const sh = spawnSync('bash', ['-c', `cd "${dir.replace(/\\/g, '/')}" && mkdir -p config && cp conv-guard.json config/ && n="$(sed -n 's/.*"restarts":\\([0-9]*\\).*/\\1/p' config/conv-guard.json)"; last="$(sed -n 's/.*"detail":"\\([^"]*\\)".*/\\1/p' config/conv-guard.json)"; echo "$n|$last"`], { encoding: 'utf8' })
    const [n, last] = (sh.stdout ?? '').trim().split('|')
    check(Number(n) === g.state.restarts && !!last && last === g.state.last?.detail, `install.sh 的 sed 取出次数 ${n}、最近一次「${last}」`)
  } finally {
    g.onModuleDestroy()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
  done()
}
void main().catch(e => {
  console.error(e)
  process.exit(1)
})
