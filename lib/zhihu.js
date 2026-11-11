/**
 * zhihu.js —— 知乎素材（只读）
 *
 * 定位：和「刷 B 站」「刷抖音」并列的一条**素材线**，不是渠道。
 * 2026-11-05 起改成和 B 站同一种动作：她醒来、作息掷骰命中知乎时，**现场抓一次**，
 * 当次递给她；不再白天预翻、不再攒 pending。一次抓 = 一次上网行为（作息配额按次算）。
 *
 * 三件事只在这一个文件里做：
 *   1. 懒加载子包（没装就整条路消失，和抖音同一个约定）；
 *   2. 用 `<root>/zhihu-state.json` 记「今天抓过几次、哪些 id 已经给过」；
 *   3. 把勾选的来源（热榜 / 关注 / 推荐 / 历史）拼成一段人类可读的素材。
 *
 * 热榜 / 关注 / 推荐 / 历史不写事件流：配额和素材都是环境参数，不是她的经历。
 * 要不要记住由她自己 growth_commit。
 * 别人的评论是另一条线（2026-11-05）：`zhihu.voices` 开着时，一天最多把 1 条收成
 * voice 事件（社会层）。浏览历史不参与。关着时这里一个事件都不写。
 */

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { writeAtomic, readEvents } from './store.js'
import { dateKey, dailyQuota } from './settings.js'
import { pacedFetch } from './pacing.js'
import { ownerLine } from './ownership.js'

const STATE_VERSION = 3
/** 记住多少个 id：一天翻几次 × 每次几十条，300 够一周不重复。 */
const SEEN_MAX = 300
/** 超过这个时间的 id 就忘了，避免快照无限长。 */
const SEEN_TTL_MS = 7 * 86_400_000

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

