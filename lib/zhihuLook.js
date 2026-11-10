/**
 * zhihuLook.js —— 她自己的另一双眼睛：`zhihu_look` 工具
 *
 * 为什么单独给一个工具，而不是只靠「白天翻好、醒来递给她」：
 *   能不能自己决定看什么，是「自主」这个需要的唯一可验证载体。
 *   定时素材是「外面有什么」，这个工具是「我现在想看看别的」。
 *   2026-11-05 起还能**点进去**：看一个问题、看一条回答、看它的评论——
 *   点不点由她自己决定，工具只负责把那一页的内容搬回来。
 *
 * 三条约束（和 bili_look 同构）：
 *   1. **只读**：不评论、不私信、不点赞，看什么都不会在账号上留痕迹；
 *   2. **不回显状态**：不告诉她「今天还剩几次」「你处于第几阶段」；
 *   3. **不给她配置**：不知道有开关、有配额；开关关着就只说「现在看不了」。
 */

import { defineTool } from './tool.js'
import { loadConfig, dateKey } from './settings.js'
import { guardWrite } from './tenant.js'
import { appendEvent, rootDir } from './store.js'
import { loadZhihu } from './zhihu.js'
import { sanitizeForeign } from './guard.js'
import { recordZhihuVoice } from './voices.js'
import { occasionLine, resolveOccasion } from './channels/passport.js'
import { ownerLine } from './ownership.js'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { slashed } from './posix.js'
import { sniffImageExt, fetchableImageUrl } from './media.js'
import { pacedFetch } from './pacing.js'
import { formatZhihuBrowse, formatZhihuOpen } from './acts.js'

/** 列表类：不用给 id。 */
const LIST_KINDS = ['all', 'hot', 'recommend', 'follow', 'history']
/** 详情类：要给 id（或者直接给链接）。 */
const DETAIL_KINDS = ['question', 'answer', 'comments']
const KINDS = [...LIST_KINDS, ...DETAIL_KINDS]

/** 链接 / 裸 id → { questionId, answerId, articleId, raw }。 */
export function parseTarget(value) {
  const s = String(value ?? '').trim()
  if (!s) return {}
  const out = {}
  const q = /\/question\/(\d+)/.exec(s)
  if (q) out.questionId = q[1]
  const a = /\/answer\/(\d+)/.exec(s)
  if (a) out.answerId = a[1]
  const p = /(?:zhuanlan\.zhihu\.com\/p|\/p)\/(\d+)/.exec(s)
  if (p) out.articleId = p[1]
  if (!out.questionId && !out.answerId && !out.articleId && /^\d+$/.test(s)) out.raw = s
  return out
}

function materialScene(config) {
  return ownerLine('知乎', config?.zhihu?.owner)
}

function renderList(items, config) {
  const groups = [
    ['hot', '热榜'],
    ['recommend', '首页推给你的'],
    ['follow', '你关注的人在说'],
    ['history', '重要的人最近看过的'],
  ]
  const out = []
  for (const [kind, title] of groups) {
    const list = items.filter((x) => x.kind === kind)
    if (!list.length) continue
    out.push(`### ${title}`)
    for (const it of list) {
      const who = it.author ? `${it.author}：` : ''
      const heat = it.heat ? `（${it.heat}）` : ''
      const link = it.url ? ` ${it.url}` : ''
      out.push(`- ${who}${it.title}${heat}${link}`)
    }
    if (kind === 'history') out.push('（这一段是重要的人看的，不是你经历的。）')
  }
  if (!out.length) return ''
  return [materialScene(config), ...out].join('\n')
}

/* ---------------------------- 图片：落盘给她看 ---------------------------- */

const MEDIA_DIR = 'zhihu-media'
const IMG_MAX_DEFAULT = 2
const IMG_MAX_BYTES = 8 * 1024 * 1024
const IMG_TTL_MS = 7 * 86_400_000
const IMG_KEEP = 30

function imagesCap(cfg) {
  const n = Number(cfg?.zhihu?.images?.max)
  return Number.isFinite(n) ? Math.max(1, Math.min(6, Math.round(n))) : IMG_MAX_DEFAULT
}

function imagesOn(cfg) {
  return cfg?.zhihu?.images?.enabled !== false
}

