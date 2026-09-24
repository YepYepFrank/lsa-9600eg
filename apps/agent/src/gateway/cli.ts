/* pnpm gateway:render —— 按 eg.yaml / local.yaml 生成 IoT Gateway 配置到 <配置目录>/gateway/config */
import { loadConfig } from '@lsa-eg/config'
import { renderGatewayConfig } from './render.js'

const cfg = loadConfig()
const r = renderGatewayConfig(cfg)
console.log(`${cfg.eg.name} 的 IoT Gateway 配置 → ${r.dir}（${r.files.join('、')}）`)
console.log(`  连本机 Edge ${cfg.local.mqtt.edge}，订阅本机总线 ${cfg.local.mqtt.bus}`)
