/* 盘满兜底与「归档前不删唯一副本」的自检（g5:verify 调；也能单独跑：node --import @swc-node/register/esm-register src/verify/evidence-purge.ts）。
 * 用临时库与假的「数据盘」（每份文件占一定百分比），不碰正在用的 evidence.db：
 *   1. 到期清理（EXPIRED_SQL）：到期的已上传 / 不需上传的清，要上传、还没确认归档的不清
 *   2. 没超 purgeWater：什么都不删
 *   3. 超了：已上传 → 不需上传 → 待上传，各类里旧的先删，降到 highWater 以下就停；
 *      只删前两类就够时不报告警；要删到待上传时报出条数与最早时刻（告警用） */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EvidenceStore, type EvidenceRow, type EvStatus } from '../evidence/evidence.store.js'
import { CANDIDATE_SQL, EXPIRED_SQL, purge, type PurgeStep } from '../evidence/purge.js'

type Check = (ok: boolean, name: string, detail?: string) => unknown

const T0 = Date.parse('2026-10-01T00:00:00Z')
function row(id: string, status: EvStatus, uploadWanted: boolean, created: number, expires: number | null): EvidenceRow {
  return {
    evidenceId: id, revision: 1, eventId: null, requestId: null, groupId: 'g', cabinetId: 'AH99', gatewayId: 'EG-AH99', channelId: 'visible', kind: 'video',
    requestedStart: created, requestedEnd: created + 90_000, actualStart: created, actualEnd: created + 90_000, status, location: status === 'UPLOADED' ? 'both' : 'edge',
    sizeBytes: 1, codec: 'h264', sha256: 'x', important: uploadWanted, pairOffsetMs: 0, createdAt: created, expiresAt: expires, missingReason: null,
    file: `${id}.mp4`, dueAt: null, uploadTries: 0, uploadNext: 0, uploadError: null, uploadWanted,
  }
}

/** 一套场景：base % + 每份文件 pct %；返回 purge 的结果与删掉的顺序 */
function scenario(base: number, pct: number) {
  const dir = mkdtempSync(join(tmpdir(), 'eg-purge-'))
  const s = new EvidenceStore(join(dir, 'evidence.db'))
  // 每类 3 份，创建时刻故意打乱插入顺序，看是不是按旧的先删
  const add = (p: string, st: EvStatus, up: boolean) => [2, 0, 1].forEach(i => s.insert(row(`${p}${i}`, st, up, T0 + i * 60_000, null)))
  add('up', 'UPLOADED', true)
  add('nw', 'READY', false)
  add('un', 'READY', true)
  const on = new Set(s.where('file is not null').map(r => r.evidenceId))
  const order: string[] = []
  const r = purge(
    {
      used: () => base + on.size * pct,
      candidates: (step: PurgeStep) => s.where(CANDIDATE_SQL[step]),
      remove: (x: EvidenceRow, step: PurgeStep) => {
        on.delete(x.evidenceId)
        order.push(x.evidenceId)
        s.update(x.evidenceId, step === 'uploaded' ? { location: 'station', file: null } : { status: 'DELETED', location: 'none', file: null })
        return true
      },
    },
    90,
    85,
  )
  s.close()
  rmSync(dir, { recursive: true, force: true })
  return { r, order }
}

export function checkEvidencePurge(check: Check): void {
  // 1. 到期清理
  const dir = mkdtempSync(join(tmpdir(), 'eg-purge-'))
  try {
    const s = new EvidenceStore(join(dir, 'evidence.db'))
    const past = T0 - 1
    s.insert(row('a-up', 'UPLOADED', true, T0 - 9e8, past))
    s.insert(row('a-nw', 'READY', false, T0 - 9e8, past))
    s.insert(row('a-un', 'READY', true, T0 - 9e8, past))
    s.insert(row('a-fresh', 'READY', false, T0 - 9e8, T0 + 9e8))
    const ids = s.where(EXPIRED_SQL, T0).map(r => r.evidenceId).sort()
    check(ids.join() === 'a-nw,a-up', '到期清理：已上传、不需上传的到期就清；待上传未归档的（唯一副本）到期也不清；没到期的不清', ids.join('、'))
    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // 2. 没超 purgeWater（80 + 9 份 × 1 % = 89 %）
  const a = scenario(80, 1)
  check(a.order.length === 0 && a.r.before === 89, `占用 ${a.r.before} % < 90 %：什么都不删`)

  // 3a. 超了，删前两类就够（78 + 9 × 2 = 96 → 删 3 份已上传到 90、再删不需上传的到 84）
  const b = scenario(78, 2)
  check(b.order.join() === 'up0,up1,up2,nw0,nw1,nw2' && b.r.unuploaded.n === 0, `占用 ${b.r.before} %：先删已上传的（旧的先），再删不需上传的，降到 ${b.r.after} % < 85 % 就停，待上传的一份没动、不报告警`, b.order.join(' '))

  // 3b. 要删到待上传（82 + 9 × 2 = 100 → 前两类删完 88，再删 2 份待上传到 84）
  const c = scenario(82, 2)
  check(
    c.order.join() === 'up0,up1,up2,nw0,nw1,nw2,un0,un1' && c.r.unuploaded.n === 2 && c.r.unuploaded.oldest === T0 && c.r.unuploaded.ids.join() === 'un0,un1',
    `占用 ${c.r.before} %：前两类删完还超，删待上传的最旧 ${c.r.unuploaded.n} 份到 ${c.r.after} %；报告警用的条数 ${c.r.unuploaded.n}、最早 ${c.r.unuploaded.oldest === T0 ? '= 最旧那份' : c.r.unuploaded.oldest}`,
    c.order.join(' '),
  )
  check(c.r.removed.uploaded === 3 && c.r.removed.not_wanted === 3 && c.r.removed.unuploaded === 2, '各类删的份数记对了', JSON.stringify(c.r.removed))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let fail = 0
  checkEvidencePurge((ok, name, detail) => {
    if (!ok) fail++
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  —— ${detail}` : ''}`)
  })
  process.exit(fail ? 1 : 0)
}
