/* 配置在启动时读一次，作为 Nest 的 provider 注入（改 local.yaml 的接口在 G2 做，改完重读） */
import { loadConfig, type EgConfig } from '@lsa-eg/config'

export const EG_CONFIG = Symbol('EG_CONFIG')

let current: EgConfig | null = null

export function egConfig(): EgConfig {
  current ??= loadConfig()
  return current
}

export const configProvider = { provide: EG_CONFIG, useFactory: egConfig }
