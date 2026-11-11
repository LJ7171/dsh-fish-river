/**
 * speakRisk.js —— 知乎 / 贴吧写操作的内存冷却
 *
 * 和 B 站评论一样：风控或要验证码就停，不自动过验证，也不把这次失败记进刷站的 risk.json
 * （那份账只关「看」，不该把「说」的冷却连坐成整天不刷）。
 * 冷却只活在这个进程里。重启之后可以再试一次，但同一次失败不会连着重试。
 */

const buckets = new Map()

export function resetSpeakRisk(name) {
  if (name) buckets.delete(String(name))
  else buckets.clear()
}

/** 还在冷却就返回拒绝；过了就当没锁。 */
export function speakCooldown(name, now = Date.now()) {
  const row = buckets.get(String(name))
  if (!row || now >= row.until) return null
  return { ok: false, code: 'COOLDOWN', why: '先歇一会儿' }
}

/** 记一次撞墙。第一次约 5 分钟，连着撞就翻倍，最多 30 分钟。 */
export function noteSpeakRisk(name, now = Date.now()) {
  const key = String(name)
  const prev = buckets.get(key)
  const streak = prev && now - (prev.at || 0) < 30 * 60_000 ? (prev.streak || 0) + 1 : 1
  const wait = Math.min(30 * 60_000, 5 * 60_000 * 2 ** (streak - 1))
  buckets.set(key, { until: now + wait, streak, at: now })
  return { until: now + wait, streak }
}

export default { resetSpeakRisk, speakCooldown, noteSpeakRisk }
