/* 0.7.3 自检：开机清扫清掉「不归本单元」设备的遗留活动告警（现场：拆柜前 SAM-AH01-A 的「设备失联」拆完还挂在 EG-AH01-B 顶栏）。
 *
 *   pnpm verify:sweep-foreign
 *
 * ApplyService 的 clearForeign（开机清扫里那一步）+ 假的本地 TB（/api/v2/alarms 回活动告警、/api/alarm/<id>/clear 记下来）；
 * foreignUnitDevice 的判法；另核 sweepOnce 里调了它、记审计。 */
import 'reflect-metadata'
import { readFileSync } from 'node:fs'
import { ApplyService, foreignUnitDevice } from './apply/apply.service.js'
import { check, done } from './verify/lib.js'

interface Alarm {
  id: { id: string }
  type: string
  originatorName?: string
}

const DEVICES = [
  { name: 'EG-AH01-B', kind: 'eg' },
  { name: 'SAM-AH01-B', kind: 'sam' },
  { name: 'CAM-AH01-B', kind: 'camera' },
  { name: 'PM-AH01', kind: 'meter' },
]

function rig(devices: { name: string; kind: string }[], active: Alarm[], failOn: string | null = null, getFails = false) {
  const cleared: string[] = []
  const logs: string[] = []
  const tb = {
    get: async (path: string) => {
      if (getFails) throw new Error('ECONNREFUSED')
      if (path.startsWith('/api/v2/alarms') && path.includes('statusList=ACTIVE')) return { data: active }
      throw new Error(`没料到的请求 ${path}`)
    },
    req: async (method: string, path: string) => {
      const id = /\/api\/alarm\/([^/]+)\/clear/.exec(path)?.[1]
      if (method !== 'POST' || !id) throw new Error(`没料到的请求 ${method} ${path}`)
      if (id === failOn) throw new Error('本地 TB 500')
      cleared.push(id)
    },
  }
  const svc = Object.create(ApplyService.prototype) as ApplyService
  Object.assign(svc, {
    cfg: { unit: { code: 'AH01-B' }, cabinet: { code: 'AH01' }, eg: { name: 'EG-AH01-B' }, devices },
    tb,
    log: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
  })
  const run = () => (svc as unknown as { clearForeign: () => Promise<Map<string, number>> }).clearForeign.call(svc)
  return { cleared, logs, run }
}

const ACTIVE: Alarm[] = [
  { id: { id: 'a1' }, type: '设备失联', originatorName: 'SAM-AH01-A' },
  { id: { id: 'a2' }, type: '温度过高', originatorName: 'SAM-AH01-A' },
  { id: { id: 'c2' }, type: '摄像机离线', originatorName: 'CAM-AH01-A' },
  { id: { id: 'b1' }, type: '设备失联', originatorName: 'SAM-AH01-B' },
  { id: { id: 'e1' }, type: 'EG 离线', originatorName: 'EG-AH01-B' },
  { id: { id: 'c1' }, type: '摄像机离线', originatorName: 'CAM-AH01-B' },
  { id: { id: 'r1' }, type: '区域过温', originatorName: 'CAM-AH01-B-R1' },
  { id: { id: 'g1' }, type: 'EG 离线', originatorName: 'EG-AH01' },
  { id: { id: 'p1' }, type: '电表失联', originatorName: 'PM-AH01' },
  { id: { id: 'v1' }, type: '网关告警', originatorName: 'tb-gateway-AH01-B' },
  { id: { id: 'x1' }, type: '老告警', originatorName: undefined },
]

