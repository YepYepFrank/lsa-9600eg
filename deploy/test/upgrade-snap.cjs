// upgrade-eg.sh 的快照：在沙箱里的 lsa-eg-agent 容器里跑（宿主机网络，本地 TB 在 127.0.0.1:18080），用 eg.yaml 里的本地租户账号读本地 TB。
//   SEED=1 时先种数据：第一台 SAM 灌 120 个历史点（kp.seed）、建一条 kp-test 告警
// 输出一行 JSON：设备、设备配置的告警规则（哈希）、告警总数、kp-test 告警数、种的点数、EG 的 cfg 属性
const fs = require('fs')
const crypto = require('crypto')
const y = fs.readFileSync('/config/eg.yaml', 'utf8')
/** eg.yaml 里某个顶层块的「键: 值」（只认一层） */
function block(k) {
  const lines = y.split('\n')
  const i = lines.findIndex(l => l.startsWith(k + ':'))
  const o = {}
  if (i < 0) return o
  for (const l of lines.slice(i + 1)) {
    if (!/^\s/.test(l)) break
    const x = l.match(/^\s+(\w+):\s*"?([^"]*?)"?\s*$/)
    if (x) o[x[1]] = x[2]
  }
  return o
}
const tb = block('tb')
const egName = block('eg').name
const B = 'http://127.0.0.1:18080'
const H = { 'content-type': 'application/json' }
async function j(m, p, b) {
  const r = await fetch(B + p, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) })
  const t = await r.text()
  if (!r.ok) throw new Error(`${m} ${p} ${r.status} ${t.slice(0, 200)}`)
  return t ? JSON.parse(t) : null
}
const h = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)
;(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      H['x-authorization'] = 'Bearer ' + (await j('POST', '/api/auth/login', { username: tb.user, password: tb.password })).token
      break
    } catch (e) {
      if (i === 59) throw e
      await new Promise(r => setTimeout(r, 5000))
    }
  }
  const devs = (await j('GET', '/api/tenant/devices?pageSize=1000&page=0')).data
  const sam = devs.filter(d => /^SAM-/.test(d.name)).sort((a, b) => (a.name < b.name ? -1 : 1))[0]
  const eg = devs.find(d => d.name === egName)
  if (process.env.SEED === '1') {
    const t0 = Date.now() - 3600e3
    await j('POST', `/api/plugins/telemetry/DEVICE/${sam.id.id}/timeseries/ANY`, Array.from({ length: 120 }, (_, i) => ({ ts: t0 + i * 30e3, values: { 'kp.seed': i } })))
    await j('POST', '/api/alarm', { originator: sam.id, type: 'kp-test', severity: 'MINOR', status: 'ACTIVE_UNACK' })
  }
  const profs = (await j('GET', '/api/deviceProfiles?pageSize=100&page=0')).data
  const seed = await j('GET', `/api/plugins/telemetry/DEVICE/${sam.id.id}/values/timeseries?keys=kp.seed&startTs=${Date.now() - 86400e3}&endTs=${Date.now()}&limit=10000`)
  const all = await j('GET', '/api/v2/alarms?pageSize=1&page=0')
  const kp = await j('GET', `/api/alarm/DEVICE/${sam.id.id}?pageSize=50&page=0`)
  const attrs = eg ? await j('GET', `/api/plugins/telemetry/DEVICE/${eg.id.id}/values/attributes`) : []
  const cfg = (attrs.find(a => a.key === 'cfg') || {}).value
  console.log(
    JSON.stringify({
      devices: devs.map(d => d.name).sort().join(','),
      rules: profs.map(p => p.name + ':' + h(JSON.stringify(p.profileData.alarms || null))).sort().join(','),
      alarmsTotal: all.totalElements,
      kpAlarm: kp.data.filter(a => a.type === 'kp-test').length,
      seed: (seed['kp.seed'] || []).length,
      cfg: cfg === undefined ? null : cfg,
    }),
  )
})().catch(e => {
  console.log(JSON.stringify({ error: e.message }))
  process.exit(1)
})
