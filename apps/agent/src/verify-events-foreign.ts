/* 0.8.1 自检：事件库里已有的告警，设备后来不在 eg.yaml 里了，对账照常跟着本地 TB 走（现场 AH01-B：开机清扫在本地 TB 上清掉了
 * SAM-AH01-A 的「设备失联」，事件库还一直是 ACTIVE，本地页顶栏一直挂着）。
 *
 *   pnpm verify:events-foreign
 *
 * AlarmsService 的对账（reconcile）+ 真的 EventsStore（临时库）+ 假的本地 TB（/api/v2/alarms、/api/alarm/info/<id>）。 */
import 'reflect-metadata'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AlarmsService, type TbAlarm } from './alarms/alarms.service.js'
import { EventsStore } from './alarms/events.store.js'
import { check, done } from './verify/lib.js'

const ID = {
  samA: '6ba5d7bc-9a0a-4d3d-9f59-c15e236ccf69',
  pm6: 'cde3aeff-c2f3-49ac-94c5-5a3752dc6b7c',
  gone: '5b383377-d4d4-45a0-83d0-e52c35bd8bba',
  newForeign: '11111111-2222-4333-8444-555555555555',
  mine: '22222222-3333-4444-8555-666666666666',
}

async function main() {
  console.log('对账：不在 eg.yaml 里的设备的已记告警照常跟着本地 TB 走（0.8.1，现场 AH01-B）\n')
  const dir = mkdtempSync(join(tmpdir(), 'evf-'))
  const store = new EventsStore(join(dir, 'events.db'))
  const t0 = Date.now() - 3600_000
  const seed = (eventId: string, device: string) =>
    store.observe({ eventId, device, type: '设备失联', severity: 'MAJOR', state: 'ACTIVE', occurredAt: t0, clearedAt: null, details: { key: 'dev.link', unit: '' } }, t0, null)
  seed(ID.samA, 'SAM-AH01-A')
  seed(ID.pm6, 'PM6-AH01')
  seed(ID.gone, 'PM-AH01')
  seed(ID.mine, 'SAM-AH01-B')

  // 本地 TB：SAM-AH01-A 已被开机清扫清掉；PM6-AH01 还活动；PM-AH01 那条已删（404）；本单元的照常活动；另有一条从没记过的别的单元设备的活动告警
  const alarm = (id: string, dev: string, cleared: boolean): TbAlarm => ({ id: { id }, type: '设备失联', severity: 'MAJOR', status: cleared ? 'CLEARED_UNACK' : 'ACTIVE_UNACK', cleared, startTs: t0, clearTs: cleared ? Date.now() - 60_000 : 0, originatorName: dev })
  const tbAlarms = new Map<string, TbAlarm>([
    [ID.samA, alarm(ID.samA, 'SAM-AH01-A', true)],
    [ID.pm6, alarm(ID.pm6, 'PM6-AH01', false)],
    [ID.mine, alarm(ID.mine, 'SAM-AH01-B', false)],
    [ID.newForeign, alarm(ID.newForeign, 'SAM-AH02-A', false)],
  ])
  const tb = {
    available: true,
    get: async (path: string) => {
      if (path.startsWith('/api/v2/alarms')) {
        const all = [...tbAlarms.values()]
        return { data: path.includes('statusList=ACTIVE') ? all.filter(a => !a.cleared) : [], hasNext: false }
      }
      const id = /\/api\/alarm\/info\/(.+)$/.exec(path)?.[1]
      const a = id ? tbAlarms.get(id) : undefined
      if (a) return a
      const { TbHttpError } = await import('./tb/local-tb.service.js')
      throw new TbHttpError(404, `没有 ${id}`)
    },
  }
  const logs: string[] = []
  const svc = Object.create(AlarmsService.prototype) as AlarmsService
  Object.assign(svc, {
    log: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
    store,
    chain: Promise.resolve(),
    devices: new Map([['EG-AH01-B', 'eg'], ['SAM-AH01-B', 'sam'], ['CAM-AH01-B', 'camera']]),
    hookSeen: new Map(),
    cfg: { local: { outbox: { maxAgeDays: 7 } }, cabinet: { group: 'A' } },
    tb,
    applySvc: { version: () => 'c-1023-1' },
    evidence: { onAlarm: () => undefined },
    sendDue: async () => undefined,
  })
  const reconcile = () => (svc as unknown as { reconcile: () => Promise<void> }).reconcile.call(svc)

  await reconcile()
  check(store.known(ID.samA)?.state === 'CLEARED', `SAM-AH01-A（已不在 eg.yaml）本地 TB 上清了 → 事件库记 CLEARED（${store.known(ID.samA)?.state}）`)
  check(store.get(ID.samA)?.details['unit'] === '', `不在 eg.yaml 里的设备：单位沿用事件库里记着的（${JSON.stringify(store.get(ID.samA)?.details['unit'])}），不被改成 null`)
  check(store.known(ID.gone)?.state === 'CLEARED', `PM-AH01 那条本地 TB 上已删（404）→ 事件库记 CLEARED（${store.known(ID.gone)?.state}）`)
  check(store.known(ID.pm6)?.state === 'ACTIVE', 'PM6-AH01 本地 TB 上还活动 → 事件库照旧 ACTIVE（等开机清扫清掉）')
  check(store.known(ID.mine)?.state === 'ACTIVE', '本单元 SAM-AH01-B 照常')
  check(store.known(ID.newForeign) === null, '从没记过的、不在 eg.yaml 里的设备的告警照旧不记（SAM-AH02-A）')
  check(store.active().map(a => a.device).sort().join(',') === 'PM6-AH01,SAM-AH01-B', `事件库里活动的只剩 PM6-AH01、SAM-AH01-B（顶栏读这里）：${store.active().map(a => a.device).join('、')}`)
  check(logs.some(l => l.includes('SAM-AH01-A「设备失联」恢复')), `记了恢复（${logs.find(l => l.includes('SAM-AH01-A')) ?? '没有'}）`)

  // 开机清扫把 PM6-AH01 清了 → 下一轮对账
  tbAlarms.set(ID.pm6, alarm(ID.pm6, 'PM6-AH01', true))
  await reconcile()
  check(store.known(ID.pm6)?.state === 'CLEARED', `开机清扫清掉 PM6-AH01 以后，下一轮对账记 CLEARED（${store.known(ID.pm6)?.state}）`)
  check(store.known(ID.samA)?.revision === 2, `SAM-AH01-A 只多一版（revision ${store.known(ID.samA)?.revision}），不重复记`)

  store.close()
  rmSync(dir, { recursive: true, force: true })
  done()
}
void main().catch(e => {
  console.error(e)
  process.exit(1)
})
