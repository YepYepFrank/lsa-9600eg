/* 摄像机驱动（G4 摄像机测温约定 §1）：与型号无关的「摄像机源」。
 *   sim    仿真器的摄像机（packages/emu 的 /emu/cam）：流地址、区域配置、温度、原生报警
 *   onvif  只有视频：ONVIF 查四路流地址与抓图地址
 *   rtsp   只有视频：只用 local.yaml 手填的地址
 *   restv1 真机（厂家 restv1 V1.8，restv1.ts）：token、流地址、区域测温（含 avg / center）、报警轮询、抓拍（EG 0.5，清单 I18）
 * 公共类型在 driver-base.ts。 */
import type { EgConfig } from '@lsa-eg/config'
import { DriverError, type CameraDriver, type Measurement, type StreamInfo } from './driver-base.js'
import { mapProfiles, OnvifClient, type ChannelKey } from './onvif.js'
import { Restv1Driver } from './restv1.js'

export { DriverError, type CameraDriver, type Measurement, type RegionDef, type StreamInfo } from './driver-base.js'

class SimDriver implements CameraDriver {
  readonly name = 'sim'
  constructor(private readonly api: string) {}

  private async state(): Promise<Measurement & { streams: Record<ChannelKey, string | null> }> {
    let r: Response
    try {
      r = await fetch(`${this.api}/state`, { signal: AbortSignal.timeout(3000) })
    } catch (e) {
      throw new DriverError(`连不上仿真摄像机 ${this.api}：${(e as Error).cause ? String((e as Error).cause) : (e as Error).message}`, 'CONNECT')
    }
    if (!r.ok) throw new DriverError(`仿真摄像机回 ${r.status}：${(await r.text().catch(() => '')).slice(0, 100)}`)
    return (await r.json()) as never
  }

  async streams() {
    const s = await this.state()
    const map: Partial<Record<ChannelKey, StreamInfo>> = {}
    for (const [k, uri] of Object.entries(s.streams)) if (uri) map[k as ChannelKey] = { uri, snapshot: null }
    return { map, note: null }
  }

  async measure(): Promise<Measurement> {
    const s = await this.state()
    return { frame: s.frame, regions: s.regions, temps: s.temps, alarm: s.alarm }
  }
}

class OnvifDriver implements CameraDriver {
  readonly name = 'onvif'
  constructor(private readonly cfg: EgConfig) {}

  async streams() {
    const cam = this.cfg.local.camera
    if (!cam.onvif) return { map: {}, note: '没配 ONVIF 地址（local.yaml camera.onvif）' }
    const client = new OnvifClient(cam.onvif, cam.user, cam.password)
    const ps = await client.profiles()
    const { map: prof, note } = mapProfiles(ps)
    const map: Partial<Record<ChannelKey, StreamInfo>> = {}
    for (const [k, p] of Object.entries(prof)) {
      if (!p) continue
      const main = k === 'visible' || k === 'thermal'
      map[k as ChannelKey] = { uri: await client.streamUri(p.token), snapshot: main ? await client.snapshotUri(p.token) : null }
    }
    return { map, note: `ONVIF 查到 ${ps.length} 个配置文件${note ? `（${note}）` : ''}` }
  }
}

class RtspDriver implements CameraDriver {
  readonly name = 'rtsp'
  async streams() {
    return { map: {}, note: '只用手填的 RTSP 地址' }
  }
}

export function driverOf(cfg: EgConfig): CameraDriver {
  const cam = cfg.local.camera
  switch (cam.driver) {
    case 'sim':
      if (!cam.api) throw new DriverError('sim 驱动要配 local.yaml camera.api（仿真器地址，如 http://127.0.0.1:3190/emu/cam）')
      return new SimDriver(cam.api.replace(/\/$/, ''))
    case 'onvif':
      return new OnvifDriver(cfg)
    case 'restv1':
      if (!cam.restv1) throw new DriverError('restv1 驱动要配 local.yaml camera.restv1（摄像机地址，如 http://192.168.10.64）', 'CONNECT')
      return new Restv1Driver({ base: cam.restv1, user: cam.user, password: cam.password })
    default:
      // 没选驱动但填了 ONVIF 地址：按 onvif
      return cam.onvif ? new OnvifDriver(cfg) : new RtspDriver()
  }
}
