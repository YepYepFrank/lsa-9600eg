/* 转换程序配置推出的「每台设备预期测点」（EG 0.6.2，全链路联调 W1）。
 *
 * 以前看护（质量码、dev.comm、到达率）按物模型：每台 SAM 都预期有温湿度、局放、弧光……
 * 同事按隔室分接时（A 只接温湿度，B 接局放 / 气体 / 弧光），另一台没接的量永远不来，两台 SAM 都一直 DEGRADED。
 * 现在以 EG 本机的转换程序配置为准：config/conv/sensors/*.yaml 里 enabled: true 的传感器，按它的 device 归到设备，
 * 预期测点 = 它 registers 里写的 key（同事的配置每个寄存器都写了 key；没写的按 type 兜底）。
 *
 * 退回物模型全量（返回 null 或某设备不在结果里）：
 *   - 没有 config/conv/sensors/（没启用过转换程序）、一个能读的 yaml 都没有；
 *   - 某台设备在 eg.yaml 里，但转换程序配置里没有传感器挂它（这台照旧按全量看护，没数据就照旧判离线）。
 * 方案二（子站在 eg.yaml 里下发每台设备的传感器清单）是长期正解，等现场布置定了再做。 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'

/** 寄存器没写 key 时按传感器类型兜底（同事 1.1.1 的驱动） */
const BY_TYPE: Record<string, string[]> = {
  temperature_humidity: ['env.t', 'env.rh'],
  partial_discharge: ['us.amp', 'us.cnt', 'us.type', 'us.level', 'tev.amp', 'tev.level', 'uhf.amp', 'uhf.level'],
  arc_light: ['uv.int'],
  smoke: ['smoke.ppm'],
  // 0.7.2：同事的 infrared.yaml 寄存器不写 key（按 base_address 连读）—— 以前不认识，红外打开了也不看护、485 清单里也漏了从站 1
  infrared: ['ir.t_max', 'ir.t_avg'],
}

/** 485 总线清单（0.17.4，舱室 EG 方案 §4）：打开的传感器各占一个从站地址。EG 作为自己的客户端属性 conv.bus 报给子站（JSON 串） */
export interface ConvBus {
  v: 1
  /** COM2（X26A 主板串口）或 USB（USB 转 485 模块） */
  port: string
  baud: number | null
  /** a 从站地址、t 传感器类型、n 中文名、dev 挂在哪台设备；按地址升序 */
  slaves: { a: number; t: string; n: string; dev: string }[]
}

/** 传感器类型的中文名（同事 1.1.1 的驱动） */
export const SENSOR_NAME: Record<string, string> = {
  infrared: '红外',
  partial_discharge: '局放',
  smoke: '气体',
  temperature_humidity: '温湿度',
  arc_light: '弧光',
}

/** 串口路径 → 接口名：主板串口 /dev/ttyS1 = COM2；USB 转 485 模块（/dev/ttyUSB*、/dev/serial/by-id/…）= USB */
export function busPort(serial: string | undefined): string {
  const s = (serial ?? '').trim()
  if (!s || s === '/dev/ttyS1') return 'COM2'
  if (/ttyUSB|ttyACM|serial\/by-id/.test(s)) return 'USB'
  const m = /ttyS(\d+)$/.exec(s)
  return m ? `COM${Number(m[1]) + 1}` : s
}

export interface ConvExpect {
  /** 设备名 → 预期测点 */
  byDevice: Map<string, Set<string>>
  /** 485 总线清单（只含打开的传感器） */
  bus: ConvBus
  /** 配置文件的签名（文件名 + 修改时间 + 大小），变了就重读 */
  sig: string
  /** 读不了的文件（文件名：原因） */
  errors: string[]
}

export function convSensorsDir(configDir: string): string {
  return resolve(configDir, 'conv', 'sensors')
}

/** 只算签名，不解析（定时看配置有没有改） */
export function convExpectSig(configDir: string): string {
  const dir = convSensorsDir(configDir)
  if (!existsSync(dir)) return ''
  try {
    return readdirSync(dir)
      .filter(f => /\.ya?ml$/.test(f))
      .sort()
      .map(f => {
        const s = statSync(resolve(dir, f))
        return `${f}:${s.mtimeMs}:${s.size}`
      })
      .join('|')
  } catch {
    return ''
  }
}

/** 转换程序 gateway.yaml 里的波特率（读不到为 null） */
function readBaud(configDir: string): number | null {
  try {
    const g = parse(readFileSync(resolve(configDir, 'conv', 'gateway.yaml'), 'utf8')) as { serial?: { baudrate?: unknown } } | null
    const b = Number(g?.serial?.baudrate)
    return Number.isFinite(b) && b > 0 ? b : null
  } catch {
    return null
  }
}

/** serial：宿主机上转换程序用的串口（compose 把 .env 的 EG_CONV_SERIAL 给 agent），只用来定接口名 */
export function loadConvExpect(configDir: string, serial: string | undefined = process.env['EG_CONV_SERIAL']): ConvExpect | null {
  const dir = convSensorsDir(configDir)
  if (!existsSync(dir)) return null
  const byDevice = new Map<string, Set<string>>()
  const slaves: ConvBus['slaves'] = []
  const errors: string[] = []
  let read = 0
  let files: string[]
  try {
    files = readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort()
  } catch {
    return null
  }
  for (const f of files) {
    let doc: { sensor?: Record<string, unknown>; registers?: Record<string, { key?: unknown }> }
    try {
      doc = (parse(readFileSync(resolve(dir, f), 'utf8')) ?? {}) as typeof doc
    } catch (e) {
      errors.push(`${f}：${(e as Error).message.split('\n')[0]}`)
      continue
    }
    read++
    const s = doc.sensor ?? {}
    if (s['enabled'] !== true) continue
    const device = typeof s['device'] === 'string' ? s['device'].trim() : ''
    if (!device) {
      errors.push(`${f}：打开了但没写 device`)
      continue
    }
    const keys = Object.values(doc.registers ?? {})
      .map(r => (r && typeof r.key === 'string' ? r.key.trim() : ''))
      .filter(Boolean)
    const type = typeof s['type'] === 'string' ? s['type'] : ''
    const list = keys.length ? keys : (BY_TYPE[type] ?? [])
    if (!list.length) {
      errors.push(`${f}：类型「${type || '?'}」没有 key，也不认识`)
      continue
    }
    let set = byDevice.get(device)
    if (!set) byDevice.set(device, (set = new Set()))
    for (const k of list) set.add(k)
    const a = Number(s['slave_id'])
    if (Number.isInteger(a) && a >= 1 && a <= 247) slaves.push({ a, t: type, n: SENSOR_NAME[type] ?? type, dev: device })
    else errors.push(`${f}：从站地址「${String(s['slave_id'] ?? '')}」不对（1–247）`)
  }
  if (!read) return null
  slaves.sort((p, q) => p.a - q.a)
  const bus: ConvBus = { v: 1, port: busPort(serial), baud: readBaud(configDir), slaves }
  return { byDevice, bus, sig: convExpectSig(configDir), errors }
}

/** 同一条总线上地址重复的：地址 → 「中文名（设备）」 */
export function busConflicts(bus: ConvBus | null | undefined): Map<number, string[]> {
  const by = new Map<number, string[]>()
  for (const s of bus?.slaves ?? []) by.set(s.a, [...(by.get(s.a) ?? []), `${s.n}（${s.dev}）`])
  for (const [a, l] of by) if (l.length < 2) by.delete(a)
  return by
}