async function main() {
  console.log('开机清扫：不归本单元的设备的遗留告警（0.7.3，拆柜）\n')

  console.log('1. foreignUnitDevice（本单元 AH01-B）')
  const cases: [string, boolean, string][] = [
    ['SAM-AH01-A', true, '拆柜后归 A 的 SAM'],
    ['CAM-AH01-A', true, '归 A 的摄像机'],
    ['EG-AH01-A', true, '另一个单元的 EG'],
    ['SAM-AH02-A', true, '别的柜的单元'],
    ['SAM-AH01-B', false, '本单元'],
    ['CAM-AH01-B-R1', false, '本单元的测温区子设备'],
    ['PM-AH01', false, '柜级名字（拿不准归哪个单元）'],
    ['EG-AH01', false, '拆柜前整柜那台 EG（柜级）'],
    ['tb-gateway-AH01-B', false, '认不出的名字'],
    ['SAM-AH01-a', false, '单元字母小写（认不出）'],
  ]
  for (const [d, want, why] of cases) check(foreignUnitDevice(d, 'AH01-B') === want, `${d}：${want ? '清' : '不清'}（${why}）`)
  check(!foreignUnitDevice('SAM-AH07-A', 'AH07') && !foreignUnitDevice('SAM-AH07-B', 'AH07') && foreignUnitDevice('SAM-AH08-A', 'AH07'), '照旧一柜一台（单元号 = 柜号 AH07）：自己的 SAM-AH07-A / -B 不清，别的柜 SAM-AH08-A 清')

  console.log('2. 拆柜后：SAM-AH01-A、CAM-AH01-A 已不归 EG-AH01-B')
  const r = rig(DEVICES, ACTIVE)
  const m = await r.run()
  check(r.cleared.sort().join(',') === 'a1,a2,c2', `只清 a1、a2（SAM-AH01-A）、c2（CAM-AH01-A）：清了 ${r.cleared.join('、')}`)
  check(m.get('SAM-AH01-A') === 2 && m.get('CAM-AH01-A') === 1 && m.size === 2, `按设备记条数：${[...m].map(([d, n]) => `${d} ${n}`).join('、')}`)
  check(!r.cleared.includes('r1'), '本单元的测温区子设备 CAM-AH01-B-R1 的告警不清（不在 eg.yaml 里也不清）')
  check(!['b1', 'e1', 'c1', 'p1'].some(x => r.cleared.includes(x)), '本单元设备、EG 自己、柜级电表 PM-AH01 不清')
  check(!['g1', 'v1', 'x1'].some(x => r.cleared.includes(x)), '柜级 EG-AH01、认不出的 tb-gateway-…、没有设备名的不清')
  const skipLine = r.logs.find(l => l.includes('名字看不出归别的单元'))
  check(!!skipLine && skipLine.includes('CAM-AH01-B-R1') && skipLine.includes('EG-AH01') && skipLine.includes('tb-gateway-AH01-B'), `不清的记一行：${skipLine}`)

  console.log('3. 设备清单为空（待接入、eg.yaml 里没写设备）：整步跳过')
  const e1 = rig([], ACTIVE)
  check((await e1.run()).size === 0 && e1.cleared.length === 0 && e1.logs.some(l => l.includes('跳过')), `一条都不清：${e1.logs.at(-1)}`)
  const e2 = rig([{ name: 'EG-AH01-B', kind: 'eg' }], ACTIVE)
  check((await e2.run()).size === 0 && e2.cleared.length === 0, '只有 EG 自己、没有下挂设备：一样跳过')

  console.log('4. 清一条失败：记警告、其余照清，不抛')
  const f = rig(DEVICES, ACTIVE, 'a1')
  const mf = await f.run()
  check(f.cleared.sort().join(',') === 'a2,c2' && mf.get('SAM-AH01-A') === 1 && f.logs.some(l => l.includes('SAM-AH01-A') && l.includes('500')), `a1 失败、其余照清（${f.cleared.join('、')}）`)

  console.log('5. 本地 TB 查不了：记警告、返回空')
  const b = rig(DEVICES, ACTIVE, null, true)
  check((await b.run()).size === 0 && b.logs.some(l => l.includes('ECONNREFUSED')), `返回空（${b.logs.at(-1)}）`)

  console.log('6. 开机清扫里调了它，并记审计')
  const src = readFileSync(new URL('./apply/apply.service.ts', import.meta.url), 'utf8')
  const sweep = src.slice(src.indexOf('private sweepOnce'), src.indexOf('private async regenerate'))
  check(/await this\.clearForeign\(\)/.test(sweep) && /action: '清除遗留告警', target: dev/.test(sweep) && /不再归本单元/.test(sweep), 'sweepOnce：clearForeign → 每台设备一条审计（action 清除遗留告警，写明不再归本单元）')
  done()
}
void main().catch(e => {
  console.error(e)
  process.exit(1)
})
