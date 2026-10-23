/* 0.8.1 自检：开机第一次报的运行配置版本 cfg 以 applied-config.json 为准（现场 AH01-B 10-23：升级重启时子站时间线卡在
 * 「配置不一致 c-0321 → c-1023-1」，协调要求核 EG 开机报的是不是 eg.yaml 里写死的部署版本）。
 *
 *   pnpm verify:boot-cfg
 *
 * 真的 ApplyService（读配置目录的 applied-config.json）+ 真的 AttrsService + 假总线（记下发了哪些属性）。 */
import 'reflect-metadata'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EgConfig } from '@lsa-eg/config'
import { ApplyService } from './apply/apply.service.js'
import { AttrsService } from './attrs/attrs.service.js'
import type { AuditService } from './audit/audit.service.js'
import type { BusService } from './bus/bus.service.js'
import { CapsService } from './caps/caps.service.js'
import type { MetersService } from './meters/meters.service.js'
import type { LocalTbService } from './tb/local-tb.service.js'
import { check, done } from './verify/lib.js'

/** 起一套：eg.yaml 的 eg.attrs 写的是部署时的 c-0321；applied = applied-config.json 里的版本（null = 一次都没应用过） */
function boot(applied: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'lsa-bootcfg-'))
  if (applied) writeFileSync(join(dir, 'applied-config.json'), JSON.stringify({ version: applied, appliedAt: 1, by: 'x', hash: 'h', thresholds: {}, rules: [], extras: {} }))
  const cfg = {
    dir,
    cabinet: { code: 'AH01', group: 'mv' },
    unit: { id: '', code: 'AH01-B', at: '', index: 2 },
    eg: { name: 'EG-AH01-B', token: 'x', attrs: { ip: '192.168.0.196', cfg: 'c-0321', cfgWant: 'c-0321' } },
    devices: [],
  } as unknown as EgConfig
  const sent: { device: string; attrs: Record<string, unknown> }[] = []
  let onConnect: (() => void) | null = null
  const bus = {
    onConnect: (fn: () => void) => (onConnect = fn),
    publishAttributes: (device: string, attrs: Record<string, unknown>) => sent.push({ device, attrs }),
  } as unknown as BusService
  const tb = { available: false } as unknown as LocalTbService
  const caps = new CapsService()
  ;(caps as unknown as { log: { log: () => void } }).log = { log: () => undefined }
  const apply = new ApplyService(cfg, tb, bus, { write: () => undefined } as unknown as AuditService, caps, { set: () => undefined } as unknown as MetersService)
  const attrs = new AttrsService(cfg, bus, apply, tb)
  attrs.onModuleInit()
  onConnect!()
  const first = sent.find(s => s.device === 'EG-AH01-B' && 'cfg' in s.attrs)
  const stop = () => {
    clearInterval((apply as unknown as { timer: NodeJS.Timeout }).timer)
    rmSync(dir, { recursive: true, force: true })
  }
  return { first, stop }
}

function main() {
  console.log('开机报的运行配置版本 cfg（0.8.1，现场 AH01-B）\n')
  {
    const { first, stop } = boot('c-1023-1')
    check(first?.attrs['cfg'] === 'c-1023-1', `applied 是 c-1023-1、eg.yaml 写的是 c-0321：开机第一次报的就是 c-1023-1（${String(first?.attrs['cfg'])}）`)
    check(!!first && !('cfgWant' in first.attrs), 'eg.yaml 里的 cfgWant 不报（子站自己的量）')
    check(first?.attrs['ip'] === '192.168.0.196', 'eg.yaml 的别的属性照报')
    stop()
  }
  {
    const { first, stop } = boot(null)
    check(first?.attrs['cfg'] === 'c-0321', `一次都没应用过：才用 eg.yaml 里的 c-0321（${String(first?.attrs['cfg'])}）`)
    stop()
  }
  done()
}
main()
