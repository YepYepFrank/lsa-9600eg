/* 电表变比（I3）的自检（a11:verify 调；也能单独跑：node --import @swc-node/register/esm-register src/verify/meters.ts）。纯函数，不碰样机。 */
import { pathToFileURL } from 'node:url'
import { factorOf, parseMeters, toPrimary } from '../meters/meters.service.js'

type Check = (ok: boolean, name: string, detail?: string) => unknown

export function checkMeters(check: Check): void {
  const r = { ct: 40, pt: 100 }
  const raw = { 'el.Ua': 57.66, 'el.Ia': 2.69, 'el.P': 0.4481, 'el.Ep': 1282.1331, 'el.PF': 0.942, 'el.F': 50, 'el.THDu': 1.9, 'el.hu.A': '[1,2]', 'el.load_pct': 44.4 }
  const p = toPrimary(raw, r)
  check(p['el.Ua'] === 5766 && p['el.Ia'] === 107.6 && p['el.P'] === 1792.4 && p['el.Ep'] === 5128532.4,
    `电压 × pt、电流 × ct、P / Ep × pt × ct：Ua ${p['el.Ua']}、Ia ${p['el.Ia']}、P ${p['el.P']}、Ep ${p['el.Ep']}（没有浮点尾巴）`)
  check(p['el.PF'] === 0.942 && p['el.F'] === 50 && p['el.THDu'] === 1.9 && p['el.hu.A'] === '[1,2]' && p['el.load_pct'] === 44.4,
    'PF、F、THD、谐波（JSON 串）、负荷率不乘')
  check(toPrimary(raw, { ct: 1, pt: 1 }) === raw, '变比都是 1：原样返回（不复制）')
  check(factorOf('el.dmdP', r) === 1, '需量（点目录还没有）暂不乘')
  const names = ['PM-AH12', 'PM2-AH12']
  check(parseMeters(undefined, names) === null, '配置体不带 meters：null（用 eg.yaml 初值）')
  const ok = parseMeters({ 'PM-AH12': { ct: 40, pt: 100 }, 'PM2-AH12': { ct: 20 } }, names)
  check(ok?.['PM-AH12']?.ct === 40 && ok?.['PM2-AH12']?.pt === undefined, '合法的 meters 解析出来；没写的 pt 留空（按 1 / 初值）')
  const bad = (raw: unknown) => {
    try {
      parseMeters(raw, names)
      return ''
    } catch (e) {
      return (e as Error).message
    }
  }
  check(/没有这台电表/.test(bad({ 'PM-XX': { ct: 1 } })), `不是本机电表 → 拒收：${bad({ 'PM-XX': { ct: 1 } })}`)
  check(/正数/.test(bad({ 'PM-AH12': { ct: 0 } })) && /正数/.test(bad({ 'PM-AH12': { pt: '100' } })), 'ct / pt 不是正数 → 拒收')
  check(/要是对象/.test(bad([1])), 'meters 不是对象 → 拒收')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let fail = 0
  checkMeters((ok, name, detail) => {
    if (!ok) fail++
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  —— ${detail}` : ''}`)
  })
  process.exit(fail ? 1 : 0)
}
