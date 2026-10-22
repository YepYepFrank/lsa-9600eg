/* 0.8.0 自检：转换程序 q 标 absent（装置报告这一路没装，内部 MQTT 格式 v0.8）与「必有」看能力（现场 AH01-B 读出 187）。
 *
 *   pnpm verify:absent-q
 *
 * 真的 QualityService / CapsService / WarmupService + 假总线 + 假预期测点（转换程序只开了局放）+ 可调的时钟（Date.now 换掉）。 */
import 'reflect-metadata'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EgConfig } from '@lsa-eg/config'
import type { BusService, DeviceLive } from './bus/bus.service.js'
import { CapsService } from './caps/caps.service.js'
import type { CapState } from './caps/caps.js'
import type { ConvExpectService } from './conv/conv-expect.service.js'
import { absentNotes, QualityService } from './quality/quality.service.js'
import { WarmupService } from './warmup/warmup.service.js'
import { check, done } from './verify/lib.js'

const DEV = 'SAM-AH01-B'
const PD = ['us.amp', 'us.cnt', 'us.type', 'us.level', 'tev.amp', 'tev.level', 'uhf.amp', 'uhf.level']
const ABSENT = JSON.stringify({ 'tev.amp': 'absent', 'tev.level': 'absent', 'uhf.amp': 'absent', 'uhf.level': 'absent' })

let clock = 1_800_000_000_000
const realNow = Date.now
Date.now = () => clock

function rig(caps: Record<string, CapState> | null) {
  const dir = mkdtempSync(join(tmpdir(), 'lsa-absent-'))
  const cfg = {
    dir,
    cabinet: { code: 'AH01', group: 'mv' },
    eg: { name: 'EG-AH01-B', attrs: {} },
    devices: [{ name: DEV, kind: 'sam', label: '', attrs: { room: '电缆室' } }],
  } as unknown as EgConfig
  let listener: ((dev: string, entries: { ts: number; values: Record<string, unknown> }[], own: boolean) => void) | null = null
  const live = new Map<string, DeviceLive>()
  const published: Record<string, unknown>[] = []
  const bus = { onTelemetry: (fn: typeof listener) => (listener = fn), publish: (_d: string, v: Record<string, unknown>) => published.push(v), live } as unknown as BusService
  const cs = new CapsService()
  if (caps) cs.set({ caps, capKeys: { pdUs: ['SAM:us.*'], tev: ['SAM:tev.*'], uhf: ['SAM:uhf.*'] } }, null)
  const expect = { expected: (n: string) => (n === DEV ? new Set(PD) : null), onChange: () => undefined } as unknown as ConvExpectService
  const q = new QualityService(cfg, bus, cs, new WarmupService(cfg, cs), expect)
  q.onModuleInit()
  const logs: string[] = []
  ;(q as unknown as { log: { log: (m: string) => void } }).log = { log: (m: string) => logs.push(m) }
  /** 局放一条（超声照常；q 给了就带上） */
  const send = (qv?: string) => listener!(DEV, [{ ts: clock, values: { 'us.amp': 25.8, 'us.cnt': 4, 'us.type': 1, 'us.level': 0, ...(qv === undefined ? {} : { q: qv }) } }], false)
  /** 每 3 s 一条，跑 sec 秒 */
  const run = (sec: number, qv?: string) => {
    for (let t = 0; t < sec; t += 3) {
      clock += 3000
      send(qv)
    }
  }
  const stop = () => {
    q.onModuleDestroy()
    rmSync(dir, { recursive: true, force: true })
  }
  return { q, cs, send, run, published, logs, stop }
}

