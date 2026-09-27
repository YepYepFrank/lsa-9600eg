/* EG 本机 mediamtx 的配置生成与 API（接口约定 §2、§3）。
 *   四路：<柜号>、<柜号>-sub、<柜号>-ir、<柜号>-ir-sub —— 每路 source 指向摄像机，sourceOnDemand：没有读者就不连摄像机；
 *   只开 RTSP（子站拉）与本机 API；读权限只给子站主机与本机，任何地址都不许推流。
 * 写配置文件时内容不变就不写（mediamtx 监视配置文件、一变就重载）。 */
import { lookup } from 'node:dns/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { stringify } from 'yaml'
import type { EgConfig } from '@lsa-eg/config'
import type { ChannelKey } from './onvif.js'

export const CHANNELS: { key: ChannelKey; suffix: string; label: string }[] = [
  { key: 'visible', suffix: '', label: '可见光主码流' },
  { key: 'visibleSub', suffix: '-sub', label: '可见光子码流' },
  { key: 'thermal', suffix: '-ir', label: '热像主码流' },
  { key: 'thermalSub', suffix: '-ir-sub', label: '热像子码流' },
]

export const pathOf = (cab: string, key: ChannelKey) => cab + CHANNELS.find(c => c.key === key)!.suffix

export function mtxConfigFile(cfg: EgConfig): string {
  return resolve(cfg.dir, 'mediamtx', 'mediamtx.yml')
}

/** 带上账号口令的摄像机地址（手填的地址里没带就补上 local.yaml 的摄像机账号） */
export function withCreds(uri: string, user: string, pass: string): string {
  try {
    const u = new URL(uri)
    if (!u.username && user) {
      u.username = encodeURIComponent(user)
      u.password = encodeURIComponent(pass)
    }
    return u.toString()
  } catch {
    return uri
  }
}

/** 日志 / 页面上显示用：口令打码 */
export function maskUri(uri: string): string {
  return uri.replace(/\/\/([^:/@]*):([^@]*)@/, '//$1:***@')
}

const cidr = (ip: string) => (ip.includes('/') ? ip : ip.includes(':') ? `${ip}/128` : `${ip}/32`)

async function resolveIps(host: string): Promise<string[]> {
  try {
    return (await lookup(host, { all: true })).map(a => a.address)
  } catch {
    return []
  }
}

export async function renderMtxConfig(cfg: EgConfig, sources: Partial<Record<ChannelKey, string>>): Promise<{ file: string; changed: boolean; readFrom: string[] }> {
  const v = cfg.local.video
  const readFrom = v.readFrom.length ? v.readFrom.map(cidr) : [...new Set([...(await resolveIps(cfg.sp.host)).map(cidr), '127.0.0.1/32', '::1/128'])]
  const apiFrom = v.apiFrom.length ? v.apiFrom.map(cidr) : ['127.0.0.1/32', '::1/128']
  const paths: Record<string, unknown> = {}
  for (const c of CHANNELS) {
    const src = sources[c.key]
    if (!src) continue
    paths[pathOf(cfg.cabinet.code, c.key)] = {
      source: src,
      sourceOnDemand: true,
      sourceOnDemandStartTimeout: '10s',
      sourceOnDemandCloseAfter: v.closeAfter,
      rtspTransport: 'tcp',
    }
  }
  const conf = {
    logLevel: 'warn',
    // 只开 RTSP 与本机 API：子站 mediamtx 从这里拉，浏览器不直连 EG
    rtsp: true,
    rtspAddress: `:${v.rtspPort}`,
    rtspTransports: ['tcp'],
    rtmp: false,
    hls: false,
    webrtc: false,
    srt: false,
    // mediamtx 1.21 起缺省还开 MoQ（QUIC / HTTP/3，:8892 / :8893）：EG 用不上，关掉，免得多开端口
    moq: false,
    api: true,
    apiAddress: v.apiListen,
    metrics: false,
    pprof: false,
    playback: false,
    authMethod: 'internal',
    authInternalUsers: [
      { user: 'any', pass: '', ips: readFrom, permissions: [{ action: 'read' }] },
      { user: 'any', pass: '', ips: apiFrom, permissions: [{ action: 'api' }] },
    ],
    // 清单外的路径一律不收（不许推流进来冒充）
    pathDefaults: { source: 'publisher', overridePublisher: false },
    paths,
  }
  const head = `# EG ${cfg.cabinet.code} 的 mediamtx 配置 —— eg-video 按 local.yaml 的摄像机与 ONVIF 查询结果生成（apps/video/src/mtx.ts），不要手改\n`
  const text = head + stringify(conf)
  const file = mtxConfigFile(cfg)
  mkdirSync(dirname(file), { recursive: true })
  const changed = !existsSync(file) || readFileSync(file, 'utf8') !== text
  if (changed) writeFileSync(file, text, 'utf8')
  return { file, changed, readFrom }
}

export interface MtxPath {
  name: string
  ready: boolean
  readers: number
  bytesReceived: number
  sourceType: string | null
}

/** mediamtx API：各路状态（有无读者、是否已拉起、入站字节） */
export async function mtxPaths(api: string): Promise<MtxPath[]> {
  const r = await fetch(`${api}/v3/paths/list?itemsPerPage=100`, { signal: AbortSignal.timeout(3000) })
  if (!r.ok) throw new Error(`mediamtx API ${r.status}`)
  const j = (await r.json()) as { items: { name: string; ready: boolean; readers: unknown[]; bytesReceived: number; source: { type: string } | null }[] }
  return j.items.map(i => ({ name: i.name, ready: i.ready, readers: i.readers?.length ?? 0, bytesReceived: i.bytesReceived ?? 0, sourceType: i.source?.type ?? null }))
}
