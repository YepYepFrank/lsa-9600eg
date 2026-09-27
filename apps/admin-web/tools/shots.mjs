/* EG 本地管理页的验收截图（G3）：两条进入路径都截 —— 交换机直连（本地维护账号）与经子站（票据单点登录，维护 / 只看两种角色）。
 * 做法同子站前端的 web/tools/shots-live.mjs：DevTools 协议驱动无头 Edge / Chrome，不依赖第三方包（Node 22 自带 WebSocket）。
 *
 *   node apps/admin-web/tools/shots.mjs              全部，截到 docs/验收截图/G3/，并写 自检.txt
 *   ONLY=02,08 node apps/admin-web/tools/shots.mjs   只截这几张
 *
 * 前提：eg-agent（EG_AGENT_URL，默认 http://127.0.0.1:9100，已 build 管理页）、子站扩展服务（EXT_URL，默认 http://localhost:3001，
 * 带 EXT_EG_URLS=<柜号>=http://127.0.0.1:9100）、仿真器在跑。本地口令读 run/initial-password.txt 或 EG_ADMIN_PASSWORD；
 * 子站账号 zhang（运维）/ duty（值班员），口令 LSA_PASS（默认开发环境的 lsa9600sp）。 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const AGENT = (process.env.EG_AGENT_URL ?? 'http://127.0.0.1:9100').replace(/\/$/, '')
const EXT = (process.env.EXT_URL ?? 'http://localhost:3001').replace(/\/$/, '')
const EMU = process.env.EMU_URL ?? 'http://127.0.0.1:3190'
const OUT = resolve(ROOT, 'docs/验收截图', process.env.OUT_DIR ?? 'G3')
const SP_PASS = process.env.LSA_PASS ?? 'lsa9600sp'
const BROWSERS = [process.env.BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const localPw = process.env.EG_ADMIN_PASSWORD ?? readFileSync(resolve(ROOT, 'run/initial-password.txt'), 'utf8').trim()
const cabinet = readFileSync(resolve(ROOT, 'run/dev-cabinet'), 'utf8').trim()
const EG = `EG-${cabinet}`
const SAM_A = `SAM-${cabinet}-A`
const SAM_B = `SAM-${cabinet}-B`

/** [名字, 进入方式, 路由, 宽, 高, 额外动作]
 *  进入方式：login 不预置会话 / local 本地账号 / sp:<子站用户> 经子站票据 */
const SHOTS = [
  ['01_登录页_直连', 'login', 'overview'],
  ['02_概览', 'local', 'overview'],
  ['03_实时数据_感知模块', 'local', `live/${SAM_B}`],
  ['04_实时数据_原始消息', 'local', `live/${SAM_B}`, 1366, 768, 'raw'],
  ['05_实时数据_EG自身指标', 'local', `live/${EG}`],
  ['06_下挂设备', 'local', 'devices'],
  ['07_视频', 'local', 'video'],
  ['08_诊断', 'local', 'diag'],
  ['09_日志', 'local', 'logs'],
  ['10_系统', 'local', 'system'],
  ['11_经子站_概览_运维', 'sp:zhang', 'overview'],
  ['12_经子站_概览_值班员只看', 'sp:duty', 'overview'],
  ['13_经子站_日志_值班员只看', 'sp:duty', 'logs'],
  ['14_浅色主题_概览', 'local', 'overview', 1366, 768, 'light'],
  ['15_大屏_概览_1920', 'local', 'overview', 1920, 1080],
  ['16_质量异常_实时数据', 'local', `live/${SAM_A}`, 1366, 768, 'fault'],
  ['17_质量异常_概览', 'local', 'overview', 1366, 768, 'fault'],
]

