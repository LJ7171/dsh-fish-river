/**
 * wakeTurn.js —— 「这一轮是她自己醒来」的短期状态（2026-11-05）
 *
 * 为什么需要它：她醒来时想主动给重要的人说一句话，但工具是全局注册的，
 * 而「现在是不是她自己的时间」只有调度器知道。所以调度器在开唤醒回合之前写进来，
 * 回合结束就清掉；`send_to_owner` / `send_image` 靠它判断现在能不能主动发。
 *
 * 两条边界：
 *   - 只活在内存里，进程重启就没了；
 *   - 会过期（30 分钟）：一次异常的回合不至于让工具一直可用。
 *
 * 和 `channelTurn.js` 的区别：那边是「她在回谁的消息」，这边是「她自己在醒着」。
 * 两个都可能同时存在；工具优先认渠道轮（回消息不需要走主动额度）。
 */

const WAKE_TURN_TTL_MS = 30 * 60_000

let current = null

/** 调度器开唤醒回合前调这里。 */
export function setWakeTurn(turn) {
  current = turn && typeof turn === 'object' ? { ...turn, at: Date.now() } : null
}

export function clearWakeTurn() {
  current = null
}

/** 当前是不是她自己的时间；没有 / 过期 / 被清掉都返回 null。 */
export function currentWakeTurn(now = Date.now()) {
  if (!current) return null
  if (now - Number(current.at ?? 0) > WAKE_TURN_TTL_MS) return null
  return current
}

export function resetWakeTurnForTests() {
  current = null
}

export default {
  setWakeTurn,
  clearWakeTurn,
  currentWakeTurn,
  resetWakeTurnForTests,
}
