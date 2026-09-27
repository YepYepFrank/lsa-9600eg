/* EG 自身指标 eg.*（接入规范 §6.5），每 5 s 发到本机总线 lsa/EG-<柜号>/telemetry，
 * 由 IoT Gateway 的自定义连接器 LsaSelfConnector 经网关自己的会话上送（deploy/tb-gateway/extensions/lsa）。
 *
 * 子站靠 EG 设备的数据判「在线」，所以这一路不能停（I 阶段起由上送服务送到子站；本地也照发，本地 TB 与本地页用）；
 * agent 停了时 LsaSelfConnector 自己补发 eg.state=degraded 维持在线（评审记录 G0-4）。
 *
 *   eg.state        online / degraded（有下挂设备整台失效，来自质量码看护）
 *   eg.lat eg.loss  到子站的 TCP 建连时延 / 失败率（连子站 TB 的 MQTT 口，即上送走的口；ICMP 要 root，不用）
 *   eg.clk_offset   本机时钟 − 时钟源，SNTP 每分钟测一次（local.yaml ntp.server，空 = 子站主机）
 *   eg.cpu eg.mem eg.ssd       CPU、内存、数据分区占用
 *   eg.temp         机内温度：/sys/class/thermal 与 hwmon 里最高的一个
 *   eg.up_kbps      上行网口发送速率（/proc/net/dev）；读不到网卡计数时退回上送服务实际发出的字节
 * 取不到的不发（Windows 开发机上 temp / up_kbps 没有；eg.volt、eg.ssd_health X26A 上无传感器 / 要 smartctl，G6 再看）。 */
import { createSocket } from 'node:dgram'
import { readdirSync, readFileSync, statfsSync } from 'node:fs'
import { connect } from 'node:net'
import { cpus, freemem, totalmem } from 'node:os'
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { BusService } from '../bus/bus.service.js'
import { QualityService } from '../quality/quality.service.js'
import { UplinkService } from '../uplink/uplink.service.js'

/** 规范的 EG 档：5 s */
const PERIOD_MS = 5_000
/** 到子站的探测：连上送用的子站 MQTT 口（eg.yaml station.mqtt，没配按 1883）；留最近 12 次（1 分钟）算失败率 */
const DEFAULT_PROBE_PORT = 1883
const PROBE_WINDOW = 12
const NTP_EVERY_MS = 60_000

@Injectable()
export class SelfService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('EG 自身')
  private timers: NodeJS.Timeout[] = []
  private lastCpu = cpuTimes()
  private lastTx: { bytes: number; at: number } | null = null
  private readonly probes: (number | null)[] = []
  private clkOffset: number | null = null
  private clkAt = 0
  /** 调试：暂停发送到这个时刻（自检用来模拟 agent 停掉，EG_DEBUG=1 才开放） */
  pausedUntil = 0

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly bus: BusService,
    private readonly quality: QualityService,
    private readonly uplink: UplinkService,
  ) {}

  onModuleInit(): void {
    this.timers.push(
      setInterval(() => {
        void this.probe()
        if (Date.now() >= this.pausedUntil) this.bus.publish(this.cfg.eg.name, this.sample())
      }, PERIOD_MS),
    )
    const ntp = () =>
      void sntpOffset(this.ntpServer())
        .then(o => {
          this.clkOffset = o
          this.clkAt = Date.now()
        })
        .catch(e => {
          if (this.clkAt === 0 || Date.now() - this.clkAt > 5 * NTP_EVERY_MS) this.clkOffset = null
          this.log.warn(`对时测量失败（${this.ntpServer()}）：${(e as Error).message}`)
        })
    ntp()
    this.timers.push(setInterval(ntp, NTP_EVERY_MS))
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t)
  }

  /** 到子站的探测：最近一次时延、近 1 分钟失败率 */
  uplinkProbe(): { host: string; port: number; latMs: number | null; lossPct: number | null } {
    const ok = this.probes.filter((x): x is number => x !== null)
    return {
      ...this.probeTarget(),
      latMs: this.probes.length && this.probes.at(-1) !== null ? Math.round(this.probes.at(-1)!) : null,
      lossPct: this.probes.length ? round((1 - ok.length / this.probes.length) * 100) : null,
    }
  }

  clock(): { server: string; offsetMs: number | null; measuredAt: number | null } {
    return { server: this.ntpServer(), offsetMs: this.clkOffset, measuredAt: this.clkAt || null }
  }

  /** 探测目标：子站上送口（station.mqtt），没配就是子站主机的 1883 */
  probeTarget(): { host: string; port: number } {
    try {
      if (this.cfg.station.mqtt) {
        const u = new URL(this.cfg.station.mqtt)
        return { host: u.hostname, port: Number(u.port || (u.protocol === 'mqtts:' ? 8883 : 1883)) }
      }
    } catch {
      /* 地址写错时退回子站主机 */
    }
    return { host: this.cfg.sp.host, port: DEFAULT_PROBE_PORT }
  }

  ntpServer(): string {
    return this.cfg.local.ntp.server || this.cfg.sp.host
  }

  sample(): Record<string, unknown> {
    const now = cpuTimes()
    const busy = now.busy - this.lastCpu.busy
    const all = now.all - this.lastCpu.all
    this.lastCpu = now
    const ok = this.probes.filter((x): x is number => x !== null)
    return {
      'eg.state': this.quality.deadDevices().length ? 'degraded' : 'online',
      'eg.lat': ok.length ? Math.round(median(ok.slice(-3))) : null,
      'eg.loss': this.probes.length ? round((1 - ok.length / this.probes.length) * 100) : null,
      'eg.clk_offset': this.clkOffset,
      'eg.cpu': all > 0 ? round((busy / all) * 100) : 0,
      'eg.mem': round((1 - freemem() / totalmem()) * 100),
      'eg.ssd': diskUsedPct(this.cfg.dir),
      'eg.temp': boardTemp(),
      'eg.up_kbps': this.upKbps(),
      // 上送状态（I2，EG独立TB调整方案 §8.1）：子站判补传中、积压、丢失都靠这几个
      ...this.uplink.metrics(),
    }
  }

  /** 到子站上送口（station.mqtt，现场 8883）的 TCP 建连时延（ms），连不上为 null */
  private async probe(): Promise<void> {
    const t0 = performance.now()
    const r = await new Promise<number | null>(res => {
      const s = connect({ ...this.probeTarget(), timeout: 2000 })
      s.once('connect', () => {
        res(performance.now() - t0)
        s.destroy()
      })
      s.once('timeout', () => {
        res(null)
        s.destroy()
      })
      s.once('error', () => res(null))
    })
    this.probes.push(r)
    if (this.probes.length > PROBE_WINDOW) this.probes.shift()
  }

  /** 上行网口的发送速率；读不到网卡计数（非 Linux、网口找不到）时退回上送服务实际发出的字节（遥测 MQTT + 告警事件） */
  private upKbps(): number | null {
    const iface = this.cfg.local.net.uplink || defaultIface()
    const bytes = iface ? txBytes(iface) : null
    if (bytes === null) return this.uplink.sentKbps()
    const at = Date.now()
    const last = this.lastTx
    this.lastTx = { bytes, at }
    if (!last || at <= last.at || bytes < last.bytes) return null
    return round(((bytes - last.bytes) * 8) / (at - last.at))
  }
}