async function json(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const t = await r.text()
  if (!r.ok) throw new Error(`${url} → ${r.status} ${t.slice(0, 120)}`)
  return JSON.parse(t)
}
const localToken = async () => (await json(`${AGENT}/api/auth/login`, { method: 'POST', body: JSON.stringify({ user: 'maint', password: localPw }) })).token
async function spTicketUrl(user) {
  const { token } = await json(`${EXT}/ext/auth/login`, { method: 'POST', body: JSON.stringify({ username: user, password: SP_PASS }) })
  const { url } = await json(`${EXT}/ext/eg/${cabinet}/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' })
  return EXT + url
}

// ---------- 起无头浏览器 ----------
const exe = BROWSERS.find(p => existsSync(p))
if (!exe) {
  console.error('找不到 Chromium 内核浏览器；用环境变量 BROWSER 指定')
  process.exit(1)
}
const profile = mkdtempSync(join(tmpdir(), 'eg-shots-'))
const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
let port
for (let i = 0; i < 100 && !port; i++) {
  await sleep(200)
  try {
    port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim()
  } catch {
    /* 还没起来 */
  }
}
if (!port) {
  console.error('浏览器没起来')
  proc.kill()
  process.exit(1)
}
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
const ws = new WebSocket(webSocketDebuggerUrl)
await new Promise((ok, bad) => {
  ws.onopen = ok
  ws.onerror = bad
})
let seq = 0
const waiting = new Map()
const listeners = new Set()
ws.onmessage = ev => {
  const m = JSON.parse(ev.data)
  if (m.id && waiting.has(m.id)) {
    const w = waiting.get(m.id)
    waiting.delete(m.id)
    m.error ? w.bad(new Error(m.error.message)) : w.ok(m.result)
  } else if (m.method) for (const f of listeners) f(m)
}
const cdp = (method, params = {}, sessionId) =>
  new Promise((ok, bad) => {
    const id = ++seq
    waiting.set(id, { ok, bad })
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })
const evaluate = async (expression, sessionId) => (await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value

// ---------- 逐张截 ----------
mkdirSync(OUT, { recursive: true })
const only = process.env.ONLY?.split(',')
const report = []
let faultOn = false

for (const [name, mode, route, w = 1366, h = 768, action] of SHOTS) {
  if (only && !only.some(k => name.startsWith(k))) continue
  // 质量异常两张：让仿真器停发 SAM-A 的环境温湿度、整台停发颗粒物，等看护标到「无效」
  if (action === 'fault' && !faultOn) {
    await fetch(`${EMU}/emu/dev/${SAM_A}/drop?keys=env.t,env.rh`, { method: 'POST' })
    await fetch(`${EMU}/emu/dev/PM6-${cabinet}/dead?on=1`, { method: 'POST' })
    faultOn = true
    console.log('  （制造质量异常，等 60 s 让看护标到「无效」）')
    await sleep(60_000)
  }
  const issues = []
  let readyMs = null
  const { browserContextId } = await cdp('Target.createBrowserContext', { disposeOnDetach: true })
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank', browserContextId })
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true })
  let base = AGENT
  const onEvent = m => {
    if (m.sessionId !== sessionId) return
    if (m.method === 'Runtime.exceptionThrown') issues.push('脚本错误：' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).split('\n')[0])
    if (m.method === 'Network.responseReceived') {
      const { url: u, status } = m.params.response
      if (status >= 400 && u.includes('/api/') && !(mode === 'login' && status === 401) && !(mode === 'sp:duty' && status === 403)) issues.push(`接口 ${status}：${u.replace(/^https?:\/\/[^/]+/, '')}`)
    }
  }
  listeners.add(onEvent)
  try {
    await cdp('Runtime.enable', {}, sessionId)
    await cdp('Network.enable', {}, sessionId)
    await cdp('Page.enable', {}, sessionId)
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId)
    const theme = action === 'light' ? 'light' : 'dark'
    let url
    if (mode === 'login' || mode === 'local') {
      const token = mode === 'local' ? await localToken() : null
      const pre = `try{localStorage.setItem('lsa-eg-theme','${theme}');${token ? `localStorage.setItem('lsa-eg-session:/', ${JSON.stringify(token)})` : ''}}catch(e){}`
      await cdp('Page.addScriptToEvaluateOnNewDocument', { source: pre }, sessionId)
      url = `${AGENT}/#/${route}`
    } else {
      base = EXT
      const t = await spTicketUrl(mode.slice(3))
      await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('lsa-eg-theme','${theme}')}catch(e){}` }, sessionId)
      url = `${t}#/${route}`
    }
    await cdp('Page.navigate', { url }, sessionId)
    const t0 = Date.now()
    for (;;) {
      await sleep(250)
      const ok = await evaluate(`document.readyState === 'complete' && !!document.querySelector('#app *') && !/加载中/.test(document.body.innerText)`, sessionId)
      if (ok) {
        readyMs = Date.now() - t0
        break
      }
      if (Date.now() - t0 > 15_000) break
    }
    // 诊断、组件 5 s 一轮，等它们都出来
    await sleep(6000)
    if (action === 'raw') {
      await evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('原始消息'))?.click()`, sessionId)
      await sleep(1500)
    }
    if (await evaluate(`/加载中/.test(document.body.innerText)`, sessionId)) issues.push('截图时仍在「加载中」')
    if (mode.startsWith('sp:') && (await evaluate(`/登录/.test(document.querySelector('.login')?.innerText ?? '')`, sessionId))) issues.push('经子站进来却停在登录页')
    if (mode.startsWith('sp:') && (await evaluate(`location.search.includes('sso=')`, sessionId))) issues.push('地址栏里还留着票据')
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId)
    writeFileSync(join(OUT, name + '.png'), Buffer.from(data, 'base64'))
    console.log(issues.length ? '△' : '✓', name, readyMs == null ? '未就绪' : `${(readyMs / 1000).toFixed(1)} s`)
    for (const s of new Set(issues)) console.log('    ' + s)
  } catch (e) {
    issues.push('截图失败：' + e.message)
    console.log('✗', name, e.message)
  }
  listeners.delete(onEvent)
  report.push([name, mode, route, [...new Set(issues)], readyMs])
  await cdp('Target.closeTarget', { targetId }).catch(() => {})
  await cdp('Target.disposeBrowserContext', { browserContextId }).catch(() => {})
}

if (faultOn) {
  await fetch(`${EMU}/emu/dev/${SAM_A}/drop?keys=`, { method: 'POST' })
  await fetch(`${EMU}/emu/dev/PM6-${cabinet}/dead?on=0`, { method: 'POST' })
  console.log('  （质量异常已撤销）')
}
ws.close()
proc.kill()
await sleep(500)
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
} catch {
  /* 浏览器退出稍慢 */
}

const lines = [`EG 本地管理页验收截图自检  ${new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}  直连 ${AGENT} / 经子站 ${EXT}/eg/${cabinet}/`, '']
for (const [name, mode, route, iss, ms] of report) {
  lines.push(`${iss.length ? '△' : '✓'} ${name}  ${ms == null ? '未就绪' : (ms / 1000).toFixed(1) + ' s'}  ${mode === 'login' ? '直连未登录' : mode === 'local' ? '直连 · 本地账号' : '经子站 · ' + mode.slice(3)}  #/${route}`)
  for (const s of iss) lines.push('    ' + s)
}
const bad = report.filter(r => r[3].length).length
lines.push('', `${report.length} 张；${report.length - bad} 张无问题，${bad} 张有记录`)
if (!only) writeFileSync(join(OUT, '自检.txt'), lines.join('\n') + '\n')
console.log(lines.slice(-1)[0], only ? '' : `→ ${OUT}`)
process.exit(bad ? 1 : 0)
