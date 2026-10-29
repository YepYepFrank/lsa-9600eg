/* 0.8.3 弧光事件量 uv.arc 自检（ArcService + @lsa/model ArcDeriver，用户 10-29 定）。
 *
 *   pnpm arc:verify
 *
 * 真的 BusService（直接喂 ingest，不连总线；publish 换成记下来、再当 agent 自己发的喂回去）+ 真的 CapsService + 真的 UplinkService
 * （子站地址指向不通的端口，数据只进 outbox，最后读 outbox.db 看 uv.arc 没进去）。本地 TB 规则那一半（uv.arc > 0 触发、≤ 0 连续 60 s 恢复、
 * 受光 60 s）在 EG 沙箱里用真的本地 TB 测，结果写在 PR 里。 */
import 'reflect-metadata'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EgConfig } from '@lsa-eg/config'
import type { ThresholdRow } from '@lsa/model'
import { BusService } from './bus/bus.service.js'
import type { AuditService } from './audit/audit.service.js'
import { CapsService } from './caps/caps.service.js'
import type { CapsConfig } from './caps/caps.js'
import { ArcService } from './derive/arc.service.js'
import type { MetersService } from './meters/meters.service.js'
import type { QualityService } from './quality/quality.service.js'
import { OutboxStore } from './uplink/outbox.store.js'
import { UplinkService } from './uplink/uplink.service.js'
import { check, done } from './verify/lib.js'

const S = 'SAM-AH99-A'
const T = 1791958923584
const buf = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8')
const ROWS = [{ key: 'arc', name: '弧光强度', unit: '%', mv: 70, tr: 60, lv: 50, note: '' }] as ThresholdRow[]
const caps = (arcEvents: 'confirmed' | 'pending'): CapsConfig => ({ caps: { arcEvents, arcIntensity: 'confirmed' }, capKeys: { arcEvents: ['SAM:uv.pulse'], arcIntensity: ['SAM:uv.int', 'SAM:uv.arc'] } })

