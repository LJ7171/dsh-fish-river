/**
 * zhihuComment.js —— 知乎说话规则的主包侧入口。
 *
 * 评 / 回 / 答 / 扫回复都在子包。这里注入宿主：醒着没有、出站筛、社会层、动作记账。
 */

import { fishHost, syncPkg } from './bridge.js'

function pkg() {
  return syncPkg()
}

export const MAX_COMMENT = 1000
export const MAX_ANSWER = 2500
export const REPLY_LOOKBACK_DAYS = 7
export const MAX_SCAN_ROOTS = 6

export function opensToday(events, dk) {
  const mod = pkg()
  if (!mod) return []
  return mod.opensToday(events, dk, fishHost())
}

export function commentCountToday(events, dk) {
  const mod = pkg()
  if (!mod) return 0
  return mod.commentCountToday(events, dk, fishHost())
}

export function replyCountToday(events, dk) {
  const mod = pkg()
  if (!mod) return 0
  return mod.replyCountToday(events, dk, fishHost())
}

export function answerCountToday(events, dk) {
  const mod = pkg()
  if (!mod) return 0
  return mod.answerCountToday(events, dk, fishHost())
}

export function herComments(events, dk) {
  const mod = pkg()
  if (!mod) return []
  return mod.herComments(events, dk, fishHost())
}

export function herCommentsRecent(events, days, now) {
  const mod = pkg()
  if (!mod) return []
  return mod.herCommentsRecent(events, days, now, fishHost())
}

export function seenReplies(events) {
  const mod = pkg()
  if (!mod) return new Set()
  return mod.seenReplies(events)
}

export async function scanReplies(o = {}) {
  const mod = pkg()
  if (!mod) return []
  return mod.scanReplies({ ...o, host: o.host ?? fishHost() })
}

export async function scanIfAwake(o = {}) {
  const mod = pkg()
  const host = o.host ?? fishHost()
  if (!mod) {
    const root = o.root ?? host.rootDir()
    const cfg = o.config ?? (await host.loadConfig(root)).config
    const gate = await host.isAwake(root, cfg, o.sleepState)
    if (gate.governed && !gate.open) return { ok: false, why: 'asleep', list: [] }
    return { ok: true, why: '', list: [] }
  }
  return mod.scanIfAwake({ ...o, host })
}

export function renderReplies(list, owner) {
  const mod = pkg()
  if (!mod) return ''
  return mod.renderReplies(list, owner, fishHost())
}

export async function postComment(o = {}) {
  const mod = pkg()
  if (!mod) return { ok: false, why: '没登录' }
  return mod.postComment({ ...o, host: o.host ?? fishHost() })
}

export async function postReply(o = {}) {
  const mod = pkg()
  if (!mod) return { ok: false, why: '没登录' }
  return mod.postReply({ ...o, host: o.host ?? fishHost() })
}

export async function postAnswer(o = {}) {
  const mod = pkg()
  if (!mod) return { ok: false, why: '没登录' }
  return mod.postAnswer({ ...o, host: o.host ?? fishHost() })
}

export default {
  MAX_COMMENT,
  MAX_ANSWER,
  REPLY_LOOKBACK_DAYS,
  MAX_SCAN_ROOTS,
  opensToday,
  commentCountToday,
  replyCountToday,
  answerCountToday,
  herComments,
  herCommentsRecent,
  seenReplies,
  scanReplies,
  scanIfAwake,
  renderReplies,
  postComment,
  postReply,
  postAnswer,
}
