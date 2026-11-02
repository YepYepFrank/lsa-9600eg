/* 0.19.5 自检：
 *   refresh 摄像机配置没变时留着驱动实例（restv1 没有退出登录，每 10 分钟 new 一个会丢令牌、多占会话），改了才换；
 *   测温失败时子站网页改的测温区照样生效（refreshCamRegions 不跟测温绑）。
 *
 *   pnpm -F @lsa-eg/video verify:driver-reuse */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAM_REGIONS_FILE, loadConfig, saveLocal } from '@lsa-eg/config'
import { driverKey } from './drivers.js'
import { VideoService } from './video.service.js'

let pass = 0
let fail = 0
function check(ok: boolean, what: string) {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? '✓' : '✗'} ${what}`)
}

const doc = {
  schema: 2,
  generatedAt: '2026-11-02T00:00:00Z',
  station: { name: 'SP-1', label: '1# 配电室', mqtt: 'mqtt://127.0.0.1:1', token: 'tok-DP4-B' },
  sp: { host: '127.0.0.1' },
  cabinet: { code: 'DP4', name: '4# 柜', group: 'mv', kind: '出线', rated: 630, riseLimit: 50, rooms: ['断路器室'], index: 4 },
  unit: { id: 'B', code: 'DP4-B', at: '断路器室', index: 2 },
  eg: { name: 'EG-DP4-B', token: 'tok-DP4-B', attrs: { cab: 'DP4', unit: 'DP4-B' } },
  devices: [{ name: 'CAM-DP4-B', kind: 'camera', label: '双目', attrs: { cab: 'DP4', unit: 'DP4-B', regions: { R1: { label: '触头' } } } }],
}

const dir = mkdtempSync(join(tmpdir(), 'lsa-vreuse-'))
process.env['EG_CONFIG_DIR'] = dir
writeFileSync(join(dir, 'eg.yaml'), JSON.stringify(doc))
const setCam = (p: Record<string, unknown>) => {
  const cfg = loadConfig(dir)
  // 连不上的地址：不碰真摄像机，只看实例换不换
  Object.assign(cfg.local.camera, { driver: 'restv1', restv1: 'http://127.0.0.1:1', user: 'u', password: 'p' }, p)
  saveLocal(cfg.local, dir)
}

type Inner = { driver: unknown; cfg: { devices: { kind: string; attrs: Record<string, unknown> }[] }; refreshCamRegions(): void }
const main = async () => {
  setCam({})
  const v = new VideoService()
  const inner = v as unknown as Inner

  console.log('1. 驱动实例')
  await v.refresh()
  const d0 = inner.driver
  await v.refresh()
  check(d0 !== undefined && d0 !== null && inner.driver === d0, 'refresh 配置没变：同一个实例（令牌留着）')
  setCam({ rtsp: { visible: 'rtsp://127.0.0.1:1/a', thermal: '', visibleSub: '', thermalSub: '' } })
  await v.refresh()
  check(inner.driver === d0, '只改手填的 RTSP 地址：不换实例')
  setCam({ password: 'p2' })
  await v.refresh()
  check(inner.driver !== d0, '改了口令：换实例')
  const before = driverKey(loadConfig(dir))
  setCam({ password: 'p2', restv1: 'http://127.0.0.1:2' })
  check(driverKey(loadConfig(dir)) !== before, '改了地址：driverKey 变')

  console.log('2. 测温区不跟测温绑（这里摄像机一直连不上）')
  inner.refreshCamRegions()
  writeFileSync(join(dir, CAM_REGIONS_FILE), JSON.stringify({ unit: 'DP4-B', regions: { R1: { label: '网页改的' }, R2: { label: '加的' } } }))
  inner.refreshCamRegions()
  const regions = inner.cfg.devices.find(d => d.kind === 'camera')?.attrs['regions'] as Record<string, { label: string }>
  check(regions['R1']?.label === '网页改的' && regions['R2']?.label === '加的', '没测过温也换上了新的部位名和个数')

  rmSync(dir, { recursive: true, force: true })
  console.log(`\n结果：✓ ${pass}，✗ ${fail}`)
  process.exit(fail ? 1 : 0)
}
void main()
