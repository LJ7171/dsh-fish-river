/**
 * zhihu.js —— 知乎素材（只读）
 *
 * 定位：和「刷 B 站」「刷抖音」并列的一条**素材线**，不是渠道。
 * 但和它们有一点不同：B 站/抖音是她醒来前现刷；知乎是**白天随机去翻几次**，
 * 翻到的新东西先攒着，等她醒来再一起递给她。这样她不用在 08:00–20:00 醒着，
 * 也不会错过白天发生的事。
 *
 * 三件事只在这一个文件里做：
 *   1. 懒加载子包（没装就整条路消失，和抖音同一个约定）；
 *   2. 用 `<root>/zhihu-state.json` 记「今天翻过几次、哪些递过、攒了哪些新的」；
 *   3. 把热榜 / 首页推荐 / 关注动态 / 浏览历史拼成一段人类可读的素材。
 *
 * 不写事件流：配额和素材都是环境参数，不是她的经历。要不要记住由她自己 growth_commit。
 */

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { writeAtomic } from './store.js'
import { dateKey } from './settings.js'

const STATE_VERSION = 2
/** 记住多少个 id：一天翻几次 × 每次几十条，300 够一周不重复。 */
const SEEN_MAX = 300
/** 超过这个时间的 id 就忘了，避免快照无限长。 */
const SEEN_TTL_MS = 7 * 86_400_000
/** 攒着等她醒来的素材上限：太多会把她淹没，太少又会漏掉一天。 */
const PENDING_MAX = 40

/** 默认窗口：白天随机翻。用户 2026-11-04 明确要 08:00–20:00。 */
export const DEFAULT_WINDOW = ['08:00', '20:00']

function errorText(error) {
  return String(error?.message ?? error).slice(0, 200)
}

function clamp(n, lo, hi) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo
}

/** 装没装知乎子包。没装返回 null——「可选装」靠包装不装，不靠开关。 */
export async function loadZhihu(importer = (n) => import(n)) {
  const candidates = ['dsh-fish-river-zhihu', '../packages/dsh-fish-river-zhihu/index.js']
  for (const spec of candidates) {
    try {
      const mod = await importer(spec)
      if (mod && typeof mod.fetchHot === 'function') return mod
    } catch (error) {
      if (String(error?.code ?? '') === 'ERR_MODULE_NOT_FOUND') continue
      throw error
    }
  }
  return null
}

export function statePath(root) {
  return join(String(root ?? ''), 'zhihu-state.json')
}

/** 读快照；没有 / 坏了都从零开始（坏文件不该拦住一次唤醒）。 */
export async function readState(root) {
  try {
    const parsed = JSON.parse(await readFile(statePath(root), 'utf8'))
    return {
      version: STATE_VERSION,
      dateKey: String(parsed?.dateKey ?? ''),
      runs: Number(parsed?.runs) || 0,
      recRuns: Number(parsed?.recRuns) || 0,
      lastMinute: Number.isFinite(Number(parsed?.lastMinute)) ? Number(parsed.lastMinute) : -1,
      seen: parsed?.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
      pending: Array.isArray(parsed?.pending) ? parsed.pending : [],
    }
  } catch {
    return { version: STATE_VERSION, dateKey: '', runs: 0, recRuns: 0, lastMinute: -1, seen: {}, pending: [] }
  }
}

export async function writeState(root, state) {
  const now = Date.now()
  const seen = {}
  for (const [id, at] of Object.entries(state?.seen ?? {})) {
    if (now - Number(at) <= SEEN_TTL_MS) seen[id] = Number(at)
  }
  const entries = Object.entries(seen).sort((a, b) => a[1] - b[1])
  const trimmed = Object.fromEntries(entries.slice(-SEEN_MAX))
  const pending = (Array.isArray(state?.pending) ? state.pending : []).slice(-PENDING_MAX)
  const next = {
    version: STATE_VERSION,
    dateKey: String(state?.dateKey ?? ''),
    runs: Number(state?.runs) || 0,
    recRuns: Number(state?.recRuns) || 0,
    lastMinute: Number.isFinite(Number(state?.lastMinute)) ? Number(state.lastMinute) : -1,
    seen: trimmed,
    pending,
  }
  try {
    await writeAtomic(statePath(root), JSON.stringify(next, null, 2), 0o600)
    return { ok: true }
  } catch (error) {
    return { ok: false, why: errorText(error) }
  }
}

