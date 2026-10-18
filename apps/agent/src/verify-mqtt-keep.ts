/* 0.17 mqtt.js 长连接保活自检（MqttKeeper + 真 mqtt.js 5.16 + 假 broker）。
 * mqtt.js 收到被拒的 CONNACK 会置 reconnectSuppressed、从此不再重连（后端 #40）；这里对真库跑：
 *   0. 对照：裸 mqtt.js（不开 reconnectOnConnackError）被拒一次就再也不连 —— 证明问题存在；
 *   1. 先拒绝两次再放行 → 连上，原因清空；
 *   2. 一直拒绝 → 退避重试（间隔翻倍到顶），原因（CONNACK 码 + 文字）记着；
 *   3. 普通断开（broker 掐掉连接）→ 照常重连；
 *   4. 兜底：库不重连（模拟 reconnectSuppressed）→ 换个新客户端连上；
 *   5. 真 UplinkService：子站拒绝（CONNACK 5）→ 状态文字、eg.uplink_err、uplink-state.json 都有原因；放行后连上、清空。
 *
 *   pnpm mqtt-keep:verify
 *   pnpm mqtt-keep:verify -- --tb      另加第 6 节：对真 TB（一次性 dind 里的 tb-node）—— 令牌错被拒 → 子站补上令牌后不重启 agent 就连上；
 *                                       docker restart TB 两次，agent 每次都连回去、断开期间的数据补传进 TB。
 *                                       环境变量 KEEP_TB_API（缺省 http://127.0.0.1:28080）、KEEP_TB_MQTT（mqtt://127.0.0.1:28883）、
 *                                       KEEP_DIND（缺省 lsa-kp-dind：TB 容器在它里面叫 tb）；只碰这个一次性容器
 *
 * 假 broker：net 服务器，收到 CONNECT 按当前模式回 CONNACK（3.1.1 / 5.0 都认），PINGREQ 回 PINGRESP；不碰任何真 broker。 */
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mqtt, { type MqttClient } from 'mqtt'
import type { EgConfig } from '@lsa-eg/config'
import { MqttKeeper, mqttKeepOptions } from '@lsa-eg/config/mqtt-keep'
import type { AuditService } from './audit/audit.service.js'
import type { BusService } from './bus/bus.service.js'
import { CapsService } from './caps/caps.service.js'
import type { MetersService } from './meters/meters.service.js'
import type { QualityService } from './quality/quality.service.js'
import { UplinkService } from './uplink/uplink.service.js'
import { check, done, sleep } from './verify/lib.js'

/** 假 broker：mode = 'accept' 或 CONNACK 拒绝码 */
async function fakeBroker() {
  const st = { mode: 'accept' as 'accept' | number, connects: [] as number[], socks: new Set<Socket>() }
  const srv = createServer(s => {
    st.socks.add(s)
    s.on('close', () => st.socks.delete(s))
    s.on('error', () => undefined)
    s.on('data', b => {
      let i = 0
      while (i < b.length) {
        const type = b[i]! >> 4
        // 剩余长度（变长编码）
        let len = 0
        let mul = 1
        let j = i + 1
        for (;;) {
          const x = b[j++]!
          len += (x & 127) * mul
          mul *= 128
          if (!(x & 128) || j >= b.length) break
        }
        const body = b.subarray(j, j + len)
        if (type === 1) {
          st.connects.push(Date.now())
          // 协议名 MQTT 后一字节是版本：4 = 3.1.1，5 = 5.0
          const v5 = body[6] === 5
          const rc = st.mode === 'accept' ? 0 : st.mode
          s.write(Buffer.from(v5 ? [0x20, 3, 0, rc, 0] : [0x20, 2, 0, rc]))
        } else if (type === 12) s.write(Buffer.from([0xd0, 0]))
        else if (type === 8) {
          // SUBSCRIBE → SUBACK（包 id 原样，QoS 0）
          s.write(Buffer.from([0x90, 3, body[0]!, body[1]!, 0]))
        }
        i = j + len
      }
    })
  })
  await new Promise<void>(ok => srv.listen(0, '127.0.0.1', ok))
  const port = (srv.address() as { port: number }).port
  return {
    st,
    url: `mqtt://127.0.0.1:${port}`,
    kick: () => st.socks.forEach(s => s.destroy()),
    close: () => new Promise<void>(ok => (st.socks.forEach(s => s.destroy()), srv.close(() => ok()))),
  }
}

