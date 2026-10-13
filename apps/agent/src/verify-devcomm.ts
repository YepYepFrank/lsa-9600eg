/* 0.17 下挂设备离线口径自检（QualityService.commOf）：转换程序按「fails 取最大、last_ok 取最早」汇总一个设备名下几路传感器的 dev.* 后，
 * 一路传感器坏了，只要这台设备最近 max(30 s, 5 个周期) 内还有测量值到达，就最多 DEGRADED，不判 OFFLINE。
 *
 *   pnpm devcomm:verify
 *
 * 真的 QualityService / WarmupService / CapsService + 假总线（bus.live 里放转换程序报的 dev.*），时刻用 commOf 的 now 参数推进。 */
import 'reflect-metadata'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EgConfig } from '@lsa-eg/config'
import type { BusService, DeviceLive } from './bus/bus.service.js'
import { CapsService } from './caps/caps.service.js'
import { QualityService } from './quality/quality.service.js'
import { WarmupService } from './warmup/warmup.service.js'
import { check, done } from './verify/lib.js'

const DEV = 'SAM-AH99-A'

async function main() {
  console.log('下挂设备离线口径自检（还有测量值在来 → 最多 DEGRADED）\n')
  const dir = mkdtempSync(join(tmpdir(), 'lsa-devcomm-'))
  const cfg = {
    dir,
    cabinet: { code: 'AH99', group: 'mv' },
    eg: { name: 'EG-AH99', attrs: {} },
    devices: [{ name: DEV, kind: 'sam', label: '', attrs: { room: '断路器室' } }],
  } as unknown as EgConfig
  let listener: ((dev: string, entries: { ts: number; values: Record<string, unknown> }[], own: boolean) => void) | null = null
  const live = new Map<string, DeviceLive>()
  const bus = { onTelemetry: (fn: typeof listener) => (listener = fn), publish: () => undefined, live } as unknown as BusService
  const caps = new CapsService()
  const q = new QualityService(cfg, bus, caps, new WarmupService(cfg, caps))
  q.onModuleInit()
  /** 转换程序报的 dev.*（汇总后的：fails 取最大、last_ok 取最早） */
  const src = (vals: Record<string, unknown>) => {
    const at = Date.now()
    live.set(DEV, { telemetry: Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, { v, ts: at, at, own: false }])), attributes: {}, msgs: 1, lastAt: at })
  }
  const meas = (values: Record<string, unknown>) => listener!(DEV, [{ ts: Date.now(), values }], false)
  try {
    const t0 = Date.now()
    console.log('1. 一个隔室里一路传感器坏了（局放读不到），温湿度照常')
    meas({ 'env.t': 25, 'env.rh': 50 })
    src({ 'dev.fails': 12, 'dev.last_ok': t0 - 120_000, 'dev.err': 'TIMEOUT' })
    let c = q.commOf(DEV, t0)
    check(c.comm === 'DEGRADED', `汇总后 fails 12、last_ok 2 min 前，但温湿度刚到：DEGRADED（以前会判 OFFLINE；实际 ${c.comm}）`)
    check(!q.deadDevices(t0).includes(DEV), '不算整台失效（dev.link 仍是 1，不出「设备失联」）')
    c = q.commOf(DEV, t0 + 45_000)
    check(c.comm === 'DEGRADED', `45 s 后（温湿度周期 10 s → 窗口 max(30 s, 50 s) = 50 s 内）：还是 DEGRADED（${c.comm}）`)

    console.log('2. 整台真的没数据了')
    c = q.commOf(DEV, t0 + 55_000)
    check(c.comm === 'OFFLINE', `55 s 没有任何测量值、转换程序仍报 fails 12：OFFLINE（${c.comm}）`)
    check(q.deadDevices(t0 + 55_000).includes(DEV), '算整台失效')

    console.log('3. 正常时照旧')
    meas({ 'env.t': 25, 'env.rh': 50 })
    src({ 'dev.fails': 0, 'dev.last_ok': Date.now(), 'dev.err': '' })
    c = q.commOf(DEV, Date.now())
    check(c.comm !== 'OFFLINE' && c.fails === 0, `转换程序报 fails 0：不离线（${c.comm}，其余量没来的按看护标 q）`)
    live.delete(DEV)
    c = q.commOf(DEV, Date.now() + 120_000)
    check(c.comm === 'OFFLINE', `转换程序不报 dev.*（EG 兜底）、2 min 一个量都没来：OFFLINE（${c.comm}）—— 原口径不变`)
  } finally {
    q.onModuleDestroy()
    rmSync(dir, { recursive: true, force: true })
  }
  done()
}
void main().catch(e => {
  console.error(e)
  process.exit(1)
})
