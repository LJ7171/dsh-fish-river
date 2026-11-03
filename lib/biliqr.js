/**
 * B 站扫码登录（2026-11-02，合并版新增）。
 *
 * 以前只能让用户去浏览器里 F12 复制整条 cookie —— 对不写代码的人这一步就是终点。
 * 这里改用 B 站官方 H5 登录用的一对接口：
 *
 *   1. 生成二维码  GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate
 *                  → { url, qrcode_key }；url 就是二维码里要画的那串
 *   2. 轮询结果    GET .../qrcode/poll?qrcode_key=<key>
 *                  → data.code：0 成功 / 86101 还没扫 / 86090 扫了没确认 / 86038 过期
 *
 * 成功那一跳的 `Set-Cookie` 里带着 SESSDATA、bili_jct、DedeUserID 等，拼起来就是
 * 以前让用户手抄的那条 cookie。这里只负责拿到它，存与校验交给 `/owner` 那条路
 * （`saveOwner` + `me()`），两边不重复实现登录态。
 *
 * 硬约束（与 lib/bili.js 一致）：
 *   - 零依赖：只用 globalThis.fetch，不引第三方；
 *   - 永不抛：网络问题一律变成 { ok:false, why }，让 UI 有话可说；
 *   - 只发 api 域：请求只去 passport.bilibili.com，不做任何跳转跟随。
 */

import { renderSVG } from './vendor/uqr.mjs'

export const QR_GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
export const QR_POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
/** 二维码本身大约 180 秒过期；这里只用来给 UI 画倒计时，不参与判定。 */
export const QR_TTL_MS = 180000
/** 一条 cookie 里真正要留下的键（其余如 buvid3 是风控指纹，可留但不必强调）。 */
export const COOKIE_KEYS = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']

/** B 站那四个状态码 → 我们能显示的一句话。 */
export const POLL_STATUS = {
  0: 'ok',
  86101: 'waiting',
  86090: 'scanned',
  86038: 'expired',
}

function nowMs(opts) {
  return typeof opts?.now === 'number' ? opts.now : Date.now()
}

/**
 * 把 `Set-Cookie` 头数组拼成一条 `k=v; k=v`。
 * Node 用 `headers.getSetCookie()`；测试里可以塞一个假的 headers。
 */
export function cookieFromSetCookie(list = []) {
  const seen = new Map()
  for (const raw of list) {
    const first = String(raw ?? '').split(';')[0]?.trim()
    if (!first || !first.includes('=')) continue
    const i = first.indexOf('=')
    const k = first.slice(0, i).trim()
    const v = first.slice(i + 1).trim()
    if (!k || !v) continue
    // 后出现的覆盖先出现的：B 站会先下发一个空的、再下发真的。
    seen.set(k, v)
  }
  if (!seen.size) return ''
  return [...seen.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/** 成功页的 `data.url` 里也带着同一组凭据，作为 `Set-Cookie` 缺失时的退路。 */
export function cookieFromUrl(url) {
  let u
  try { u = new URL(String(url ?? '')) } catch { return '' }
  const parts = []
  for (const k of COOKIE_KEYS) {
    const v = u.searchParams.get(k)
    if (v) parts.push(`${k}=${v}`)
  }
  return parts.join('; ')
}

/** 只留我们认识的那几个键，避免把一堆无关 cookie 写进 owner.json。 */
export function pickCookie(cookie) {
  const map = new Map()
  for (const piece of String(cookie ?? '').split(';')) {
    const s = piece.trim()
    if (!s || !s.includes('=')) continue
    const i = s.indexOf('=')
    map.set(s.slice(0, i).trim(), s.slice(i + 1).trim())
  }
  const parts = []
  for (const k of COOKIE_KEYS) {
    const v = map.get(k)
    if (v) parts.push(`${k}=${v}`)
  }
  return parts.join('; ')
}

/** 把 B 站给的 url 画成一张 SVG（data URI 由客户端拼，这里只给源码）。 */
export function qrSvg(url, { size = 220 } = {}) {
  try {
    return renderSVG(String(url ?? ''), { whiteColor: '#ffffff', blackColor: '#111111', border: 2 })
  } catch {
    return ''
  }
}

async function getJson(fetchImpl, url, { signal } = {}) {
  const res = await fetchImpl(url, {
    method: 'GET',
    signal,
    headers: {
      // 不带 UA 时 passport 会 412；带一个普通的桌面 UA 就够。
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      referer: 'https://www.bilibili.com/',
      accept: 'application/json, text/plain, */*',
    },
  })
  const setCookie = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { res, json, setCookie, text }
}

/**
 * 要一张新二维码。
 * @returns {Promise<{ok:boolean, key?:string, url?:string, svg?:string, expiresIn?:number, why?:string}>}
 */
export async function createQr(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, why: '这个 Node 没有 fetch。' }
  try {
    const { res, json } = await getJson(fetchImpl, QR_GENERATE_URL, opts)
    if (!res.ok) return { ok: false, why: `B 站返回 ${res.status}。` }
    const data = json?.data
    if (json?.code !== 0 || !data?.url || !data?.qrcode_key) {
      return { ok: false, why: String(json?.message || 'B 站没给二维码。') }
    }
    return {
      ok: true,
      key: String(data.qrcode_key),
      url: String(data.url),
      svg: qrSvg(data.url, opts),
      expiresIn: QR_TTL_MS,
    }
  } catch (err) {
    return { ok: false, why: `连不上 B 站：${String(err?.message ?? err).slice(0, 60)}` }
  }
}

/**
 * 问一次「扫了没有」。
 * @returns {Promise<{ok:boolean, status:'waiting'|'scanned'|'expired'|'ok'|'error', code?:number, message?:string, cookie?:string, url?:string, why?:string}>}
 */
export async function pollQr(key, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (!key) return { ok: false, status: 'error', why: '没有二维码的 key。' }
  if (typeof fetchImpl !== 'function') return { ok: false, status: 'error', why: '这个 Node 没有 fetch。' }
  try {
    const url = `${QR_POLL_URL}?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`
    const { res, json, setCookie } = await getJson(fetchImpl, url, opts)
    if (!res.ok) return { ok: false, status: 'error', why: `B 站返回 ${res.status}。` }
    const data = json?.data ?? {}
    const code = Number(data.code ?? json?.code ?? -1)
    const status = POLL_STATUS[code] ?? 'error'
    if (status !== 'ok') {
      return { ok: true, status, code, message: String(data.message || '') }
    }
    const cookie = pickCookie(cookieFromSetCookie(setCookie)) || pickCookie(cookieFromUrl(data.url))
    if (!cookie) return { ok: false, status: 'error', why: '登录成功了，但没拿到 cookie。' }
    return { ok: true, status: 'ok', code, cookie, url: String(data.url ?? '') }
  } catch (err) {
    return { ok: false, status: 'error', why: `连不上 B 站：${String(err?.message ?? err).slice(0, 60)}` }
  }
}
