/**
 * replyScan.js —— 扫「有没有人回她」的节奏
 *
 * 只看开关和自己的间隔。不看作出门掷骰、不看 choose_outing。
 * 2026-11-18 起：三平台统一只在**作息窗口**内扫（睡着也扫）；窗口判定在 scheduler，
 * 不在这里。递不递给她是另一条路（醒着就立投），见 replyDelivery.js。
 */

export function scanDue({ enabled = false, lastAt = 0, everyMin = 30, now = Date.now() } = {}) {
  if (enabled !== true) return false
  const every = Math.max(5, Number(everyMin) || 30) * 60_000
  const last = Number(lastAt) || 0
  if (last && now - last < every) return false
  return true
}

export default { scanDue }
