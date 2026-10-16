// 全链路联调：EG 侧一次快照（在沙箱的 lsa-eg-agent 容器里跑，经 stdin 传进去：docker exec -i lsa-eg-agent node - < it-probe.cjs）
//   agent（本地管理页的接口）：各设备通信状态 / 测点数 / 质量码 / 最近数据、转换程序保险、上送状态、组件
//   本地 TB：SAM 的 env.t、uv.pulse 条数，本柜活动告警
// 只读。口令用沙箱自己生成的 initial-password.txt（maint）与 eg.yaml 里的本地 TB 账号（同 fresh-install.sh / upgrade-snap.cjs）
const fs = require('fs')
const since = Number(process.env.SINCE || Date.now() - 3600e3)
const y = fs.readFileSync('/config/eg.yaml', 'utf8')
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
async function json(url, opt = {}) {
  const r = await fetch(url, opt)
  const t = await r.text()
  if (!r.ok) throw new Error(`${url} ${r.status} ${t.slice(0, 120)}`)
  return t ? JSON.parse(t) : null
}
const bj = t => (t ? new Date(t + 8 * 3600e3).toISOString().slice(11, 19) : '—')
;(async () => {
  const A = 'http://127.0.0.1'
  const pw = fs.readFileSync('/config/initial-password.txt', 'utf8').trim()
  const tok = (await json(`${A}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'maint', password: pw }) })).token
  const H = { authorization: 'Bearer ' + tok }
  const st = await json(`${A}/api/status`, { headers: H })
  if (process.env.MODE === 'comm') {
    // 精简：每台 SAM 一段「通信 / 测点数 / 质量异常的量」，场景脚本每 10 s 采一次
    console.log(bj(Date.now()) + ' ' + st.devices.filter(d => /^SAM-/.test(d.name)).map(d => `${d.name} ${d.comm?.comm} keys=${d.keys} badq=${Object.keys(d.q).length}`).join(' | '))
    return
  }
  const dg = await json(`${A}/api/diag`, { headers: H })
  const comps = await json(`${A}/api/components`, { headers: H })
  console.log(`== agent ${st.version}：eg ${st.state}，总线 ${st.bus.connected ? '连上' : '没连上'}（${st.bus.msgs} 条），上送 ${dg.uplink.state}「${dg.uplink.text}」`)
  for (const d of st.devices) {
    const c = d.comm || {}
    console.log(`  ${d.name.padEnd(12)} 通信 ${String(c.comm).padEnd(8)} fails ${c.fails ?? '—'} 测点 ${d.keys} 最近数据 ${d.ageSec ?? '—'} s 前 质量 ${JSON.stringify(d.q)}${d.dead ? ' 整台无数据' : ''}${d.warmupS ? ' 预热 ' + d.warmupS + ' s' : ''}`)
  }
  const g = st.convGuard
  if (g) console.log(`  转换程序保险：${g.enabled ? '开' : '关'}，自动重启 ${g.restarts} 次${g.last ? `，最近 ${bj(g.last.at)} ${g.last.reason}（${g.last.detail}）` : ''}，最近读数 ${bj(g.lastReadAt)}`)
  const conv = comps.find(c => c.key === 'conv')
  if (conv) console.log(`  组件 conv：${conv.state}，内存 ${conv.memMb ?? '—'} MB，镜像 ${conv.image}`)
  if (dg.uplink.refused) console.log(`  上送被拒：${JSON.stringify(dg.uplink.refused)}`)
  // 本地 TB
  const tb = block('tb')
  const T = 'http://127.0.0.1:18080'
  const tt = (await json(`${T}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: tb.user, password: tb.password }) })).token
  const TH = { 'x-authorization': 'Bearer ' + tt }
  const devs = (await json(`${T}/api/tenant/devices?pageSize=1000&page=0`, { headers: TH })).data
  for (const d of devs.filter(x => /^SAM-/.test(x.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const ts = await json(`${T}/api/plugins/telemetry/DEVICE/${d.id.id}/values/timeseries?keys=env.t,uv.pulse,uv.int,us.amp&startTs=${since}&endTs=${Date.now()}&limit=100000`, { headers: TH })
    const n = k => (ts[k] || []).length
    console.log(`  本地 TB ${d.name}：env.t ${n('env.t')}、uv.int ${n('uv.int')}、uv.pulse ${n('uv.pulse')}、us.amp ${n('us.amp')}（${bj(since)} 起）`)
    // PULSES=1：逐条列 uv.pulse（看去重 / 有没有丢）
    if (process.env.PULSES) for (const p of (ts['uv.pulse'] || []).reverse()) console.log(`    uv.pulse ${bj(p.ts)} ${p.value}`)
  }
  const al = await json(`${T}/api/v2/alarms?pageSize=50&page=0&statusList=ACTIVE`, { headers: TH })
  console.log(`  本地 TB 活动告警 ${al.totalElements}：${al.data.map(a => `${a.originatorName || ''} ${a.type} ${a.severity}`).join('；') || '无'}`)
})().catch(e => {
  console.log('!! ' + e.message)
  process.exit(1)
})