/** 读快照：只有「今天抓过几次」和「哪些 id 给过」。坏档当空。 */
export async function readState(root) {
  try {
    const parsed = JSON.parse(await readFile(statePath(root), 'utf8'))
    return {
      version: STATE_VERSION,
      dateKey: String(parsed?.dateKey ?? ''),
      runs: Number(parsed?.runs) || 0,
      seen: parsed?.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
    }
  } catch {
    return { version: STATE_VERSION, dateKey: '', runs: 0, seen: {} }
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
  const next = {
    version: STATE_VERSION,
    dateKey: String(state?.dateKey ?? ''),
    runs: Number(state?.runs) || 0,
    seen: trimmed,
  }
  try {
    await writeAtomic(statePath(root), JSON.stringify(next, null, 2), 0o600)
    return { ok: true }
  } catch (error) {
    return { ok: false, why: errorText(error) }
  }
}

/** 今天抓过几次（按 dateKey 归零）。 */
export function runsToday(state, dk) {
  return state?.dateKey === dk ? Number(state.runs) || 0 : 0
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
/**
 * 候选问题：只给标题、问题 id、来源；不替她选、不替她写。
 * 她要用 zhihu_look kind=question 点开，才能回答（opensToday 认的是 zhihu-open）。
 */
export function renderQuestions(questions = []) {
  const list = Array.isArray(questions) ? questions.filter((q) => q?.id && q?.title) : []
  if (!list.length) return ''
  const label = { invite: '邀请', recommend: '推荐', home: '首页' }
  return [
    '## 可以回答的问题',
    '（这些是平台递到你面前的问题。想答，先用 zhihu_look 点开问题；没点开过的不算。）',
    ...list.map((q) => `- ${q.title}（问题 ${q.id}，${label[q.source] ?? '推荐'}）`),
  ].join('\n')
}

export function renderMaterial(items = [], config) {
  const by = { hot: [], recommend: [], follow: [], history: [] }
  for (const it of items) if (by[it.kind]) by[it.kind].push(it)
  const scene = ownerLine('知乎', config?.zhihu?.owner)
  const out = [scene, '## 今天外面在说这些']
  let any = false
  if (by.hot.length) { any = true; out.push('### 热榜', ...by.hot.map(lineOf)) }
  if (by.recommend.length) { any = true; out.push('### 首页推给你的', ...by.recommend.map(lineOf)) }
  if (by.follow.length) { any = true; out.push('### 你关注的人在说', ...by.follow.map(lineOf)) }
  if (by.history.length) {
    any = true
    out.push('### 重要的人最近看过的', '（这一段是重要的人看的，不是你经历的。你知道重要的人最近在关心什么。）', ...by.history.map(lineOf))
  }
  if (!any) return ''
  out.push('（这些是知乎上的公开内容，不是你认识的人专门跟你说的。）')
  return out.join('\n')
}

/**
 * 现场抓一次知乎（2026-11-05，和刷 B 站同一个动作）。
 *
 * 按 `zhihu.hot/follow/recommend/history` 的开关各抓一份；id 去过重（300 个/7 天）。
 * 每个请求都过全局「请求节奏」（lib/pacing.js）。一次抓 = 一次上网：
 * 会先把今天的 runs 加一，配额满了直接 blocked，不会空手假装抓过。
 *
 * 别人的评论：抓完从当次素材里挑一处，一天最多留 1 条 voice（社会层）。
 *
 * @returns {Promise<{ok:boolean, text:string, picks:object[], acted:boolean, blocked:boolean, why:string}>}
 */
export async function fetchZhihuMaterial({ root, cfg, now = new Date(), fetchImpl, mod, log } = {}) {
  const empty = { ok: false, text: '', picks: [], acted: false, blocked: true, why: '' }
  const z = cfg?.zhihu
  if (!z || z.enabled !== true) return { ...empty, why: 'disabled' }
  const module = mod ?? (await loadZhihu().catch(() => null))
  if (!module) return { ...empty, why: 'no-subpackage' }
  const auth = await module.readAuth(root).catch(() => null)
  if (!auth?.cookie) return { ...empty, why: 'login-required' }

  const cap = dailyQuota(cfg, 'zhihu')
  if (cap <= 0) return { ...empty, why: 'quota' }
  const dk = dateKey(now)
  const state = await readState(root)
  const runs = state.dateKey === dk ? Number(state.runs) || 0 : 0
  if (runs >= cap) return { ...empty, why: 'quota' }

  const hotOn = z.hot?.enabled !== false
  const followOn = z.follow?.enabled !== false
  const recOn = z.recommend?.enabled !== false
  const histOn = z.history?.enabled !== false
  if (!hotOn && !followOn && !recOn && !histOn) return { ...empty, why: 'nothing-selected' }

  const paced = fetchImpl ?? pacedFetch()
  const seen = { ...(state.seen ?? {}) }
  const items = []
  const push = (kind, list) => {
    for (const it of list ?? []) {
      const id = String(it?.id ?? '')
      const title = String(it?.title ?? '').trim()
      if (!id || !title || seen[id]) continue
      seen[id] = Date.now()
      items.push({
        kind,
        id,
        title,
        author: String(it?.author ?? '').trim(),
        heat: String(it?.heat ?? '').trim(),
        url: String(it?.url ?? '').trim(),
        at: Date.now(),
      })
    }
  }

  const limit = (v, dflt) => clamp(v ?? dflt, 1, 20)
  let recResult = null
  try {
    const [hot, follow, rec, hist] = await Promise.all([
      hotOn ? module.fetchHot({ cookie: auth.cookie, limit: limit(z.hot?.topN, 8), fetchImpl: paced }).catch(() => null) : null,
      followOn ? module.fetchFollow({ cookie: auth.cookie, limit: limit(z.follow?.topN, 8), fetchImpl: paced }).catch(() => null) : null,
      recOn ? module.fetchRecommend({ cookie: auth.cookie, limit: limit(z.recommend?.topN, 6), fetchImpl: paced }).catch(() => null) : null,
      histOn ? module.fetchHistory({ cookie: auth.cookie, limit: limit(z.history?.topN, 10), fetchImpl: paced }).catch(() => null) : null,
    ])
    recResult = rec
    if (hot) push('hot', hot.items)
    if (follow) push('follow', follow.items)
    if (rec) push('recommend', rec.items)
    if (hist) push('history', hist.items)
  } catch (error) {
    log?.(`zhihu fetch failed: ${errorText(error)}`)
    return { ...empty, why: 'error' }
  }

  // 2026-11-06：知乎不再读评论区（读评论统一挪到社会层，之后再接）。

  // 回答问题：只有开关打开时才多抓邀请/推荐两路；首页推荐复用 recResult，不重复请求。
  const questions = []
  if (z.answer?.enabled === true) {
    try {
      const [inv, qrec] = await Promise.all([
        module.fetchQuestionInvites ? module.fetchQuestionInvites({ cookie: auth.cookie, limit: 20, fetchImpl: paced }).catch(() => null) : null,
        module.fetchQuestionRecommend ? module.fetchQuestionRecommend({ cookie: auth.cookie, limit: 20, fetchImpl: paced }).catch(() => null) : null,
      ])
      const home = (recResult?.items ?? []).filter((x) => x?.kind === 'question')
        .map((x) => ({ id: String(x.id ?? '').replace(/^rec:/, ''), title: String(x.title ?? '').trim(), source: 'home', url: x.url }))
      for (const list of [inv?.items, qrec?.items, home]) {
        for (const q of list ?? []) {
          if (!q?.id || !q?.title) continue
          if (questions.some((x) => x.id === q.id)) continue
          questions.push({ id: String(q.id), title: String(q.title).trim(), source: q.source ?? 'recommend', url: q.url ?? '' })
          if (questions.length >= 6) break
        }
        if (questions.length >= 6) break
      }
    } catch { /* 问题源失败不影响素材 */ }
  }

  await writeState(root, { dateKey: dk, runs: runs + 1, seen })
  const listText = items.length ? renderMaterial(items, cfg) : ''
  const qText = renderQuestions(questions)
  const text = [listText, qText].filter(Boolean).join('\n\n')
  return { ok: Boolean(text), text, picks: items, questions, acted: true, blocked: false, why: text ? '' : 'empty' }
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
    savedAt: auth?.savedAt ?? '',
  }
}

export default {
  loadZhihu,
  gatherZhihu,
  fetchZhihuMaterial,
  renderMaterial,
  renderQuestions,
  readState,
  writeState,
  runsToday,
  zhihuStatus,
  statePath,
}
