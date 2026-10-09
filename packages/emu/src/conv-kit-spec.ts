/* 转换程序测试套件（tools/conv-kit）的点表：从 @lsa/points 目录导出成 spec.json，lsa_check.py 按它校验。
 * 点表改了要重跑：pnpm conv-kit:spec（pack 时也会跑）。
 * 只导出「转换程序该发 / 可以发 / 不许发」三类，供校验用；周期、单位与目录一致。 */
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATALOG, CATALOG_VERSION, DEVICE_STATUS, SOUTH, periodMs, pointsOf, sourceOf, type PointDef } from '@lsa/points'

type Kind = 'sam' | 'meter' | 'pm'
const KINDS: Kind[] = ['sam', 'meter', 'pm']

interface Key { key: string; label: string; unit: string; periodMs: number | null; optional: boolean; type: 'number' | 'string' | 'json' | 'bool' }

const toKey = (p: PointDef, optional = !!p.optional): Key => ({
  key: p.key, label: p.label, unit: p.unit, periodMs: periodMs(p.period), optional,
  type: p.json ? 'json' : (p.type ?? 'number'),
})

const devices: Record<string, { send: Key[]; forbid: string[] }> = {}
for (const kind of KINDS) {
  // 低压柜的相数最多，按 lv 展开就覆盖了其他柜型（电表 / SAM / 颗粒物的 key 现在都不按相展开）
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
  forbid: ['dev.comm', 'dev.link'],
}

// G4 起 SAM 不再报热像（改由摄像机）；老程序按 v0.1 发的这些 key 不会被识别
const retired = { sam: ['ir.t_max', 'ir.t_avg', 'ir.rise', 'ir.box.*', 'ir.z*'] }

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
  format: 'EG 内部 MQTT 格式 v0.4',
  devices, common, retired, eg,
}

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/conv-kit/spec.json')
writeFileSync(out, JSON.stringify(spec, null, 2) + '\n')
console.log(`已写 ${out}（${KINDS.map(k => `${k} ${devices[k]!.send.length}`).join(' / ')}）`)