/** 今天翻过几次（按 dateKey 归零）。 */
export function runsToday(state, dk) {
  return state?.dateKey === dk ? Number(state.runs) || 0 : 0
}

/* ---------------------------- 时间窗 ---------------------------- */

function parseHm(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!m) return fallback
  const h = Number(m[1]); const mi = Number(m[2])
  if (h > 23 || mi > 59) return fallback
  return h * 60 + mi
}

/** 她的知乎窗口（分钟数区间）。配置里空数组 → 默认 08:00–20:00。 */
export function zhihuWindowMinutes(cfg) {
  const w = Array.isArray(cfg?.zhihu?.window) && cfg.zhihu.window.length === 2 ? cfg.zhihu.window : DEFAULT_WINDOW
  const from = parseHm(w[0], 8 * 60)
  const to = parseHm(w[1], 20 * 60)
  if (to <= from) return { from: 8 * 60, to: 20 * 60, span: 12 * 60 }
  return { from, to, span: to - from }
}

export function inZhihuWindow(cfg, now = new Date()) {
  const { from, to } = zhihuWindowMinutes(cfg)
  const m = now.getHours() * 60 + now.getMinutes()
  return m >= from && m < to
}

export function minuteOfDay(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes()
}

/* ---------------------------- 采集 ---------------------------- */

function toItem(kind, raw) {
  return {
    kind,
    id: String(raw?.id ?? ''),
    title: String(raw?.title ?? '').trim(),
    author: String(raw?.author ?? '').trim(),
    heat: String(raw?.heat ?? '').trim(),
    url: String(raw?.url ?? '').trim(),
    at: Date.now(),
  }
}

/** 按开关拉一批（热榜 / 关注 / 历史），返回统一形状的 items。 */
export async function fetchMainBatch({ mod, cookie, cfg, fetchImpl } = {}) {
  const hotOn = cfg?.zhihu?.hot?.enabled !== false
  const followOn = cfg?.zhihu?.follow?.enabled !== false
  const historyOn = cfg?.zhihu?.history?.enabled === true
  const hotN = clamp(cfg?.zhihu?.hot?.topN ?? 8, 1, 20)
  const followN = clamp(cfg?.zhihu?.follow?.topN ?? 8, 1, 20)
  const historyN = clamp(cfg?.zhihu?.history?.topN ?? 10, 1, 20)
  const [hot, follow, history] = await Promise.all([
    hotOn && mod?.fetchHot ? mod.fetchHot({ cookie, limit: hotN, fetchImpl }).catch(() => ({ ok: false, items: [] })) : { ok: false, items: [] },
    followOn && mod?.fetchFollow ? mod.fetchFollow({ cookie, limit: followN, fetchImpl }).catch(() => ({ ok: false, items: [] })) : { ok: false, items: [] },
    historyOn && mod?.fetchHistory ? mod.fetchHistory({ cookie, limit: historyN, fetchImpl }).catch(() => ({ ok: false, items: [] })) : { ok: false, items: [] },
  ])
  const items = []
  for (const it of hot.items ?? []) items.push(toItem('hot', it))
  for (const it of follow.items ?? []) items.push(toItem('follow', it))
  for (const it of history.items ?? []) items.push(toItem('history', it))
  return { ok: items.length > 0, items }
}

/** 首页推荐单独一批（单独开关、单独次数）。 */
export async function fetchRecommendBatch({ mod, cookie, cfg, fetchImpl } = {}) {
  const n = clamp(cfg?.zhihu?.recommend?.topN ?? 6, 1, 20)
  if (!mod?.fetchRecommend) return { ok: false, items: [] }
  const r = await mod.fetchRecommend({ cookie, limit: n, fetchImpl }).catch(() => ({ ok: false, items: [] }))
  return { ok: (r.items ?? []).length > 0, items: (r.items ?? []).map((x) => toItem('recommend', x)) }
}

