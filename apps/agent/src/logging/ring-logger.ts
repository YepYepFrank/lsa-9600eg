/* eg-agent 自己的日志：照常打到控制台（docker 收），另在内存里留最近 1000 行给本地管理页「日志」看 */
import { ConsoleLogger } from '@nestjs/common'

const MAX = 1000

export class RingLogger extends ConsoleLogger {
  static readonly lines: string[] = []

  private keep(level: string, message: unknown, context?: string): void {
    const t = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    RingLogger.lines.push(`${t} ${level} [${context ?? this.context ?? ''}] ${typeof message === 'string' ? message : JSON.stringify(message)}`)
    if (RingLogger.lines.length > MAX) RingLogger.lines.splice(0, RingLogger.lines.length - MAX)
  }

  override log(message: unknown, context?: string): void {
    this.keep('信息', message, context)
    super.log(message, ...(context ? [context] : []))
  }
  override warn(message: unknown, context?: string): void {
    this.keep('警告', message, context)
    super.warn(message, ...(context ? [context] : []))
  }
  override error(message: unknown, stack?: string, context?: string): void {
    this.keep('错误', message, context)
    super.error(message, ...([stack, context].filter(Boolean) as string[]))
  }
}
