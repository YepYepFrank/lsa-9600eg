/* 0.7.3 自检：必有量看本单元能力（子站 0.18.3，现场 AH01-B：地电波改成「不支持」以后 SAM 还是一直 DEGRADED）。
 *
 *   pnpm verify:caps-required
 *
 * 真的 QualityService / CapsService / WarmupService + 假总线 + 假预期测点（转换程序只开了局放）+ 可调的时钟（Date.now 换掉）。 */
import 'reflect-metadata'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EgConfig } from '@lsa-eg/config'
import type { BusService, DeviceLive } from './bus/bus.service.js'
import { CapsService } from './caps/caps.service.js'
import { deviceEnabled, keyCapState, keyUplink, type CapState, type CapsConfig } from './caps/caps.js'
import type { AuditService } from './audit/audit.service.js'
import type { ConvExpectService } from './conv/conv-expect.service.js'
import type { MetersService } from './meters/meters.service.js'
import { UplinkService } from './uplink/uplink.service.js'
import { QualityService } from './quality/quality.service.js'
import { WarmupService } from './warmup/warmup.service.js'
import { check, done } from './verify/lib.js'

const DEV = 'SAM-AH01-B'
const PD = ['us.amp', 'us.cnt', 'us.type', 'us.level', 'tev.amp', 'tev.level', 'uhf.amp', 'uhf.level']
const CAP_KEYS = { pdAmplitude: ['SAM:us.amp'], pdCount: ['SAM:us.cnt'], tev: ['SAM:tev.*'], uhf: ['SAM:uhf.*'] }
const capsOf = (tev: CapState): CapsConfig => ({ caps: { pdAmplitude: 'confirmed', pdCount: 'confirmed', tev, uhf: 'unsupported' }, capKeys: CAP_KEYS })

let clock = 1_800_000_000_000
const realNow = Date.now
Date.now = () => clock

function rig(caps: CapsConfig | null) {
  const dir = mkdtempSync(join(tmpdir(), 'lsa-capsreq-'))
  const cfg = {
    dir,
    cabinet: { code: 'AH01', group: 'mv' },
    eg: { name: 'EG-AH01-B', attrs: {} },
    devices: [{ name: DEV, kind: 'sam', label: '', attrs: { room: '电缆室' } }],
  } as unknown as EgConfig
  let listener: ((dev: string, entries: { ts: number; values: Record<string, unknown> }[], own: boolean) => void) | null = null
  const live = new Map<string, DeviceLive>()
  const bus = { onTelemetry: (fn: typeof listener) => (listener = fn), publish: () => undefined, live } as unknown as BusService
  const cs = new CapsService()
  ;(cs as unknown as { log: { log: () => void } }).log = { log: () => undefined }
  if (caps) cs.set(caps, null)
  const expect = { expected: (n: string) => (n === DEV ? new Set(PD) : null), onChange: () => undefined } as unknown as ConvExpectService
  const q = new QualityService(cfg, bus, cs, new WarmupService(cfg, cs), expect)
  ;(q as unknown as { log: { log: () => void } }).log = { log: () => undefined }
  q.onModuleInit()
  const send = (extra: Record<string, unknown> = {}) => listener!(DEV, [{ ts: clock, values: { 'us.amp': 25.8, 'us.cnt': 4, 'us.type': 1, 'us.level': 0, ...extra } }], false)
  /** 局放每 3 s 一条（地电波、特高频不发：读出 187 / 269），跑 sec 秒 */
  const run = (sec: number) => {
    for (let t = 0; t < sec; t += 3) {
      clock += 3000
      send()
    }
  }
  const stop = () => {
    q.onModuleDestroy()
    rmSync(dir, { recursive: true, force: true })
  }
  return { q, cs, send, run, stop }
}

