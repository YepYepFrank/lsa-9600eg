/* 摄像机驱动的公共类型（G4 摄像机测温约定 §1）：drivers.ts 的各驱动与 restv1.ts 共用，单放一个文件免得互相引用。 */
import type { ChannelKey } from './onvif.js'

export interface StreamInfo {
  uri: string
  /** 抓图地址（ONVIF GetSnapshotUri）；没有就经本机 mediamtx 解一帧 */
  snapshot?: string | null
}

export interface RegionDef {
  name: string
  type: 'point' | 'line' | 'region' | 'polygon'
  coords: Record<string, unknown>
  enabled: boolean
}

export interface Measurement {
  frame: { w: number; h: number }
  regions: RegionDef[]
  temps: {
    ts: number
    /** avg / center：真机（restv1）才有（厂家 CAM2：avg = 平均温、center = 中心点温度） */
    glob: { max: number; min: number; maxX: number; maxY: number; avg?: number; center?: number }
    regions: { name: string; max?: number; min?: number; maxX?: number; maxY?: number; pt?: number; avg?: number; center?: number }[]
  } | null
  /** 原生报警状态，原样 */
  alarm: string
  /** 测温本身成功、但附带的接口出错（区域配置、报警状态）：[接口, 原因]。video.service 据此把 cam.rest 标 DEGRADED、相关量标质量码 */
  partial?: { what: 'region' | 'alarm'; error: string }[]
}

export interface CameraDriver {
  readonly name: string
  /** 测温轮询间隔（ms）；不给按 2 s */
  readonly pollMs?: number
  /** 四路流地址（查不到的路缺） */
  streams(): Promise<{ map: Partial<Record<ChannelKey, StreamInfo>>; note: string | null }>
  /** 测温（只有能测温的驱动有） */
  measure?(): Promise<Measurement>
  /** 驱动自己能抓图（restv1 的 channel/snap）：返回 JPEG；不支持就没有这个方法 */
  snap?(ch: 'visible' | 'ir'): Promise<Buffer>
  /** 本地页看的驱动细节（token 剩余时间、固件版本等）；不含口令 */
  detail?(): Record<string, unknown>
}

/** 摄像机上的区域 → R1–R<limit>（约定 §2；与后端 @lsa/points 的 numbered 同一规则）：区域名就是 R1–R<limit> 的按名对应，
 *  否则取前 limit 个启用区域按顺序编。limit = 这面柜配了几个测温区（eg.yaml CAM 属性 regions.R<n> 的个数，1–12，缺省 3；I18） */
export function numberRegions(regions: RegionDef[], limit: number): { id: string; def: RegionDef }[] {
  const enabled = regions.filter(r => r.enabled)
  const byName = enabled.filter(r => {
    const m = /^R(\d{1,2})$/.exec(r.name)
    return !!m && Number(m[1]) >= 1 && Number(m[1]) <= limit
  })
  if (byName.length) return byName.map(r => ({ id: r.name, def: r }))
  return enabled.slice(0, limit).map((r, i) => ({ id: `R${i + 1}`, def: r }))
}

/** 驱动出错。code 给质量码 / dev.err 用：CONNECT 连不上、TIMEOUT 超时、AUTH 账号口令不对、TOKEN 令牌失效重取也不行、API 接口报错、DATA 回的数据不对 */
export type DriverErrorCode = 'CONNECT' | 'TIMEOUT' | 'AUTH' | 'TOKEN' | 'API' | 'DATA'

export class DriverError extends Error {
  constructor(
    message: string,
    readonly code: DriverErrorCode = 'API',
  ) {
    super(message)
  }
}
