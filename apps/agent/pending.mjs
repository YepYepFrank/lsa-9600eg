// LSA-9600EG 待接入页（0.17.4 一键加柜）：给了 --join-key、还没有 eg.yaml 时，install.sh 用应用镜像起它（compose 的 pending 服务，宿主机网络 80 口）。
// 现场的人笔记本接 LAN2 的交换机、浏览器打开 EG 地址，就能看到「待接入」、授权的子站、各网口的 IP / MAC，不用 SSH。
// 只读：不带任何口令 / 令牌，不能做任何操作，只认 GET。只用 Node 自带模块（不经 Nest、不读 eg.yaml）。
// 接入后（子站 join-egs.sh 推了 eg.yaml）install.sh 会删掉这个容器、起 agent。
import { createServer } from 'node:http'
import { networkInterfaces, hostname, uptime } from 'node:os'
import { readFileSync } from 'node:fs'

const PORT = Number(process.env.PORT || 80)
const CFG = process.env.EG_CONFIG_DIR || '/config'
// 摄像机网口（LAN1）进来的一律 403，同 agent（EG_HTTP_DENY_ON）
const DENY = (process.env.EG_HTTP_DENY_ON || '').split(',').map(s => s.trim()).filter(Boolean)

const read = (f, d = '') => {
  try {
    return readFileSync(f, 'utf8')
  } catch {
    return d
  }
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function joinInfo() {
  try {
    const j = JSON.parse(read(`${CFG}/join.json`, '{}'))
    return { sp: j.sp || null, at: j.at || null, tunnelFp: j.tunnelFp || null, upgradeFp: j.upgradeFp || null }
  } catch {
    return { sp: null, at: null, tunnelFp: null, upgradeFp: null }
  }
}
function ifaces() {
  const out = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/^(lo|docker|br-|veth)/.test(name)) continue
    const v4 = (addrs || []).filter(a => a.family === 'IPv4' || a.family === 4)
    const mac = (addrs || []).find(a => a.mac && a.mac !== '00:00:00:00:00:00')?.mac || ''
    out.push({ name, ipv4: v4.map(a => `${a.address}/${a.cidr?.split('/')[1] ?? ''}`), mac, lan1: DENY.includes(name) })
  }
  return out
}
function denied(req) {
  if (!DENY.length) return false
  const local = (req.socket.localAddress || '').replace(/^::ffff:/, '')
  const nics = networkInterfaces()
  return DENY.some(n => (nics[n] || []).some(a => a.address === local))
}
async function tbUp() {
  try {
    const r = await fetch('http://127.0.0.1:18080/', { signal: AbortSignal.timeout(2000) })
    return r.status < 500
  } catch {
    return false
  }
}
async function state() {
  return {
    state: 'pending',
    host: hostname(),
    version: read('/eg-version').trim() || null,
    uptimeS: Math.round(uptime()),
    join: joinInfo(),
    ifaces: ifaces(),
    localTb: await tbUp(),
    at: new Date().toISOString(),
  }
}
function page(s) {
  const lan2 = s.ifaces.find(i => !i.lan1 && i.ipv4.length)?.ipv4[0]?.split('/')[0] || '<本机地址>'
  const rows = s.ifaces
    .map(i => `<tr><td>${esc(i.name)}${i.lan1 ? '（LAN1 摄像机网）' : ''}</td><td>${i.ipv4.map(esc).join('<br>') || '—'}</td><td><code>${esc(i.mac) || '—'}</code></td></tr>`)
    .join('')
  const j = s.join
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10"><title>LSA-9600EG 待接入</title>
<style>
body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:0;padding:24px;background:#f5f6f8;color:#1f2329}
.card{max-width:760px;margin:0 auto;background:#fff;border-radius:10px;padding:24px 28px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 4px}.tag{display:inline-block;background:#fff4e5;color:#b25e00;border:1px solid #f5c37a;border-radius:4px;padding:2px 10px;font-size:14px;margin-left:8px}
.muted{color:#646a73;font-size:13px}table{border-collapse:collapse;width:100%;margin:8px 0 16px}td,th{border-bottom:1px solid #e5e6eb;padding:8px 6px;text-align:left;font-size:14px;vertical-align:top}
th{color:#646a73;font-weight:normal;width:150px}code{font-family:ui-monospace,Consolas,monospace;font-size:13px}.next{background:#f2f8ff;border-left:3px solid #3370ff;padding:10px 14px;font-size:14px;line-height:1.7}
@media (prefers-color-scheme:dark){body{background:#17181a;color:#e8e9eb}.card{background:#222326}td,th{border-color:#34363a}.next{background:#1d2a3f}.muted,th{color:#9da3ab}}
</style></head><body><div class="card">
<h1>LSA-9600EG<span class="tag">待接入</span></h1>
<div class="muted">${esc(s.host)} · 软件 ${esc(s.version || '?')} · 本地 TB ${s.localTb ? '已起' : '没起来'} · 每 10 秒刷新 · 本页只读</div>
<h3>接入授权</h3><table>
<tr><th>授权的子站</th><td>${j.sp ? esc(j.sp) : '还没有（装的时候没给 --join-key）'}</td></tr>
${j.at ? `<tr><th>授权时间</th><td>${esc(j.at)}</td></tr>` : ''}
${j.tunnelFp ? `<tr><th>隧道 key 指纹</th><td><code>${esc(j.tunnelFp)}</code></td></tr>` : ''}
${j.upgradeFp ? `<tr><th>升级 key 指纹</th><td><code>${esc(j.upgradeFp)}</code></td></tr>` : ''}
</table>
<h3>本机网口</h3><table><tr><th>网口</th><th>IPv4</th><th>MAC</th></tr>${rows}</table>
<div class="next">${
    j.sp
      ? `下一步在子站主机（${esc(j.sp)}）上执行：<br><code>sudo bash /opt/lsa9600sp/join-egs.sh --unit &lt;单元号，如 AH07-A&gt; --eg ${esc(lan2)}</code>`
      : '这台 EG 还没给子站授权：用子站 <code>join-egs.sh --keygen</code> 打印的那一行重装：<code>--role eg --join-key \'…\'</code>'
  }</div>
</div></body></html>`
}

createServer(async (req, res) => {
  if (denied(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('403：管理页不对摄像机网口（LAN1）开放')
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET' }).end()
    return
  }
  const s = await state()
  if (req.url?.startsWith('/api/pending')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(s))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page(s))
}).listen(PORT, '0.0.0.0', () => console.log(`待接入页：听 ${PORT}（LAN1 拒绝：${DENY.join(',') || '无'}）`))
