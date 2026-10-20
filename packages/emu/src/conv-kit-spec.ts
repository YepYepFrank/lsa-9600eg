/* 转换程序测试套件（tools/conv-kit）的点表：从 @lsa/points 目录导出成 spec.json，lsa_check.py 按它校验。
 * 点表改了要重跑：pnpm conv-kit:spec（pack 时也会跑）。pnpm conv-kit:spec -- --check 只比对、不写：不一致退出 1（g1:verify 第 1 节调它）。
 * 只导出「转换程序该发 / 可以发 / 不许发」三类，供校验用；周期取设备实际刷新周期（expectedPeriodMs：局放 3 s），单位与目录一致。
 *
 * v0.7（格式文档 docs/EG内部MQTT格式.md v0.7，2026-10-13 转换程序联调）：
 *   - 每个量带能力 cap 与它在现场口径（production）下的状态 capState：不是 confirmed 的（局放类型 / 等级待定、地电波 / 特高频「本柜装了才发」）
 *     检查工具不报「一直没收到」，收到了给一条说明；
 *   - smoke.ppm（烟雾浓度）0.7.1 起在点目录的 SAM 里（能力 smokePpm 已确认）；独立颗粒物 PM6 取消，pm 种类不再导出（舱室方案 v0.9 §10）；
 *   - 各设备通用的「不要发」带原因（forbidWhy）：dev.warmup_s（0.17 预热由 EG 判）、dev.comm / dev.link。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATALOG, CATALOG_VERSION, DEVICE_STATUS, SOUTH, expectedPeriodMs, pointsOf, sourceOf, type PointDef } from '@lsa/points'
import { CAP_DEFAULT_PRODUCTION, CAP_LABEL, pendingText, type CapKey } from '@lsa/model'

type Kind = 'sam' | 'meter'
const KINDS: Kind[] = ['sam', 'meter']

interface Key {
  key: string
  label: string
  unit: string
  periodMs: number | null
  optional: boolean
  type: 'number' | 'string' | 'json' | 'bool'
  cap?: string
  capState?: string
  note?: string
}

const capNote = (cap: CapKey) => {
  const st = CAP_DEFAULT_PRODUCTION[cap]
  if (st === 'confirmed') return undefined
  const why = st === 'pending' ? pendingText(cap) : ''
  return `能力「${CAP_LABEL[cap]}」现场口径是「${st === 'pending' ? '待定' : '不支持'}」${why ? `（${why}）` : ''}：本柜装了才发，检查工具不报缺`
}

const toKey = (p: PointDef, optional = !!p.optional): Key => {
  const note = p.cap ? capNote(p.cap) : undefined
  return {
    key: p.key,
    label: p.label,
    unit: p.unit,
    periodMs: expectedPeriodMs(p),
    optional,
    type: p.json ? 'json' : (p.type ?? 'number'),
    ...(p.cap ? { cap: p.cap, capState: CAP_DEFAULT_PRODUCTION[p.cap] } : {}),
    ...(note ? { note } : {}),
  }
}

const devices: Record<string, { send: Key[]; forbid: string[] }> = {}
for (const kind of KINDS) {
  // 低压柜的相数最多，按 lv 展开就覆盖了其他柜型（电表 / SAM 的 key 现在都不按相展开）
  const pts = pointsOf(kind, 'lv')
  devices[kind] = {
    send: pts.filter(p => sourceOf(kind, p) === 'device').map(p => toKey(p)),
    forbid: pts.filter(p => sourceOf(kind, p) !== 'device').map(p => p.key),
  }
}

// 各下挂设备都能带的：通信状态（§6b，可选）、质量码（§6，可选）、南向统计（§6，要发就五个一起发）
const common = {
  send: [
    ...DEVICE_STATUS.filter(p => p.src === 'device' && p.key !== 'dev.comm').map(p => toKey(p, true)),
    { ...toKey(DEVICE_STATUS.find(p => p.key === 'q')!, true) },
    ...SOUTH.map(p => toKey(p, true)),
  ],
  forbid: [...new Set(['dev.comm', 'dev.link', ...DEVICE_STATUS.filter(p => p.src === 'eg' && p.key !== 'q').map(p => p.key)])],
  forbidWhy: {
    'dev.comm': '通信状态由 eg-agent 按你报的 dev.last_ok / fails 算（§6b），转换程序不要发',
    'dev.link': '设备链路由 eg-agent 算（§6b），转换程序不要发',
    'dev.warmup_s': '传感器预热由 EG 0.17 自己判（读数中断后恢复 / 主机刚开机），转换程序不要发；型号能读出预热状态时用 q 标 "warmup"（§6）',
  } as Record<string, string>,
}

// G4 起 SAM 不再报热像（改由摄像机）；老程序按 v0.1 发的这些 key 不会被识别。
// 0.18.1（S19 A4，能力 samIr）SAM 红外的 ir.t_max / ir.t_avg 恢复（点目录里有了，只显示、上送，不进温升 / 过温），这里只留还退役的
const retired = { sam: ['ir.rise', 'ir.box.*', 'ir.z*'] }

// EG 级信号（MQTT 格式 §5.4），设备名 EG-<柜号>；eg.* 自身指标是 eg-agent 发的
const eg = {
  send: [
    { key: 'sw.cb', label: '断路器分合位', unit: '', periodMs: 60_000, optional: true, type: 'number', enum: [1, 0, -1] },
    { key: 'sw.es', label: '接地刀位置', unit: '', periodMs: 60_000, optional: true, type: 'number', enum: [1, 0, -1] },
    { key: 'eg.power', label: '装置电源', unit: '', periodMs: 60_000, optional: true, type: 'number', enum: [0, 1] },
  ],
  forbid: CATALOG.eg.map(p => p.key),
}

const spec = {
  generatedFrom: `@lsa/points ${CATALOG_VERSION}`,
  format: 'EG 内部 MQTT 格式 v0.7',
  devices,
  common,
  retired,
  eg,
}

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/conv-kit/spec.json')
const text = JSON.stringify(spec, null, 2) + '\n'
if (process.argv.includes('--check')) {
  let now = ''
  try {
    now = readFileSync(out, 'utf8').replace(/\r\n/g, '\n')
  } catch {
    /* 没有文件 = 不一致 */
  }
  if (now === text) {
    console.log(`conv-kit spec.json 与点目录一致（@lsa/points ${CATALOG_VERSION}）`)
  } else {
    console.error(`conv-kit spec.json 与点目录不一致：跑 pnpm conv-kit:spec 重新导出（${out}）`)
    process.exit(1)
  }
} else {
  writeFileSync(out, text)
  console.log(`已写 ${out}（${KINDS.map(k => `${k} ${devices[k]!.send.length}`).join(' / ')}）`)
}
