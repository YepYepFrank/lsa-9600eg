// 开发样机的起停与宿主机进程（G0）
//
//   pnpm dev:up      生成 IoT Gateway 配置 + 起 mosquitto、tb-gateway 容器
//   pnpm dev:down    停容器
//   node scripts/dev.mjs agent | emu | video   在宿主机跑，连 127.0.0.1:11883 的总线
import { spawnSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMPOSE = resolve(ROOT, 'deploy/dev/compose.yaml')
const cmd = process.argv[2]
/** Windows 上 pnpm 是 .cmd，要经 shell 起；docker 不经 shell（路径里有空格，经 shell 会被拆开） */
const shellFor = bin => process.platform === 'win32' && bin === 'pnpm'

/** 宿主机进程连容器里的总线；管理页端口 9100（EG 上是 80） */
const HOST_ENV = { ...process.env, EG_BUS_MQTT: 'mqtt://127.0.0.1:11883', EG_HTTP_PORT: '9100' }

function run(bin, args, env = process.env) {
  const r = spawnSync(bin, args, { cwd: ROOT, stdio: 'inherit', env, shell: shellFor(bin) })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

switch (cmd) {
  case 'up':
    if (!existsSync(resolve(ROOT, 'run/eg.yaml'))) {
      console.error('没有 run/eg.yaml —— 先 pnpm dev:config')
      process.exit(1)
    }
    run('pnpm', ['-s', 'gateway:render'])
    run('docker', ['compose', '-f', COMPOSE, 'up', '-d'])
    break
  case 'down':
    run('docker', ['compose', '-f', COMPOSE, 'down'])
    break
  case 'agent':
  case 'emu':
  case 'video': {
    const p = spawn('pnpm', ['-s', cmd], { cwd: ROOT, stdio: 'inherit', env: HOST_ENV, shell: shellFor('pnpm') })
    p.on('exit', c => process.exit(c ?? 0))
    break
  }
  default:
    console.error('用法：node scripts/dev.mjs up | down | agent | emu | video')
    process.exit(1)
}
