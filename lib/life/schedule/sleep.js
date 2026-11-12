/**
 * sleep.js —— 作息：睡眠 / 会话苏醒 / 可掷骰苏醒
 *
 * 2026-11-05 起固定生效（没有开关）：主动上网、刷回复、回评、知乎翻页都跟这份状态走；
 * 旧的 window / wakesPerDay / 各渠道时段不再参与调度。
 *
 * 状态落在 `<root>/sleep-state.json`（0600），不是派生的 state.json：
 * 后者会被 rebuild() 覆盖，作息是运行时台账，不是她的记忆。
 * 事件流只追加，这里不改任何事件语义。
 *
 * `memory.sleepEveryDays` / `sleepKeep` 是「回头想」，跟这一组无关。
 */

import { join } from 'node:path'
import { readJson, writeAtomic, readEvents } from '../../core/store.js'
import { withSerial } from '../../core/serialize.js'
import { loadConfig, dailyQuota, dateKey } from '../../core/settings.js'
import { browseCountToday } from '../../platforms/bili/browse.js'
import { douyinCountToday } from '../../platforms/douyin/douyinbrowse.js'
import { readState as readZhihuState, runsToday } from '../../platforms/zhihu/client.js'
import { readState as readTiebaState, runsToday as tiebaRunsToday } from '../../platforms/tieba/client.js'

export const SLEEP_FILE = 'sleep-state.json'
export const ROLL_CHANNELS = Object.freeze(['bili', 'douyin', 'zhihu', 'tieba'])

const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** 固定使用作息（保留这个名字，免得调用方到处改）。 */
export function sleepEnabled() {
  return true
}

export function hmToMin(value, fallback) {
  const m = HM_RE.exec(String(value ?? '').trim())
  if (!m) return fallback
  return Number(m[1]) * 60 + Number(m[2])
}

/** 活跃窗 [start, end)。23:00 整点算窗外，到点就睡。 */
export function inActiveWindow(cfg, now = new Date()) {
  const d = now instanceof Date ? now : new Date(now)
  const start = hmToMin(cfg?.sleep?.active_start, 7 * 60)
  const end = hmToMin(cfg?.sleep?.active_end, 23 * 60)
  if (start === end) return false
  const cur = d.getHours() * 60 + d.getMinutes()
  if (start < end) return cur >= start && cur < end
  return cur >= start || cur < end
}

/** 下一个活跃窗起点（本地时区）。已经在窗内时，指的是再下一次。 */
export function nextActiveStart(cfg, now = new Date()) {
  const d = now instanceof Date ? new Date(now.getTime()) : new Date(now)
  d.setSeconds(0, 0)
  const start = hmToMin(cfg?.sleep?.active_start, 7 * 60)
  const cur = d.getHours() * 60 + d.getMinutes()
  if (cur >= start) d.setDate(d.getDate() + 1)
  d.setHours(Math.floor(start / 60), start % 60, 0, 0)
  return d.getTime()
}

function idleMs(cfg) {
  return Math.max(1, Number(cfg?.sleep?.idle_to_sleep_min) || 90) * 60_000
}

function weixinIdleMs(cfg) {
  return Math.max(1, Number(cfg?.sleep?.weixin_session_idle_min) || 10) * 60_000
}

function zeroRolls() {
  return { bili: 0, douyin: 0, zhihu: 0, tieba: 0 }
}

/** 本段「真的上网」次数（不是掷骰次数） */
function zeroActs() {
  return { bili: 0, douyin: 0, zhihu: 0, tieba: 0 }
}

export function blankState(cfg, now = Date.now()) {
  const t = typeof now === 'number' ? now : now.getTime()
  const base = {
    mode: 'asleep',
    since: t,
    lastActivityAt: t,
    weixinSilentSince: 0,
    sessionSince: 0,
    sleptAt: 0,
    napHours: 0,
    wakeDueAt: nextActiveStart(cfg, new Date(t)),
    wokeInside: false,
    looked: true,
    segmentId: 0,
    acts: zeroActs(),
    blocked: zeroRolls(),
    nextRollAt: zeroRolls(),
  }
  if (inActiveWindow(cfg, new Date(t))) {
    return {
      ...base,
      mode: 'dice_awake',
      wokeInside: true,
      looked: false,
      wakeDueAt: 0,
      segmentId: 1,
    }
  }
  return base
}

function enterDice(s, cfg, now) {
  return {
    ...s,
    mode: 'dice_awake',
    since: now,
    // 2026-11-05 修：醒来这一刻就算「有过活动」。原来沿用睡前的 lastActivityAt，
    // 睡满醒来后下一分钟就会被判成「90 分钟没动」又睡回去。
    lastActivityAt: now,
    wokeInside: inActiveWindow(cfg, new Date(now)),
    looked: false,
    segmentId: (Number(s.segmentId) || 0) + 1,
    acts: zeroActs(),
    blocked: zeroRolls(),
    nextRollAt: zeroRolls(),
  }
}

