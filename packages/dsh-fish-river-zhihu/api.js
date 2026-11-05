/**
 * api.js —— 知乎只读数据（热榜 / 关注动态）
 *
 * 为什么是只读、为什么这么简单：这个子包只做「她看世界」的一条素材线，
 * 不评论、不私信、不点赞。所以没有写操作，也就不需要处理 csrf 那一套。
 *
 * 两个域名的分工（2026-11-04 实测）：
 *   - `www.zhihu.com/api/...`：网页端。热榜能用；但「某人的回答」等接口会回
 *     `403 {"code":10003,"message":"请求参数异常，请升级客户端后重试"}`——它要 `x-zse-96` 签名。
 *   - `api.zhihu.com`：移动端。**不校验签名**，只认 cookie。关注动态（moments）走这里。
 * 所以：能用移动端就用移动端，网页端只拿确实不要签名的那几个。
 */

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
    const comments = list.map((c) => ({
      id: String(c?.id ?? ''),
      author: String(c?.author?.name ?? '').trim(),
      likes: Number(c?.like_count) || 0,
      text: trimText(htmlToText(c?.content), 300),
      replies: Number(c?.child_comment_count) || 0,
    }))
    return { ok: true, comments, total: Number(r.json?.paging?.totals) || comments.length, why: '' }
  } catch (error) {
    return { ok: false, why: `读评论失败：${errorText(error)}`, comments: [] }
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
export default { fetchHot, fetchFollow, fetchHistory, fetchRecommend, fetchQuestion, fetchAnswer, fetchComments, htmlToText, extractImages, probe, ENDPOINTS }
