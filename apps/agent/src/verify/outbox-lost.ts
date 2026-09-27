/* outbox 丢失记账的自检（i2:verify 调；也能单独跑：node --import @swc-node/register/esm-register src/verify/outbox-lost.ts）。
 * 子站按 eg.lost 的丢弃总数变大建「缓存溢出」告警（后端 7d3d9b4），所以总数要累计、只增不减：
 * 多次丢弃合并、段数超上限折叠、重开库（agent 重启）后总数与丢弃时刻都不变。用临时库，不碰正在用的 outbox。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LOST_SEGMENTS, OutboxStore } from '../uplink/outbox.store.js'

type Check = (ok: boolean, name: string, detail?: string) => unknown

export function checkLostAccounting(check: Check): void {
  const dir = mkdtempSync(join(tmpdir(), 'eg-outbox-'))
  const file = join(dir, 'outbox.db')
  try {
    let s = new OutboxStore(file)
    const t0 = Date.parse('2026-09-01T00:00:00Z')
    // 1. 超量时每分钟丢一批最旧的：源时间首尾相接，应并成一段
    const body = 'x'.repeat(1000)
    s.push(Array.from({ length: 600 }, (_, i) => ({ dev: 'SAM-X', kind: 't' as const, ts: t0 + i * 2000, body })))
    let dropped = 0
    const totals: number[] = []
    for (const limit of [500_000, 400_000, 300_000]) {
      dropped += s.trim(0, limit)?.n ?? 0
      totals.push(s.lostTotal())
    }
    check(dropped > 0 && s.lost().length === 1 && s.lostTotal() === dropped, '连续几次超量丢弃并成一段、总数 = 丢弃条数', `${s.lost().length} 段，共 ${s.lostTotal()} 条`)
    check(totals.every((v, i) => i === 0 || v >= totals[i - 1]!), '每次丢弃后总数只增不减', totals.join(' → '))

    // 2. 互不相接的丢失段超过上限：折叠最旧的，段数封顶、总数不变
    for (let i = 0; i < LOST_SEGMENTS + 10; i++) s.recordLost({ from: t0 + 86_400_000 * (i + 1), to: t0 + 86_400_000 * (i + 1) + 60_000, n: 7 })
    const want = dropped + 7 * (LOST_SEGMENTS + 10)
    check(s.lost().length === LOST_SEGMENTS && s.lostTotal() === want, `段数超 ${LOST_SEGMENTS} 时折叠最旧的、条数总和不变`, `${s.lost().length} 段，共 ${s.lostTotal()} 条（应 ${want}）`)
    const sum = s.lost().reduce((a, r) => a + r.n, 0)
    check(sum === s.lostTotal(), 'eg.lost 数组的条数之和就是累计丢弃数（子站按它比大小）')
    const lastAt = s.lastLostAt()

    // 3. 重开库（agent 重启）
    s.close()
    s = new OutboxStore(file)
    check(s.lostTotal() === want && s.lost().length === LOST_SEGMENTS, '重启后总数与段数不变（不清零）', `${s.lostTotal()} 条`)
    check(s.lastLostAt() === lastAt && lastAt > 0, '最近一次丢弃时刻重启后还在（eg.outbox_full 的保持期接着算）')
    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let fail = 0
  checkLostAccounting((ok, name, detail) => {
    if (!ok) fail++
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  —— ${detail}` : ''}`)
  })
  process.exit(fail ? 1 : 0)
}