async function main() {
  console.log('转换程序 q 标 absent / 必有量看能力 自检（v0.8，现场 AH01-B）\n')

  console.log('1. 对照：地电波、特高频读出 187 / 269，转换程序照旧不发、也不标（0.7.2 以前的转换程序）')
  {
    const r = rig(null)
    r.run(45)
    const qq = r.q.qualityOf(DEV)
    check(qq['tev.amp'] === 'invalid' && r.q.commOf(DEV).comm === 'DEGRADED', `tev.amp 判 invalid、设备 DEGRADED（以前的现象：${JSON.stringify(qq)}）`)
    r.stop()
  }

  console.log('2. 转换程序 q 标 absent（补丁 H）')
  {
    const r = rig(null)
    r.run(45, ABSENT)
    const qq = r.q.qualityOf(DEV)
    check(Object.keys(qq).length === 0, `tev.* / uhf.* 不算缺，q 里没有（${JSON.stringify(qq)}）`)
    check(r.q.commOf(DEV).comm === 'ONLINE', `设备 ONLINE（${r.q.commOf(DEV).comm}）`)
    check(r.q.absentOf(DEV).join(',') === 'tev.amp,tev.level,uhf.amp,uhf.level', `状态接口 absent：${r.q.absentOf(DEV).join('、')}`)
    ;(r.q as unknown as { evaluate: () => void }).evaluate()
    const sent = r.published.map(v => String(v['q'] ?? '')).filter(Boolean)
    check(sent.length > 0 && sent.every(s => !s.includes('absent')), `发出去的 q 不带 absent（子站不认）：${sent.at(-1)}`)
    check(r.logs.some(l => l.includes('读出 187 = 没装地电波') && l.includes('建议') && l.includes('「地电波」改成不支持')), `日志给建议：${r.logs.find(l => l.includes('地电波')) ?? '（没有）'}`)
    check(r.logs.some(l => l.includes('读出 269 = 没装特高频')), '特高频同样一句')

    console.log('3. 转换程序挂了：absent 过了新鲜度窗口不算数，照常判缺')
    r.run(75)
    check(r.q.absentOf(DEV).length === 0 && r.q.qualityOf(DEV)['tev.amp'] === 'invalid', `75 s 没再标（窗口 60 s）：tev.amp 又判 invalid（${r.q.qualityOf(DEV)['tev.amp']}）`)

    console.log('4. 地电波装好了：转换程序发读数、q 发 "{}"')
    for (let i = 0; i < 4; i++) {
      clock += 3000
      r.send('{}')
    }
    const live = (k: Record<string, unknown>) => (r.q as unknown as { take: (d: string, e: { ts: number; values: Record<string, unknown> }[], o: boolean) => void }).take(DEV, [{ ts: clock, values: k }], false)
    live({ 'tev.amp': 12.3, 'tev.level': 0, 'uhf.amp': 30, 'uhf.level': 0, q: '{}' })
    ;(r.q as unknown as { evaluate: () => void }).evaluate()
    check(Object.keys(r.q.qualityOf(DEV)).length === 0 && r.q.commOf(DEV).comm === 'ONLINE', `全部有效、ONLINE（${JSON.stringify(r.q.qualityOf(DEV))}）`)
    check(r.logs.some(l => l.includes('地电波：转换程序不再标没装')), '日志记一句「不再标没装」')
    r.stop()
  }

  console.log('5. 必有量看能力（子站 0.18.3 起地电波 / 特高频缺省 pending，S19 本站模型 confirmed）')
  {
    const r = rig({ pdUs: 'confirmed', tev: 'pending', uhf: 'unsupported' })
    r.run(45)
    const qq = r.q.qualityOf(DEV)
    check(!qq['tev.amp'] && !qq['uhf.amp'] && r.q.commOf(DEV).comm === 'ONLINE', `地电波待定、特高频不支持，一直没来：不算缺、ONLINE（${JSON.stringify(qq)}）`)
    r.stop()
  }
  {
    const r = rig({ pdUs: 'confirmed', tev: 'confirmed', uhf: 'unsupported' })
    r.run(45)
    const qq = r.q.qualityOf(DEV)
    check(qq['tev.amp'] === 'invalid' && !qq['uhf.amp'] && r.q.commOf(DEV).comm === 'DEGRADED', `地电波 confirmed、一直没来、也没标 absent：照旧判缺、DEGRADED（${JSON.stringify(qq)}）`)
    r.run(9, JSON.stringify({ 'tev.amp': 'absent', 'tev.level': 'absent' }))
    check(r.q.commOf(DEV).comm === 'ONLINE', `同一柜转换程序标了 absent：ONLINE（${r.q.commOf(DEV).comm}）`)
    r.stop()
  }
  {
    const r = rig({ pdUs: 'confirmed', tev: 'pending', uhf: 'unsupported' })
    const live = (k: Record<string, unknown>) => (r.q as unknown as { take: (d: string, e: { ts: number; values: Record<string, unknown> }[], o: boolean) => void }).take(DEV, [{ ts: clock, values: k }], false)
    live({ 'tev.amp': 12.3, 'tev.level': 0 })
    r.run(45)
    check(r.q.qualityOf(DEV)['tev.amp'] === 'invalid', `待定的地电波来过以后断了：照常判缺（${r.q.qualityOf(DEV)['tev.amp']}）—— 本柜装了就要看护`)
    r.stop()
  }

  console.log('6. 日志说法')
  const n1 = absentNotes(['tev.amp', 'tev.level'], [], () => 'confirmed')
  check(n1.length === 1 && n1[0]!.includes('建议') && n1[0]!.includes('tev.amp、tev.level 不发'), `confirmed：${n1[0]}`)
  const n2 = absentNotes(['tev.amp', 'tev.level'], [], () => 'pending')
  check(n2[0]!.includes('「待定」') && n2[0]!.includes('不用处理') && !n2[0]!.includes('建议'), `pending：${n2[0]}`)
  const n3 = absentNotes(['ir.t_max'], [], () => null)
  check(n3[0]!.includes('转换程序报 ir.t_max 没装') && n3[0]!.includes('「ir.t_max」改成不支持'), `别的量（通用说法）：${n3[0]}`)

  Date.now = realNow
  done()
}
void main().catch(e => {
  console.error(e)
  process.exit(1)
})
