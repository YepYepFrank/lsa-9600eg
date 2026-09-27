/* pnpm video:render —— 只按 local.yaml（手填地址）与 ONVIF 生成 EG mediamtx 配置，不起服务。
 * 开发样机 dev:up、EG 上 install.sh 在起 mediamtx 之前跑一次，免得 mediamtx 找不到配置文件。 */
import { VideoService } from './video.service.js'

const svc = new VideoService()
await svc.refresh()
const s = svc.status()
console.log(`${s.cabinet} 的 mediamtx 配置 → ${s.mediamtx.file}`)
for (const c of s.channels) console.log(`  ${c.path.padEnd(14)} ${c.from ? `${c.from === 'manual' ? '手填' : '驱动'} ${c.uri}` : '（没有地址）'}`)
if (s.driver && !s.driver.ok) console.log(`  取流地址失败（${s.driver.driver} 驱动）：${s.driver.error}`)
process.exit(0)
