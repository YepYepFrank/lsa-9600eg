/* ONVIF 的最小客户端：只用 Media（ver10）的 GetProfiles / GetStreamUri / GetSnapshotUri，外加 Device 的 GetCapabilities 找 Media 服务地址。
 * 鉴权：SOAP 头带 WS-Security UsernameToken（PasswordDigest = Base64(SHA1(nonce + created + 口令))）；摄像机回 401 时再按 HTTP 摘要重发。
 * 不引 XML 库：只取固定几个字段，按本地名匹配（忽略命名空间前缀）。 */
import { createHash, randomBytes } from 'node:crypto'
import { fetchAuth } from './digest.js'

export interface OnvifProfile {
  token: string
  name: string
  /** 视频源（可见光 / 热像各一个源是常见划分） */
  source: string
  width: number
  height: number
  encoding: string
}

export class OnvifError extends Error {}

const NS_MEDIA = 'http://www.onvif.org/ver10/media/wsdl'
const NS_DEVICE = 'http://www.onvif.org/ver10/device/wsdl'

function security(user: string, pass: string): string {
  if (!user) return ''
  const nonce = randomBytes(16)
  const created = new Date().toISOString()
  const digest = createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(pass)])).digest('base64')
  return (
    '<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
    `<UsernameToken><Username>${esc(user)}</Username>` +
    `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>` +
    `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>` +
    `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>` +
    '</UsernameToken></Security></s:Header>'
  )
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 第一个本地名为 tag 的元素的文本 */
export function textOf(xml: string, tag: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${tag}>`).exec(xml)
  return m ? m[1]!.trim() : null
}

/** 本地名为 tag 的全部元素：属性串 + 内部 XML */
export function elementsOf(xml: string, tag: string): { attrs: string; body: string }[] {
  const re = new RegExp(`<(?:\\w+:)?${tag}(\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g')
  return [...xml.matchAll(re)].map(m => ({ attrs: m[1] ?? '', body: m[2] ?? '' }))
}

const attrOf = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? ''

export class OnvifClient {
  private mediaUrl: string | null = null

  constructor(
    private readonly deviceUrl: string,
    private readonly user: string,
    private readonly pass: string,
  ) {}

  private async call(url: string, body: string): Promise<string> {
    const env = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${security(this.user, this.pass)}<s:Body>${body}</s:Body></s:Envelope>`
    let r: Response
    try {
      r = await fetchAuth(url, { method: 'POST', headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' }, body: env, user: this.user, pass: this.pass })
    } catch (e) {
      throw new OnvifError(`连不上 ${url}：${(e as Error).cause ? String((e as Error).cause) : (e as Error).message}`)
    }
    const text = await r.text()
    if (/<(?:\w+:)?Fault\b/.test(text)) {
      const reason = textOf(text, 'Text') ?? textOf(text, 'Value') ?? `HTTP ${r.status}`
      throw new OnvifError(/NotAuthorized|Sender/i.test(text) && /auth/i.test(text) ? `认证失败：${reason}` : reason)
    }
    if (!r.ok) throw new OnvifError(r.status === 401 ? '认证失败（HTTP 401）' : `HTTP ${r.status}`)
    return text
  }

  /** Media 服务地址（GetCapabilities）；取不到就用设备服务地址本身（不少摄像机两者同址） */
  private async media(): Promise<string> {
    if (this.mediaUrl) return this.mediaUrl
    try {
      const x = await this.call(this.deviceUrl, `<GetCapabilities xmlns="${NS_DEVICE}"><Category>Media</Category></GetCapabilities>`)
      const media = elementsOf(x, 'Media')[0]
      this.mediaUrl = (media && textOf(media.body, 'XAddr')) || this.deviceUrl
    } catch (e) {
      if (e instanceof OnvifError && /认证/.test(e.message)) throw e
      this.mediaUrl = this.deviceUrl
    }
    return this.mediaUrl
  }

  async profiles(): Promise<OnvifProfile[]> {
    const x = await this.call(await this.media(), `<GetProfiles xmlns="${NS_MEDIA}"/>`)
    return elementsOf(x, 'Profiles').map(p => {
      const enc = elementsOf(p.body, 'VideoEncoderConfiguration')[0]?.body ?? ''
      const src = elementsOf(p.body, 'VideoSourceConfiguration')[0]?.body ?? ''
      return {
        token: attrOf(p.attrs, 'token'),
        name: textOf(p.body, 'Name') ?? '',
        source: textOf(src, 'SourceToken') ?? '',
        width: Number(textOf(enc, 'Width') ?? 0),
        height: Number(textOf(enc, 'Height') ?? 0),
        encoding: textOf(enc, 'Encoding') ?? '',
      }
    })
  }

  async streamUri(profile: string): Promise<string> {
    const x = await this.call(
      await this.media(),
      `<GetStreamUri xmlns="${NS_MEDIA}"><StreamSetup><Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>` +
        `<Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport></StreamSetup><ProfileToken>${esc(profile)}</ProfileToken></GetStreamUri>`,
    )
    const uri = textOf(x, 'Uri')
    if (!uri) throw new OnvifError(`GetStreamUri（${profile}）没有返回地址`)
    return uri.replace(/&amp;/g, '&')
  }

  /** 抓图地址；摄像机不支持返回 null */
  async snapshotUri(profile: string): Promise<string | null> {
    try {
      const x = await this.call(await this.media(), `<GetSnapshotUri xmlns="${NS_MEDIA}"><ProfileToken>${esc(profile)}</ProfileToken></GetSnapshotUri>`)
      return textOf(x, 'Uri')?.replace(/&amp;/g, '&') ?? null
    } catch {
      return null
    }
  }
}

export type ChannelKey = 'visible' | 'visibleSub' | 'thermal' | 'thermalSub'

/** 按视频源分可见光 / 热像、按分辨率分主 / 子码流（接口约定 §5、G4-1）。
 *  热像源：名字里带 thermal / ir / 热，否则取最大分辨率较小的那个源（热像传感器分辨率低）。
 *  某个源只有一个配置文件时，子码流就用主码流。 */
export function mapProfiles(ps: OnvifProfile[]): { map: Partial<Record<ChannelKey, OnvifProfile>>; note: string | null } {
  const bySource = new Map<string, OnvifProfile[]>()
  for (const p of ps) bySource.set(p.source || '?', [...(bySource.get(p.source || '?') ?? []), p])
  const sources = [...bySource.entries()].map(([id, list]) => ({
    id,
    list: [...list].sort((a, b) => b.width * b.height - a.width * a.height),
    thermalName: list.some(p => /thermal|infra|\bir\b|热/i.test(`${p.name} ${id}`)),
  }))
  if (!sources.length) return { map: {}, note: '摄像机没有返回任何配置文件' }
  const pick = (list: OnvifProfile[]) => ({ main: list[0]!, sub: list[list.length - 1]! })
  if (sources.length === 1) {
    const v = pick(sources[0]!.list)
    return { map: { visible: v.main, visibleSub: v.sub }, note: '只有一个视频源：当作可见光；热像两路请在本地管理页手填' }
  }
  const area = (s: (typeof sources)[number]) => s.list[0]!.width * s.list[0]!.height
  const thermal = sources.find(s => s.thermalName) ?? [...sources].sort((a, b) => area(a) - area(b))[0]!
  const visible = sources.find(s => s !== thermal && !s.thermalName) ?? sources.find(s => s !== thermal)!
  const v = pick(visible.list)
  const t = pick(thermal.list)
  return {
    map: { visible: v.main, visibleSub: v.sub, thermal: t.main, thermalSub: t.sub },
    note: sources.length > 2 ? `有 ${sources.length} 个视频源，只用了其中两个（${visible.id}、${thermal.id}）` : null,
  }
}
