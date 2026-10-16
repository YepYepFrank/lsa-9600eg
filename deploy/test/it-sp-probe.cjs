// 全链路联调：子站侧快照（在子站沙箱的 lsa-ext 容器里跑：docker exec -i -e TBP=<租户口令> -e SINCE=<ms> -e UNTIL=<ms> lsa-ext node - < it-sp-probe.cjs）
// 子站 TB 上 AH07 各设备：在线、各量条数与最近时刻、最大间隔；子站侧活动告警。只读。
const T = 'http://tb:8080'
const since = Number(process.env.SINCE || Date.now() - 3600e3)
const until = Number(process.env.UNTIL || Date.now())
const cab = process.env.CAB || 'AH07'
async function json(url, opt = {}) {
  const r = await fetch(url, opt)
  const t = await r.text()
  if (!r.ok) throw new Error(`${url} ${r.status} ${t.slice(0, 120)}`)
  return t ? JSON.parse(t) : null
}
const bj = t => (t ? new Date(t + 8 * 3600e3).toISOString().slice(11, 19) : '—')
;(async () => {
  const tok = (await json(`${T}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.TBU || 'admin@lsa9600sp.local', password: process.env.TBP }) })).token
  const H = { 'x-authorization': 'Bearer ' + tok }
  const devs = (await json(`${T}/api/tenant/devices?pageSize=1000&page=0&textSearch=${cab}`, { headers: H })).data.filter(d => d.name.endsWith(cab) || d.name.includes(`-${cab}-`))
  for (const d of devs.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const keys = /^SAM-/.test(d.name) ? ['env.t', 'uv.int', 'uv.pulse', 'us.amp', 'smoke.ppm', 'dev.comm'] : /^EG-/.test(d.name) ? ['eg.uplink', 'eg.buf_depth', 'eg.conv_restarts', 'eg.uplink_err'] : []
    if (!keys.length) continue
    const ts = await json(`${T}/api/plugins/telemetry/DEVICE/${d.id.id}/values/timeseries?keys=${keys.join(',')}&startTs=${since}&endTs=${until}&limit=100000&orderBy=ASC`, { headers: H })
    const parts = keys.map(k => {
      const p = ts[k] || []
      if (!p.length) return `${k} 0`
      let gap = 0
      for (let i = 1; i < p.length; i++) gap = Math.max(gap, p[i].ts - p[i - 1].ts)
      const last = p[p.length - 1]
      return `${k} ${p.length}（最近 ${bj(last.ts)}=${String(last.value).slice(0, 24)}，最大间隔 ${Math.round(gap / 1000)} s）`
    })
    console.log(`  子站 TB ${d.name}：${parts.join('；')}`)
  }
  // textSearch 不搜发起设备名，取全部再按名字筛
  const al = await json(`${T}/api/v2/alarms?pageSize=500&page=0&sortProperty=createdTime&sortOrder=ASC`, { headers: H })
  const mine = (al.data || []).filter(a => String(a.originatorName || '').includes(cab))
  const act = mine.filter(a => a.status.startsWith('ACTIVE'))
  console.log(`  子站活动告警（${cab}）${act.length}：${act.map(a => `${a.originatorName} ${a.type} ${a.severity}`).join('；') || '无'}`)
  const win = mine.filter(a => a.createdTime >= since && a.createdTime <= until)
  console.log(`  窗口内产生的告警 ${win.length}：${win.map(a => `${bj(a.createdTime)}–${a.clearTs ? bj(a.clearTs) : '…'} ${a.originatorName} ${a.type}`).join('；') || '无'}`)
})().catch(e => {
  console.log('!! ' + e.message)
  process.exit(1)
})
