/**
 * api.js —— 知乎数据（热榜 / 关注 / 评论 / 回答）
 *
 * 读接口能用移动端就用移动端，网页端只拿确实不要签名的那几个。
 * 写评论、回楼中楼、写回答走网页端 comment_v5 / questions，要 cookie 里的 `_xsrf`
 * （请求头 `x-xsrftoken`）。要验证码或风控就停，不取验证码、不重试。
 *
 * 两个域名的分工（2026-11-04 实测）：
 *   - `www.zhihu.com/api/...`：网页端。热榜能用；但「某人的回答」等接口会回
 *     `403 {"code":10003,"message":"请求参数异常，请升级客户端后重试"}`——它要 `x-zse-96` 签名。
 *   - `api.zhihu.com`：移动端。**不校验签名**，只认 cookie。关注动态（moments）走这里。
 * 所以：能用移动端就用移动端，网页端只拿确实不要签名的那几个。
 */

import { randomUUID } from 'node:crypto'

const WEB = 'https://www.zhihu.com'
const MOBILE = 'https://api.zhihu.com'
const UA_MOBILE = 'ZhihuHybrid/7.0'
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const TIMEOUT_MS = 12000

function clamp(n, lo, hi) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo
}

function errorText(error) {
  return String(error?.message ?? error).slice(0, 200)
}

