/* 盘满兜底（V3 A12 补，协调会话 2026-10-08）。
 *
 * 要上传、还没确认归档的证据到期也不删（唯一副本）—— 上传长期失败时盘会满。数据盘超 purgeWater 时按顺序腾地方，降到 highWater 以下就停：
 *   ① 循环录像最旧的段：eg-video 的 trimForDisk 超 highWater 就在删（保留最近 1 h，新证据的前窗要用）
 *   ② 已上传子站的本地副本（子站有一份，删了不丢；位置改 station）
 *   ③ 不需要上传的本地证据（没标重要、子站也没要；状态 DELETED，missingReason disk_purged）
 *   ④ 待上传、还没确认归档的（唯一副本）：最后才删，状态 DELETED，missingReason disk_purged_unuploaded；
 *      报 EG 告警「证据未上传即被清理」（送子站），写日志与审计
 * 每删一份重新量一次盘。新录像与新证据始终要能写进去：fullWater（新锁定标缺证）只在这些都删完了还满时才出现。
 * 纯逻辑放这里（verify/evidence-purge.ts 用临时库测），文件删除、量盘、告警由调用方给。 */
import type { EvidenceRow } from './evidence.store.js'

export type PurgeStep = 'uploaded' | 'not_wanted' | 'unuploaded'

export interface PurgeDeps {
  /** 当前数据盘占用 %（每删一份重新量） */
  used: () => number | null
  /** 按步骤取候选，旧的在前 */
  candidates: (step: PurgeStep) => EvidenceRow[]
  /** 删一份本地文件并改这条的状态；删不掉返回 false */
  remove: (row: EvidenceRow, step: PurgeStep) => boolean
}

export interface PurgeResult {
  /** 开始时的占用 */
  before: number | null
  after: number | null
  removed: Record<PurgeStep, number>
  /** 第④步删掉的（报告警用）：条数与最早一条的创建时刻 */
  unuploaded: { n: number; oldest: number | null; ids: string[] }
}

export const STEPS: PurgeStep[] = ['uploaded', 'not_wanted', 'unuploaded']

/** 第②–④步：超 purgeWater 才动手，降到 highWater 以下就停 */
export function purge(deps: PurgeDeps, purgeWater: number, highWater: number): PurgeResult {
  const before = deps.used()
  const res: PurgeResult = { before, after: before, removed: { uploaded: 0, not_wanted: 0, unuploaded: 0 }, unuploaded: { n: 0, oldest: null, ids: [] } }
  if (before === null || before < purgeWater) return res
  let used: number | null = before
  for (const step of STEPS) {
    for (const r of deps.candidates(step)) {
      if (used === null || used < highWater) break
      if (!deps.remove(r, step)) continue
      res.removed[step]++
      if (step === 'unuploaded') {
        res.unuploaded.n++
        res.unuploaded.ids.push(r.evidenceId)
        res.unuploaded.oldest = res.unuploaded.oldest === null ? r.createdAt : Math.min(res.unuploaded.oldest, r.createdAt)
      }
      used = deps.used()
    }
    if (used === null || used < highWater) break
  }
  res.after = used
  return res
}

/** 到期清理（clean）的条件：到期、有本地文件，但要上传、还没确认归档的不删（唯一副本，V3 A12） */
export const EXPIRED_SQL = "expires_at is not null and expires_at < ? and file is not null and not (upload_wanted = 1 and status = 'READY')"

/** 各步的候选（SQL 条件，旧的在前）：都要有本地文件 */
export const CANDIDATE_SQL: Record<PurgeStep, string> = {
  uploaded: "file is not null and status = 'UPLOADED' order by created_at",
  not_wanted: "file is not null and status = 'READY' and upload_wanted = 0 order by created_at",
  unuploaded: "file is not null and status = 'READY' and upload_wanted = 1 order by created_at",
}
