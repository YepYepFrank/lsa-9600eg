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
}

export interface ConvExpect {
  /** 设备名 → 预期测点 */
  byDevice: Map<string, Set<string>>
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

export function loadConvExpect(configDir: string): ConvExpect | null {
  const dir = convSensorsDir(configDir)
  if (!existsSync(dir)) return null
  const byDevice = new Map<string, Set<string>>()
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
  }
  if (!read) return null
  return { byDevice, sig: convExpectSig(configDir), errors }
}
