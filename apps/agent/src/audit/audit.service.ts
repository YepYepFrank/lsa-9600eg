/* EG 本地审计：登录、单点登录、改口令、重启组件、改本地配置…… 一行一条 JSON，写在配置目录的 audit.log。
 * 超过 5 MB 滚动，留 3 份。经子站进来的操作，子站那边另记了「打开 EG 管理页」（谁、何时、哪台）。 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Inject, Injectable } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'

export interface AuditEntry {
  ts: number
  user: string
  name: string
  /** local 本机账号 / sp 经子站单点登录 / system */
  via: 'local' | 'sp' | 'system'
  ip: string
  action: string
  target: string
  ok: boolean
  detail?: string
}

const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 3

@Injectable()
export class AuditService {
  private readonly file: string

  constructor(@Inject(EG_CONFIG) cfg: EgConfig) {
    this.file = resolve(cfg.dir, 'audit.log')
  }

  write(e: Omit<AuditEntry, 'ts'>): void {
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) this.rotate()
      appendFileSync(this.file, JSON.stringify({ ts: Date.now(), ...e }) + '\n', 'utf8')
    } catch {
      /* 审计写不进去不能挡住业务（磁盘满时本地页的诊断会报） */
    }
  }

  /** 最近 limit 条，新的在前 */
  recent(limit = 200): AuditEntry[] {
    if (!existsSync(this.file)) return []
    const lines = readFileSync(this.file, 'utf8').trim().split('\n')
    const out: AuditEntry[] = []
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]!) as AuditEntry)
      } catch {
        /* 半行（断电）跳过 */
      }
    }
    return out
  }

  private rotate(): void {
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`
      if (existsSync(from)) renameSync(from, `${this.file}.${i + 1}`)
    }
    renameSync(this.file, `${this.file}.1`)
  }
}
