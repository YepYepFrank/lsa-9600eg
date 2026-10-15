/* 真机 restv1 探测（联调用）：按 local.yaml 的摄像机配置，逐个接口打一遍、原样打印回应的结构，再用 Restv1Driver 走一遍。
 * 用来对照驱动的假设（restv1-mock.ts 是照文档写的）和真机实际回的东西。不写配置、不改摄像机，只读。
 *
 *   pnpm restv1:probe                     # 读 run/local.yaml（或 EG_CONFIG_DIR）
 *   pnpm restv1:probe -- --base http://192.168.1.19
 *
 * 账号口令只从配置里取，任何输出都不带口令、口令的 MD5 和令牌。 */
import { createHash } from 'node:crypto'
import { loadConfig } from '@lsa-eg/config'
import { restv1Opts } from './drivers.js'
import { Restv1Driver } from './restv1.js'

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex')
const arg = (k: string) => {
  const i = process.argv.indexOf(k)
  return i > 0 ? process.argv[i + 1] : undefined
}

/** 回应的结构：数组只展开第一项、长字符串截断，便于和文档对照 */
function shape(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.length ? [`…共 ${v.length} 项，第 1 项：`, shape(v[0], depth + 1)] : []
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, depth > 4 ? '…' : shape(x, depth + 1)]))
  if (typeof v === 'string' && v.length > 80) return `${v.slice(0, 40)}…（${v.length} 字符）`
  return v
}

async function main() {
  const cfg = loadConfig()
  const o = restv1Opts(cfg.local.camera)
  const base = (arg('--base') ?? o.base).replace(/\/+$/, '')
  if (!base) throw new Error('没配摄像机地址：local.yaml camera.restv1，或 --base http://<摄像机>')
  if (!o.password) throw new Error('local.yaml 里没有接口口令（camera.restPassword，或 restUser 留空时的 camera.password）')
  const url = /^https?:\/\//.test(base) ? base : `http://${base}`
  console.log(`摄像机 ${url}，接口账号 ${o.user}${cfg.local.camera.restUser ? '（restUser）' : '（同取流账号）'}\n`)

  const login = await fetch(`${url}/restv1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: md5(o.user), key: md5(o.password) }),
    signal: AbortSignal.timeout(5000),
  }).then(r => r.json() as Promise<{ code?: number; msg?: string; data?: { accessToken?: string; expireTime?: number } }>)
  const token = login.data?.accessToken
  console.log(`== POST /restv1/token → code ${login.code} ${login.msg ?? ''}，expireTime ${login.data?.expireTime ?? '—'}`)
  if (!token) process.exit(1)

  const paths = [
    '/restv1/device/info',
    '/restv1/channel/rtsp/0',
    '/restv1/channel/rtsp/1',
    '/restv1/measurement/region',
    '/restv1/measurement/globTemp',
    '/restv1/measurement/regionTemp',
    '/restv1/alarm/status',
  ]
  for (const p of paths) {
    const t0 = Date.now()
    try {
      const r = await fetch(`${url}${p}`, { headers: { accessToken: token }, signal: AbortSignal.timeout(5000) })
      const text = await r.text()
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        body = `（不是 JSON）${text.slice(0, 120)}`
      }
      console.log(`\n== GET ${p} → HTTP ${r.status}，${Date.now() - t0} ms`)
      console.log(JSON.stringify(shape(body), null, 2))
    } catch (e) {
      console.log(`\n== GET ${p} → 出错：${(e as Error).message}`)
    }
  }
  for (const id of [0, 1]) {
    const t0 = Date.now()
    try {
      const r = await fetch(`${url}/restv1/channel/snap/${id}`, { headers: { accessToken: token }, signal: AbortSignal.timeout(10_000) })
      const j = (await r.json()) as { code?: number; data?: { snapData?: string } }
      const b = Buffer.from((j.data?.snapData ?? '').replace(/^data:image\/\w+;base64,/, ''), 'base64')
      console.log(`\n== GET /restv1/channel/snap/${id} → code ${j.code}，${b.length} 字节，${b[0] === 0xff && b[1] === 0xd8 ? 'JPEG' : '不是 JPEG'}，${Date.now() - t0} ms`)
    } catch (e) {
      console.log(`\n== GET /restv1/channel/snap/${id} → 出错：${(e as Error).message}`)
    }
  }

  // 驱动自己走一遍（与 eg-video 同一套代码）。上面的令牌占了一个会话，摄像机上限 2，驱动再登一次正好用满
  console.log('\n\n==== Restv1Driver ====')
  const d = new Restv1Driver({ ...o, base: url })
  try {
    const s = await d.streams()
    console.log(`streams：${s.note}`)
    for (const [k, v] of Object.entries(s.map)) console.log(`  ${k.padEnd(10)} ${v?.uri}`)
  } catch (e) {
    console.log(`streams 失败：${(e as Error).message}`)
  }
  try {
    const m = await d.measure()
    console.log(`measure：画面 ${m.frame.w}×${m.frame.h}，区域 ${m.regions.length} 个（${m.regions.map(r => `${r.name}/${r.type}${r.enabled ? '' : '停用'}`).join(' ')}）`)
    const g = m.temps?.glob
    console.log(`  全画面 max ${g?.max} @(${g?.maxX},${g?.maxY}) min ${g?.min} avg ${g?.avg ?? '—'} center ${g?.center ?? '—'}`)
    for (const r of m.temps?.regions ?? []) console.log(`  ${r.name.padEnd(4)} max ${r.max ?? '—'} min ${r.min ?? '—'} avg ${r.avg ?? '—'} center ${r.center ?? '—'}${r.pt !== undefined ? ` pt ${r.pt}` : ''}`)
    console.log(`  原生报警：${m.alarm || '无'}${m.partial ? `；partial：${m.partial.map(p => `${p.what} ${p.error}`).join('；')}` : ''}`)
  } catch (e) {
    console.log(`measure 失败：${(e as Error).message}`)
  }
  for (const ch of ['visible', 'ir'] as const) {
    try {
      console.log(`snap ${ch}：${(await d.snap(ch)).length} 字节 JPEG`)
    } catch (e) {
      console.log(`snap ${ch} 失败：${(e as Error).message}`)
    }
  }
  console.log(`detail：${JSON.stringify(d.detail())}`)
}

main().catch(e => {
  console.error((e as Error).message)
  process.exit(1)
})
