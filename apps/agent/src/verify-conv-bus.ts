/* 0.17.4 485 总线清单自检（舱室 EG 方案 §4）：从转换程序配置推出的 conv.bus，与报给子站的客户端属性。
 *
 *   pnpm conv-bus:verify
 *
 *   1. 只列打开的传感器，按地址升序；中文名；波特率取 conv/gateway.yaml
 *   2. 接口名：/dev/ttyS1 = COM2，USB 转 485 = USB，没给 = COM2
 *   3. 地址不对的记进 errors；地址重复 busConflicts 给出
 *   4. ConvExpectService：连上总线报 EG 的 conv.bus；配置改了再报；没有转换程序配置报空清单 */
import 'reflect-metadata'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EgConfig } from '@lsa-eg/config'
import { busConflicts, busPort, loadConvExpect } from '@lsa-eg/config/conv-expect'
import type { BusService } from './bus/bus.service.js'
import { ConvExpectService } from './conv/conv-expect.service.js'

let pass = 0
let fail = 0
function check(ok: boolean, what: string) {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? '✓' : '✗'} ${what}`)
}

function sensorYaml(type: string, device: string, enabled: boolean, slave: number | string, key: string): string {
  return ['sensor:', `  type: "${type}"`, `  device: "${device}"`, `  slave_id: ${slave}`, `  enabled: ${enabled}`, 'registers:', '  r0:', '    address: 0x0000', `    key: "${key}"`, ''].join('\n')
}

console.log('485 总线清单自检（转换程序配置 → conv.bus）\n')
const dir = mkdtempSync(join(tmpdir(), 'lsa-bus-'))
const sensors = join(dir, 'conv', 'sensors')
mkdirSync(sensors, { recursive: true })
const put = (f: string, s: string) => writeFileSync(join(sensors, f), s)
put('arc_light.yaml', sensorYaml('arc_light', 'SAM-AH99-B', true, 5, 'uv.int'))
put('pd.yaml', sensorYaml('partial_discharge', 'SAM-AH99-B', true, 2, 'us.amp'))
put('temperature.yaml', sensorYaml('temperature_humidity', 'SAM-AH99-A', true, 4, 'env.t'))
put('infrared.yaml', sensorYaml('infrared', 'SAM-AH99-B', false, 1, 'ir.max'))
writeFileSync(join(dir, 'conv', 'gateway.yaml'), 'serial:\n  port: "/dev/ttyS1"\n  baudrate: 9600\n')

try {
  console.log('1. 清单')
  const ce = loadConvExpect(dir, '/dev/ttyS1')
  const s = ce?.bus.slaves ?? []
  check(s.map(x => x.a).join(',') === '2,4,5', `只列打开的、按地址升序（${s.map(x => x.a).join(',')}）`)
  check(s[0]?.n === '局放' && s[1]?.n === '温湿度' && s[2]?.n === '弧光' && s[0]?.dev === 'SAM-AH99-B', '中文名与挂的设备')
  check(ce?.bus.baud === 9600 && ce.bus.port === 'COM2' && ce.bus.v === 1, '波特率取 gateway.yaml、接口 COM2')

  console.log('2. 接口名')
  check(busPort('/dev/ttyS1') === 'COM2' && busPort(undefined) === 'COM2' && busPort('') === 'COM2', '/dev/ttyS1 / 没给 → COM2')
  check(busPort('/dev/serial/by-id/usb-FTDI-if00-port0') === 'USB' && busPort('/dev/ttyUSB0') === 'USB', 'USB 转 485 → USB')
  check(busPort('/dev/ttyS0') === 'COM1', '/dev/ttyS0 → COM1')

  console.log('3. 错误与重复')
  put('gas.yaml', sensorYaml('smoke', 'SAM-AH99-B', true, 300, 'smoke.ppm'))
  const bad = loadConvExpect(dir, '/dev/ttyS1')
  check(!!bad?.errors.some(e => e.startsWith('gas.yaml') && e.includes('300')) && bad.bus.slaves.length === 3, '地址 300 记进 errors、不进清单（测点照常预期）')
  put('gas.yaml', sensorYaml('smoke', 'SAM-AH99-B', true, 5, 'smoke.ppm'))
  const dup = busConflicts(loadConvExpect(dir, '/dev/ttyS1')?.bus)
  check(dup.get(5)?.length === 2, `地址 5 重复给出（${dup.get(5)?.join('、')}）`)
  put('gas.yaml', sensorYaml('smoke', 'SAM-AH99-B', true, 3, 'smoke.ppm'))

  console.log('4. 报给子站')
  const pub: { dev: string; v: Record<string, unknown> }[] = []
  let onConn: (() => void) | null = null
  const bus = { publishAttributes: (dev: string, v: Record<string, unknown>) => pub.push({ dev, v }), onConnect: (fn: () => void) => (onConn = fn) } as unknown as BusService
  const cfg = { dir, eg: { name: 'EG-AH99' }, devices: [] } as unknown as EgConfig
  const svc = new ConvExpectService(cfg, bus)
  svc.onModuleInit()
  check(pub.length === 0, '构造时不报（总线还没连上）')
  onConn!()
  const last = () => JSON.parse(String(pub.at(-1)?.v['conv.bus'] ?? '{}')) as { slaves?: { a: number }[] }
  check(pub.at(-1)?.dev === 'EG-AH99' && last().slaves?.map(x => x.a).join(',') === '2,3,4,5', '连上总线：EG 的 conv.bus 带全部打开的传感器')
  put('pd.yaml', sensorYaml('partial_discharge', 'SAM-AH99-B', false, 2, 'us.amp'))
  const n = pub.length
  svc.reload()
  check(pub.length === n + 1 && last().slaves?.map(x => x.a).join(',') === '3,4,5', '配置改了（局放关掉）马上再报')
  check(svc.busList()?.slaves.length === 3, 'busList() 给状态接口用')
  svc.onModuleDestroy()

  const empty = mkdtempSync(join(tmpdir(), 'lsa-bus-0-'))
  const pub0: Record<string, unknown>[] = []
  const svc0 = new ConvExpectService({ dir: empty, eg: { name: 'EG-AH98' }, devices: [] } as unknown as EgConfig, {
    publishAttributes: (_d: string, v: Record<string, unknown>) => pub0.push(v),
    onConnect: (fn: () => void) => fn(),
  } as unknown as BusService)
  svc0.onModuleInit()
  check(svc0.busList() === null && JSON.parse(String(pub0[0]?.['conv.bus'])).slaves.length === 0, '没有转换程序配置：busList() 为 null，报空清单')
  svc0.onModuleDestroy()
  rmSync(empty, { recursive: true, force: true })
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(`\n${fail ? '✗' : '✓'} ${pass} 过 / ${fail} 不过`)
process.exit(fail ? 1 : 0)
