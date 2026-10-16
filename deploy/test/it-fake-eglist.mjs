// 沙箱用：仿后端 eg-list --json 的输出（EG 库批量升级测试；字段同后端 lsa-9600sp-backend#95 的样例），数据取子站 TB
// 子站沙箱里：EG_LIST_JSON_CMD="docker exec -i -e TBP=<租户口令> [-e FAKE_RC=3] lsa-ext node --input-type=module - < it-fake-eglist.mjs" bash upgrade-egs.sh …
//   FAKE_RC=3：仿「扩展服务刚起、没读全」（upgrade-egs.sh 要整批不开始）
const T = 'http://tb:8080'
const j = async (u, o = {}) => { const r = await fetch(T + u, o); if (!r.ok) throw new Error(`${u} ${r.status}`); return r.json() }
const tok = (await j('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin@lsa9600sp.local', password: process.env.TBP }) })).token
const H = { headers: { 'x-authorization': 'Bearer ' + tok } }
const egs = []
for (const d of (await j('/api/tenant/devices?pageSize=1000&page=0&textSearch=EG-', H)).data.filter(d => /^EG-AH0[78]$/.test(d.name))) {
  const attr = async s => Object.fromEntries((await j(`/api/plugins/telemetry/DEVICE/${d.id.id}/values/attributes/${s}`, H)).map(a => [a.key, a.value]))
  const c = await attr('CLIENT_SCOPE'), s = await attr('SERVER_SCOPE')
  const up = ((await j(`/api/plugins/telemetry/DEVICE/${d.id.id}/values/timeseries?keys=eg.uplink`, H))['eg.uplink'] || [])[0]
  const age = up ? Math.round((Date.now() - up.ts) / 1000) : null
  egs.push({ code: d.name.slice(3), cab: '', eg: d.name, state: age !== null && age < 60 ? 'online' : 'offline', skip: null, egUrl: s.egUrl, egUrlSource: 'attr',
    version: c.egAgentVersion || c.agent, tbVersion: c.tbVersion, uplink: up && up.value, uplinkAt: up && up.ts, uplinkAgeS: age, uplinkOk: !!up && up.value === 'ok' && age < 60,
    cfgWant: c.cfg, cfgActual: c.cfg, cfgStatus: 'APPLIED', cfgApplied: true })
}
console.log(JSON.stringify({ at: Date.now(), sp: '0.17.3', ready: { svc: true, live: process.env.FAKE_RC !== '3' }, egs }, null, 1))
process.exit(Number(process.env.FAKE_RC || 0))
