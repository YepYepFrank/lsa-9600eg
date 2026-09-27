// 开发样机的起停与宿主机进程
//
//   pnpm dev:up      生成 IoT Gateway 配置；本地 TB 的库是空的先建库（首次约 1–2 分钟）；再起全部容器
//   pnpm dev:down    停容器（数据卷保留）
//   node scripts/dev.mjs agent | emu | video   在宿主机跑，连 127.0.0.1:11883 的总线、127.0.0.1:18080 的本地 TB
import { spawnSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMPOSE = resolve(ROOT, 'deploy/dev/compose.yaml')
const cmd = process.argv[2]
/** Windows 上 pnpm 是 .cmd，要经 shell 起；docker 不经 shell（路径里有空格，经 shell 会被拆开） */
const shellFor = bin => process.platform === 'win32' && bin === 'pnpm'

/** 宿主机进程连容器里的总线与本地 TB；管理页端口 9100（EG 上是 80） */
const HOST_ENV = { ...process.env, EG_BUS_MQTT: 'mqtt://127.0.0.1:11883', EG_TB_MQTT: 'mqtt://127.0.0.1:11884', EG_TB_HTTP: 'http://127.0.0.1:18080', EG_HTTP_PORT: '9100', EG_DEBUG: '1', EG_CAM_HOST: '127.0.0.1:18555' }

function run(bin, args, env = process.env) {
  const r = spawnSync(bin, args, { cwd: ROOT, stdio: 'inherit', env, shell: shellFor(bin) })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
const compose = (...args) => run('docker', ['compose', '-f', COMPOSE, ...args])

/** 本地 TB 的库建过没有：看有没有 tb_user 表 */
function tbInstalled() {
  const r = spawnSync('docker', ['exec', 'lsa-eg-postgres', 'psql', '-U', 'postgres', '-d', 'thingsboard', '-Atc', "select count(*) from information_schema.tables where table_name='tb_user'"], {
    encoding: 'utf8',
  })
  return r.status === 0 && r.stdout.trim() === '1'
}

switch (cmd) {
  case 'up':
    if (!existsSync(resolve(ROOT, 'run/eg.yaml'))) {
      console.error('没有 run/eg.yaml —— 先 pnpm dev:config')
      process.exit(1)
    }
    run('pnpm', ['-s', 'gateway:render'])
    // EG mediamtx 起来前要有配置文件（eg-video 起了以后会按摄像机刷新）
    run('pnpm', ['-s', '-F', '@lsa-eg/video', 'video:render'], HOST_ENV)
    compose('up', '-d', '--wait', 'eg-postgres')
    if (!tbInstalled()) {
      console.log('本地 TB 的库是空的，先建库（约 1–2 分钟）…')
      compose('--profile', 'install', 'run', '--rm', 'eg-tb-install')
    }
    compose('up', '-d')
    console.log('本地 TB 首次启动约 1–2 分钟；管理界面 http://127.0.0.1:18080（sysadmin@thingsboard.org / sysadmin，provision:eg 之后用 eg.yaml 的 tb 账号）')
    break
  case 'down':
    compose('down')
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