async function sweep(root) {
  try {
    const dir = join(root, MEDIA_DIR)
    const names = await readdir(dir).catch(() => [])
    const rows = []
    for (const name of names) {
      const full = join(dir, name)
      const st = await stat(full).catch(() => null)
      if (!st) continue
      if (Date.now() - st.mtimeMs > IMG_TTL_MS) await unlink(full).catch(() => {})
      else rows.push({ full, mtime: st.mtimeMs })
    }
    rows.sort((a, b) => a.mtime - b.mtime)
    for (const row of rows.slice(0, Math.max(0, rows.length - IMG_KEEP))) await unlink(row.full).catch(() => {})
  } catch { /* 清理失败不影响这次阅读 */ }
}

/**
 * 把正文里的图下载到本机。她的 read_image 只能读文件，链接读不了。
 * 失败就少一张图，不影响文字。
 * @returns {Promise<string[]>} 本地绝对路径
 */
export async function saveImages({ root, urls = [], tag = 'zhihu', fetchImpl = null, max = IMG_MAX_DEFAULT } = {}) {
  const doFetch = fetchImpl ?? pacedFetch()
  const cap = Math.max(0, Math.min(6, Number(max) || 0))
  const out = []
  for (const [i, raw] of urls.slice(0, cap).entries()) {
    try {
      // 回答正文里的图片地址不可信：只走 https，且拒绝 localhost/内网 IP/组播
      // （与 media.saveFetchedImages 同一道 SSRF 闸）。
      const url = fetchableImageUrl(raw)
      if (!url) continue
      const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15000) : undefined
      const res = await doFetch(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.zhihu.com/' }, signal })
      if (!res?.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length || buf.length > IMG_MAX_BYTES) continue
      const ext = sniffImageExt(buf)
      if (!ext) continue
      const dir = join(root, MEDIA_DIR)
      await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {})
      const safe = String(tag).replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40) || 'zhihu'
      const file = join(dir, `${safe}-${i}.${ext}`)
      await writeFile(file, buf, { mode: 0o600 })
      out.push(slashed(file))
    } catch { /* 单张失败不影响其它 */ }
  }
  if (out.length) void sweep(root)
  return out
}

function imageLines(paths) {
  return paths.length ? ['', ...paths.map((p) => `（有图存在 ${slashed(p)}，想看就用 read_image。）`)] : []
}

/** 记一条动作。不加 runs：每天的次数只在 fetchZhihuMaterial 里加。 */
async function noteAct(root, text, sessionId) {
  const line = String(text ?? '')
  if (!line) return
  const stamp = sessionId ? { sessionId } : {}
  await appendEvent(
    { type: 'meta', text: line, ...stamp },
    { day: 0, stage: 1, source: 'system' },
    root,
  ).catch(() => {})
}

const BROWSE_KINDS = new Set(['all', 'hot', 'recommend'])

function renderQuestion(q, config) {
  const out = [materialScene(config), `### 问题：${q.question.title || '（没读到标题）'}`]
  if (q.question.answerCount) out.push(`（共 ${q.question.answerCount} 个回答，这里是最靠前的几条）`)
  for (const a of q.answers) {
    out.push('', `**${a.author || '匿名'}**（赞 ${a.votes} · 评论 ${a.comments}）`, a.text, a.url)
  }
  return out.join('\n')
}

function renderAnswer(a, config) {
  const out = [materialScene(config), `### ${a.question.title || '一条回答'}`]
  out.push(`**${a.author || '匿名'}**（赞 ${a.votes} · 评论 ${a.comments}）`, '', a.text)
  if (a.url) out.push('', a.url)
  return out.join('\n')
}

function renderComments(c) {
  const scene = occasionLine(resolveOccasion({ channel: 'zhihu', kind: 'comment' }))
  const out = [scene, `### 评论${c.total ? `（共 ${c.total} 条，这里按分数取前 ${c.comments.length} 条）` : ''}`]
  for (const x of c.comments) {
    out.push(`- ${x.author || '匿名'}（赞 ${x.likes}${x.replies ? ` · 回复 ${x.replies}` : ''}）：${x.text}`)
  }
  return out.join('\n')
}

/**
 * 现场拉一次（给工具和测试用）。
 * @returns {Promise<{ok:boolean, text:string, picks:object[], note:string}>}
 */
