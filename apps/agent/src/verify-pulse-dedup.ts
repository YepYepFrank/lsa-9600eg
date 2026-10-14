/* 0.17 事件去重自检（BusService + EventDedup）：同一设备、同一 ts 的 uv.pulse 只处理、只上送一次。
 * 场景（协调会话实测）：转换程序发布超时的那一条转入缓存，原来那次 QoS1 发送总线恢复后也送到了 —— 实时一条、补传批里又一条。
 *
 *   pnpm pulse:verify
 *
 * 真的 BusService（直接喂 ingest，不连总线）+ 真的 UplinkService（子站地址指向不通的端口，数据只进 outbox，最后读 outbox.db 数条数）。 */
import 'reflect-metadata'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EgConfig } from '@lsa-eg/config'
import { BusService, type Entry } from './bus/bus.service.js'
import type { AuditService } from './audit/audit.service.js'
import { CapsService } from './caps/caps.service.js'
import type { MetersService } from './meters/meters.service.js'
import type { QualityService } from './quality/quality.service.js'
import { OutboxStore } from './uplink/outbox.store.js'
import { UplinkService } from './uplink/uplink.service.js'
import { check, done } from './verify/lib.js'

const A = 'SAM-AH99-A'
const B = 'SAM-AH99-B'
const T = 1791958923584
const pulse = (ts: number, peak = 72.35) => ({ ts, values: { 'uv.int': peak, 'uv.pulse': JSON.stringify({ peak, ms: 21 }) } })
const buf = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8')

async function main() {
  console.log('事件去重自检（同设备同 ts 的 uv.pulse 只处理、只上送一次）\n')
  const dir = mkdtempSync(join(tmpdir(), 'lsa-pulse-'))
  const cfg = {
    dir,
    cabinet: { code: 'AH99', group: 'mv' },
    eg: { name: 'EG-AH99', token: 'x', attrs: {} },
    station: { mqtt: 'mqtt://127.0.0.1:9', token: 'x' },
    conn: { bus: 'mqtt://127.0.0.1:9' },
    local: { outbox: { maxAgeDays: 7, maxMb: 64, backfillRate: 2000 } },
    devices: [
      { name: A, kind: 'sam', label: '', attrs: {} },
      { name: B, kind: 'sam', label: '', attrs: {} },
    ],
  } as unknown as EgConfig
  const saved = process.env['EG_UPLINK']
  delete process.env['EG_UPLINK']
  const bus = new BusService(cfg)
  const seen: { dev: string; ts: number; keys: string[]; own: boolean }[] = []
  bus.onTelemetry((dev, entries: Entry[], own) => entries.forEach(e => seen.push({ dev, ts: e.ts, keys: Object.keys(e.values), own })))
  const audit = { write: () => undefined } as unknown as AuditService
  const meters = { toPrimary: (_d: string, v: Record<string, unknown>) => v } as unknown as MetersService
  const quality = { warmupOf: () => null } as unknown as QualityService
  const up = new UplinkService(cfg, bus, audit, new CapsService(), meters, quality)
  up.onModuleInit()
  const pulses = (dev: string, ts: number) => seen.filter(s => s.dev === dev && s.ts === ts && s.keys.includes('uv.pulse')).length
  try {
    console.log('1. 实时一条、补传批里又一条（同 ts）')
    bus.ingest(`lsa/${A}/telemetry`, buf(pulse(T)), false)
    bus.ingest(`lsa/${A}/telemetry`, buf([{ ts: T - 2000, values: { 'env.t': 25 } }, pulse(T), pulse(T + 5000, 80)]), false)
    check(pulses(A, T) === 1, `ts ${T} 的 uv.pulse 下游只见到 1 次（${pulses(A, T)}）`)
    check(seen.filter(s => s.dev === A && s.ts === T).length === 2 && seen.filter(s => s.dev === A && s.ts === T)[1]!.keys.join() === 'uv.int', '重复那行只去掉 uv.pulse，同 ts 的 uv.int 照常（同 ts 覆盖无害）')
    check(pulses(A, T + 5000) === 1, '同一批里新的事件（ts + 5 s）照常处理')
    check(seen.some(s => s.dev === A && s.ts === T - 2000 && s.keys.includes('env.t')), '同一批里别的量照常')
    check(bus.events.dropped === 1, `去掉的重复计数 = 1（${bus.events.dropped}）`)

    console.log('2. 只含 uv.pulse 的重复行整行不要；不相干的不受影响')
    const n0 = seen.length
    bus.ingest(`lsa/${A}/telemetry`, buf({ ts: T + 5000, values: { 'uv.pulse': '{"peak":80,"ms":21}' } }), false)
    check(seen.length === n0, `整行都是重复事件：下游一行都没收到（${seen.length - n0}）`)
    bus.ingest(`lsa/${B}/telemetry`, buf(pulse(T)), false)
    check(pulses(B, T) === 1, '另一台设备同 ts 的弧光事件照常处理（按设备分开记）')
    bus.ingest(`lsa/${A}/telemetry`, buf({ ts: T + 9000, values: { 'env.t': 26 } }), false)
    bus.ingest(`lsa/${A}/telemetry`, buf({ ts: T + 9000, values: { 'env.t': 26 } }), false)
    check(seen.filter(s => s.dev === A && s.ts === T + 9000).length === 2, '非事件类的量同 ts 重复照常放行（按 ts 覆盖，不去重）')
    bus.ingest(`lsa/${A}/telemetry`, buf({ ts: T + 7000, values: { 'uv.pulse': 'x' } }), true)
    bus.ingest(`lsa/${A}/telemetry`, buf({ ts: T + 7000, values: { 'uv.pulse': 'x' } }), true)
    check(seen.filter(s => s.own && s.ts === T + 7000).length === 2, 'agent 自己发的不参与去重（也不记进去重表）')

    console.log('3. agent 重启后照样认（记录落盘）')
    check(existsSync(join(dir, 'pulse-seen.json')) && JSON.parse(readFileSync(join(dir, 'pulse-seen.json'), 'utf8'))[A]?.length === 2, 'pulse-seen.json 记了 A 的 2 个事件')
    const bus2 = new BusService(cfg)
    let again = 0
    bus2.onTelemetry((_d, es) => es.forEach(e => (again += 'uv.pulse' in e.values ? 1 : 0)))
    bus2.ingest(`lsa/${A}/telemetry`, buf(pulse(T)), false)
    bus2.ingest(`lsa/${A}/telemetry`, buf(pulse(T + 60_000)), false)
    check(again === 1, `重启后 Mosquitto 重投 ts ${T}：不再处理；新的照常（${again} 条）`)

    console.log('4. 上送 outbox')
    up.onModuleDestroy()
    const store = new OutboxStore(join(dir, 'outbox.db'))
    const rows = store.take(0, store.maxSeq(), 1000)
    store.close()
    const outPulse = (ts: number) => rows.filter(r => r.dev === A && r.ts === ts && 'uv.pulse' in JSON.parse(r.body)).length
    check(outPulse(T) === 1 && outPulse(T + 5000) === 1, `outbox 里 A 的两个事件各 1 条（${outPulse(T)} / ${outPulse(T + 5000)}）`)
    check(rows.filter(r => r.dev === B && 'uv.pulse' in JSON.parse(r.body)).length === 1, 'outbox 里 B 的事件 1 条')
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
