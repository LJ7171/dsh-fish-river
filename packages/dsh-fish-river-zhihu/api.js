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
        url: String(x?.target?.link?.url ?? x?.target?.url ?? '').trim(),
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
      const url = String(tgt?.url ?? tgt?.question?.url ?? src?.url ?? m?.url ?? '').trim()
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
export default { fetchHot, fetchFollow, probe, ENDPOINTS }
