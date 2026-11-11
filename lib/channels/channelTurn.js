/**
 * channelTurn.js —— 「这一轮她正在跟谁说话」的短期状态（2026-11-05，B 方案）
 *
 * 为什么需要它：她要能从对话里主动发一张图（`send_image`），但工具是全局注册的，
 * 而「发给谁」只有渠道层知道。所以路由在叫醒她之前把这一轮的会话放进来，
 * 工具执行时再取走；她说完就清掉。
 *
 * 三条边界：
 *   - **只活在内存里**：进程重启就没了，不需要持久化；
 *   - **会过期**：超过 5 分钟没动就当没有这一轮，避免一次异常的回合让工具一直可用；
 *   - **只有渠道轮才有**：她在 DSH 里跟自己说话时没有「对方」，工具该拒绝。
 */

const TURN_TTL_MS = 5 * 60_000

let current = null
let sender = null

/** 路由在叫醒她之前调这里。会盖掉上一轮（同一时刻只可能有一轮在跑：队列是串行的）。 */
export function setChannelTurn(turn) {
  current = turn && typeof turn === 'object' ? { ...turn, at: Date.now() } : null
}

export function clearChannelTurn() {
  current = null
}

/** 取当前这一轮；没有 / 过期 / 被清掉都返回 null。 */
export function currentChannelTurn(now = Date.now()) {
  if (!current) return null
  if (now - Number(current.at ?? 0) > TURN_TTL_MS) return null
  return current
}

/** 路由注册的「真的把图发出去」的实现；工具只调这个。 */
export function setChannelSender(fn) {
  sender = typeof fn === 'function' ? fn : null
}

export function getChannelSender() {
  return sender
}

/** 测试用：每个用例之间清干净（线上不需要）。 */
export function resetChannelTurnForTests() {
  current = null
  sender = null
}

export default {
  setChannelTurn,
  clearChannelTurn,
  currentChannelTurn,
  setChannelSender,
  getChannelSender,
  resetChannelTurnForTests,
}
