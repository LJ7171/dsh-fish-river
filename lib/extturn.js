/**
 * 「这一轮是渠道在问她」的开关（2026-11-03）。
 *
 * 为什么需要：渠道回复走的是 `sessionController.prompt`，她答的话会作为
 * `assistant/message` 出现在**她自己那条 DSH 会话**里。`lib/turns.js` 的
 * 叫醒轮记账（recordWakeSay）看到没有 pending 的 assistant/message 就会记一条
 * `channel: dsh` 的 utterance —— 于是同一句渠道回话被记了两次（dsh + qq），
 * 判断被重复计入 beliefs。
 *
 * 这里只放一个计数：`lib/channels/router.js` 在问她之前 +1、问完 -1；
 * `turns.js` 见到 &gt;0 就把这一轮让给渠道层记（那边记 `channel: qq/bili/douyin`）。
 *
 * 用计数而不是布尔：两台渠道可能并发问，各自的 finally 都要能正确退场。
 */
const state = { active: 0 }

export function beginExternalTurn() {
  state.active += 1
  return state.active
}

export function endExternalTurn() {
  if (state.active > 0) state.active -= 1
  return state.active
}

export function isExternalTurn() {
  return state.active > 0
}

export function _resetExternalTurn() {
  state.active = 0
}