function enterSleep(s, cfg, now, rng) {
  const minH = Number(cfg?.sleep?.nap_min_h) || 3
  const maxH = Math.max(Number(cfg?.sleep?.nap_max_h) || minH, minH)
  const nap = minH + rng() * (maxH - minH)
  let due = now + nap * 3_600_000
  if (!inActiveWindow(cfg, new Date(due))) due = nextActiveStart(cfg, new Date(due))
  return {
    ...s,
    mode: 'asleep',
    sleptAt: now,
    napHours: Math.round(nap * 1000) / 1000,
    wakeDueAt: due,
    looked: true,
    weixinSilentSince: 0,
  }
}

function pack(state, extra) {
  return { state, enteredDice: false, slept: false, ...extra }
}

/**
 * 纯函数。signals.weixin / signals.manual 是这一拍刚发生的事；
 * 没信号就只按时间往前走（窗边、睡满、静默升级、空闲入睡）。
 */
export function advance(prev, cfg, now, signals = {}) {
  const rng = typeof signals.rng === 'function' ? signals.rng : Math.random
  const t = typeof now === 'number' ? now : now.getTime()
  let s = {
    ...prev,
    acts: { ...zeroActs(), ...(prev?.acts ?? {}) },
    blocked: { ...zeroRolls(), ...(prev?.blocked ?? {}) },
    nextRollAt: { ...zeroRolls(), ...(prev?.nextRollAt ?? {}) },
  }
  if (!s.mode) s.mode = 'asleep'
  const active = inActiveWindow(cfg, new Date(t))

  if (signals.manual) {
    const next = enterDice(s, cfg, t)
    next.lastActivityAt = t
    return pack(next, { enteredDice: true, reason: 'manual' })
  }

  if (signals.weixin) {
    s.lastActivityAt = t
    s.weixinSilentSince = t
    if (s.mode !== 'dice_awake') {
      s.mode = 'session_awake'
      s.sessionSince = t
    }
    return pack(s, { reason: 'weixin' })
  }

  if (!active && s.mode === 'dice_awake' && s.wokeInside) {
    return pack(enterSleep(s, cfg, t, rng), { slept: true, reason: 'window-end' })
  }

  if (!active && s.mode === 'session_awake') {
    const silent = t - (Number(s.weixinSilentSince) || t)
    if (silent >= weixinIdleMs(cfg)) {
      return pack(enterSleep(s, cfg, t, rng), { slept: true, reason: 'session-done-outside' })
    }
    return pack(s, { reason: 'session-outside' })
  }

  if (!active && s.mode === 'dice_awake') {
    const idle = t - (Number(s.lastActivityAt) || Number(s.since) || t)
    if (idle >= idleMs(cfg)) return pack(enterSleep(s, cfg, t, rng), { slept: true, reason: 'idle' })
    return pack(s, { reason: 'dice-outside' })
  }

  if (s.mode === 'asleep') {
    if (active && s.wakeDueAt && t >= s.wakeDueAt) {
      return pack(enterDice(s, cfg, t), { enteredDice: true, reason: 'nap-done' })
    }
    if (!active && s.wakeDueAt && t >= s.wakeDueAt) s.wakeDueAt = nextActiveStart(cfg, new Date(t))
    return pack(s, { reason: 'asleep' })
  }

  if (active && s.mode === 'session_awake') {
    const silent = t - (Number(s.weixinSilentSince) || t)
    if (silent >= weixinIdleMs(cfg)) {
      const next = enterDice(s, cfg, t)
      next.lastActivityAt = Number(s.lastActivityAt) || t
      return pack(next, { enteredDice: true, reason: 'session-upgrade' })
    }
    return pack(s, { reason: 'session' })
  }

  if (s.mode === 'dice_awake') {
    const idle = t - (Number(s.lastActivityAt) || Number(s.since) || t)
    if (idle >= idleMs(cfg)) return pack(enterSleep(s, cfg, t, rng), { slept: true, reason: 'idle' })
    return pack(s, { reason: 'dice' })
  }

  return pack(s, { reason: 'noop' })
}

export function channelEnabled(cfg, ch) {
  if (ch === 'bili') return cfg?.browse?.enabled !== false && dailyQuota(cfg, 'bili') > 0
  if (ch === 'douyin') return cfg?.browse?.douyin?.enabled === true && dailyQuota(cfg, 'douyin') > 0
  if (ch === 'zhihu') return cfg?.zhihu?.enabled === true && dailyQuota(cfg, 'zhihu') > 0
  if (ch === 'tieba') return cfg?.tieba?.enabled === true && dailyQuota(cfg, 'tieba') > 0
  if (ch === 'reply') return cfg?.comment?.enabled === true
  return false
}