export async function zhihuLookOnce({ root, cfg, kind = 'all', id = '', target = '', topN, orderBy = 'score', mod, fetchImpl, sessionId = '' } = {}) {
  if (!cfg?.zhihu?.enabled) return { ok: false, text: '', picks: [], note: '现在看不了。' }
  const module = mod ?? (await loadZhihu().catch(() => null))
  if (!module) return { ok: false, text: '', picks: [], note: '现在看不了。' }
  const auth = await module.readAuth(root).catch(() => null)
  if (!auth?.cookie) return { ok: false, text: '', picks: [], note: '现在看不了。' }

  const n = Math.max(1, Math.min(20, Number(topN) || 0)) || null
  const parsed = parseTarget(id || '')

  try {
    // ---- 详情：问题 / 回答 / 评论 ----
    if (kind === 'question') {
      const qid = parsed.questionId || parsed.raw || ''
      if (!qid) return { ok: false, text: '', picks: [], note: '要给问题号，或者一条带 /question/ 的链接。' }
      const r = await module.fetchQuestion({ cookie: auth.cookie, id: qid, limit: n ?? 5, fetchImpl })
      if (!r.ok) return { ok: false, text: '', picks: [], note: r.why }
      const cap = imagesCap(cfg)
      const urls = imagesOn(cfg) ? (r.answers ?? []).flatMap((a) => a.images ?? []).slice(0, cap) : []
      const pics = urls.length ? await saveImages({ root, urls, tag: `q-${qid}`, fetchImpl, max: cap }) : []
      const text = [sanitizeForeign(renderQuestion(r, cfg)).text, ...imageLines(pics)].join('\n')
      await noteAct(root, formatZhihuOpen(dateKey(), qid, r.question?.title), sessionId)
      return { ok: true, text, picks: r.answers, note: '' }
    }
    if (kind === 'answer') {
      const aid = parsed.answerId || parsed.raw || ''
      if (!aid) return { ok: false, text: '', picks: [], note: '要给回答号，或者一条带 /answer/ 的链接。' }
      const r = await module.fetchAnswer({ cookie: auth.cookie, id: aid, fetchImpl })
      if (!r.ok) return { ok: false, text: '', picks: [], note: r.why }
      const cap = imagesCap(cfg)
      const urls = imagesOn(cfg) ? (r.answer.images ?? []).slice(0, cap) : []
      const pics = urls.length ? await saveImages({ root, urls, tag: `a-${aid}`, fetchImpl, max: cap }) : []
      const text = [sanitizeForeign(renderAnswer(r.answer, cfg)).text, ...imageLines(pics)].join('\n')
      await noteAct(root, formatZhihuOpen(dateKey(), aid, r.answer?.question?.title || r.answer?.text), sessionId)
      return { ok: true, text, picks: [r.answer], note: '' }
    }
    if (kind === 'comments') {
      const which = target === 'article' || parsed.articleId
        ? 'article'
        : target === 'question' || (parsed.questionId && !parsed.answerId)
          ? 'question'
          : 'answer'
      const rid = which === 'article'
        ? (parsed.articleId || parsed.raw || '')
        : which === 'question'
          ? (parsed.questionId || parsed.raw || '')
          : (parsed.answerId || parsed.raw || '')
      if (!rid) return { ok: false, text: '', picks: [], note: '要给讨论号，或者带 /answer/、/question/、/p/ 的链接。' }
      const r = await module.fetchComments({ cookie: auth.cookie, target: which, id: rid, limit: n ?? 20, orderBy, fetchImpl })
      if (!r.ok) return { ok: false, text: '', picks: [], note: r.why }
      const cap = imagesCap(cfg)
      const urls = imagesOn(cfg) ? (r.comments ?? []).flatMap((c) => c.images ?? []).slice(0, cap) : []
      const pics = urls.length ? await saveImages({ root, urls, tag: `c-${rid}`, fetchImpl, max: cap }) : []
      const text = [sanitizeForeign(renderComments(r)).text, ...imageLines(pics)].join('\n')
      // 看评论页是点开，不是评论。不加每天的次数。
      await noteAct(root, formatZhihuOpen(dateKey(), rid, ''), sessionId)
      // 评论正文已经在这一轮的回复里。事件流另记至多一条，关着开关就什么都不写。
      await recordZhihuVoice({
        comments: r.comments,
        ref: `zh:${which}:${rid}`,
        root,
        cfg,
        sessionId,
      })
      return { ok: true, text, picks: r.comments, note: '' }
    }

    // ---- 列表：热榜 / 推荐 / 关注 / 历史 ----
    const items = []
    const want = (k) => kind === 'all' || kind === k
    const push = (k, raw) => {
      for (const x of raw ?? []) {
        items.push({
          kind: k,
          id: String(x?.id ?? ''),
          title: String(x?.title ?? '').trim(),
          author: String(x?.author ?? '').trim(),
          heat: String(x?.heat ?? '').trim(),
          url: String(x?.url ?? '').trim(),
        })
      }
    }
    if (want('hot')) push('hot', (await module.fetchHot({ cookie: auth.cookie, limit: n ?? 8, fetchImpl }).catch(() => ({ items: [] }))).items)
    if (want('recommend')) push('recommend', (await module.fetchRecommend({ cookie: auth.cookie, limit: n ?? 6, fetchImpl }).catch(() => ({ items: [] }))).items)
    if (want('follow')) push('follow', (await module.fetchFollow({ cookie: auth.cookie, limit: n ?? 8, fetchImpl }).catch(() => ({ items: [] }))).items)
    if (want('history')) push('history', (await module.fetchHistory({ cookie: auth.cookie, limit: n ?? 10, fetchImpl }).catch(() => ({ items: [] }))).items)

    const fresh = items.filter((x) => x.title)
    if (!fresh.length) return { ok: false, text: '', picks: [], note: '这次没看到什么。' }
    if (BROWSE_KINDS.has(kind)) await noteAct(root, formatZhihuBrowse(dateKey(), fresh), sessionId)
    return { ok: true, text: renderList(fresh, cfg), picks: fresh, note: '' }
  } catch (error) {
    return { ok: false, text: '', picks: [], note: `这次没看到：${String(error?.message ?? error).slice(0, 120)}` }
  }
}

