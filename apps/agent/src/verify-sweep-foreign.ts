/* 0.7.3 自检：开机清扫清掉「不归本单元」设备的遗留活动告警（现场：拆柜前 SAM-AH01-A 的「设备失联」拆完还挂在 EG-AH01-B 顶栏）。
 *
 *   pnpm verify:sweep-foreign
 *
 * ApplyService 的 clearForeign（开机清扫里那一步）+ 假的本地 TB（/api/v2/alarms 回活动告警、/api/alarm/<id>/clear 记下来）；
 * 另核 sweepOnce 里调了它、记审计。 */
import 'reflect-metadata'
import { readFileSync } from 'node:fs'
import { ApplyService } from './apply/apply.service.js'
import { check, done } from './verify/lib.js'

interface Alarm {
  id: { id: string }
  type: string
  originatorName?: string
}

async function main() {
  console.log('开机清扫：不归本单元的设备的遗留告警（0.7.3，拆柜）\n')
  const active: Alarm[] = [
    { id: { id: 'a1' }, type: '设备失联', originatorName: 'SAM-AH01-A' },
    { id: { id: 'a2' }, type: '温度过高', originatorName: 'SAM-AH01-A' },
    { id: { id: 'b1' }, type: '设备失联', originatorName: 'SAM-AH01-B' },
    { id: { id: 'e1' }, type: 'EG 离线', originatorName: 'EG-AH01-B' },
    { id: { id: 'c1' }, type: '摄像机离线', originatorName: 'CAM-AH01-B' },
    { id: { id: 'x1' }, type: '老告警', originatorName: undefined },
    { id: { id: 'v1' }, type: '网关告警', originatorName: 'tb-gateway-AH01-B' },
    { id: { id: 'g1' }, type: 'EG 离线', originatorName: 'EG-AH01' },
  ]
  const cleared: string[] = []
  let failOn: string | null = null
  const tb = {
    get: async (path: string) => {
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
  const warns: string[] = []
  const svc = Object.create(ApplyService.prototype) as ApplyService
  Object.assign(svc, {
    cfg: {
      unit: { code: 'AH01-B' },
      eg: { name: 'EG-AH01-B' },
      devices: [{ name: 'EG-AH01-B', kind: 'eg' }, { name: 'SAM-AH01-B', kind: 'sam' }, { name: 'CAM-AH01-B', kind: 'camera' }, { name: 'PM-AH01', kind: 'meter' }],
    },
    tb,
    log: { log: () => undefined, warn: (m: string) => warns.push(m) },
  })
  const clearForeign = (svc as unknown as { clearForeign: () => Promise<Map<string, number>> }).clearForeign.bind(svc)

  console.log('1. 拆柜后：SAM-AH01-A 已不归 EG-AH01-B')
  const r = await clearForeign()
  check(cleared.sort().join(',') === 'a1,a2,g1', `清 SAM-AH01-A 的两条、拆柜前整柜那台 EG-AH01 的一条（清了 ${cleared.join('、')}）`)
  check(r.size === 2 && r.get('SAM-AH01-A') === 2 && r.get('EG-AH01') === 1, `按设备记条数：${[...r].map(([d, n]) => `${d} ${n}`).join('、')}`)
  check(!cleared.includes('v1'), '名字不像下挂设备 / EG 的（本机虚拟设备 tb-gateway-AH01-B）不动')
  check(!cleared.includes('b1') && !cleared.includes('e1') && !cleared.includes('c1'), '本单元的设备（SAM-AH01-B、摄像机）和 EG 自己的不动')
  check(!cleared.includes('x1'), '没有发起设备名的不动（拿不准就不清）')

  console.log('2. 清一条失败：记警告、其余照清，不抛')
  cleared.length = 0
  failOn = 'a1'
  const r2 = await clearForeign()
  check(cleared.join(',') === 'a2,g1' && r2.get('SAM-AH01-A') === 1 && warns.some(w => w.includes('SAM-AH01-A') && w.includes('500')), `a1 失败、a2 照清（${cleared.join('、')}；${warns.at(-1)}）`)

  console.log('3. 本地 TB 查不了：记警告、返回空，不影响开机清扫的其余部分')
  const bad = Object.create(ApplyService.prototype) as ApplyService
  Object.assign(bad, { cfg: (svc as unknown as { cfg: unknown }).cfg, tb: { get: async () => { throw new Error('ECONNREFUSED') } }, log: { log: () => undefined, warn: (m: string) => warns.push(m) } })
  const r3 = await (bad as unknown as { clearForeign: () => Promise<Map<string, number>> }).clearForeign()
  check(r3.size === 0 && warns.at(-1)!.includes('ECONNREFUSED'), `返回空（${warns.at(-1)}）`)

  console.log('3b. eg.yaml 里一台下挂设备都没有（不全 / 读坏了）：整步跳过，不当成「清单为空」')
  cleared.length = 0
  failOn = null
  const empty = Object.create(ApplyService.prototype) as ApplyService
  Object.assign(empty, { cfg: { unit: { code: 'AH01-B' }, eg: { name: 'EG-AH01-B' }, devices: [{ name: 'EG-AH01-B', kind: 'eg' }] }, tb, log: { log: () => undefined, warn: (m: string) => warns.push(m) } })
  const r4 = await (empty as unknown as { clearForeign: () => Promise<Map<string, number>> }).clearForeign()
  check(r4.size === 0 && cleared.length === 0 && warns.at(-1)!.includes('没有下挂设备'), `一条都不清（${warns.at(-1)}）`)

  console.log('4. 开机清扫里调了它，并记审计')
  const src = readFileSync(new URL('./apply/apply.service.ts', import.meta.url), 'utf8')
  const sweep = src.slice(src.indexOf('private sweepOnce'), src.indexOf('private async regenerate'))
  check(/await this\.clearForeign\(\)/.test(sweep) && /action: '清除遗留告警', target: dev/.test(sweep) && /不再归本单元/.test(sweep), 'sweepOnce：clearForeign → 每台设备一条审计（action 清除遗留告警，写明不再归本单元）')
  done()
}
void main().catch(e => {
  console.error(e)
  process.exit(1)
})
