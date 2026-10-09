/* 区域温升的环境温度来源（子站 0.11：SAM 清单与隔室解耦）自检（g4:verify 调；也能单独跑：node --import @swc-node/register/esm-register src/verify/derive-env.ts）。
 * 用假的总线与质量服务，不碰样机：
 *   R1 env 显式写了 SAM-X-B → 用 B 的 env.t；R2 env 字段不存在（老 eg.yaml）→ 回退第一台 SAM（A）；R3 env 为 "" → 不出 ir.R3.rise、q 标 invalid；
 *   ir.rise / ir.hot 只按算得出的区。 */
import { pathToFileURL } from 'node:url'
import type { EgConfig } from '@lsa-eg/config'
import { DeriveService } from '../derive/derive.service.js'

type Check = (ok: boolean, name: string, detail?: string) => unknown

export function checkDeriveEnv(check: Check): void {
  const now = Date.now()
  const published: Record<string, number> = {}
  const q: Record<string, string | null> = {}
  let handler: ((dev: string, entries: { ts: number; values: Record<string, unknown> }[], own: boolean) => void) | null = null
  const bus = {
    live: new Map([
      ['SAM-X-A', { telemetry: { 'env.t': { v: 25, ts: now } } }],
      ['SAM-X-B', { telemetry: { 'env.t': { v: 30, ts: now } } }],
    ]),
    publish: (_d: string, v: Record<string, number>) => Object.assign(published, v),
    onTelemetry: (fn: typeof handler) => (handler = fn),
  }
  const quality = { setDerived: (_d: string, k: string, v: string | null) => (q[k] = v), qualityOf: () => ({ ...q }) }
  const cfg = {
    cabinet: { rated: 630 },
    local: { camera: { riseToleranceS: 15 } },
    devices: [
      { name: 'SAM-X-A', kind: 'sam', attrs: {} },
      { name: 'SAM-X-B', kind: 'sam', attrs: {} },
      { name: 'CAM-X', kind: 'camera', attrs: { regions: { R1: { env: 'SAM-X-B' }, R2: { label: '无 env 字段' }, R3: { env: '' } } } },
    ],
  } as unknown as EgConfig
  const svc = new DeriveService(cfg, bus as never, quality as never, { ratio: () => ({ ct: 1, pt: 1 }) } as never)
  svc.onModuleInit()
  handler!('CAM-X', [{ ts: now, values: { 'ir.R1.max': 50, 'ir.R2.max': 40, 'ir.R3.max': 70 } }], false)
  check(published['ir.R1.rise'] === 20, `R1 env 显式写 SAM-X-B：温升 = 50 − 30 = ${published['ir.R1.rise']}`)
  check(published['ir.R2.rise'] === 15, `R2 没有 env 字段（老 eg.yaml）：回退第一台 SAM-X-A，温升 = 40 − 25 = ${published['ir.R2.rise']}`)
  check(!('ir.R3.rise' in published) && q['ir.R3.rise'] === 'invalid', `R3 env 为 ""：不出温升（${'ir.R3.rise' in published ? '出了' : '没出'}），质量码 ${q['ir.R3.rise']}`)
  check(published['ir.rise'] === 20 && published['ir.hot'] === 1, `汇总只按算得出的区：ir.rise ${published['ir.rise']}、ir.hot R${published['ir.hot']}（R3 最高温 70 但没有温升，不算）`)
  check(published['ir.rmax'] === 70 && published['ir.dmax'] === 30, `最高温与区间温差照常含 R3：ir.rmax ${published['ir.rmax']}、ir.dmax ${published['ir.dmax']}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let fail = 0
  checkDeriveEnv((ok, name, detail) => {
    if (!ok) fail++
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  —— ${detail}` : ''}`)
  })
  process.exit(fail ? 1 : 0)
}
