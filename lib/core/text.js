/**
 * text.js —— 字符二元组相似度（纯函数，无状态）。
 *
 * 从 derive.js 抽出来是为了断开 `derive ↔ voices` 的循环：
 * derive 需要 findEcho（评论回声），voices 需要 similarity；
 * 两者都依赖这个叶子之后，derive 不再 import voices。
 */

export const DAY_MS = 86_400_000

/** 字符二元组（含计数）。similarity 与 mentions 的倒排索引共用。 */
export function bigrams(s) {
  const m = new Map()
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2)
    m.set(g, (m.get(g) || 0) + 1)
  }
  return m
}

/** Dice 系数：2*交集 / (|A|+|B|)，按二元组计数。 */
export function dice(ga, gb) {
  let inter = 0, total = 0
  for (const [g, c] of ga) {
    total += c
    const d = gb.get(g)
    if (d) inter += Math.min(c, d)
  }
  for (const [, c] of gb) total += c
  return total === 0 ? 0 : (2 * inter) / total
}

/** 字符二元组 Dice 相似度（跨情境一致与"新话"判定用） */
export function similarity(a, b) {
  const A = String(a ?? ''), B = String(b ?? '')
  if (A === B) return 1
  if (!A || !B) return 0
  return dice(bigrams(A), bigrams(B))
}

export default { DAY_MS, bigrams, dice, similarity }
