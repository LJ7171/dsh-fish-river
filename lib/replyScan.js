/**
 * replyScan.js —— 扫「有没有人回她」的节奏
 *
 * 只看开关和自己的间隔。不看作出门掷骰、不看 choose_outing。
 * 作息没醒时打不打请求，由各平台的 scanIfAwake 决定，不在这里。
 */

export function scanDue({ enabled = false, lastAt = 0, everyMin = 30, now = Date.now() } = {}) {
  if (enabled !== true) return false
  const every = Math.max(5, Number(everyMin) || 30) * 60_000
  const last = Number(lastAt) || 0
  if (last && now - last < every) return false
  return true
}

export default { scanDue }
