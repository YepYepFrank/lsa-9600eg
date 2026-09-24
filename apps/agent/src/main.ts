/* eg-agent：EG 上我方的服务（开发计划 §2）。
 *   派生量与质量码看护（G1）、本地 API 与管理页（G2/G3）、抓拍录波与上传（G5）。
 *   视频另是一个服务 eg-video（apps/video），不经 TB。
 *
 *   pnpm agent                       开发：读仓库下 run/eg.yaml、run/local.yaml
 *   EG_CONFIG_DIR=/etc/lsa-eg ...     EG 上 */
import 'reflect-metadata'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Logger, ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import express from 'express'
import { repoRoot } from '@lsa-eg/config'
import { AppModule } from './app.module.js'
import { egConfig } from './config.js'
import { renderGatewayConfig } from './gateway/render.js'

async function bootstrap() {
  const cfg = egConfig()
  // IoT Gateway 的配置每次启动按 eg.yaml / local.yaml 重新生成，保证只有一个来源
  const gw = renderGatewayConfig(cfg)

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] })
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))

  // 本地管理页：构建产物由 agent 直出（EG_WEB_DIR 或仓库里 apps/admin-web/dist）
  const web = process.env['EG_WEB_DIR'] ?? resolve(repoRoot() ?? process.cwd(), 'apps/admin-web/dist')
  if (existsSync(web)) app.use('/', express.static(web, { index: 'index.html' }))

  const port = cfg.conn.httpPort
  await app.listen(port, '0.0.0.0')
  const log = new Logger('eg-agent')
  log.log(`${cfg.eg.name}（${cfg.cabinet.name}）已启动：http://localhost:${port}/`)
  log.log(`IoT Gateway 配置 → ${gw.dir}`)
  if (!existsSync(web)) log.warn(`没有管理页构建产物 ${web}（开发时用 pnpm web）`)
}

bootstrap().catch(e => {
  console.error('eg-agent 启动失败：', e instanceof Error ? e.message : e)
  process.exit(1)
})