async function main() {
  console.log('必有量看本单元能力 自检（0.7.3，现场 AH01-B）\n')

  console.log('1. 子站没下发能力（老子站）：照旧按预期测点全看护')
  {
    const r = rig(null)
    r.run(45)
    const qq = r.q.qualityOf(DEV)
    check(qq['tev.amp'] === 'invalid' && r.q.commOf(DEV).comm === 'DEGRADED', `地电波一直没来：tev.amp invalid、DEGRADED（${JSON.stringify(qq)}）`)
    r.stop()
  }

  console.log('2. 现场 AH01-B：地电波改成「不支持」（unsupported）')
  {
    const r = rig(capsOf('unsupported'))
    r.run(45)
    const qq = r.q.qualityOf(DEV)
    check(Object.keys(qq).length === 0, `q 里没有 tev.* / uhf.*（${JSON.stringify(qq)}）—— 子站不会再收到 tev.amp invalid`)
    check(r.q.commOf(DEV).comm === 'ONLINE', `SAM-AH01-B ONLINE，不再 DEGRADED（${r.q.commOf(DEV).comm}）`)
    r.stop()
  }

  console.log('3. 地电波「待定」（pending，子站 0.18.3 起的全局缺省）')
  {
    const r = rig(capsOf('pending'))
    r.run(45)
    check(!r.q.qualityOf(DEV)['tev.amp'] && r.q.commOf(DEV).comm === 'ONLINE', `一直没来：不算缺、ONLINE（${JSON.stringify(r.q.qualityOf(DEV))}）`)
    r.send({ 'tev.amp': 12.3, 'tev.level': 0 })
    r.run(45)
    check(r.q.qualityOf(DEV)['tev.amp'] === 'invalid' && r.q.commOf(DEV).comm === 'DEGRADED', `来过以后断了：照常判缺（${r.q.qualityOf(DEV)['tev.amp']}）—— 本柜装了就要看护`)
    r.stop()
  }

  console.log('4. 地电波「已确认」（confirmed，S19 本站模型）')
  {
    const r = rig(capsOf('confirmed'))
    r.run(45)
    check(r.q.qualityOf(DEV)['tev.amp'] === 'invalid' && !r.q.qualityOf(DEV)['uhf.amp'] && r.q.commOf(DEV).comm === 'DEGRADED',
      `一直没来：tev.amp invalid、DEGRADED；特高频不支持照样不算（${JSON.stringify(r.q.qualityOf(DEV))}）`)

    console.log('5. 子站改能力（下发新配置）马上生效，不用重启 agent')
    r.cs.set(capsOf('unsupported'), null)
    check(Object.keys(r.q.qualityOf(DEV)).length === 0 && r.q.commOf(DEV).comm === 'ONLINE', `confirmed → unsupported：q 清空、ONLINE（${JSON.stringify(r.q.qualityOf(DEV))}）`)
    r.cs.set(capsOf('confirmed'), null)
    check(r.q.qualityOf(DEV)['tev.amp'] === 'invalid', `再改回 confirmed：又判缺（${r.q.qualityOf(DEV)['tev.amp']}）`)
    r.stop()
  }

  console.log('6. keyCapState')
  const c = capsOf('pending')
  check(keyCapState(DEV, 'tev.level', c) === 'pending', 'SAM:tev.* 前缀匹配 tev.level → pending')
  check(keyCapState(DEV, 'env.t', c) === null, '没有对应能力的量 → null（照旧当启用）')
  check(keyCapState('PM-AH01', 'tev.amp', c) === null, '前缀不同的设备不匹配 → null')
  check(keyCapState(DEV, 'tev.amp', null) === null, '子站没下发能力 → null')
  check(keyCapState(DEV, 'us.amp', { caps: { a: 'unsupported', b: 'confirmed' }, capKeys: { a: ['SAM:us.*'], b: ['SAM:us.amp'] } }) === 'confirmed', '几条能力都匹配上：有 confirmed 就算 confirmed')
  check(keyCapState(DEV, 'us.cnt', { caps: {}, capKeys: { a: ['SAM:us.*'] } }) === 'unsupported', 'capKeys 有、caps 没写的能力 → unsupported（同 capEnabled）')

  console.log('7. 0.8.1 上送按量挡（现场 AH01-B：测温区改待定后摄像机整台不上送；协调定：按量挡，全都 unsupported 才整台不送）')
  {
    // 子站现在的 capKeys：camVideo 没有遥测（空数组），摄像机只对得上 thermalRegions（CAM:ir.*）
    const cc: CapsConfig = {
      caps: { thermalRegions: 'pending', camVideo: 'confirmed', meterBasic: 'unsupported', meterHarmonics: 'unsupported', pdAmplitude: 'pending', envTH: 'confirmed', samIr: 'pending', tev: 'unsupported', uhf: 'unsupported', arc: 'unsupported', smokePpm: 'unsupported' },
      // SAM 的点表 key 全归能力（同子站 CAP_KEYMAP：us / env / ir.t_* / tev / uhf / uv / smoke）
      capKeys: { thermalRegions: ['CAM:ir.*'], camVideo: [], meterBasic: ['PM:el.*'], meterHarmonics: ['PM:el.h*'], pdAmplitude: ['SAM:us.*'], envTH: ['SAM:env.*'], samIr: ['SAM:ir.t_max', 'SAM:ir.t_avg'], tev: ['SAM:tev.*'], uhf: ['SAM:uhf.*'], arc: ['SAM:uv.*'], smokePpm: ['SAM:smoke.*'] },
    }
    const off = { ...cc, caps: { ...cc.caps, thermalRegions: 'unsupported' as const } }
    check(deviceEnabled('CAM-AH01-B', cc), '测温区待定（不是 unsupported）→ 摄像机整台照常连子站')
    check(!deviceEnabled('CAM-AH01-B', off), '不给点表、测温区 unsupported → 摄像机整台不送（只对得上这一项）')
    check(deviceEnabled('CAM-AH01-B', off, ['ir.max', 'cam.online']), '给了点表：cam.online 不归任何能力 → 测温区 unsupported 也照常连')
    check(!deviceEnabled('PM-AH01', cc, ['el.Ia', 'el.hu.A']), '电表的能力全都 unsupported → 整台不送')
    check(deviceEnabled('PM-AH01', { ...cc, caps: { ...cc.caps, meterHarmonics: 'pending' } }, ['el.Ia', 'el.hu.A']), '电表有一项待定 → 整台照常连（量按量挡）')
    check(!keyUplink('CAM-AH01-B', 'ir.R1.max', cc) && keyUplink('CAM-AH01-B', 'cam.online', cc) && keyUplink('CAM-AH01-B', 'dev.comm', cc) && keyUplink('CAM-AH01-B', 'q', cc), 'keyUplink：测温区待定 → ir.* 不送；cam.* / dev.* / q 照常')
    const narrow: CapsConfig = { ...cc, capKeys: { ...cc.capKeys, thermalRegions: ['CAM:ir.R*', 'CAM:ir.rise', 'CAM:ir.rmax'] } }
    check(keyUplink('CAM-AH01-B', 'ir.max', narrow) && !keyUplink('CAM-AH01-B', 'ir.R2.avg', narrow) && !keyUplink('CAM-AH01-B', 'ir.rmax', narrow), '子站把 thermalRegions 收窄到区域量时：全画面 ir.max 照常、ir.R* / ir.rmax 不送')
    const cfg = {
      cabinet: { code: 'AH01', group: 'mv' },
      eg: { name: 'EG-AH01-B' },
      devices: [{ name: 'EG-AH01-B', kind: 'eg' }, { name: 'CAM-AH01-B', kind: 'camera' }, { name: 'SAM-AH01-B', kind: 'sam' }],
    } as unknown as EgConfig
    const cs = new CapsService(cfg)
    ;(cs as unknown as { log: { log: () => void } }).log = { log: () => undefined }
    cs.set(off, null)
    check(cs.deviceEnabled('CAM-AH01-B'), 'CapsService 按 eg.yaml 取摄像机点表：测温区 unsupported 也照常连（cam.* 不归能力）')
    cs.set(cc, null)
    const row = { 'ir.max': 41.2, 'ir.R1.max': 40.1, 'cam.online': 4, 'cam.bitrate': 2048, 'dev.comm': 'ONLINE', q: '{}' }
    const kept = Object.keys(cs.uplinkValues('CAM-AH01-B', row))
    check(kept.join(',') === 'cam.online,cam.bitrate,dev.comm,q', `uplinkValues：一行里去掉 ir.*，其余照送（${kept.join('、')}）`)
    check(Object.keys(cs.uplinkValues('SAM-AH01-B', { 'us.amp': 25.8, 'env.t': 26.1, 'ir.t_max': 30 })).join(',') === 'env.t', 'SAM：局放待定、SAM 红外待定的不送，温湿度（已确认）照送')
    cs.set({ ...cc, caps: { ...cc.caps, thermalRegions: 'confirmed' } }, null)
    check(cs.uplinkValues('CAM-AH01-B', row) === row, '测温区改回已确认：整行原样送（缓存跟着清）')
  }

  console.log('8. 上送入队（真的 UplinkService，子站连不上也照样入队）：测温区待定 + 双光已确认 → cam.* 照常送、ir.* 不送')
  Date.now = realNow
  {
    const dir = mkdtempSync(join(tmpdir(), 'lsa-capsup-'))
    const cfg = {
      dir,
      cabinet: { code: 'AH01', group: 'mv' },
      unit: { id: '', code: 'AH01-B', at: '', index: 2 },
      eg: { name: 'EG-AH01-B', token: 'x', attrs: {} },
      station: { mqtt: 'mqtt://127.0.0.1:1', token: 'x' },
      local: { outbox: { maxAgeDays: 7, maxMb: 64, backfillRate: 2000 } },
      devices: [{ name: 'EG-AH01-B', kind: 'eg' }, { name: 'CAM-AH01-B', kind: 'camera', attrs: {} }],
    } as unknown as EgConfig
    const cs = new CapsService(cfg)
    ;(cs as unknown as { log: { log: () => void } }).log = { log: () => undefined }
    cs.set({ caps: { thermalRegions: 'pending', camVideo: 'confirmed' }, capKeys: { thermalRegions: ['CAM:ir.*'], camVideo: [] } }, null)
    let feed: ((d: string, e: { ts: number; values: Record<string, unknown> }[], own: boolean) => void) | null = null
    const bus = { onTelemetry: (fn: typeof feed) => (feed = fn), onAttributes: () => undefined } as unknown as BusService
    const meters = { toPrimary: (_d: string, v: Record<string, unknown>) => v } as unknown as MetersService
    const up = new UplinkService(cfg, bus, { write: () => undefined } as unknown as AuditService, cs, meters, { warmupOf: () => null } as unknown as QualityService)
    ;(up as unknown as { log: Record<string, () => void> }).log = { log: () => undefined, warn: () => undefined, error: () => undefined }
    up.onModuleInit()
    const ts = Date.now()
    feed!('CAM-AH01-B', [{ ts, values: { 'ir.max': 41.2, 'ir.R1.max': 40.1, 'cam.online': 4, 'cam.bitrate': 2048 } }], false)
    feed!('CAM-AH01-B', [{ ts: ts + 1, values: { 'ir.R2.max': 39 } }], false)
    feed!('CAM-AH01-B', [{ ts: ts + 2, values: { 'dev.comm': 'ONLINE', 'dev.link': 1 } }], true)
    const q = (up as unknown as { pending: { dev: string; kind: string; body: string }[] }).pending.filter(p => p.dev === 'CAM-AH01-B' && p.kind === 't').map(p => JSON.parse(p.body) as Record<string, unknown>)
    check(q.length === 2, `入队 2 行（只有 ir.* 的那行整行不送）：${q.map(x => Object.keys(x).join(',')).join(' | ')}`)
    check(!!q[0] && q[0]['cam.online'] === 4 && q[0]['cam.bitrate'] === 2048 && !('ir.max' in q[0]) && !('ir.R1.max' in q[0]), 'cam.online / cam.bitrate 照送，ir.max / ir.R1.max 不送')
    check(!!q[1] && q[1]['dev.comm'] === 'ONLINE' && q[1]['dev.link'] === 1, 'dev.comm / dev.link 照送（子站网关页不再显示离线）')
    up.onModuleDestroy()
    rmSync(dir, { recursive: true, force: true })
  }

  Date.now = realNow
  done()
}
void main().catch(e => {
  console.error(e)
  process.exit(1)
})
