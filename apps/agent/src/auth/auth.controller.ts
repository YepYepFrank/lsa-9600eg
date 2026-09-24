/* 登录、单点登录、退出、改口令、当前会话 */
import { Body, Controller, ForbiddenException, Get, HttpCode, Post, UnauthorizedException } from '@nestjs/common'
import { IsString, MaxLength } from 'class-validator'
import { AuthError, AuthService, POLICY, type Session } from './auth.service.js'
import { ClientIp, CurrentSession, Public } from './guard.js'

class LoginDto {
  @IsString() @MaxLength(64) user!: string
  @IsString() @MaxLength(128) password!: string
}
class SsoDto {
  @IsString() @MaxLength(4096) ticket!: string
}
class PasswordDto {
  @IsString() @MaxLength(128) oldPassword!: string
  @IsString() @MaxLength(128) newPassword!: string
}

const view = (s: Session) => ({ token: s.token, user: s.user, name: s.name, role: s.role, via: s.via, sessionMin: POLICY.sessionMin })

function fail(e: unknown): never {
  if (e instanceof AuthError) {
    if (e.code === 'weak_password') throw new ForbiddenException({ code: e.code, message: e.message })
    throw new UnauthorizedException({ code: e.code, message: e.message })
  }
  throw e
}

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() b: LoginDto, @ClientIp() ip: string) {
    try {
      return view(this.auth.login(b.user, b.password, ip))
    } catch (e) {
      fail(e)
    }
  }

  @Public()
  @Post('sso')
  @HttpCode(200)
  sso(@Body() b: SsoDto, @ClientIp() ip: string) {
    try {
      return view(this.auth.sso(b.ticket, ip))
    } catch (e) {
      fail(e)
    }
  }

  @Post('logout')
  @HttpCode(200)
  logout(@CurrentSession() s: Session) {
    this.auth.logout(s)
    return { ok: true }
  }

  @Get('me')
  me(@CurrentSession() s: Session) {
    return { ...view(s), token: undefined, account: s.via === 'local' ? this.auth.accountInfo() : null }
  }

  /** 改本地维护账号的口令（要原口令）。经子站进来的维护人员也能改 —— 交接时常用 */
  @Post('password')
  @HttpCode(200)
  password(@CurrentSession() s: Session, @Body() b: PasswordDto) {
    if (s.role !== 'maint') throw new ForbiddenException({ code: 'no_permission', message: '只读账号不能改口令' })
    try {
      this.auth.changePassword(s, b.oldPassword, b.newPassword)
      return { ok: true }
    } catch (e) {
      fail(e)
    }
  }
}
