/* 0.7.1 开机重算告警规则的开关自检（协调 10-20）：重算以已生效配置里子站给的开关为准，不能把子站关掉的告警重新打开。
 *
 *   pnpm regen:verify
 *
 * 纯函数（regenRules / filterRules / configHash），不连任何东西。 */
import 'reflect-metadata'
import { configHash, filterRules, regenRules } from './apply/apply.service.js'
import { check, done } from './verify/lib.js'

const ALL = ['EG-rise', 'EG-rise2', 'EG-tabs', 'EG-pd', 'EG-arc', 'EG-rh', 'EG-ol', 'EG-dphase', 'EG-devlost']
const base = ALL.map(id => ({ id, on: id !== 'EG-rh' }))
const smokeOf = (rs: { id: string; on: boolean }[]) => rs.find(r => r.id === 'EG-smoke')
const def = (alarmType: string, sev: string[]) => ({ id: alarmType, alarmType, createRules: Object.fromEntries(sev.map(s => [s, {}])) })
const generated = [def('烟气', ['CRITICAL', 'MAJOR']), def('预热期读数越限（烟气）', ['WARNING']), def('局放异常', ['MAJOR'])]
const kept = (rs: { id: string; on: boolean }[]) => filterRules(generated, rs).map(a => a.alarmType)

console.log('1. 0.7.1 起存的配置：被跳过的规则开关记在 ignoredRules')
{
  const r = regenRules({ rules: base, ignoredRules: [{ id: 'EG-smoke', on: false }] }, new Set())
  check(smokeOf(r.rules)?.on === false && !r.unknown.length, '老配置里 EG-smoke 是 off、当时在 ignored 里（记了开关）：重算后保持 off')
  check(!kept(r.rules).includes('烟气') && !kept(r.rules).includes('预热期读数越限（烟气）'), '生成的规则里没有烟气、也没有它的预热降级那支')
  const on = regenRules({ rules: base, ignoredRules: [{ id: 'EG-smoke', on: true }] }, new Set())
  check(smokeOf(on.rules)?.on === true && kept(on.rules).includes('烟气'), '记的是 on：重算后有烟气')
  const none = regenRules({ rules: base, ignoredRules: [] }, new Set())
  check(!smokeOf(none.rules) && kept(none.rules).includes('烟气') && !none.unknown.length, '载荷里根本没有 EG-smoke（老子站没发）：按缺省开')
}

console.log('2. 认得的规则：照存的 on')
{
  const r = regenRules({ rules: [...base, { id: 'EG-smoke', on: false }], ignoredRules: [] }, new Set(['烟气']))
  check(smokeOf(r.rules)?.on === false && !kept(r.rules).includes('烟气'), 'rules 里 EG-smoke off：保持 off（本地 TB 现在有烟气也去掉）')
}

console.log('3. 0.7.0 及以前存的配置（没有 ignoredRules 字段，被跳过的规则开关没记）：保持本地 TB 现状')
{
  const r = regenRules({ rules: base }, new Set(['局放异常', '设备失联']))
  check(smokeOf(r.rules)?.on === false && !kept(r.rules).includes('烟气'), '本地没有烟气（0.7.0 生成不出来）：EG-smoke 按停 —— 不会把子站可能关掉的烟雾告警打开')
  // 0.8.3 起多一条 EG-arcuv（弧光传感器受光异常）：老配置里同样没有它的开关，本地也没有这个类型 → 一样按停，等子站下发
  check(r.unknown.map(x => x.id).sort().join() === 'EG-arcuv,EG-smoke' && r.unknown.every(x => !x.on), `开关不知道的只列 EG-smoke、EG-arcuv，都按停（${r.unknown.map(x => x.id).join('、')}）`)
  const r2 = regenRules({ rules: base }, new Set(['烟气']))
  check(smokeOf(r2.rules)?.on === true, '本地已经有烟气：照旧开')
  const old = regenRules({ rules: base.filter(x => x.id !== 'EG-devlost') }, new Set(['设备失联']))
  check(old.rules.find(x => x.id === 'EG-devlost')?.on === true, '更老的配置没带 EG-devlost、本地有「设备失联」：照旧开，不因重算被去掉')
}

console.log('4. 配置哈希')
{
  const b = { thresholds: [], rules: base, extras: { pdCnt: 20, commPeriods: 5 }, caps: null, devComm: null, meters: null, gas: null }
  check(configHash({ ...b, ignoredRules: [] }) === configHash(b), '没有被跳过的规则：与老哈希一致')
  check(configHash({ ...b, ignoredRules: [{ id: 'EG-x', on: false }] }) !== configHash({ ...b, ignoredRules: [{ id: 'EG-x', on: true }] }), '子站只改了被跳过的规则的开关：算新内容（要重新记下）')
}
done()