/** 不配 browse_prob 时，开着的渠道按 1（去不去由间隔和配额决定）。 */
export function channelProb(cfg, ch) {
  const p = cfg?.sleep?.browse_prob?.[ch]
  if (typeof p === 'number' && Number.isFinite(p)) return Math.max(0, Math.min(1, p))
  return channelEnabled(cfg, ch) ? 1 : 0
}

export function dueRolls(state, cfg, now) {
  if (!state || state.mode !== 'dice_awake' || !state.looked) return []
  const max = Number(cfg?.sleep?.browse_max_per_wake ?? 2)
  const t = typeof now === 'number' ? now : now.getTime()
  // 2026-11-05 修：窗外不掷骰。手动叫醒发生窗外时原来会在 30–45 分钟后自己刷站。
  if (!inActiveWindow(cfg, new Date(t))) return []
  const out = []
  for (const ch of ROLL_CHANNELS) {
    if (!channelEnabled(cfg, ch)) continue
    if (state.blocked?.[ch]) continue
    if ((state.acts?.[ch] ?? 0) >= max) continue
    if (t >= (state.nextRollAt?.[ch] ?? 0)) out.push(ch)
  }
  return out
}

export function armRoll(state, cfg, ch, now, rng = Math.random) {
  const lo = Number(cfg?.sleep?.browse_interval_min_m) || 30
  const hi = Math.max(Number(cfg?.sleep?.browse_interval_max_m) || lo, lo)
  const mins = lo + rng() * (hi - lo)
  const t = typeof now === 'number' ? now : now.getTime()
  return {
    ...state,
    nextRollAt: { ...zeroRolls(), ...(state.nextRollAt ?? {}), [ch]: t + mins * 60_000 },
  }
}

/**
 * 2026-11-07：全局只留一个出门时间。所有开着的平台共用同一个 nextOutingAt（仍存在
 * nextRollAt 对象里，值相同），谁先到点就醒一次，醒来后把全部平台一起重排。
 */
export function armOuting(state, cfg, now, rng = Math.random) {
  const lo = Number(cfg?.sleep?.browse_interval_min_m) || 30
  const hi = Math.max(Number(cfg?.sleep?.browse_interval_max_m) || lo, lo)
  const mins = lo + rng() * (hi - lo)
  const t = typeof now === 'number' ? now : now.getTime()
  const at = t + mins * 60_000
  const next = { ...zeroRolls() }
  for (const ch of ROLL_CHANNELS) {
    if (channelEnabled(cfg, ch)) next[ch] = at
  }
  return { ...state, nextRollAt: next }
}

/** 记录一次「真的上网」：只有动作真的发生了才调用。 */
export function markAct(state, ch, now) {
  const t = typeof now === 'number' ? now : now == null ? null : Date.now()
  return {
    ...state,
    acts: { ...zeroActs(), ...(state.acts ?? {}), [ch]: (state.acts?.[ch] ?? 0) + 1 },
    ...(t == null ? {} : { lastActivityAt: t }),
  }
}

/** 这一路本段没得看了（配额用完 / 风控 / 没装子包）：本段不再掷它，但不算次数。 */
export function markBlocked(state, ch) {
  return {
    ...state,
    blocked: { ...zeroRolls(), ...(state.blocked ?? {}), [ch]: 1 },
  }
}

/**
 * 段首掷一次骰（不再无条件刷一遍）：给每一路排下一次间隔，返回这次命中的路。
 * 命中只是「允许去看」，真正算一次上网要等 wake 里真的发了请求（markAct）。
 */
export function rollSegment(state, cfg, now, rng = Math.random) {
  const t = typeof now === 'number' ? now : now.getTime()
  let s = {
    ...state,
    looked: true,
    blocked: { ...zeroRolls(), ...(state.blocked ?? {}) },
    nextRollAt: { ...zeroRolls(), ...(state.nextRollAt ?? {}) },
  }
  const hits = []
  s = armOuting(s, cfg, t, rng)
  for (const ch of ROLL_CHANNELS) {
    if (!channelEnabled(cfg, ch)) continue
    if (rng() < channelProb(cfg, ch)) hits.push(ch)
  }
  return { state: s, hits }
}

/**
 * 作息是否接管这一次主动上网。
 * 没有台账时不算接管——调用方继续用旧时段，避免一开插件就把进行中的测试/旧配置打断。
 * 有台账且不是可掷骰苏醒：这一拍 no-op。
 */
