/* 0.6.2 预期测点自检（全链路联调 W1 / W2）：看护按 EG 本机转换程序配置（config/conv/sensors/*.yaml）推出的预期测点。
 *
 *   pnpm conv-expect:verify
 *
 * 真的 ConvExpectService / QualityService / SouthService + 假总线 + 假时钟（Date.now 换成可推进的）。
 *   1. 按隔室分接：A 只接温湿度，B 接局放 / 气体 / 弧光 —— 两台都 ONLINE、q 为空、A 的到达率按 10 s 档算 ≈ 100 %
 *      （对照：不读转换程序配置的老口径，两台都 DEGRADED，A 的到达率 0 %）
 *   2. 弧光从 B 改挂到 A（配置改了，agent 不重启）：B 上留下的 uv.int 照常过期成 invalid 进 q（W2），但 B 仍 ONLINE；
 *      A 的到达率改按 2 s 档重新起算
 *   3. 退回老口径：没有 config/conv/sensors/；某台设备没有传感器挂它
 *   4. 配置有错：读不了的 yaml、eg.yaml 里没有的设备名 */
import 'reflect-metadata'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EgConfig } from '@lsa-eg/config'
import { loadConvExpect } from '@lsa-eg/config/conv-expect'
import type { BusService, DeviceLive } from './bus/bus.service.js'
import { CapsService } from './caps/caps.service.js'
import { ConvExpectService } from './conv/conv-expect.service.js'
import { QualityService } from './quality/quality.service.js'
import { SouthService } from './south/south.service.js'
import { WarmupService } from './warmup/warmup.service.js'
import { check, done } from './verify/lib.js'

const A = 'SAM-AH99-A'
const B = 'SAM-AH99-B'

/** 同事配置的样子：sensor 段 + registers 里每个寄存器写 key */
function sensorYaml(type: string, device: string, enabled: boolean, keys: string[]): string {
  return [
    'sensor:',
    `  name: "${type}"`,
    `  type: "${type}"`,
    `  device: "${device}"        # 设备名 (与 eg.yaml 一致)`,
    '  slave_id: 1',
    `  enabled: ${enabled}`,
    'registers:',
    ...keys.flatMap((k, i) => [`  r${i}:`, `    address: 0x000${i}`, `    key: "${k}"`]),
    '',
  ].join('\n')
}
const PD_KEYS = ['us.amp', 'us.cnt', 'us.type', 'us.level', 'tev.amp', 'tev.level', 'uhf.amp', 'uhf.level']

