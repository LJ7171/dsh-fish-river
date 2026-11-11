/**
 * material.js —— 知乎素材：抓、去重、拼成一段给人看的文字。
 *
 * 热榜 / 关注 / 推荐 / 历史不写事件流。一次抓 = 一次上网，次数记在 zhihu-state.json。
 * 每天几次由宿主的 dailyQuota 决定（作息配额），不在这里另写一套。
 */

import { readState, writeState } from './state.js'
import { errorText, hostOf, localApi } from './runtime.js'

function clamp(n, lo, hi) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo
}

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

function lineOf(it) {
  const link = it.url ? ` ${it.url}` : ''
  if (it.kind === 'follow') return `- ${it.author ? `${it.author}：` : ''}${it.title}${link}`
  if (it.kind === 'hot') return `- ${it.title}${it.heat ? `（${it.heat}）` : ''}${link}`
  if (it.kind === 'recommend') return `- ${it.author ? `${it.author}：` : ''}${it.title}${link}`
  return `- ${it.title}${link}`
}

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

export function renderMaterial(items = [], config, host) {
  const h = hostOf(host)
  const by = { hot: [], recommend: [], follow: [], history: [] }
  for (const it of items) if (by[it.kind]) by[it.kind].push(it)
  const scene = h.ownerLine('知乎', config?.zhihu?.owner)
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

const EMPTY = { ok: false, text: '', picks: [], acted: false, blocked: true, why: '' }

/**
 * 现场抓一次知乎。按勾选的来源各抓一份；id 去过重（300 个 / 7 天）。
 * 会先把今天的 runs 加一。配额满了直接 blocked，不会空手假装抓过。
 */
export async function fetchZhihuMaterial({ root, cfg, now = new Date(), fetchImpl, mod, log, host } = {}) {
  const h = hostOf(host)
  const z = cfg?.zhihu
  if (!z || z.enabled !== true) return { ...EMPTY, why: 'disabled' }
  const module = mod ?? localApi()
  const auth = await module.readAuth(root).catch(() => null)
  if (!auth?.cookie) return { ...EMPTY, why: 'login-required' }

  const cap = h.dailyQuota(cfg, 'zhihu')
  if (cap <= 0) return { ...EMPTY, why: 'quota' }
  const dk = h.dateKey(now)
  const state = await readState(root)
  const runs = state.dateKey === dk ? Number(state.runs) || 0 : 0
  if (runs >= cap) return { ...EMPTY, why: 'quota' }

  const hotOn = z.hot?.enabled !== false
  const followOn = z.follow?.enabled !== false
  const recOn = z.recommend?.enabled !== false
  const histOn = z.history?.enabled !== false
  // 回答问题也算一种素材来源：素材全关、但允许回答且有额度时，仍要抓问题。
  const answerOn = z.answer?.enabled === true && Number(z.answer?.perDay) > 0
  if (!hotOn && !followOn && !recOn && !histOn && !answerOn) return { ...EMPTY, why: 'nothing-selected' }

  const paced = fetchImpl ?? h.pacedFetch()
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
    return { ...EMPTY, why: 'error' }
  }

  const questions = []
  if (answerOn) {
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
          const seenKey = `q:${dk}:${q.id}`
          if (seen[seenKey] || questions.some((x) => x.id === q.id)) continue
          seen[seenKey] = Date.now()
          questions.push({ id: String(q.id), title: String(q.title).trim(), source: q.source ?? 'recommend', url: q.url ?? '' })
          if (questions.length >= 6) break
        }
        if (questions.length >= 6) break
      }
    } catch { /* 问题源失败不影响素材 */ }
  }

  await writeState(root, { dateKey: dk, runs: runs + 1, seen }, h)
  const listText = items.length ? renderMaterial(items, cfg, h) : ''
  const qText = renderQuestions(questions)
  const text = [listText, qText].filter(Boolean).join('\n\n')
  return { ok: Boolean(text), text, picks: items, questions, acted: true, blocked: false, why: text ? '' : 'empty' }
}

/** 一轮采集：拉热榜 + 关注动态（+历史），去掉已经递过的。留给「现在去看一眼」和测试。 */
export async function gatherZhihu({ root, cfg, mod, fetchImpl, host } = {}) {
  const h = hostOf(host)
  const z = cfg?.zhihu
  if (!z || z.enabled !== true) return { ok: false, text: '', picks: [], why: 'disabled' }
  const module = mod ?? localApi()
  const auth = await module.readAuth(root).catch(() => null)
  if (!auth?.cookie) return { ok: false, text: '', picks: [], why: 'login-required' }

  const batch = await fetchMainBatch({ mod: module, cookie: auth.cookie, cfg, fetchImpl })
  const state = await readState(root)
  const seen = state.seen ?? {}
  const fresh = (batch.items ?? []).filter((it) => it.id && !seen[it.id])
  if (!fresh.length) return { ok: false, text: '', picks: [], note: '翻到的都看过了' }
  for (const it of fresh) seen[it.id] = Date.now()
  await writeState(root, { ...state, dateKey: h.dateKey(), seen }, h)
  return { ok: true, text: renderMaterial(fresh, cfg, h), picks: fresh, note: '' }
}

/** 给观测台 / 设置页看的一行事实：登录的是谁、今天翻过几次。 */
export async function zhihuStatus(root, cfg, host) {
  const h = hostOf(host)
  const state = await readState(root)
  const dk = h.dateKey()
  const auth = await localApi().readAuth(root).catch(() => null)
  return {
    installed: true,
    enabled: cfg?.zhihu?.enabled === true,
    loggedIn: Boolean(auth?.cookie),
    account: auth?.account ?? null,
    runsToday: state.dateKey === dk ? Number(state.runs) || 0 : 0,
    savedAt: auth?.savedAt ?? '',
  }
}

export default {
  fetchMainBatch,
  fetchRecommendBatch,
  renderQuestions,
  renderMaterial,
  fetchZhihuMaterial,
  gatherZhihu,
  zhihuStatus,
}