export function diceOpen(cfg, state) {
  if (!sleepEnabled(cfg)) return { governed: false, open: true }
  if (!state || !state.mode) return { governed: false, open: true }
  return { governed: true, open: state.mode === 'dice_awake' }
}

/**
 * 今天各路已经出门几次。
 * 和配额闸同一口径：B 站数 `browse:`、抖音数 `dy-browse:`，知乎数 `zhihu-state.json` 当天的 runs，贴吧数 `tieba-state.json` 当天的 runs。
 * 段内的 markAct 只管「这一段醒着逛了几次」，不在这里重算。
 */
export async function readDailySpent(root, dk = dateKey()) {
  const { events } = await readEvents(root)
  const zh = await readZhihuState(root)
  const tb = await readTiebaState(root)
  return {
    bili: browseCountToday(events, dk),
    douyin: douyinCountToday(events, dk),
    zhihu: runsToday(zh, dk),
    tieba: tiebaRunsToday(tb, dk),
  }
}

export function sleepPath(root) {
  return join(root, SLEEP_FILE)
}

export async function readSleep(root) {
  if (!root) return null
  const raw = await readJson(sleepPath(root), null)
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || !raw.mode) return null
  return raw
}

async function writeSleepRaw(root, state) {
  await writeAtomic(sleepPath(root), JSON.stringify({ v: 1, ...state }, null, 2), 0o600)
}

/** 只有真正变了才写盘；每次 tick 无条件重写 1440 次/天没有意义。 */
function sameSleep(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

/**
 * 写作息状态：同一 root 串行，且把「这段时间里新发生的活动」合并进来。
 *
 * 为什么需要合并：`runSleep` 会先读快照、再发网络请求、最后写回；这期间
 * `noteWeixin` 可能刚把状态改成 session_awake。旧写法会把那次更新覆盖掉。
 * 这里只做保守合并：更晚的活动时间不被回退；旧快照想让她睡、但期间她刚被
 * 消息叫醒时，不把 awake 覆盖成 asleep。真正的事件流仍是唯一真相。
 */
export async function writeSleep(root, state) {
  return withSerial(sleepPath(root), async () => {
    const next = { v: 1, ...state }
    const cur = await readJson(sleepPath(root), null)
    if (cur && typeof cur === 'object') {
      const curAt = Number(cur.lastActivityAt) || 0
      const nextAt = Number(next.lastActivityAt) || 0
      if (curAt > nextAt) {
        next.lastActivityAt = curAt
        next.weixinSilentSince = Math.max(Number(cur.weixinSilentSince) || 0, Number(next.weixinSilentSince) || 0)
        if (next.mode === 'asleep' && cur.mode && cur.mode !== 'asleep') {
          // 这次写回的依据是一份「她该睡了」的旧快照；期间她刚醒过，别让她睡。
          // 既然用新状态，就把新状态那一段的运行时字段整组拿过来（段 id、次数、下一轮时间……），
          // 不能只改 mode 而留下旧快照的 acts/looked，否则下一拍会立刻又睡/又叫。
          for (const k of ['mode', 'since', 'sessionSince', 'looked', 'segmentId', 'wokeInside', 'wakeDueAt', 'acts', 'blocked', 'nextRollAt', 'napHours', 'sleptAt']) {
            if (cur[k] !== undefined) next[k] = cur[k]
          }
        }
      }
      if (sameSleep(cur, next)) return
    }
    await writeSleepRaw(root, next)
  })
}

export async function noteWeixin(root, now = Date.now()) {
  if (!root) return { governed: false }
  return withSerial(sleepPath(root), async () => {
    const { config } = await loadConfig(root)
    if (!sleepEnabled(config)) return { governed: false }
    const prev = (await readSleep(root)) ?? blankState(config, now)
    const { state, reason } = advance(prev, config, now, { weixin: true })
    await writeSleepRaw(root, state)
    return { governed: true, state, reason }
  })
}

export async function markManual(root, now = Date.now()) {
  if (!root) return { governed: false }
  return withSerial(sleepPath(root), async () => {
    const { config } = await loadConfig(root)
    if (!sleepEnabled(config)) return { governed: false }
    const prev = (await readSleep(root)) ?? blankState(config, now)
    const { state } = advance(prev, config, now, { manual: true })
    // 2026-11-06：手动叫醒已经醒了这一轮；把 looked 标成 true 并排好下一轮间隔，
    // 否则下一分钟 tick 会把它当“段首还没醒”，再叫一次。
    const rolled = rollSegment(state, config, now).state
    await writeSleepRaw(root, rolled)
    return { governed: true, state: rolled }
  })
}