async function main() {
  console.log('弧光事件量 uv.arc 自检（ArcService）\n')
  const dir = mkdtempSync(join(tmpdir(), 'lsa-arc-'))
  const cfg = {
    dir,
    cabinet: { code: 'AH99', group: 'mv' },
    unit: { id: '', code: 'AH99-A', at: '', index: 1 },
    eg: { name: 'EG-AH99-A', token: 'x', attrs: {} },
    station: { mqtt: 'mqtt://127.0.0.1:9', token: 'x' },
    conn: { bus: 'mqtt://127.0.0.1:9' },
    local: { outbox: { maxAgeDays: 7, maxMb: 64, backfillRate: 2000 } },
    devices: [{ name: S, kind: 'sam', label: '', attrs: {} }],
  } as unknown as EgConfig
  const saved = process.env['EG_UPLINK']
  delete process.env['EG_UPLINK']
  const bus = new BusService(cfg)
  // agent 发回总线的：记下来，再像 Mosquitto 投回来一样当 own 喂回去（上送那边按 own 处理）
  const out: { dev: string; ts: number; v: unknown }[] = []
  ;(bus as unknown as { publish: BusService['publish'] }).publish = (dev, values, ts = Date.now()) => {
    if ('uv.arc' in values) out.push({ dev, ts, v: values['uv.arc'] })
    bus.ingest(`lsa/${dev}/telemetry`, buf({ ts, values }), true)
  }
  const cs = new CapsService()
  ;(cs as unknown as { log: { log: () => void } }).log = { log: () => undefined }
  const audit = { write: () => undefined } as unknown as AuditService
  const meters = { toPrimary: (_d: string, v: Record<string, unknown>) => v } as unknown as MetersService
  const quality = { warmupOf: () => null } as unknown as QualityService
  const up = new UplinkService(cfg, bus, audit, cs, meters, quality)
  up.onModuleInit()
  const arc = new ArcService(cfg, bus, cs)
  arc.onModuleInit()
  arc.setThresholds(ROWS)
  const feed = (ts: number, values: Record<string, unknown>) => bus.ingest(`lsa/${S}/telemetry`, buf({ ts, values }), false)
  const since = (n: number) => out.slice(n).map(x => `${x.v}@${x.ts - T}`).join(' ')
  const pulse = (ts: number, peak: number, ms: number) => feed(ts, { 'uv.int': peak, 'uv.pulse': JSON.stringify({ peak, ms }) })
  try {
    check(arc.arcThreshold === 70, `阈值取 arc 这一行、本柜柜型（mv）那一列：${arc.arcThreshold}`)

    console.log('1. 真事件（ms 21）→ uv.arc = 峰值，ts 同事件；同一条里同 ts 的 uv.int 不回零；下一条 ts 更大的 uv.int 回 0')
    cs.set(caps('confirmed'), null)
    feed(T, { 'uv.int': 3 })
    let n = out.length
    pulse(T + 2000, 82.5, 21)
    check(since(n) === '82.5@2000', `出一条 uv.arc = 82.5、ts = 事件那条（${since(n)}）`)
    n = out.length
    feed(T + 2000, { 'uv.int': 82.5 })
    check(out.length === n, '同 ts 再来一条 uv.int：不回零')
    feed(T + 4000, { 'uv.int': 2 })
    check(since(n) === '0@4000', `下一条 uv.int（ts + 2 s）回 0（${since(n)}）`)
    pulse(T + 6000, 0, 15)
    check(out.at(-1)?.v === 1, `峰值不是正数时写 1（${out.at(-1)?.v}）`)
    feed(T + 8000, { 'uv.int': 1 })

    console.log('2. 开门强光（一直 > 阈值、没有事件，arcEvents 已确认）→ 不出 uv.arc（受光异常由本地 TB 规则 EG-arcuv 判）')
    n = out.length
    for (let i = 0; i < 40; i++) feed(T + 10_000 + i * 2000, { 'uv.int': i % 2 ? 50 : 90 })
    check(out.length === n, `40 个样本在阈值上下来回：一条 uv.arc 都没出（${since(n) || '无'}）`)

    console.log('3. 事件持续 > 1 s → 不出 uv.arc，只记日志；1000 ms 本身算电弧')
    n = out.length
    pulse(T + 100_000, 95, 1500)
    check(out.length === n && arc.counts.long === 1, `ms 1500：没出（长事件计数 ${arc.counts.long}）`)
    pulse(T + 102_000, 95, 1000)
    check(since(n) === '95@102000', `ms 1000：照常出（${since(n)}）`)
    feed(T + 104_000, { 'uv.int': 1 })

    console.log('4. 一直没有后续 uv.int：60 s 后补 0（tick）')
    n = out.length
    feed(T + 200_000, { 'uv.pulse': JSON.stringify({ peak: 77, ms: 30 }) })
    arc.tick(T + 200_000 + 59_000)
    check(since(n) === '77@200000', `59 s 时还不补（${since(n)}）`)
    arc.tick(T + 200_000 + 61_000)
    check(out.at(-1)?.v === 0 && out.at(-1)?.ts === T + 261_000, `61 s 时补 0，ts = 当时（${since(n)}）`)

    console.log('5. 兜底：arcEvents 待定 → uv.int 上升沿出一次；一直亮着不再出；回到阈值下再上去再出一次；启动后第一个样本不算')
    const arc2 = new ArcService(cfg, bus, cs)
    cs.set(caps('pending'), null)
    arc2.setThresholds(ROWS)
    arc2.onModuleInit()
    check(arc.edgeOn && arc2.edgeOn, '能力清单 arcEvents = pending：兜底开')
    // arc（第一个）也收着；只看 arc2 新出的：先停掉 arc 的输入
    ;(arc as unknown as { sams: Map<string, unknown> }).sams.clear()
    n = out.length
    feed(T + 300_000, { 'uv.int': 90 })
    check(out.length === n, '启动后第一个样本 90 > 70：不算上升沿')
    feed(T + 302_000, { 'uv.int': 40 })
    feed(T + 304_000, { 'uv.int': 88 })
    feed(T + 306_000, { 'uv.int': 92 })
    feed(T + 308_000, { 'uv.int': 95 })
    check(since(n) === '88@304000 0@306000', `上升沿出一次 88，之后一直亮：下一条回 0、不再出（${since(n)}）`)
    feed(T + 310_000, { 'uv.int': 70 })
    feed(T + 312_000, { 'uv.int': 71 })
    check(out.at(-1)?.v === 71, `回到阈值（含 70）以下再上去：再出一次（${since(n)}）`)
    feed(T + 314_000, { 'uv.int': 2 })
    cs.set(caps('confirmed'), null)
    check(!arc2.edgeOn, '能力改成 confirmed：兜底关')
    n = out.length
    feed(T + 316_000, { 'uv.int': 40 })
    feed(T + 318_000, { 'uv.int': 90 })
    check(out.length === n, `兜底关了以后上升沿不出（${since(n) || '无'}）`)
    cs.set(null, null)
    check(!arc2.edgeOn, '没下发能力清单：当 confirmed，兜底关')

    console.log('6. uv.arc 不上送子站')
    up.onModuleDestroy()
    const store = new OutboxStore(join(dir, 'outbox.db'))
    const rows = store.take(0, store.maxSeq(), 10_000)
    store.close()
    const withArc = rows.filter(r => 'uv.arc' in JSON.parse(r.body)).length
    const withPulse = rows.filter(r => 'uv.pulse' in JSON.parse(r.body)).length
    check(withArc === 0 && withPulse > 0, `outbox 里 uv.arc ${withArc} 条、uv.pulse ${withPulse} 条（uv.pulse 照常送）`)
    arc.onModuleDestroy()
    arc2.onModuleDestroy()
  } finally {
    if (saved !== undefined) process.env['EG_UPLINK'] = saved
    rmSync(dir, { recursive: true, force: true })
  }
  done()
}
void main().catch(e => {
  console.error(e)
  process.exit(1)
})
