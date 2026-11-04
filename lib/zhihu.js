/**
 * zhihu.js —— 知乎素材（只读）
 *
 * 定位：和「刷 B 站」「刷抖音」并列的一条**素材线**，不是渠道。
 * 只在她醒来前拉一次，把「今天外面在说什么」拼成素材递进去；
 * 不写事件流（她要不要记住，由她自己 growth_commit）。
 *
 * 三件事只在这一个文件里做：
 *   1. 懒加载子包（没装就整条路消失，和抖音同一个约定）；
 *   2. 用 `<root>/zhihu-state.json` 记「今天拉过几次」和「哪些内容已经递过」；
 *   3. 把热榜 + 关注动态拼成一段人类可读的素材。
 *
 * 为什么计数不写进 events.jsonl：配额是环境参数，不是她的经历。
 * 写事件流会让她以为「我今天看过知乎」——她确实看过，但那份计数不该变成记忆。
 */

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { writeAtomic } from './store.js'
import { dateKey } from './settings.js'

const STATE_VERSION = 1
/** 记住多少个 id：热榜一次 8 条、关注 8 条，300 够一周不重复。 */
const SEEN_MAX = 300
/** 超过这个时间的 id 就忘了，避免快照无限长。 */
const SEEN_TTL_MS = 7 * 86_400_000

function errorText(error) {
  return String(error?.message ?? error).slice(0, 200)
}

/**
 * 装没装知乎子包。没装返回 null——「可选装」靠包装不装，不靠开关。
 * 和 douyin 一样先找包名，再找仓库里的那一份（GitHub / 压缩包装也能用）。
 */
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
  // 超上限时丢掉最旧的
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

/** 今天拉过几次（按 dateKey 归零）。 */
export function runsToday(state, dk) {
  return state?.dateKey === dk ? Number(state.runs) || 0 : 0
}

function bullet(title, suffix = '') {
  return suffix ? `- ${title}（${suffix}）` : `- ${title}`
}

/**
 * 一轮采集：拉热榜 + 关注动态，去掉已经递过的，拼素材。
 *
 * @param {object} o
 * @param {string} o.root
 * @param {object} o.cfg  全量配置（读 cfg.zhihu）
 * @param {object} [o.mod] 测试注入：子包模块
 * @param {Function} [o.fetchImpl] 测试注入
 * @returns {Promise<{ok:boolean, text:string, picks:object[], note?:string, why?:string}>}
 */
export async function gatherZhihu({ root, cfg, mod, fetchImpl } = {}) {
  const z = cfg?.zhihu
  if (!z || z.enabled !== true) return { ok: false, text: '', picks: [], why: 'disabled' }
  const module = mod ?? (await loadZhihu())
  if (!module) return { ok: false, text: '', picks: [], why: '没装 dsh-fish-river-zhihu（知乎是可选子包）' }

  const auth = await module.readAuth(root).catch(() => null)
  if (!auth?.cookie) return { ok: false, text: '', picks: [], why: 'login-required' }

  const hotOn = z?.hot?.enabled !== false
  const followOn = z?.follow?.enabled !== false
  if (!hotOn && !followOn) return { ok: false, text: '', picks: [], why: '两条都关着' }

  const hotN = Math.max(1, Math.min(20, Number(z?.hot?.topN ?? 8)))
  const followN = Math.max(1, Math.min(20, Number(z?.follow?.topN ?? 8)))
  const [hot, follow] = await Promise.all([
    hotOn ? module.fetchHot({ cookie: auth.cookie, limit: hotN, fetchImpl }).catch((e) => ({ ok: false, items: [], why: errorText(e) })) : { ok: false, items: [], why: '关着' },
    followOn ? module.fetchFollow({ cookie: auth.cookie, limit: followN, fetchImpl }).catch((e) => ({ ok: false, items: [], why: errorText(e) })) : { ok: false, items: [], why: '关着' },
  ])

  // 单路失败不影响另一路；两路都失败就这次没有素材。
  if (!hot.ok && !follow.ok) {
    const why = [hot.why, follow.why].filter(Boolean).join('；')
    return { ok: false, text: '', picks: [], why: why || '两路都没拉到' }
  }

  const state = await readState(root)
  const seen = state.seen ?? {}
  const freshHot = (hot.items ?? []).filter((it) => it.id && !seen[it.id])
  const freshFollow = (follow.items ?? []).filter((it) => it.id && !seen[it.id])
  if (!freshHot.length && !freshFollow.length) {
    return { ok: false, text: '', picks: [], note: '翻到的都看过了' }
  }

  const sections = []
  if (freshHot.length) {
    sections.push('### 热榜', ...freshHot.map((it) => bullet(it.title, it.heat)))
  }
  if (freshFollow.length) {
    sections.push('### 你关注的人在说', ...freshFollow.map((it) => bullet(it.author ? `${it.author}：${it.title}` : it.title)))
  }
  const text = [
    '## 今天外面在说这些',
    '（这些是知乎上的公开内容，不是你认识的人专门跟你说的。）',
    ...sections,
  ].join('\n')

  // 记账：今天第几次 + 已经递过的 id
  const dk = dateKey()
  const runs = state.dateKey === dk ? Number(state.runs) || 0 : 0
  const now = Date.now()
  const nextSeen = { ...seen }
  for (const it of [...freshHot, ...freshFollow]) nextSeen[it.id] = now
  await writeState(root, { dateKey: dk, runs: runs + 1, seen: nextSeen })

  return {
    ok: true,
    text,
    picks: [...freshHot, ...freshFollow],
    note: '',
  }
}

/** 给观测台/设置页看的一行事实：登录的是谁、今天拉过几次。 */
export async function zhihuStatus(root, cfg) {
  const module = await loadZhihu().catch(() => null)
  if (!module) return { installed: false, enabled: cfg?.zhihu?.enabled === true, loggedIn: false }
  const auth = await module.readAuth(root).catch(() => null)
  const state = await readState(root)
  return {
    installed: true,
    enabled: cfg?.zhihu?.enabled === true,
    loggedIn: Boolean(auth?.cookie),
    account: auth?.account ?? null,
    runsToday: runsToday(state, dateKey()),
    savedAt: auth?.savedAt ?? '',
  }
}

export default { loadZhihu, gatherZhihu, readState, writeState, runsToday, statePath, zhihuStatus }
