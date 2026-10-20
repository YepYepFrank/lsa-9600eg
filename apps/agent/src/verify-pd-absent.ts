/* 0.7.1（S19 D5）：局放「没装这一路」的固定值（地电波 187 / 特高频 269）上送前挡掉 —— 纯函数自检。
 *
 *   pnpm pd-absent:verify
 *
 * 转换程序（pd.py）见到固定值本来就不发；这是第二道。端到端（同事程序 + sim.py）另见 PR 说明。 */
import { dropPdAbsent } from './uplink/pd-absent.js'
import { check, done } from './verify/lib.js'

console.log('局放没装通道的固定值')
const real = { 'us.amp': 25.8, 'tev.amp': 12.3, 'tev.level': 0 }
check(dropPdAbsent(real).values === real && !dropPdAbsent(real).dropped.length, '地电波真读数 12.3：原样（同一个对象，不复制）')
const a = dropPdAbsent({ 'us.amp': 25.8, 'tev.amp': 18.7, 'tev.level': 0, 'uhf.amp': 26.9, 'uhf.level': 0 })
check(JSON.stringify(a.values) === JSON.stringify({ 'us.amp': 25.8 }) && a.dropped.join(',') === 'tev.amp,tev.level,uhf.amp,uhf.level', `÷10 后的 18.7 / 26.9：连同等级码一起去掉（${a.dropped.join('、')}）`)
const b = dropPdAbsent({ 'tev.amp': 187 })
check(!Object.keys(b.values).length && b.dropped.join(',') === 'tev.amp', '没 ÷10 的原值 187 也认；去完空了（调用方整行不送）')
check(dropPdAbsent({ 'tev.amp': '18.7' }).dropped.length === 1, '字符串 "18.7" 也认')
check(!dropPdAbsent({ 'tev.amp': 18.8, 'uhf.amp': 27 }).dropped.length, '18.8 / 27：是读数，不动')
check(!dropPdAbsent({ 'tev.level': 0 }).dropped.length, '只有等级码、没有放电量：不动')
done()
