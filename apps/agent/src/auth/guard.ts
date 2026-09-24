/* 全局守卫：/api 下除了 @Public() 的都要会话（Authorization: Bearer <令牌>）；@Maint() 的要维护角色。
 * 管理页的静态文件不走这里（express.static 在 Nest 路由之前）。 */
import { createParamDecorator, Injectable, SetMetadata, UnauthorizedException, ForbiddenException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { AuthService, type Session } from './auth.service.js'

const PUBLIC = 'eg:public'
const MAINT = 'eg:maint'
export const Public = () => SetMetadata(PUBLIC, true)
export const Maint = () => SetMetadata(MAINT, true)

export const CurrentSession = createParamDecorator((_d: unknown, ctx: ExecutionContext): Session => {
  return (ctx.switchToHttp().getRequest<Request>() as Request & { session: Session }).session
})

/** 客户端地址：经子站反代时取 X-Forwarded-For 的第一个 */
export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for']
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
  return first || req.socket.remoteAddress || '?'
}

export const ClientIp = createParamDecorator((_d: unknown, ctx: ExecutionContext): string => clientIp(ctx.switchToHttp().getRequest<Request>()))

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true
    const req = ctx.switchToHttp().getRequest<Request & { session?: Session }>()
    const h = req.headers.authorization
    const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined
    const s = this.auth.session(token)
    if (!s) throw new UnauthorizedException({ code: 'no_session', message: '未登录或会话已过期' })
    req.session = s
    if (this.reflector.getAllAndOverride<boolean>(MAINT, targets) && s.role !== 'maint') {
      throw new ForbiddenException({ code: 'no_permission', message: '只读账号不能做这项操作（要子站「网关维护」权限或本地维护账号）' })
    }
    return true
  }
}
