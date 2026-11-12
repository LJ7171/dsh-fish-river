/**
 * growthcards.js —— 成长卡的触发与台账（2026-11-06，用户定案）
 *
 * 只在两个时机推卡：
 *   1. 作息自然睡满醒来（asleep → dice_awake，最短睡–最长睡到点；手动/消息叫醒不算）；
 *   2. 当日上网总配额首次达到 50% / 100%（同一轮出门结束后推）。
 * 两次卡之间至少 60 分钟；每天最多 daily.events 张；卡不过零点。
 *
 * 台账单独存 growth-cards.json（0600），不写 events.jsonl；推成功时另记一条
 * `card:<日期> <模板id>` 的 meta，只用于观测，不参与配额。
 */

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

import { dailyQuota, dateKey } from '../../core/settings.js'
import { channelEnabled, readDailySpent, ROLL_CHANNELS } from '../../life/schedule/sleep.js'
import { writeAtomic } from '../../core/store.js'
import { withSerial } from '../../core/serialize.js'

const VERSION = 1
export const CARD_GAP_MS = 60 * 60_000
const PENDING = ['sleep', 'half', 'all']

export function cardsPath(root) {
  return join(String(root ?? ''), 'growth-cards.json')
}

export function blankCards(now = Date.now()) {
  return { version: VERSION, dateKey: dateKey(new Date(now)), pushed: 0, lastAt: 0, half: false, all: false, pending: [] }
}

function normalize(raw, now) {
  const base = blankCards(now)
  if (!raw || typeof raw !== 'object') return base
  const out = {
    version: VERSION,
    dateKey: String(raw.dateKey ?? ''),
    pushed: Math.max(0, Math.floor(Number(raw.pushed) || 0)),
    lastAt: Math.max(0, Number(raw.lastAt) || 0),
    half: raw.half === true,
    all: raw.all === true,
    pending: Array.isArray(raw.pending) ? raw.pending.filter((x) => PENDING.includes(x)) : [],
  }
  if (out.dateKey !== dateKey(new Date(now))) return base
  out.pending = [...new Set(out.pending)]
  return out
}

export async function readCards(root, now = Date.now()) {
  try {
    return normalize(JSON.parse(await readFile(cardsPath(root), 'utf8')), now)
  } catch {
    return blankCards(now)
  }
}

export async function writeCards(root, state) {
  await writeAtomic(cardsPath(root), JSON.stringify(state, null, 2), 0o600)
  return state
}

/** 今日上网总额：只算开着的平台；used 取当天实际出门次数。 */
export async function quotaProgress(root, cfg) {
  const spent = await readDailySpent(root).catch(() => ({}))
  let cap = 0
  let used = 0
  for (const ch of ROLL_CHANNELS) {
    if (!channelEnabled(cfg, ch)) continue
    const c = dailyQuota(cfg, ch)
    if (!(c > 0)) continue
    cap += c
    used += Math.max(0, Number(spent?.[ch]) || 0)
  }
  return { cap, used, half: cap > 0 ? Math.ceil(cap / 2) : 0 }
}

/** 记录今天首次跨过的 50% / 100%，进待推队列；返回最新台账。 */
export function withCards(root, fn) {
  return withSerial(cardsPath(root), fn)
}

export async function recordMilestones(root, cfg, now = Date.now()) {
  return withCards(root, async () => {
    let st = await readCards(root, now)
    const p = await quotaProgress(root, cfg)
    if (!(p.cap > 0)) return st
    let dirty = false
    if (!st.half && p.used >= p.half) { st.half = true; if (!st.pending.includes('half')) st.pending.push('half'); dirty = true }
    if (!st.all && p.used >= p.cap) { st.all = true; if (!st.pending.includes('all')) st.pending.push('all'); dirty = true }
    if (dirty) st = await writeCards(root, st)
    return st
  })
}

/** 现在能不能推（不是有没有卡）。 */
export function canPush(state, cfg, now = Date.now()) {
  const cap = Math.max(0, Number(cfg?.daily?.events ?? 0))
  if (!(cap > 0)) return false
  if (Number(state?.pushed ?? 0) >= cap) return false
  if (now - Number(state?.lastAt ?? 0) < CARD_GAP_MS) return false
  return true
}

/** 卡排进队列（同一原因只排一次）。 */
export function queueCard(state, reason) {
  if (!PENDING.includes(reason)) return state
  if (state.pending?.includes(reason)) return state
  return { ...state, pending: [...(state.pending ?? []), reason] }
}

/** 取队首并记一次推送。 */
export async function markPushed(root, state, now = Date.now()) {
  const pending = [...(state.pending ?? [])]
  const reason = pending.shift() ?? ''
  const next = { ...state, pending, pushed: Number(state.pushed ?? 0) + 1, lastAt: now }
  await writeCards(root, next)
  return { state: next, reason }
}

/** 当天结束条件：卡推满，或上网总额到 100%。 */
export function dayFinished(state, cfg, p) {
  const cap = Math.max(0, Number(cfg?.daily?.events ?? 0))
  if (cap > 0 && Number(state?.pushed ?? 0) >= cap) return true
  return Boolean(p && p.cap > 0 && p.used >= p.cap)
}

export default { readCards, writeCards, quotaProgress, recordMilestones, canPush, queueCard, markPushed, dayFinished, blankCards, cardsPath, CARD_GAP_MS }