/** 一条素材 → 一行素材（带上作者/热度，不写评价）。 */
function lineOf(it) {
  const link = it.url ? ` ${it.url}` : ''
  if (it.kind === 'follow') return `- ${it.author ? `${it.author}：` : ''}${it.title}${link}`
  if (it.kind === 'hot') return `- ${it.title}${it.heat ? `（${it.heat}）` : ''}${link}`
  if (it.kind === 'recommend') return `- ${it.author ? `${it.author}：` : ''}${it.title}${link}`
  return `- ${it.title}${link}`
}

/** 把攒下的素材按来源分组拼成提示词段落。 */
export function renderMaterial(items = []) {
  const by = { hot: [], recommend: [], follow: [], history: [] }
  for (const it of items) if (by[it.kind]) by[it.kind].push(it)
  const out = ['## 今天外面在说这些']
  let any = false
  if (by.hot.length) { any = true; out.push('### 热榜', ...by.hot.map(lineOf)) }
  if (by.recommend.length) { any = true; out.push('### 首页推给你的', ...by.recommend.map(lineOf)) }
  if (by.follow.length) { any = true; out.push('### 你关注的人在说', ...by.follow.map(lineOf)) }
  if (by.history.length) {
    any = true
    out.push('### 他最近看过的', '（这一段是他看的，不是你经历的。你知道他最近在关心什么。）', ...by.history.map(lineOf))
  }
  if (!any) return ''
  out.push('（这些是知乎上的公开内容，不是你认识的人专门跟你说的。）')
  return out.join('\n')
}

/** 攒着、还没递出去的素材（不清空）。 */
export async function readPending(root) {
  return (await readState(root)).pending
}

/** 取走素材：先给她看，再清空（seen 留着，避免同一批反复出现）。 */
export async function takePendingMaterial(root) {
  const state = await readState(root)
  const items = Array.isArray(state.pending) ? state.pending : []
  if (!items.length) return { text: '', picks: [] }
  const text = renderMaterial(items)
  await writeState(root, { ...state, pending: [] })
  return { text, picks: items }
}

/* ---------------------------- 定时翻 ---------------------------- */

/**
 * 每分钟调一次：在窗口里按概率随机翻。
 *
 * 为什么用概率而不是排时刻表：`perDay` 是「一天大概几次」，不是「必须几点几分」。
 * 每分钟以 `quota / 窗口分钟数` 的概率掷一次，期望就等于配额，
 * 而落点天然是随机的——用户要的就是「每天随机的时间点」。
 *
 * @returns {Promise<{ran:boolean, items?:number, why?:string}>}
 */