async function main() {
  console.log('预期测点自检（转换程序配置 → 质量码 / dev.comm / 到达率）\n')
  const realNow = Date.now
  let T = realNow()
  Date.now = () => T

  const dir = mkdtempSync(join(tmpdir(), 'lsa-expect-'))
  const sensors = join(dir, 'conv', 'sensors')
  mkdirSync(sensors, { recursive: true })
  const put = (f: string, s: string) => writeFileSync(join(sensors, f), s)
  put('temperature.yaml', sensorYaml('temperature_humidity', A, true, ['env.rh', 'env.t']))
  put('pd.yaml', sensorYaml('partial_discharge', B, true, PD_KEYS))
  put('gas.yaml', sensorYaml('smoke', B, true, ['smoke.ppm']))
  put('arc_light.yaml', sensorYaml('arc_light', B, true, ['uv.int']))
  put('infrared.yaml', sensorYaml('infrared', B, false, []))
  const cfg = {
    dir,
    cabinet: { code: 'AH99', group: 'mv' },
    eg: { name: 'EG-AH99', attrs: {} },
    devices: [
      { name: A, kind: 'sam', label: '', attrs: { room: '断路器室' } },
      { name: B, kind: 'sam', label: '', attrs: { room: '电缆室' } },
    ],
  } as unknown as EgConfig

  type L = (dev: string, entries: { ts: number; values: Record<string, unknown> }[], own: boolean) => void
  const listeners: L[] = []
  const live = new Map<string, DeviceLive>()
  const bus = { onTelemetry: (fn: L) => listeners.push(fn), publish: () => undefined, live } as unknown as BusService
  const caps = new CapsService()
  const expect = new ConvExpectService(cfg)
  const q = new QualityService(cfg, bus, caps, new WarmupService(cfg, caps), expect)
  const south = new SouthService(cfg, bus, expect)
  // 对照：老口径（不读转换程序配置）
  const qOld = new QualityService(cfg, bus, caps, new WarmupService(cfg, caps))
  const southOld = new SouthService(cfg, bus)
  for (const s of [q, south, qOld, southOld]) s.onModuleInit()

  /** 按各路周期发数据，推进 secs 秒：温湿度 / 烟雾 10 s、局放 3 s、弧光 2 s；where 给每一路挂在哪台 */
  const run = (secs: number, where: { env: string; pd: string; gas: string; arc: string }) => {
    for (let i = 0; i < secs; i++) {
      T += 1000
      const s = Math.round(T / 1000)
      const send = (dev: string, values: Record<string, unknown>) => listeners.forEach(fn => fn(dev, [{ ts: T, values }], false))
      if (s % 10 === 0) send(where.env, { 'env.t': 25, 'env.rh': 50 })
      if (s % 10 === 5) send(where.gas, { 'smoke.ppm': 6 })
      if (s % 3 === 0) send(where.pd, Object.fromEntries(PD_KEYS.map(k => [k, 1])))
      if (s % 2 === 0) send(where.arc, { 'uv.int': 0.03 })
    }
  }
  const qOf = (svc: QualityService, d: string) => Object.keys(svc.qualityOf(d, T))

  try {
    console.log('1. 按隔室分接：A 只接温湿度，B 接局放 / 气体 / 弧光')
    const ea = expect.expected(A)
    const eb = expect.expected(B)
    check(!!ea && [...ea].sort().join(',') === 'env.rh,env.t', `A 预期测点 = env.t、env.rh（${ea ? [...ea].join(', ') : 'null'}）`)
    check(!!eb && eb.has('uv.int') && eb.has('us.amp') && eb.has('smoke.ppm') && !eb.has('env.t'), `B 预期测点 = 局放 + 烟雾 + 弧光，没有温湿度（${eb ? eb.size : 0} 个）`)
    run(180, { env: A, pd: B, gas: B, arc: B })
    let ca = q.commOf(A, T)
    let cb = q.commOf(B, T)
    check(ca.comm === 'ONLINE' && cb.comm === 'ONLINE', `两台都 ONLINE（A ${ca.comm}、B ${cb.comm}）`)
    check(!qOf(q, A).length && !qOf(q, B).length, `q 都为空（A ${JSON.stringify(q.qualityOf(A, T))}、B ${JSON.stringify(q.qualityOf(B, T))}）`)
    check(ca.fails === 0, `A 的 fails 按 10 s 周期算：0（${ca.fails}）`)
    const ra = south.rowOf(A, T)
    check(!!ra && ra.rate !== null && ra.rate >= 95, `A 到达率按 10 s 档：${ra?.rate} %（应到 ${ra?.req}）`)
    const oa = qOld.commOf(A, T)
    const ob = qOld.commOf(B, T)
    check(oa.comm === 'DEGRADED' && ob.comm === 'DEGRADED', `对照老口径：两台都 DEGRADED（A ${oa.comm}，缺 ${qOf(qOld, A).length} 个量；B ${ob.comm}，缺 ${qOf(qOld, B).join(', ')}）`)
    check(southOld.rowOf(A, T)?.rate === 0, `对照老口径：A 到达率 ${southOld.rowOf(A, T)?.rate} %（按 2 s 弧光档）`)

    console.log('2. 弧光从 B 改挂到 A（agent 不重启）')
    put('arc_light.yaml', sensorYaml('arc_light', A, true, ['uv.int']) + '# moved\n')
    check(expect.reload(), '配置签名变了，重读')
    check(!!expect.expected(A)?.has('uv.int') && !expect.expected(B)?.has('uv.int'), 'uv.int 现在预期在 A、不在 B')
    run(120, { env: A, pd: B, gas: B, arc: A })
    ca = q.commOf(A, T)
    cb = q.commOf(B, T)
    const qb = q.qualityOf(B, T)
    check(qb['uv.int'] === 'invalid', `B 上留下的 uv.int 过期成 invalid、照常进 q（W2，子站据此给最后值打标记）：${JSON.stringify(qb)}`)
    check(cb.comm === 'ONLINE', `但 B 不因此 DEGRADED：${cb.comm}`)
    check(ca.comm === 'ONLINE' && !qOf(q, A).length, `A 接上弧光后 ONLINE、q 为空（${ca.comm}，${JSON.stringify(q.qualityOf(A, T))}）`)
    const ra2 = south.rowOf(A, T)
    check(!!ra2 && ra2.req >= 55 && ra2.req <= 60 && (ra2.rate ?? 0) >= 95, `A 到达率改按 2 s 档、窗口重新起算：应到 ${ra2?.req}、${ra2?.rate} %`)

    console.log('3. 退回老口径')
    const empty = mkdtempSync(join(tmpdir(), 'lsa-expect-none-'))
    const e0 = new ConvExpectService({ ...cfg, dir: empty } as EgConfig)
    check(e0.expected(A) === null && e0.expected(B) === null, '没有 config/conv/sensors/：两台都按物模型全量（expected = null）')
    rmSync(empty, { recursive: true, force: true })
    put('temperature.yaml', sensorYaml('temperature_humidity', A, false, ['env.rh', 'env.t']))
    put('arc_light.yaml', sensorYaml('arc_light', B, true, ['uv.int']))
    expect.reload()
    check(expect.expected(A) === null && !!expect.expected(B), 'A 上没有打开的传感器了：A 按物模型全量，B 照旧按配置')

    console.log('4. 配置有错')
    put('bad.yaml', 'sensor: [这不是\n  合法: yaml')
    put('other.yaml', sensorYaml('smoke', 'SAM-AH98-B', true, ['smoke.ppm']))
    const ce = loadConvExpect(dir)
    check(!!ce && ce.errors.some(e => e.startsWith('bad.yaml')), `读不了的文件记进 errors，其余照读（${ce?.errors.join('；')}）`)
    check(!!ce?.byDevice.has('SAM-AH98-B'), '不在 eg.yaml 里的设备名照样读出来（ConvExpectService 打警告：数据进不了本地 TB）')

    console.log('5. 红外打开（同事的 infrared.yaml 寄存器不写 key，0.7.2）')
    put('infrared.yaml', 'sensor:\n  name: "infrared"\n  type: "infrared"\n  device: "' + B + '"\n  slave_id: 1\n  enabled: true\nregisters:\n  base_address: 0x004F\n  register_count: 3\n  scale: 0.1\n')
    const ci = loadConvExpect(dir)
    const ib = ci?.byDevice.get(B)
    check(!!ib && ib.has('ir.t_max') && ib.has('ir.t_avg') && !ci!.errors.some(e => e.startsWith('infrared.yaml')), `按类型兜底：B 预期测点多了 ir.t_max、ir.t_avg，不报「不认识」（${ci?.errors.join('；') || '无错'}）`)
    check(!!ci?.bus.slaves.some(s => s.a === 1 && s.t === 'infrared' && s.dev === B), `485 清单（conv.bus）里有红外从站 1（${ci?.bus.slaves.map(s => `${s.a} ${s.n}`).join('，')}）`)

    console.log('6. 0.19.0：本项目局放只有超声，地电波 / 特高频不进预期测点（同事的 pd.yaml 照样写着它们的 key）')
    put('pd2.yaml', sensorYaml('partial_discharge', 'SAM-AH98-C', true, ['us.amp', 'us.cnt', 'us.type', 'us.level', 'tev.amp', 'tev.level', 'uhf.amp', 'uhf.level']))
    const cp = loadConvExpect(dir)?.byDevice.get('SAM-AH98-C')
    check(!!cp && [...cp].sort().join(',') === 'us.amp,us.cnt,us.level,us.type', `只留超声四个（${cp ? [...cp].join('、') : '没有'}）`)
  } finally {
    for (const s of [q, south, qOld, southOld, expect]) s.onModuleDestroy()
    Date.now = realNow
    rmSync(dir, { recursive: true, force: true })
  }
  done()
}
void main().catch(e => {
  console.error(e)
  process.exit(1)
})