export function registerZhihuLook(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const tenancy = { root, herDir: String(deps.tenant?.herDir ?? ''), tenant: deps.tenant?.tenant ?? { ok: true } }

  return ctx.tools.register(
    defineTool({
      name: 'zhihu_look',
      description:
        '看知乎。列表：热榜 / 首页推荐 / 你关注的人在说什么 / 重要的人最近看过什么（kind=all 或那几个名字）。' +
        '也可以点进去看一页：kind=question 看一个问题下面的回答，kind=answer 看一条回答的全文，' +
        'kind=comments 看一条回答/文章/问题下面的评论；这时要带 id——给链接也行' +
        '（比如 https://www.zhihu.com/question/123/answer/456）。回答和评论里的图会下载到本机并告诉你路径，用 read_image 看。只读，不会在账号上留下痕迹。',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: KINDS,
            description: '看什么：all / hot / recommend / follow / history / question / answer / comments。默认 all。',
          },
          id: { type: 'string', description: '问题号、回答号，或者直接贴链接（question/answer/comments 时用）。' },
          target: {
            type: 'string',
            enum: ['answer', 'article', 'question'],
            description: 'comments 专用：这是谁的评论。不给就按链接里的推断（默认 answer）。',
          },
          orderBy: { type: 'string', enum: ['score', 'time'], description: 'comments 的排序：score（默认）或 time。' },
          topN: { type: 'number', description: '最多几条（1–20，默认按各类自己的设置）。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `这次没看到：${out.note}` }],
      },
      async execute(args, exec) {
        const who = guardWrite(tenancy, exec, 'zhihu_look')
        if (!who.ok) return { ok: false, text: '', note: who.note }
        const { config } = await loadConfig(root)
        const kind = KINDS.includes(String(args?.kind ?? '')) ? String(args.kind) : 'all'
        const r = await zhihuLookOnce({
          root,
          cfg: config,
          kind,
          id: args?.id,
          target: args?.target,
          topN: args?.topN,
          orderBy: args?.orderBy,
          sessionId: who.sessionId,
        })
        return { ok: r.ok, text: r.text, note: r.note }
      },
    }),
  )
}

export default { registerZhihuLook, zhihuLookOnce, parseTarget }
