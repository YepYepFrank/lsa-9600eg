/* 0.8.0 自检：本地页摄像机地址的 IPv4 校验（camUrlProblem）。宿主机按这些地址写对时的防火墙放行（install.sh --cam-ntp-sync），
 * 192.168.1.300 这类写进 local.yaml 以前在页面这一层就拒掉。
 *
 *   pnpm verify:cam-url */
import 'reflect-metadata'
import { camUrlProblem } from './config/config.controller.js'
import { check, done } from './verify/lib.js'

console.log('摄像机地址 IPv4 校验（0.8.0）\n')
const ok: string[] = [
  '',
  'http://192.168.1.180',
  'http://192.168.100.64:8080/restv1',
  'rtsp://admin:p%40ss@192.168.1.64:554/ch0',
  'rtsp://192.168.1.65/ch1',
  'http://0.0.0.0',
  'http://255.255.255.255',
  'http://cam-ah01.local',
  'rtsp://camera/ch0',
]
const bad: string[] = [
  'http://192.168.1.300',
  'rtsp://admin:x@192.168.1.3000:554/ch0',
  'http://192.168.1',
  'http://192.168.1.1.1',
  'rtsp://256.1.1.1/ch1',
  'http://1234.1.1.1',
]
for (const u of ok) check(camUrlProblem(u) === null, `放过：${u || '（空）'}`)
for (const u of bad) {
  const p = camUrlProblem(u)
  check(!!p && p.includes('不是合法的 IPv4'), `拒：${u}（${p}）`)
}
done()
