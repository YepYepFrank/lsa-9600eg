/* 上送切批的自检（i2:verify 调；也能单独跑：node --import @swc-node/register/esm-register src/verify/outbox-chunk.ts）。
 * §8.1 修订：一次发布 ≤ 500 条且 ≤ 48 KB（子站 TB 单条 MQTT 消息上限 64 KB，超了断连接、补传永远补不完）。
 * 用临时库模拟一次大积压的补传：假子站收到 > 64 KB 的消息就「断开」（这一批不确认），看能不能补完、每批多大。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chunkRows, MAX_PAYLOAD_BYTES, MAX_SAMPLES } from '../uplink/chunk.js'
import { OutboxStore } from '../uplink/outbox.store.js'

type Check = (ok: boolean, name: string, detail?: string) => unknown

const TB_LIMIT = 64 * 1024

export function checkChunking(check: Check): void {
  const dir = mkdtempSync(join(tmpdir(), 'eg-chunk-'))
  try {
    const s = new OutboxStore(join(dir, 'outbox.db'))
    const t0 = Date.parse('2026-09-01T00:00:00Z')
    // 一面柜 30 分钟的积压：3 台 SAM 各 2 s 一条（~300 字节）、电表带谐波 JSON（~1.5 KB）、EG 自身指标、几条属性；外加一条 70 KB 的畸形数据
    const harm = JSON.stringify(Array.from({ length: 50 }, (_, i) => Math.round(Math.random() * 1000) / 100))
    const rows: { dev: string; kind: 't' | 'a'; ts: number; body: string }[] = []
    for (let i = 0; i < 900; i++) {
      const ts = t0 + i * 2000
      for (const d of ['SAM-X-A', 'SAM-X-B', 'SAM-X-C']) rows.push({ dev: d, kind: 't', ts, body: JSON.stringify(Object.fromEntries(Array.from({ length: 14 }, (_, k) => [`ir.k${k}`, 20 + Math.random() * 40]))) })
      rows.push({ dev: 'PM-X', kind: 't', ts, body: JSON.stringify({ 'el.Ia': 50, 'el.harm_u': harm, 'el.harm_i': harm }) })
      if (i % 3 === 0) rows.push({ dev: 'EG-X', kind: 't', ts, body: JSON.stringify({ 'eg.cpu': 12.3, 'eg.mem': 40.1, 'eg.state': 'online' }) })
    }
    rows.push({ dev: 'PM-X', kind: 't', ts: t0 + 5000, body: JSON.stringify({ 'el.harm_bad': 'x'.repeat(70 * 1024) }) })
    rows.push({ dev: 'EG-X', kind: 'a', ts: t0, body: JSON.stringify({ cfg: 'c-1', tbVersion: '4.2.2.5' }) })
    rows.push({ dev: 'SAM-X-A', kind: 'a', ts: t0, body: JSON.stringify({ fw: 'v2.1.0' }) })
    s.push(rows)
    const total = s.stats().depth

    // 按上送服务的做法取批（每次 ≤ 500 行）→ 切批 → 假子站：> 64 KB 断开（不确认），否则确认
    let maxBytes = 0
    let maxSamples = 0
    let publishes = 0
    let rejected = 0
    let dropped = 0
    let cursor = 0
    for (let round = 0; round < 1000 && s.stats().depth > 0; round++) {
      const batch = s.take(cursor, Number.MAX_SAFE_INTEGER, 500)
      if (!batch.length) break
      cursor = batch[batch.length - 1]!.seq
      const { publishes: ps, oversized } = chunkRows(batch, 'EG-X')
      for (const r of oversized) {
        s.ack([r.seq])
        dropped++
      }
      for (const p of ps) {
        publishes++
        const b = Buffer.byteLength(p.payload)
        maxBytes = Math.max(maxBytes, b)
        maxSamples = Math.max(maxSamples, p.seqs.length)
        if (b > TB_LIMIT) rejected++
        else s.ack(p.seqs)
      }
    }
    check(s.stats().depth === 0, `大批补传补得完（${total} 条、${publishes} 次发布）`, `剩 ${s.stats().depth} 条`)
    check(maxBytes <= MAX_PAYLOAD_BYTES && rejected === 0, '每次发布 ≤ 48 KB（子站 64 KB 上限不会断连接）', `最大 ${(maxBytes / 1024).toFixed(1)} KB`)
    check(maxSamples <= MAX_SAMPLES, '每次发布 ≤ 500 条', `最多 ${maxSamples} 条`)
    check(dropped === 1, '单条就超上限的那一条丢弃、不卡队列', `丢 ${dropped} 条`)
    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let fail = 0
  checkChunking((ok, name, detail) => {
    if (!ok) fail++
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  —— ${detail}` : ''}`)
  })
  process.exit(fail ? 1 : 0)
}
