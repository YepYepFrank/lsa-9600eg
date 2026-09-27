/* 测试件（deploy/test）用：把 local.yaml 的摄像机改成仿真器 + 本机 RTSP 测试源（虚拟样机 G6 验收；现场不装测试件、不跑这个）。
 *   node --import @swc-node/register/esm-register ../../packages/emu/src/setup-test.ts */
import { loadConfig, saveLocal } from '@lsa-eg/config'

const cfg = loadConfig()
const local = structuredClone(cfg.local)
local.camera = {
  ...local.camera,
  driver: 'sim',
  api: `http://127.0.0.1:${process.env['EMU_CTL_PORT'] ?? 3190}/emu/cam`,
  user: 'admin',
  password: 'lsa-cam',
}
saveLocal(local, cfg.dir)
console.log(`${cfg.dir}/local.yaml：camera.driver = sim，api = ${local.camera.api}`)