function cpuTimes(): { busy: number; all: number } {
  let busy = 0
  let all = 0
  for (const c of cpus()) {
    const t = c.times
    const sum = t.user + t.nice + t.sys + t.idle + t.irq
    all += sum
    busy += sum - t.idle
  }
  return { busy, all }
}

/** 数据所在分区的占用 %（EG 上是 SSD） */
function diskUsedPct(path: string): number | null {
  try {
    const s = statfsSync(path)
    return round((1 - s.bavail / s.blocks) * 100)
  } catch {
    return null
  }
}

/** 机内温度 ℃：thermal_zone 与 hwmon（J1900 的 coretemp 在 hwmon 里）中最高的一个 */
function boardTemp(): number | null {
  const vals: number[] = []
  const read = (p: string) => {
    try {
      const v = Number(readFileSync(p, 'utf8').trim())
      if (Number.isFinite(v) && v > 0) vals.push(v / 1000)
    } catch {
      /* 没有就算了 */
    }
  }
  try {
    for (const z of readdirSync('/sys/class/thermal')) if (z.startsWith('thermal_zone')) read(`/sys/class/thermal/${z}/temp`)
  } catch {
    /* 非 Linux */
  }
  try {
    for (const h of readdirSync('/sys/class/hwmon'))
      for (const f of readdirSync(`/sys/class/hwmon/${h}`)) if (/^temp\d+_input$/.test(f)) read(`/sys/class/hwmon/${h}/${f}`)
  } catch {
    /* 非 Linux */
  }
  return vals.length ? round(Math.max(...vals)) : null
}

/** 默认路由所在网口（/proc/net/route 里目的地址为 0 的那行） */
function defaultIface(): string | null {
  try {
    for (const line of readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const [iface, dest] = line.trim().split(/\s+/)
      if (iface && dest === '00000000') return iface
    }
  } catch {
    /* 非 Linux */
  }
  return null
}

function txBytes(iface: string): number | null {
  try {
    for (const line of readFileSync('/proc/net/dev', 'utf8').split('\n')) {
      const [name, rest] = line.split(':')
      if (name?.trim() !== iface || !rest) continue
      const cols = rest.trim().split(/\s+/)
      return Number(cols[8])
    }
  } catch {
    /* 非 Linux */
  }
  return null
}

/** SNTP：返回 本机时钟 − 服务器时钟（ms，本机快为正）。RFC 4330，一次往返 */
function sntpOffset(server: string, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = createSocket('udp4')
    const msg = Buffer.alloc(48)
    msg[0] = 0x1b // LI=0, VN=3, Mode=3（客户端）
    const t1 = Date.now()
    const timer = setTimeout(() => {
      sock.close()
      reject(new Error('超时'))
    }, timeoutMs)
    sock.once('error', e => {
      clearTimeout(timer)
      sock.close()
      reject(e)
    })
    sock.once('message', buf => {
      const t4 = Date.now()
      clearTimeout(timer)
      sock.close()
      if (buf.length < 48) return reject(new Error('应答太短'))
      const ts = (off: number) => (buf.readUInt32BE(off) - 2_208_988_800) * 1000 + (buf.readUInt32BE(off + 4) * 1000) / 2 ** 32
      const t2 = ts(32) // 服务器收到
      const t3 = ts(40) // 服务器发出
      // θ = 服务器 − 本机；eg.clk_offset 要 本机 − 服务器
      const theta = (t2 - t1 + (t3 - t4)) / 2
      resolve(Math.round(-theta))
    })
    sock.send(msg, 123, server)
  })
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

const round = (v: number) => Math.round(v * 10) / 10
