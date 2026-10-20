/* 局放「没装这一路」的固定值上送前挡掉（0.7.1，S19 待确认 D5；《EG / SAM 接入规范》§6.1「没装这一路时设备读出固定值 187，不得上送」）。
 *
 * 装置没装地电波 / 特高频时，寄存器 6 / 10 读出固定值 187 / 269（÷10 后 18.7 / 26.9）。这不是读数：
 * 转换程序的局放驱动见到它就不发（pd.py _TEV_INVALID / _UHF_INVALID）；这里是第二道 —— 转换程序万一照发了（换了程序、没 ÷10），
 * 上送子站前把这个量连同它的等级码一起去掉，免得子站把「没装」当成一条 18.7 dBmV 的真读数（地电波能力 0.18.1 起缺省已确认）。
 * 只挡上送；本地 TB 照收（本地页、检查工具 lsa_check 会提示「这是没装时的固定值」）。 */

/** 量 → 没装时的固定值（÷10 前后两种写法都认）与要一起去掉的伴随量 */
const ABSENT: Record<string, { values: number[]; with: string[] }> = {
  'tev.amp': { values: [18.7, 187], with: ['tev.level'] },
  'uhf.amp': { values: [26.9, 269], with: ['uhf.level'] },
}

/** 去掉没装通道的固定值；返回去掉后的 values 与去掉了哪些量（没去掉时原样返回同一个对象） */
export function dropPdAbsent(values: Record<string, unknown>): { values: Record<string, unknown>; dropped: string[] } {
  let out: Record<string, unknown> | null = null
  const dropped: string[] = []
  for (const [key, a] of Object.entries(ABSENT)) {
    const v = values[key]
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
    if (typeof n !== 'number' || !a.values.includes(n)) continue
    out ??= { ...values }
    for (const k of [key, ...a.with]) {
      if (!(k in out)) continue
      delete out[k]
      dropped.push(k)
    }
  }
  return { values: out ?? values, dropped }
}
