/**
 * douyinbrowse.js —— 她"刷抖音"这件事（2026-11-02，用户 m03490）
 *
 * 和 `browse.js` 一个地位：**她自己去看**，不是别人找她。看进眼里的东西喂给她，
 * 她说什么由她自己决定；写进事件流的只有她说过的话，视频本身只留在素材与记账里。
 *
 * 为什么单独一个文件而不是塞进 browse.js：
 *   · 抖音的能力在可选子包 `dsh-fish-river-douyin` 里，主包没装就必须整条路消失；
 *   · B 站是 HTTP 接口，抖音是真浏览器，失败模式完全不同（拉不起 Edge 是常态）。
 *
 * 三条约束和 B 站一样：只读、永不抛、素材不是指令。
 */

import { appendEvent, readEvents } from './store.js'
import { dateKey } from './settings.js'
import path from 'node:path'
import { ownerLine } from './ownership.js'

/** 记账前缀。配额按它算，和 B 站的 `browse:` 分开——两边各刷各的。 */
export const DY_PREFIX = 'dy-browse:'

/** 今天的抖音刷了几次。 */
export function douyinCountToday(events, dk = dateKey()) {
  const want = `${DY_PREFIX}${dk}`
  let n = 0
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    if (String(e.text ?? '').startsWith(want)) n += 1
  }
  return n
}

/** 看过哪些，用来去重（同一条视频不该连着两天喂给她）。 */
export function douyinSeenIds(events, keepDays = 7) {
  const out = new Set()
  for (const e of events ?? []) {
    const t = String(e?.text ?? '')
    if (!t.startsWith(DY_PREFIX) && !t.startsWith(`${DY_PREFIX}more:`)) continue
    const body = t.slice(t.indexOf('[') + 1, t.lastIndexOf(']'))
    if (!body) continue
    try {
      for (const it of JSON.parse(`[${body}]`)) if (it?.id) out.add(String(it.id))
    } catch { /* 一条记账坏了不该让整轮失败 */ }
  }
  return { ids: out, keepDays }
}

/** 把一批视频拼成素材。写成"平台上有什么"，不写成"你应该觉得什么"。 */
export function renderDouyin(items, cfg = null) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return ''
  const scene = ownerLine('抖音', cfg?.browse?.douyin?.owner ?? 'owner')
  const lines = [scene, '（抖音 · 此刻推到你面前的）']
  list.forEach((it, i) => {
    const title = String(it.title ?? '').trim() || '（没有标题）'
    const author = String(it.author ?? '').trim()
    const like = String(it.like ?? '').trim()
    const bits = [author ? `@${author}` : '', like ? `${like} 赞` : ''].filter(Boolean).join(' · ')
    lines.push(`${i + 1}. ${title}${bits ? `（${bits}）` : ''}`)
  })
  return lines.join('\n')
}

/** 记账：今天看了哪几条。分片写，和 B 站同一套上限。 */
export async function recordDouyinBrowse(root, dk, items, model) {
  const slim = (items ?? []).slice(0, 20).map((it) => ({
    id: String(it.id ?? ''),
    title: String(it.title ?? '').slice(0, 80),
    author: String(it.author ?? '').slice(0, 40),
    like: String(it.like ?? '').slice(0, 20),
    href: String(it.href ?? '').slice(0, 200),
  })).filter((it) => it.id)
  if (!slim.length) return null
  const head = { day: Number(model?.day ?? 0), stage: Number(model?.stage ?? 1), source: 'system' }
  const chunk = []
  let size = 0
  const chunks = []
  for (const it of slim) {
    const n = JSON.stringify(it).length
    if (chunk.length && size + n > 1800) { chunks.push(chunk.slice()); chunk.length = 0; size = 0 }
    chunk.push(it)
    size += n
  }
  if (chunk.length) chunks.push(chunk)
  let last = null
  for (let i = 0; i < chunks.length; i++) {
    const pre = i === 0 ? DY_PREFIX : `${DY_PREFIX}more:`
    try {
      last = await appendEvent({ type: 'meta', text: `${pre}${dk} ${JSON.stringify(chunks[i])}` }, head, root)
    } catch {
      return last
    }
  }
  return last
}

/**
 * 装没装抖音子包。没装就整条路消失——「可选装」靠包装不装，不靠开关。
 * @returns {Promise<object|null>}
 */
export async function loadDouyin(importer = (n) => import(n)) {
  try {
    const mod = await importer('dsh-fish-river-douyin')
    return mod && typeof mod.browseFeed === 'function' ? mod : null
  } catch {
    return null
  }
}

/**
 * 完整一轮：拉推荐 → 去重 → 拼素材 → 记账。返回 `{ ok, text, picks, note }`，永不抛。
 *
 * @param {object} o
 * @param {Function} [o.feed]  测试注入：`({limit}) => Promise<{ok, items}>`
 */
export async function gatherDouyin({ model, cfg, root, dk, events, feed, limit } = {}) {
  const note = []
  try {
    const day = dk ?? dateKey()
    const evs = events ?? (await readEvents(root).then((r) => r.events).catch(() => []))
    const want = Math.max(1, Math.min(20, Number(limit ?? cfg?.browse?.douyin?.topN ?? 4)))
    const { ids } = douyinSeenIds(evs)

    let got
    if (typeof feed === 'function') {
      got = await feed({ limit: want })
    } else {
      const mod = await loadDouyin()
      if (!mod) return { ok: false, text: '', picks: [], note: '没装 dsh-fish-river-douyin（抖音是可选子包）' }
      const transport = await mod.createCdpTransport?.({
        browserPath: cfg?.browse?.douyin?.browserPath || cfg?.channels?.douyin?.browserPath || '',
        // 2026-11-02：登录态必须留在她自己的数据目录里。子包原来默认 `os.tmpdir()`，
        // 每轮换一个临时 profile —— 用户扫码登录一次，下一轮就又是未登录，
        // 而抖音网页版对未登录访客基本不给推荐流（`/jingxuan` 只有导航栏）。
        profileDir: path.join(root, 'douyin-profile'),
      })
      const started = await transport?.start?.()
      if (started && started.ok === false) return { ok: false, text: '', picks: [], note: started.why ?? '浏览器没起来' }
      try {
        got = await mod.browseFeed({ transport, limit: want })
      } finally {
        await transport?.close?.().catch?.(() => {})
      }
    }

    if (!got?.ok) return { ok: false, text: '', picks: [], note: got?.why ?? '没拉到' }
    const fresh = (got.items ?? []).filter((it) => it?.id && !ids.has(String(it.id))).slice(0, want)
    if (!fresh.length) {
      return { ok: false, text: '', picks: [], note: (got.items ?? []).length ? '翻到的都看过了' : '平台这会儿没给' }
    }
    await recordDouyinBrowse(root, day, fresh, model)
    return {
      ok: true,
      text: renderDouyin(fresh, cfg),
      picks: fresh.map((it) => ({ bvid: `dy_${it.id}`, title: it.title, up: it.author, duration: 0, view: 0, pic: '' })),
      note: note.join('；'),
      dk: day,
    }
  } catch (err) {
    return { ok: false, text: '', picks: [], note: String(err?.message ?? err) }
  }
}