export async function zhihuTick({ root, cfg, now = new Date(), rnd = Math.random, fetchImpl, mod, log } = {}) {
  const z = cfg?.zhihu
  if (!z || z.enabled !== true) return { ran: false, why: 'disabled' }
  if (!inZhihuWindow(cfg, now)) return { ran: false, why: 'out-of-window' }
  const module = mod ?? (await loadZhihu().catch(() => null))
  if (!module) return { ran: false, why: 'no-subpackage' }
  const auth = await module.readAuth(root).catch(() => null)
  if (!auth?.cookie) return { ran: false, why: 'login-required' }

  const dk = dateKey(now)
  const state = await readState(root)
  const fresh = state.dateKey !== dk
  const st = fresh ? { ...state, dateKey: dk, runs: 0, recRuns: 0, lastMinute: -1, pending: [] } : state

  const minute = minuteOfDay(now)
  if (minute === st.lastMinute) return { ran: false, why: 'same-minute' }

  const { span } = zhihuWindowMinutes(cfg)
  const perDay = clamp(z.perDay ?? 4, 0, 8)
  const recPerDay = z.recommend?.enabled === false ? 0 : clamp(z.recommend?.perDay ?? 8, 0, 12)

  let did = 0
  const pending = [...(st.pending ?? [])]
  const seen = { ...(st.seen ?? {}) }
  const pushNew = (items) => {
    let n = 0
    for (const it of items ?? []) {
      if (!it.id || seen[it.id]) continue
      seen[it.id] = Date.now()
      pending.push(it)
      n += 1
    }
    return n
  }

  try {
    if (perDay > 0 && (st.runs ?? 0) < perDay && rnd() < perDay / Math.max(1, span)) {
      const batch = await fetchMainBatch({ mod: module, cookie: auth.cookie, cfg, fetchImpl })
      did += pushNew(batch.items)
      st.runs = (st.runs ?? 0) + 1
    }
    if (recPerDay > 0 && (st.recRuns ?? 0) < recPerDay && rnd() < recPerDay / Math.max(1, span)) {
      const batch = await fetchRecommendBatch({ mod: module, cookie: auth.cookie, cfg, fetchImpl })
      did += pushNew(batch.items)
      st.recRuns = (st.recRuns ?? 0) + 1
    }
  } catch (error) {
    log?.(`zhihu tick failed: ${errorText(error)}`)
    return { ran: false, why: 'error' }
  }

  st.lastMinute = minute
  await writeState(root, { ...st, pending })
  return { ran: did > 0, items: did }
}

/* ---------------------------- 兼容：一次性拉取 ---------------------------- */

/**
 * 一轮采集：拉热榜 + 关注动态（+历史），去掉已经递过的，拼素材（不写 pending）。
 * 留给设置页「让她现在去看一眼」和测试用。
 */
export async function gatherZhihu({ root, cfg, mod, fetchImpl } = {}) {
  const z = cfg?.zhihu
  if (!z || z.enabled !== true) return { ok: false, text: '', picks: [], why: 'disabled' }
  const module = mod ?? (await loadZhihu())
  if (!module) return { ok: false, text: '', picks: [], why: '没装 dsh-fish-river-zhihu（知乎是可选子包）' }
  const auth = await module.readAuth(root).catch(() => null)
  if (!auth?.cookie) return { ok: false, text: '', picks: [], why: 'login-required' }

  const batch = await fetchMainBatch({ mod: module, cookie: auth.cookie, cfg, fetchImpl })
  const state = await readState(root)
  const seen = state.seen ?? {}
  const fresh = (batch.items ?? []).filter((it) => it.id && !seen[it.id])
  if (!fresh.length) return { ok: false, text: '', picks: [], note: '翻到的都看过了' }
  for (const it of fresh) seen[it.id] = Date.now()
  await writeState(root, { ...state, dateKey: dateKey(), seen })
  return { ok: true, text: renderMaterial(fresh), picks: fresh, note: '' }
}

/** 给观测台/设置页看的一行事实：登录的是谁、今天翻过几次。 */
export async function zhihuStatus(root, cfg) {
  const module = await loadZhihu().catch(() => null)
  const state = await readState(root)
  const dk = dateKey()
  const auth = module ? await module.readAuth(root).catch(() => null) : null
  return {
    installed: Boolean(module),
    enabled: cfg?.zhihu?.enabled === true,
    loggedIn: Boolean(auth?.cookie),
    account: auth?.account ?? null,
    runsToday: state.dateKey === dk ? Number(state.runs) || 0 : 0,
    recRunsToday: state.dateKey === dk ? Number(state.recRuns) || 0 : 0,
    pendingCount: (state.pending ?? []).length,
    savedAt: auth?.savedAt ?? '',
  }
}

export default {
  loadZhihu,
  gatherZhihu,
  zhihuTick,
  takePendingMaterial,
  readPending,
  renderMaterial,
  readState,
  writeState,
  runsToday,
  zhihuStatus,
  inZhihuWindow,
  zhihuWindowMinutes,
  statePath,
  DEFAULT_WINDOW,
}
