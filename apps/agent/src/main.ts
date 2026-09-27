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
import { RingLogger } from './logging/ring-logger.js'
import { denyOnIfaces } from './net/deny.js'
import { AuthService } from './auth/auth.service.js'
import { streamProxy } from './stream/stream.proxy.js'

async function bootstrap() {
  const cfg = egConfig()
  // IoT Gateway 的配置每次启动按 eg.yaml / local.yaml 重新生成，保证只有一个来源
  const gw = renderGatewayConfig(cfg)

  const logger = new RingLogger()
  logger.setLogLevels(['log', 'warn', 'error'])
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger })
  // 经子站反代进来时取真实客户端地址（审计用）
  app.set('trust proxy', true)
  // 管理页只对 LAN2 开：LAN1（摄像机网）进来的一律 403（local.yaml http.denyOn；EG 编排经 EG_HTTP_DENY_ON 给）
  const deny = denyOnIfaces([...(cfg.local.http.denyOn ?? []), ...(process.env['EG_HTTP_DENY_ON'] ?? '').split(',').map(x => x.trim()).filter(Boolean)])
  if (deny) app.use(deny)
  // 实时画面（WHEP / HLS）带会话鉴权反代到本机 mediamtx（eg-ui-v2）；请求体（SDP）要原样转，放在 Nest 的 body parser 之前
  app.use('/api/stream', streamProxy(cfg, app.get(AuthService)))
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))

  // 本地管理页：构建产物由 agent 直出（EG_WEB_DIR 或仓库里 apps/admin-web/dist）
  const web = process.env['EG_WEB_DIR'] ?? resolve(repoRoot() ?? process.cwd(), 'apps/admin-web/dist')
  if (existsSync(web)) app.use('/', express.static(web, { index: 'index.html' }))

  const port = cfg.conn.httpPort
  await app.listen(port, '0.0.0.0')
  const log = new Logger('eg-agent')
  // 旁观模式只给开发机并排验接口用（发布件的 compose / install.sh 里没有它）：生产环境看到就醒目地报出来
  if (process.env['EG_PASSIVE'] === '1') {
    const msg = '！！！EG_PASSIVE=1 旁观模式：本机不发任何数据（派生量、质量码、EG 自身指标、证据都不做）—— 只用于开发机，现场绝不能开 ！！！'
    if (process.env['NODE_ENV'] === 'production') for (let k = 0; k < 3; k++) log.error(msg)
    else log.warn(msg)
  }
  log.log(`${cfg.eg.name}（${cfg.cabinet.name}）已启动：http://localhost:${port}/`)
  log.log(`IoT Gateway 配置 → ${gw.dir}`)
  if (!existsSync(web)) log.warn(`没有管理页构建产物 ${web}（开发时用 pnpm web）`)
}

bootstrap().catch(e => {
  console.error('eg-agent 启动失败：', e instanceof Error ? e.message : e)
  process.exit(1)
})