const waitFor = async (fn: () => boolean | Promise<boolean>, ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(50)
  }
  return fn()
}

/** 第 6 节：真 TB */
async function realTb() {
  const API = process.env['KEEP_TB_API'] ?? 'http://127.0.0.1:28080'
  const MQ = process.env['KEEP_TB_MQTT'] ?? 'mqtt://127.0.0.1:28883'
  const DIND = process.env['KEEP_DIND'] ?? 'lsa-kp-dind'
  console.log(`6. 真 TB（${API}，TB 容器在 ${DIND} 里）`)
  const login = (await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tenant@thingsboard.org', password: 'tenant' }) })).json()) as { token: string }
  const h = { 'content-type': 'application/json', 'x-authorization': `Bearer ${login.token}` }
  const tb = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`${API}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`)
    const t = await r.text()
    return (t ? JSON.parse(t) : null) as T
  }
  const name = `EG-KP${process.pid % 100}`
  const dev = await tb<{ id: { id: string } }>('POST', '/api/device', { name, type: 'default', additionalInfo: { gateway: true } })
  const token = `kp-${Math.random().toString(16).slice(2, 10)}`
  const dir = mkdtempSync(join(tmpdir(), 'lsa-keep-tb-'))
  const cfg = {
    dir,
    cabinet: { code: 'KP99', group: 'mv' },
    unit: { id: '', code: 'KP99', at: '', index: 1 },
    eg: { name, token, attrs: {} },
    station: { mqtt: MQ, token },
    local: { outbox: { maxAgeDays: 7, maxMb: 64, backfillRate: 2000 } },
    devices: [],
  } as unknown as EgConfig
  let feed: ((d: string, e: { ts: number; values: Record<string, unknown> }[], own: boolean) => void) | null = null
  const bus = { onTelemetry: (fn: typeof feed) => (feed = fn), onAttributes: () => undefined } as unknown as BusService
  const meters = { toPrimary: (_d: string, v: Record<string, unknown>) => v } as unknown as MetersService
  const up = new UplinkService(cfg, bus, { write: () => undefined } as unknown as AuditService, new CapsService(), meters, { warmupOf: () => null } as unknown as QualityService)
  up.onModuleInit()
  let n = 0
  const fed: number[] = []
  const tick = setInterval(() => {
    const ts = Date.now()
    fed.push(ts)
    feed?.(name, [{ ts, values: { 'kp.n': ++n } }], false)
  }, 1000)
  const seen = new Set<string>()
  const watch = setInterval(() => {
    const st = up.status()
    if (st.refused) seen.add(`CONNACK ${st.refused.code} ${st.refused.reason}`)
  }, 100)
  try {
    const r1 = await waitFor(() => !!up.status().refused, 15_000)
    const s1 = up.status()
    check(r1 && s1.refused?.code === 5, `令牌在子站上不存在：真 TB 回 CONNACK ${s1.refused?.code} ${s1.refused?.reason}，状态写明`, s1.text)
    const cred = await tb<{ id: { id: string }; deviceId: unknown; credentialsType: string }>('GET', `/api/device/${dev.id.id}/credentials`)
    await tb('POST', '/api/device/credentials', { ...cred, credentialsType: 'ACCESS_TOKEN', credentialsId: token })
    const t1 = Date.now()
    const ok1 = await waitFor(() => up.status().state !== 'offline', 70_000)
    check(ok1, `子站补上令牌后不重启 agent 就连上（${((Date.now() - t1) / 1000).toFixed(1)} s）`, up.status().text)
    const series = async (from: number, to: number) => {
      const r = await tb<Record<string, { ts: number }[]>>('GET', `/api/plugins/telemetry/DEVICE/${dev.id.id}/values/timeseries?keys=kp.n&startTs=${from}&endTs=${to}&limit=100000`)
      return new Set((r['kp.n'] ?? []).map(x => x.ts))
    }
    seen.clear()
    for (const round of [1, 2]) {
      await sleep(5000)
      const t0 = Date.now()
      execFileSync('docker', ['exec', DIND, 'docker', 'restart', 'tb'], { stdio: 'ignore' })
      const downOk = await waitFor(() => up.status().state === 'offline', 30_000)
      const back = await waitFor(async () => {
        if (up.status().state === 'offline') return false
        return true
      }, 300_000)
      const tUp = Date.now()
      // 连回去后再喂 10 s，等补传走完
      await sleep(10_000)
      await waitFor(() => (up.status().depth ?? 0) === 0, 60_000)
      const got = await series(t0 - 3000, tUp + 8000)
      const want = fed.filter(ts => ts >= t0 - 3000 && ts <= tUp + 8000)
      const miss = want.filter(ts => !got.has(ts)).length
      check(downOk && back, `第 ${round} 次 docker restart TB：断开后 ${((tUp - t0) / 1000).toFixed(0)} s 连回去`, up.status().text)
      check(miss === 0, `第 ${round} 次：断开期间的 ${want.length} 个读数全部补传进 TB（缺 ${miss}）`)
    }
    check(true, `重启过程中见到的拒绝：${seen.size ? [...seen].join('、') : '无（这几次 TB 起来前只是连不上，没回拒绝）'}`)
  } finally {
    clearInterval(tick)
    clearInterval(watch)
    up.onModuleDestroy()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  console.log('mqtt.js 长连接保活自检（真 mqtt.js + 假 broker）\n')
  const fb = await fakeBroker()
  const logs: string[] = []
  const mk = (opts: { keepOpt?: boolean; minMs?: number; maxMs?: number } = {}) =>
    new MqttKeeper<MqttClient>({
      create: () => {
        const o = { clientId: `keep-${Math.random().toString(16).slice(2, 8)}`, reconnectPeriod: 200, connectTimeout: 2000 }
        return mqtt.connect(fb.url, opts.keepOpt === false ? o : mqttKeepOptions(o))
      },
      wire: c => c.on('error', () => undefined),
      minMs: opts.minMs ?? 200,
      maxMs: opts.maxMs ?? 1600,
      log: (_l, m) => logs.push(m),
    })
  try {
    console.log('0. 对照：裸 mqtt.js 被拒一次')
    fb.st.mode = 5
    fb.st.connects = []
    const bare = mqtt.connect(fb.url, { clientId: 'bare', reconnectPeriod: 200 })
    bare.on('error', () => undefined)
    await sleep(300)
    fb.st.mode = 'accept'
    await sleep(1500)
    check(!bare.connected && fb.st.connects.length === 1, `裸 mqtt.js 被拒后不再重连（broker 放行 1.5 s 后仍断着，共试 ${fb.st.connects.length} 次）—— 问题存在`)
    bare.end(true)

    console.log('1. 先拒绝两次再放行')
    fb.st.mode = 5
    fb.st.connects = []
    let k = mk()
    k.start()
    await waitFor(() => fb.st.connects.length >= 2, 3000)
    check(k.refused?.code === 5 && k.refused.reason === 'Not authorized', `原因记下来了：CONNACK ${k.refused?.code} ${k.refused?.reason}，连续 ${k.refused?.count} 次`)
    fb.st.mode = 'accept'
    const ok1 = await waitFor(() => k.connected, 4000)
    check(ok1, `放行后连上（共试 ${fb.st.connects.length} 次，没换客户端：${k.replaced === 0}）`)
    check(k.refused === null, '连上后原因清空')
    k.stop()

    console.log('2. 一直拒绝（CONNACK 3 Server unavailable）')
    fb.st.mode = 3
    fb.st.connects = []
    logs.length = 0
    k = mk()
    k.start()
    await sleep(5500)
    const gaps = fb.st.connects.slice(1).map((t, i) => t - fb.st.connects[i]!)
    check(fb.st.connects.length >= 4, `一直在重试（5.5 s 内 ${fb.st.connects.length} 次）`)
    check(gaps.length >= 3 && gaps[1]! > gaps[0]! * 1.5 && gaps[2]! > gaps[1]! * 1.5, `间隔翻倍退避：${gaps.map(g => `${(g / 1000).toFixed(1)} s`).join(' → ')}`)
    check(gaps.every(g => g < 1600 * 1.3), '退避到顶不超过上限')
    check(k.refused?.code === 3 && (k.refused?.count ?? 0) === fb.st.connects.length, `原因：CONNACK ${k.refused?.code} ${k.refused?.reason}，连续 ${k.refused?.count} 次`)
    check(logs.some(l => l.includes('CONNACK 3 Server unavailable')), '日志里有 CONNACK 码与原因（不静默）', logs[0])
    k.stop()

    console.log('3. 普通断开')
    fb.st.mode = 'accept'
    fb.st.connects = []
    k = mk()
    k.start()
    await waitFor(() => k.connected, 2000)
    fb.kick()
    await sleep(100)
    const down = !k.connected
    const back = await waitFor(() => k.connected, 3000)
    check(down && back && k.replaced === 0, `broker 掐掉连接 → mqtt.js 自己重连上（没动兜底）`)
    k.stop()

    console.log('4. 兜底：库不重连（不开 reconnectOnConnackError，模拟 reconnectSuppressed）')
    fb.st.mode = 5
    fb.st.connects = []
    logs.length = 0
    k = mk({ keepOpt: false })
    k.start()
    await sleep(300)
    fb.st.mode = 'accept'
    const ok4 = await waitFor(() => k.connected, 4000)
    check(ok4 && k.replaced >= 1, `close 后 mqtt.js 没排重连 → 换了 ${k.replaced} 次客户端、连上`)
    check(logs.some(l => l.includes('换个客户端')), '兜底时有日志', logs.find(l => l.includes('换个客户端')))
    k.stop()

    console.log('5. 真 UplinkService：子站拒绝连接')
    const dir = mkdtempSync(join(tmpdir(), 'lsa-keep-'))
    const cfg = {
      dir,
      cabinet: { code: 'AH99', group: 'mv' },
      unit: { id: '', code: 'AH99', at: '', index: 1 },
      eg: { name: 'EG-AH99', token: 'bad-token', attrs: {} },
      station: { mqtt: fb.url, token: 'bad-token' },
      local: { outbox: { maxAgeDays: 7, maxMb: 64, backfillRate: 2000 } },
      devices: [],
    } as unknown as EgConfig
    const bus = { onTelemetry: () => undefined, onAttributes: () => undefined } as unknown as BusService
    const up = new UplinkService(cfg, bus, { write: () => undefined } as unknown as AuditService, new CapsService(), {} as MetersService, { warmupOf: () => null } as unknown as QualityService)
    fb.st.mode = 5
    fb.st.connects = []
    delete process.env['EG_UPLINK']
    up.onModuleInit()
    await waitFor(() => fb.st.connects.length >= 1, 3000)
    await sleep(200)
    const s = up.status()
    check(s.state === 'offline' && /CONNACK 5 Not authorized/.test(s.text) && /令牌/.test(s.text), '状态文字写清原因', s.text)
    check(up.metrics()['eg.uplink_err'] === 'CONNACK 5 Not authorized', `EG 遥测 eg.uplink_err = ${JSON.stringify(up.metrics()['eg.uplink_err'])}`)
    const f = JSON.parse(readFileSync(join(dir, 'uplink-state.json'), 'utf8')) as { refused: { code: number } | null }
    check(f.refused?.code === 5, 'uplink-state.json 记了被拒（install.sh --status 读）')
    fb.st.mode = 'accept'
    // UplinkService 的退避起点 5 s：第 1 次拒绝后 5 s 重试
    const ok5 = await waitFor(() => up.status().state !== 'offline', 8000)
    const f2 = JSON.parse(readFileSync(join(dir, 'uplink-state.json'), 'utf8')) as { refused: unknown }
    check(ok5 && up.metrics()['eg.uplink_err'] === '' && f2.refused === null, `子站放行后连上（${up.status().state}），原因清空`)
    up.onModuleDestroy()
    rmSync(dir, { recursive: true, force: true })

    if (process.argv.includes('--tb')) await realTb()
  } finally {
    await fb.close()
  }
  done()
}
void main().catch(e => {
  console.error(e)
  process.exit(1)
})
