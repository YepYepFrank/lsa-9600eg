/* 事件时延记账（event_timing）的自检（i3:verify 调；也能单独跑：node --import @swc-node/register/esm-register src/verify/event-timing.ts）。
 * 每一版记：本地 TB 发生 / 恢复时刻 → 钩子到 → 排进待送 → 第一次 POST → 子站回执，毫秒；重试只记第一次发出、累计次数；
 * 拒收不算回执；30 天后清掉。用临时库，不碰正在用的 events.db。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventsStore } from '../alarms/events.store.js'

type Check = (ok: boolean, name: string, detail?: string) => unknown

export function checkEventTiming(check: Check): void {
  const dir = mkdtempSync(join(tmpdir(), 'eg-events-'))
  const file = join(dir, 'events.db')
  try {
    let s = new EventsStore(file)
    const t0 = Date.parse('2026-09-01T00:00:00Z')
    const base = { eventId: '11111111-1111-4111-8111-111111111111', device: 'SAM-X-A', type: '弧光异常', severity: 'CRITICAL', details: {} }

    // 1. 钩子带出来的第 1 版：发生 t0，钩子 +120 ms，排队 +150 ms，第一次发 +160 ms（失败），重发 +2160 ms，回执 +2400 ms
    s.observe({ ...base, state: 'ACTIVE', occurredAt: t0, clearedAt: null }, t0 + 150, t0 + 120)
    s.markSent([{ eventId: base.eventId, revision: 1 }], t0 + 160)
    s.markSent([{ eventId: base.eventId, revision: 1 }], t0 + 2160)
    s.settle(base.eventId, 1, true, t0 + 2400)
    const [a] = s.timing(base.eventId)
    check(
      !!a && a.at === t0 && a.hookAt === t0 + 120 && a.queuedAt === t0 + 150 && a.sentAt === t0 + 160 && a.ackedAt === t0 + 2400 && a.tries === 2 && a.via === 'hook',
      '第 1 版：发生 / 钩子 / 排队 / 第一次发 / 回执都按毫秒记，重试只累计次数',
      a ? `钩子 +${a.hookAt! - a.at}、排队 +${a.queuedAt - a.at}、发 +${a.sentAt! - a.at}、回执 +${a.ackedAt! - a.at} ms，${a.tries} 次` : '没有',
    )

    // 2. 对账补出来的恢复版：没有钩子时刻、起点是恢复时刻；子站拒收不算回执
    s.observe({ ...base, state: 'CLEARED', occurredAt: t0, clearedAt: t0 + 60_000 }, t0 + 70_000, null)
    s.markSent([{ eventId: base.eventId, revision: 2 }], t0 + 70_010)
    s.settle(base.eventId, 2, false, t0 + 70_100)
    const b = s.timing(base.eventId).find(t => t.revision === 2)
    check(!!b && b.via === 'reconcile' && b.hookAt === null && b.at === t0 + 60_000 && b.ackedAt === null, '第 2 版（对账补的恢复）：via = reconcile、起点 = 恢复时刻、拒收不记回执')

    // 3. 重开库（agent 重启）还在；30 天后清掉
    s.close()
    s = new EventsStore(file)
    check(s.timing(base.eventId).length === 2, '重启后时延记录还在')
    s.prune(t0 + 31 * 86_400_000)
    check(s.timing(base.eventId).length === 0, '30 天后清掉')
    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let fail = 0
  checkEventTiming((ok, name, detail) => {
    if (!ok) fail++
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  —— ${detail}` : ''}`)
  })
  process.exit(fail ? 1 : 0)
}
