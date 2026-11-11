/**
 * echo.js —— 「她有没有认下一条评论」（回声）。
 *
 * 从 voices.js 抽出来，只为断开 derive ↔ voices 的循环：derive 需要
 * findEcho，voices 需要 similarity/modelOf；把 findEcho 放到只依赖 text.js
 * 的叶子里，derive 就不必 import voices。
 */

import { similarity } from '../core/text.js'

const DAY_MS = 86_400_000

/** 她"回声"判定的窗口与阈值：评论之后三天内说的，相似度 ≥ 0.7 才算她认下了 */
export const ECHO_WINDOW_MS = 3 * DAY_MS
export const ECHO_MIN_SIM = 0.7
/** 身份文档里「你读到的一句话」只认 7 天内的，太久了就不该再摆在眼前 */
export const VOICE_FRESH_DAYS = 7

/**
 * 归一化：只留字。
 *
 * 为什么要去 URL / @ / 标点 / 空白：同一条评论常被复制粘贴，两边只差几个符号和空格，
 * 不归一化就会当成两句不同的话各自占一次名额。截 120 是为了做 key 时不被长尾稀释。
 */
export function normVoice(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[^\s]+/g, ' ')
    .replace(/[，。！？、；：「」『』（）()[\]{}<>《》~!?,.;:"'`~^*_+=|\\/#%&$@\-]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .slice(0, 120)
}

/**
 * 她有没有认下这条评论（回声）。
 *
 * 只在评论之后 ECHO_WINDOW_MS 内找她说的话，比她说过什么更重要——
 * 隔了两个月忽然说了句相似的话，那是她自己想起来的，不是被这条评论带的。
 */
export function findEcho(voice, events = []) {
  const t0 = Date.parse(voice.at ?? '')
  if (!Number.isFinite(t0)) return null
  const mine = normVoice(voice.text)
  // 只在**这条评论之后**的事件里找。按事件流里的先后判，不按毫秒：
  // 同一天里"先读到、后开口"时两条的 ts 可能只差几秒，甚至测试里是同一毫秒。
  const idx = events.findIndex((e) => e.id && e.id === voice.id)
  const after = idx >= 0 ? events.slice(idx + 1) : events
  for (const e of after) {
    if (e.type !== 'utterance' && e.type !== 'revise') continue
    const t = Date.parse(e.ts ?? '')
    if (!Number.isFinite(t) || t - t0 > ECHO_WINDOW_MS) continue
    if (similarity(mine, normVoice(e.text)) >= ECHO_MIN_SIM) return e
  }
  return null
}

export default { ECHO_WINDOW_MS, ECHO_MIN_SIM, VOICE_FRESH_DAYS, normVoice, findEcho }