async function getJson({ fetchImpl, url, cookie, referer, mobile = false, timeoutMs = TIMEOUT_MS }) {
  const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
  const res = await fetchImpl(url, {
    headers: {
      'user-agent': mobile ? UA_MOBILE : UA_WEB,
      accept: 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(referer ? { referer } : {}),
      ...(mobile ? { 'x-requested-with': 'fetch' } : {}),
    },
    signal,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON：下面按状态码报 */ }
  return { status: res.status, json, text }
}

/**
 * 当日热榜。
 * GET www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=N&desktop=true
 *
 * @returns {Promise<{ok:boolean, items:{id,title,heat,url}[], why:string}>}
 */
export async function fetchHot({ cookie = '', limit = 8, fetchImpl = fetch } = {}) {
  try {
    const n = clamp(limit, 1, 30)
    const r = await getJson({
      fetchImpl,
      url: `${WEB}/api/v3/feed/topstory/hot-lists/total?limit=${n}&desktop=true`,
      cookie,
      referer: `${WEB}/hot`,
    })
    if (!Array.isArray(r.json?.data)) return { ok: false, items: [], why: `热榜拿不到（HTTP ${r.status}）` }
    const items = []
    for (const x of r.json.data.slice(0, n)) {
      const title = String(x?.target?.title ?? x?.target?.question?.title ?? '').trim()
      if (!title) continue
      const id = String(x?.card_id ?? x?.id ?? x?.target?.question?.id ?? title)
      items.push({
        id: `hot:${id}`,
        title,
        heat: String(x?.detail_text ?? '').trim(),
        url: String(x?.target?.link?.url ?? x?.target?.url ?? '').trim()
          || (String(x?.target?.type ?? '') === 'question' && x?.target?.id ? `https://www.zhihu.com/question/${x.target.id}` : ''),
      })
    }
    return { ok: items.length > 0, items, why: items.length ? '' : '热榜是空的' }
  } catch (error) {
    return { ok: false, items: [], why: `热榜请求失败：${errorText(error)}` }
  }
}

/**
 * 关注动态（关注的人的回答 / 文章 / 想法）。
 * GET api.zhihu.com/moments?limit=N （移动端，免签名）
 *
 * @returns {Promise<{ok:boolean, items:{id,kind,author,title,url}[], why:string}>}
 */
export async function fetchFollow({ cookie = '', limit = 8, fetchImpl = fetch } = {}) {
  try {
    const n = clamp(limit, 1, 20)
    const r = await getJson({
      fetchImpl,
      url: `${MOBILE}/moments?limit=${n}`,
      cookie,
      referer: `${WEB}/follow`,
      mobile: true,
    })
    if (!Array.isArray(r.json?.data)) return { ok: false, items: [], why: `关注动态拿不到（HTTP ${r.status}）` }
    const items = []
    for (const m of r.json.data) {
      const src = m?.source ?? {}
      const tgt = m?.target ?? src?.target ?? {}
      const actor = src?.actor ?? tgt?.author ?? {}
      const title = String(tgt?.title ?? tgt?.question?.title ?? src?.title ?? m?.title ?? '').trim()
      if (!title) continue
      const kind = String(tgt?.type ?? src?.type ?? m?.type ?? '').trim()
      const tid = String(tgt?.id ?? tgt?.question?.id ?? '').trim()
      const url = String(tgt?.url ?? tgt?.question?.url ?? src?.url ?? m?.url ?? '').trim()
        || (tid && kind === 'answer' ? `https://www.zhihu.com/answer/${tid}` : '')
        || (tid && kind === 'question' ? `https://www.zhihu.com/question/${tid}` : '')
        || (tid && kind === 'article' ? `https://zhuanlan.zhihu.com/p/${tid}` : '')
      items.push({
        id: `feed:${String(m?.id ?? m?.feed_id ?? url ?? title)}`,
        kind,
        author: String(actor?.name ?? '').trim(),
        title,
        url,
      })
    }
    return { ok: items.length > 0, items: items.slice(0, n), why: items.length ? '' : '关注动态是空的' }
  } catch (error) {
    return { ok: false, items: [], why: `关注动态请求失败：${errorText(error)}` }
  }
}

/**
 * 浏览历史（**他**看过的，不是她看过的）。
 * GET www.zhihu.com/api/v4/unify-consumption/read_history?offset=0&limit=N
 *
 * @returns {Promise<{ok:boolean, items:{id,title,url,readAt}[], why:string}>}
 */
export async function fetchHistory({ cookie = '', limit = 10, fetchImpl = fetch } = {}) {
  try {
    const n = clamp(limit, 1, 20)
    const r = await getJson({
      fetchImpl,
      url: `${WEB}/api/v4/unify-consumption/read_history?offset=0&limit=${n}`,
      cookie,
      referer: `${WEB}/history`,
    })
    if (!Array.isArray(r.json?.data)) return { ok: false, items: [], why: `浏览历史拿不到（HTTP ${r.status}）` }
    const items = []
    for (const card of r.json.data) {
      const d = card?.data ?? {}
      const title = String(d?.header?.title ?? '').trim()
      if (!title) continue
      const extra = d?.extra ?? {}
      items.push({
        id: `hist:${String(extra.content_token ?? d?.action?.url ?? title)}`,
        title,
        url: String(d?.action?.url ?? '').trim(),
        readAt: Number(extra.read_time) || 0,
      })
    }
    return { ok: items.length > 0, items, why: items.length ? '' : '浏览历史是空的' }
  } catch (error) {
    return { ok: false, items: [], why: `浏览历史请求失败：${errorText(error)}` }
  }
}

/**
 * 首页推荐（今天外面推到你面前的东西）。
 * GET www.zhihu.com/api/v3/feed/topstory/recommend?…&page_number=N
 *
 * 不需要 session_token（2026-11-04 实测）：带上 cookie 直接回 6 条/页。
 *
 * @returns {Promise<{ok:boolean, items:{id,kind,author,title,url}[], why:string}>}
 */
export async function fetchRecommend({ cookie = '', limit = 6, pages = 1, fetchImpl = fetch } = {}) {
  try {
    const want = clamp(limit, 1, 20)
    const out = []
    for (let page = 1; page <= Math.max(1, Math.min(3, pages)); page += 1) {
      const r = await getJson({
        fetchImpl,
        url: `${WEB}/api/v3/feed/topstory/recommend?action=down&ad_interval=-10&after_id=${page * 5}&desktop=true&end_offset=${page * 5}&page_number=${page}`,
        cookie,
        referer: `${WEB}/`,
      })
      const list = Array.isArray(r.json?.data) ? r.json.data : []
      if (!list.length) break
      for (const x of list) {
        const tgt = x?.target ?? {}
        const title = String(tgt.title ?? tgt.question?.title ?? '').trim()
        if (!title) continue
        const kind = String(tgt.type ?? '').trim()
        const id = String(tgt.id ?? tgt.question?.id ?? title)
        const url = kind === 'article'
          ? `https://zhuanlan.zhihu.com/p/${id}`
          : kind === 'answer'
            ? `https://www.zhihu.com/answer/${id}`
            : kind === 'question'
              ? `https://www.zhihu.com/question/${id}`
              : String(tgt.url ?? '').trim()
        out.push({ id: `rec:${id}`, kind, author: String(tgt.author?.name ?? '').trim(), title, url })
        if (out.length >= want) break
      }
      if (out.length >= want) break
    }
    return { ok: out.length > 0, items: out, why: out.length ? '' : '推荐是空的' }
  } catch (error) {
    return { ok: false, items: [], why: `推荐请求失败：${errorText(error)}` }
  }
}

/**
 * 邀请回答里的问题。跳过已经回答过、关闭、删除的。
 * GET www.zhihu.com/api/v4/notifications/v3/timeline/entry/invite?…
 */
export async function fetchQuestionInvites({ cookie = '', limit = 20, fetchImpl = fetch } = {}) {
  try {
    const n = clamp(limit, 1, 20)
    const r = await getJson({
      fetchImpl,
      url: `${WEB}/api/v4/notifications/v3/timeline/entry/invite?invite_with_time_slice=1&limit=${n}&offset=0&invite_domain_score_ab=1`,
      cookie,
      referer: `${WEB}/`,
    })
    const list = Array.isArray(r.json?.data) ? r.json.data : []
    const out = []
    for (const x of list) {
      const q = x?.target ?? x?.extra_action?.data ?? {}
      const item = questionItem(q, 'invite')
      if (item) out.push(item)
    }
    return { ok: out.length > 0, items: out, why: out.length ? '' : '没有邀请回答' }
  } catch (error) {
    return { ok: false, items: [], why: `邀请回答请求失败：${errorText(error)}` }
  }
}

/**
 * 作者相关的问题推荐。
 * GET www.zhihu.com/api/v4/creators/question_route/author_related/recommend?…
 */
export async function fetchQuestionRecommend({ cookie = '', limit = 20, fetchImpl = fetch } = {}) {
  try {
    const n = clamp(limit, 1, 20)
    const r = await getJson({
      fetchImpl,
      url: `${WEB}/api/v4/creators/question_route/author_related/recommend?limit=${n}&offset=0&page_source=web_author_recommend&recom_domain_score_ab=1`,
      cookie,
      referer: `${WEB}/creators`,
    })
    const list = Array.isArray(r.json?.data) ? r.json.data : []
    const out = []
    for (const x of list) {
      if (x?.is_in_draft === true) continue
      const item = questionItem(x?.question, 'recommend')
      if (item) out.push(item)
    }
    return { ok: out.length > 0, items: out, why: out.length ? '' : '没有问题推荐' }
  } catch (error) {
    return { ok: false, items: [], why: `问题推荐请求失败：${errorText(error)}` }
  }
}

function questionItem(q, source) {
  const id = String(q?.id ?? q?.question?.id ?? '').trim()
  const title = String(q?.title ?? q?.question?.title ?? '').trim()
  if (!id || !title) return null
  if (q?.is_deleted === true) return null
  if (q?.has_answer === true || q?.my_answer_url) return null
  if (q?.status?.is_close === true || q?.status?.is_locked === true) return null
  const rawUrl = String(q?.url ?? '').trim()
  const url = rawUrl.replace('https://api.zhihu.com/questions/', 'https://www.zhihu.com/question/')
  return { id, title, source, url: /^https?:\/\//.test(url) ? url : `https://www.zhihu.com/question/${id}` }
}

/** 知乎正文是 HTML：去掉标签、解几个实体，留下人能读的段落。 */
export function htmlToText(html) {
  const s = String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  return s
}

/** 正文里的图：只认 http(s)，data: 占位图跳过；最多 n 张。 */
export function extractImages(html, max = 3) {
  const out = []
  const seen = new Set()
  for (const m of String(html ?? '').matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0]
    const attr = (name) => {
      const r = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)
      return r ? r[1] : ''
    }
    const raw = attr('data-original') || attr('src')
    const url = raw.startsWith('//') ? `https:${raw}` : raw
    if (!/^https?:\/\//i.test(url)) continue
    // 同一张图在正文里常同时出现「缩略图」和「原图」两种地址：按去掉尺寸后缀的键去重，
    // 否则一次阅读会把同一张图存两遍。
    const key = url.replace(/\?.*$/, '').replace(/_(?:[0-9]+w|r|is|hd|xl|qhd|fhd)\.(?:jpe?g|png|webp|gif)$/i, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(url)
    if (out.length >= Math.max(1, Math.min(6, Number(max) || 3))) break
  }
  return out
}

function trimText(value, max) {
  const s = String(value ?? '')
  return s.length > max ? `${s.slice(0, max)}……` : s
}

/**
 * 一个问题 + 它下面点赞靠前的回答（列表页）。
 * 问题标题藏在每条回答的 `question.title` 里——单独查问题详情要签名（403/10003）。
 */
export async function fetchQuestion({ cookie = '', id = '', limit = 5, fetchImpl = fetch } = {}) {
  try {
    const qid = String(id ?? '').trim()
    if (!qid) return { ok: false, why: '缺问题 id', question: null, answers: [] }
    const n = clamp(limit, 1, 10)
    const r = await getJson({
      fetchImpl,
      url: `${WEB}/api/v4/questions/${encodeURIComponent(qid)}/answers?limit=${n}&include=content,voteup_count,comment_count,author,question`,
      cookie,
      referer: `${WEB}/question/${qid}`,
    })
    const list = Array.isArray(r.json?.data) ? r.json.data : []
    if (!list.length) return { ok: false, why: `没读到这个问题（HTTP ${r.status}）`, question: null, answers: [] }
    const title = String(list[0]?.question?.title ?? '').trim()
    const answers = list.map((it) => ({
      id: String(it?.id ?? ''),
      author: String(it?.author?.name ?? '').trim(),
      votes: Number(it?.voteup_count) || 0,
      comments: Number(it?.comment_count) || 0,
      text: trimText(htmlToText(it?.content), 400),
      images: extractImages(it?.content, 2),
      url: `https://www.zhihu.com/answer/${it?.id ?? ''}`,
    }))
    return { ok: true, question: { id: qid, title, answerCount: Number(r.json?.paging?.totals) || answers.length }, answers, why: '' }
  } catch (error) {
    return { ok: false, why: `读问题失败：${errorText(error)}`, question: null, answers: [] }
  }
}

/** 一条回答的正文（截到 maxChars 字，剩下的不硬塞）。 */
export async function fetchAnswer({ cookie = '', id = '', maxChars = 1500, fetchImpl = fetch } = {}) {
  try {
    const aid = String(id ?? '').trim()
    if (!aid) return { ok: false, why: '缺回答 id', answer: null }
    const r = await getJson({
      fetchImpl,
      url: `${WEB}/api/v4/answers/${encodeURIComponent(aid)}?include=content,voteup_count,comment_count,author,question`,
      cookie,
      referer: `${WEB}/answer/${aid}`,
    })
    const d = r.json
    if (!d?.content) return { ok: false, why: `没读到这条回答（HTTP ${r.status}）`, answer: null }
    return {
      ok: true,
      answer: {
        id: String(d.id ?? aid),
        question: { id: String(d.question?.id ?? ''), title: String(d.question?.title ?? '').trim() },
        author: String(d.author?.name ?? '').trim(),
        votes: Number(d.voteup_count) || 0,
        comments: Number(d.comment_count) || 0,
        text: trimText(htmlToText(d.content), Math.max(200, Math.min(4000, Number(maxChars) || 1500))),
        images: extractImages(d.content, 3),
        url: `https://www.zhihu.com/answer/${aid}`,
      },
      why: '',
    }
  } catch (error) {
    return { ok: false, why: `读回答失败：${errorText(error)}`, answer: null }
  }
}

/** 评论正文或附件里的图。纯文字评论就是空数组。 */
function commentImageUrls(c) {
  const fromHtml = extractImages(c?.content, 3)
  const extra = []
  for (const key of ['pictures', 'images', 'image_list']) {
    const arr = c?.[key]
    if (!Array.isArray(arr)) continue
    for (const it of arr) {
      const raw = typeof it === 'string' ? it : String(it?.url ?? it?.src ?? it?.original ?? '')
      const url = raw.startsWith('//') ? `https:${raw}` : raw
      if (/^https?:\/\//i.test(url)) extra.push(url)
    }
  }
  return [...new Set([...fromHtml, ...extra])].slice(0, 3)
}

/** 评论（按分数）。target 只认 answer / article / question。 */
export async function fetchComments({ cookie = '', target = 'answer', id = '', limit = 20, orderBy = 'score', fetchImpl = fetch } = {}) {
  const t = String(target ?? '').trim()
  if (!['answer', 'article', 'question'].includes(t)) return { ok: false, why: '不认识这类评论', comments: [] }
  try {
    const rid = String(id ?? '').trim()
    if (!rid) return { ok: false, why: '缺 id', comments: [] }
    const n = clamp(limit, 1, 20)
    const plural = t === 'answer' ? 'answers' : t === 'article' ? 'articles' : 'questions'
    const r = await getJson({
      fetchImpl,
      url: `${WEB}/api/v4/comment_v5/${plural}/${encodeURIComponent(rid)}/root_comment?order_by=${encodeURIComponent(orderBy)}&limit=${n}&offset=`,
      cookie,
      referer: `${WEB}/`,
    })
    const list = Array.isArray(r.json?.data) ? r.json.data : []
    if (!list.length) return { ok: false, why: `没读到评论（HTTP ${r.status}）`, comments: [] }
    const comments = list.map(mapComment)
    return { ok: true, comments, total: Number(r.json?.paging?.totals) || comments.length, why: '' }
  } catch (error) {
    return { ok: false, why: `读评论失败：${errorText(error)}`, comments: [] }
  }
}

/** 写操作冷却只在这个进程里。要验证码或风控才记，不自动重试。 */
const writeRisk = { until: 0, streak: 0, at: 0 }

export function resetZhihuWriteRisk() {
  writeRisk.until = 0
  writeRisk.streak = 0
  writeRisk.at = 0
}

function zhihuCooldown(now = Date.now()) {
  if (!writeRisk.until || now >= writeRisk.until) return null
  return { ok: false, code: 'COOLDOWN', why: '先歇一会儿' }
}

function noteZhihuWriteRisk(now = Date.now()) {
  const streak = writeRisk.at && now - writeRisk.at < 30 * 60_000 ? writeRisk.streak + 1 : 1
  const wait = Math.min(30 * 60_000, 5 * 60_000 * 2 ** (streak - 1))
  writeRisk.until = now + wait
  writeRisk.streak = streak
  writeRisk.at = now
}

function mapComment(c) {
  return {
    id: String(c?.id ?? ''),
    author: String(c?.author?.name ?? '').trim(),
    authorId: String(c?.author?.id ?? ''),
    likes: Number(c?.like_count) || 0,
    text: trimText(htmlToText(c?.content), 300),
    images: commentImageUrls(c),
    replies: Number(c?.child_comment_count) || 0,
    created: Number(c?.created_time ?? c?.created ?? 0) || 0,
  }
}

function xsrfOf(cookie) {
  const m = /(?:^|;\s*)_xsrf=([^;]+)/i.exec(String(cookie ?? ''))
  if (!m) return ''
  try { return decodeURIComponent(m[1]) } catch { return m[1] }
}

async function postJson({ fetchImpl, url, cookie, referer, body, timeoutMs = TIMEOUT_MS }) {
  const xsrf = xsrfOf(cookie)
  const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'user-agent': UA_WEB,
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      origin: WEB,
      referer: referer || `${WEB}/`,
      'x-requested-with': 'fetch',
      ...(cookie ? { cookie } : {}),
      ...(xsrf ? { 'x-xsrftoken': xsrf } : {}),
    },
    body: JSON.stringify(body ?? {}),
    signal,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: res.status, json, text }
}

/** 验证码 / 风控 / 普通失败。成功返回空串。不发起第二次请求。 */
function classifyWrite(status, json) {
  const err = json?.error && typeof json.error === 'object' ? json.error : {}
  const message = String(err.message ?? json?.message ?? '')
  const name = String(err.name ?? json?.name ?? '')
  const blob = `${name} ${message}`
  const captcha = /验证码|captcha|need_captcha/i.test(blob) || Boolean(json?.captcha || json?.need_captcha || err.captcha)
  if (captcha) return 'CAPTCHA'
  const code = Number(err.code ?? json?.code)
  const risk = /风控|请求存在异常|操作过于频繁/.test(blob)
    || [403, 412, 429].includes(Number(status))
    || [4039, 40362, 180000].includes(code)
  if (risk) return 'RISK'
  if (Number(status) === 401 || /未登录|请登录/.test(message)) return 'NOT_LOGIN'
  if (Number(status) >= 400 || (err.code != null && err.code !== 0)) return 'FAIL'
  return ''
}

function stopForRisk(kind) {
  if (kind !== 'CAPTCHA' && kind !== 'RISK') return null
  noteZhihuWriteRisk()
  return { ok: false, code: kind, why: kind === 'CAPTCHA' ? '要验证' : '被拦了一下' }
}

/**
 * 一条评论下面的楼中楼。空列表也算读到了。
 * GET /api/v4/comment_v5/comment/{id}/child_comment
 */
export async function fetchChildComments({ cookie = '', id = '', limit = 20, fetchImpl = fetch } = {}) {
  try {
    const rid = String(id ?? '').trim()
    if (!rid) return { ok: false, why: '缺评论 id', comments: [] }
    const n = clamp(limit, 1, 20)
    const r = await getJson({
      fetchImpl,
      url: `${WEB}/api/v4/comment_v5/comment/${encodeURIComponent(rid)}/child_comment?order_by=ts&limit=${n}&offset=`,
      cookie,
      referer: `${WEB}/`,
    })
    const list = Array.isArray(r.json?.data) ? r.json.data : []
    if (!list.length && r.status >= 400) return { ok: false, why: `没读到楼中楼（HTTP ${r.status}）`, comments: [] }
    return { ok: true, comments: list.map(mapComment), why: '' }
  } catch (error) {
    return { ok: false, why: `读楼中楼失败：${errorText(error)}`, comments: [] }
  }
}

/**
 * 在一条回答下面写评论，或回复某一条。
 * replyCommentId 空着是主楼；有值是楼中楼（仍挂在这条回答上）。
 */
export async function createComment({ cookie = '', id = '', content = '', replyCommentId = '', replyRootCommentId = '', fetchImpl = fetch } = {}) {
  const blocked = zhihuCooldown()
  if (blocked) return blocked
  const rid = String(id ?? '').trim()
  const text = String(content ?? '').trim()
  if (!rid || !text) return { ok: false, code: 'EMPTY', why: '空评论不发' }
  if (!xsrfOf(cookie)) return { ok: false, code: 'NO_CSRF', why: 'cookie 不完整' }
  try {
    const r = await postJson({
      fetchImpl,
      url: `${WEB}/api/v4/comment_v5/answers/${encodeURIComponent(rid)}/comment`,
      cookie,
      referer: `${WEB}/answer/${rid}`,
      body: {
        content: commentHtml(text),
        reply_comment_id: replyCommentId ? String(replyCommentId) : '0',
        ...(replyCommentId ? { reply_root_comment_id: String(replyRootCommentId || replyCommentId) } : {}),
        selected_settings: [],
        unfriendly_check: 'strict',
      },
    })
    const kind = classifyWrite(r.status, r.json)
    const stopped = stopForRisk(kind)
    if (stopped) return stopped
    if (kind === 'NOT_LOGIN') return { ok: false, code: 'NOT_LOGIN', why: '没登录' }
    if (kind) return { ok: false, code: 'FAIL', why: String(r.json?.error?.message ?? r.json?.message ?? '没发出去').slice(0, 60) }
    const cid = String(r.json?.id ?? r.json?.comment?.id ?? r.json?.data?.id ?? '')
    if (!cid) return { ok: false, code: 'FAIL', why: '没发出去' }
    return { ok: true, id: cid }
  } catch (error) {
    return { ok: false, code: 'NETWORK', why: `没发出去：${errorText(error)}` }
  }
}

function commentHtml(text) {
  const esc = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return esc.split(/\n{2,}/).map((part) => `<p>${part.replace(/\n/g, '<br>')}</p>`).join('')
}

function answerHtml(text) {
  const esc = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return esc.split(/\n{2,}/).map((part) => `<p>${part.replace(/\n/g, '<br>')}</p>`).join('')
}

/** 给一个问题写回答。正文按纯文本转成段落，不接收调用方拼好的 HTML。 */
const ANSWER_INCLUDE = 'is_contain_ai_content,is_visible,paid_info,paid_info_content,has_column,admin_closed_comment,reward_info,annotation_action,annotation_detail,collapse_reason,is_normal,is_sticky,collapsed_by,suggest_edit,comment_count,thanks_count,favlists_count,can_comment,content,editable_content,voteup_count,reshipment_settings,comment_permission,created_time,updated_time,review_info,relevant_info,question,excerpt,attachment,content_source,is_labeled,endorsements,reaction_instruction,reaction,ip_info,relationship.is_authorized,voting,is_thanked,is_author,is_nothelp,is_favorited;author.vip_info,kvip_info,badge[*].topics;settings.table_of_content.enabled'

const ANSWER_BIZ = Object.freeze({
  reshipment_settings: 'allowed',
  comment_permission: 'all',
  columns: null,
  reward_setting: { can_reward: false, tagline: '' },
  disclaimer_status: 'close',
  disclaimer_type: 'none',
  commercial_report_info: { is_report: false },
  commercial_zhitask_bind_info: null,
  is_report: false,
  push_activity: true,
  table_of_contents_enabled: false,
  thank_inviter_status: 'close',
  thank_inviter: '',
})

/**
 * 写回答前的控制检查：GET api.zhihu.com/content/publish/control/v2?…
 * 失败就不发。返回 {ok, why}。
 */
export async function answerPublishControl({ cookie = '', questionId = '', fetchImpl = fetch } = {}) {
  const qid = String(questionId ?? '').trim()
  if (!qid) return { ok: false, why: '缺问题 id' }
  try {
    const r = await getJson({
      fetchImpl,
      url: `${MOBILE}/content/publish/control/v2?scene=answer&questionToken=${encodeURIComponent(qid)}`,
      cookie,
      referer: `${WEB}/question/${encodeURIComponent(qid)}`,
      mobile: true,
    })
    if (r.status >= 400 || Number(r.json?.code) !== 0) {
      return { ok: false, why: String(r.json?.message ?? `发布检查失败（HTTP ${r.status}）`).slice(0, 80) }
    }
    return { ok: true, why: '' }
  } catch (error) {
    return { ok: false, why: `发布检查失败：${errorText(error)}` }
  }
}

/** 给一个问题写回答。正文按纯文本转成段落，不接收调用方拼好的 HTML。 */
export async function createAnswer({ cookie = '', questionId = '', content = '', fetchImpl = fetch } = {}) {
  const blocked = zhihuCooldown()
  if (blocked) return blocked
  const qid = String(questionId ?? '').trim()
  const text = String(content ?? '').trim()
  if (!qid || !text) return { ok: false, code: 'EMPTY', why: '空回答不发' }
  if (!xsrfOf(cookie)) return { ok: false, code: 'NO_CSRF', why: 'cookie 不完整' }
  const ctrl = await answerPublishControl({ cookie, questionId: qid, fetchImpl })
  if (!ctrl.ok) return { ok: false, code: 'BLOCKED', why: ctrl.why }
  const html = answerHtml(text)
  try {
    const body = {
      action: 'answer',
      data: {
        publish: { traceId: `${Date.now()},${randomUUID()}` },
        hybridInfo: {},
        draft: { isPublished: false, disabled: 1 },
        extra_info: {
          question_id: qid,
          publisher: 'pc',
          include: ANSWER_INCLUDE,
          pc_business_params: JSON.stringify(ANSWER_BIZ),
        },
        hybrid: { html, textLength: [...text].length },
        reprint: { reshipment_settings: 'allowed' },
        commentsPermission: { comment_permission: 'all' },
        appreciate: { can_reward: false, tagline: '' },
        publishSwitch: { draft_type: 'normal' },
        creationStatement: { disclaimer_status: 'close', disclaimer_type: 'none' },
        commercialReportInfo: { isReport: 0 },
        toFollower: {},
        contentsTables: { table_of_contents_enabled: false },
        thanksInvitation: { thank_inviter_status: 'close', thank_inviter: '' },
      },
    }
    const r = await postJson({
      fetchImpl,
      url: `${WEB}/api/v4/content/publish`,
      cookie,
      referer: `${WEB}/question/${qid}`,
      body,
    })
    const kind = classifyWrite(r.status, r.json)
    const stopped = stopForRisk(kind)
    if (stopped) return stopped
    if (kind === 'NOT_LOGIN') return { ok: false, code: 'NOT_LOGIN', why: '没登录' }
    if (kind) return { ok: false, code: 'FAIL', why: String(r.json?.error?.message ?? r.json?.message ?? '没发出去').slice(0, 60) }
    let result = r.json?.data?.result
    if (typeof result === 'string') {
      try { result = JSON.parse(result) } catch { result = null }
    }
    const aid = String(result?.publish?.id ?? r.json?.id ?? r.json?.data?.answer?.id ?? '')
    if (!aid) return { ok: false, code: 'FAIL', why: '没发出去' }
    return { ok: true, id: aid }
  } catch (error) {
    return { ok: false, code: 'NETWORK', why: `没发出去：${errorText(error)}` }
  }
}

/** 认一下这份 cookie 是谁（登录后校验 / 设置页显示用）。 */
export async function probe({ cookie = '', fetchImpl = fetch } = {}) {
  try {
    const r = await getJson({ fetchImpl, url: `${WEB}/api/v4/me`, cookie, referer: `${WEB}/` })
    if (!r.json?.name) return { ok: false, why: `没认到账号（HTTP ${r.status}）` }
    return {
      ok: true,
      account: {
        name: String(r.json.name ?? ''),
        token: String(r.json.url_token ?? ''),
        id: String(r.json.id ?? ''),
      },
    }
  } catch (error) {
    return { ok: false, why: `认账号失败：${errorText(error)}` }
  }
}

export const ENDPOINTS = { WEB, MOBILE }
export default {
  fetchHot, fetchFollow, fetchHistory, fetchRecommend, fetchQuestionInvites, fetchQuestionRecommend, fetchQuestion, fetchAnswer, fetchComments,
  fetchChildComments, createComment, createAnswer, answerPublishControl, htmlToText, extractImages, probe, ENDPOINTS,
}
