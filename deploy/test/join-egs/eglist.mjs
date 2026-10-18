// 假 eg-list --json：/fake/cabs.json 里的柜（legacy 或已拆的单元），/fake/applied/<单元> 存在 = 在线、配置生效；拆柜看 model.site.yaml 的 legacyEg
import { existsSync, readFileSync } from 'node:fs'
const cabs = JSON.parse(readFileSync('/fake/cabs.json', 'utf8'))
const site = readFileSync('/opt/lsa9600sp/lsa9600sp-backend/tb/model.site.yaml', 'utf8')
const legacy = new Set((site.match(/^legacyEg: *\[(.*)\]/m)?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean))
const egs = []
for (const [cab, units] of Object.entries(cabs)) {
  const list = legacy.has(cab) || !units.length ? [cab] : units
  for (const u of list) {
    const on = existsSync(`/fake/applied/${u}`)
    const host = JSON.parse(readFileSync('/fake/hosts.json', 'utf8'))[u] ?? ''
    egs.push({ code: u, unit: u, cabCode: cab, eg: `EG-${u}`, state: on ? 'online' : 'never', version: on ? '0.7.0-test' : null, uplinkOk: on, cfgApplied: on, egUrl: host ? `http://${host}` : null, egUrlSource: host ? 'attr' : 'rule' })
  }
}
console.log(JSON.stringify({ ready: { svc: true, live: true }, egs }))
