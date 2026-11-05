/**
 * tieba.js —— 贴吧素材（只读）
 *
 * 和刷 B 站、刷知乎并列的一条素材线，不是渠道：不发帖、不回帖、不点赞。
 * 作息掷骰命中时现场抓一次首页推荐；按设置再进几条帖、或进名单里的吧。
 * 一次抓 = sleep.daily.tieba 记 1。素材进醒来提示词，不写经历事件。
 *
 * 登录态只落 `<root>/tieba.json`（0600）。接口摘要、日志、设置页都不回 cookie 全文。
 */

import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFile, rm } from 'node:fs/promises'
import { writeAtomic, readJson } from './store.js'
import { dateKey, dailyQuota } from './settings.js'
import { pacedFetch } from './pacing.js'
import { sanitizeForeign } from './guard.js'

// 非官方客户端签名密钥：可用环境变量覆盖（百度换了密钥时不用改代码）。
// 注意：这是逆向接口，随时可能失效；失效时这一路只是抓不到素材，不影响别的。
export const SIGN_SECRET = String(process.env.DSH_FISH_TIEBA_SIGN || '36770b1f34c9bbf2e7d1a99d2b82fa9e')
export const API_HOST = 'https://tiebac.baidu.com'
const CLIENT_VERSION = '12.64.0'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const COOKIE_KEYS = ['BDUSS', 'STOKEN', 'PTOKEN', 'BAIDUID']
const SEEN_MAX = 300
const SEEN_TTL = 7 * 86_400_000
const STATE_VERSION = 1
const QR_TTL_MS = 3 * 60_000

const QR_PENDING = new Map()

function clip(s, n) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
}

/** 除 sign 外的非空参数按 key 升序拼 key=value，再拼密钥，MD5 小写。 */
export function signParams(params) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sig' && params[k] !== '' && params[k] != null)
    .sort()
  const raw = keys.map((k) => `${k}=${params[k]}`).join('') + SIGN_SECRET
  return createHash('md5').update(raw).digest('hex')
}

export function withClientParams(params = {}) {
  return {
    ...params,
    subapp_type: 'pc',
    _client_type: 20,
    _client_version: CLIENT_VERSION,
  }
}

function formBody(params) {
  const signed = withClientParams(params)
  signed.sign = signParams(signed)
  return new URLSearchParams(Object.entries(signed).map(([k, v]) => [k, String(v)])).toString()
}

export function pickCookie(cookie) {
  const map = new Map()
  for (const piece of String(cookie ?? '').split(';')) {
    const s = piece.trim()
    const i = s.indexOf('=')
    if (i <= 0) continue
    map.set(s.slice(0, i).trim(), s.slice(i + 1).trim())
  }
  return COOKIE_KEYS.filter((k) => map.get(k)).map((k) => `${k}=${map.get(k)}`).join('; ')
}

export function cookieFromSetCookie(list = []) {
  const map = new Map()
  for (const raw of list) {
    const first = String(raw ?? '').split(';')[0]?.trim()
    const i = first.indexOf('=')
    if (i <= 0) continue
    map.set(first.slice(0, i).trim(), first.slice(i + 1).trim())
  }
  return pickCookie([...map.entries()].map(([k, v]) => `${k}=${v}`).join('; '))
}

/** JSONP 外壳剥掉。解析失败返回 null，不抛。 */
export function parseJsonp(text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  const i = s.indexOf('(')
  const j = s.lastIndexOf(')')
  const body = i >= 0 && j > i ? s.slice(i + 1, j) : s
  try { return JSON.parse(body) } catch { return null }
}

export function bdussFromBody(text) {
  const m = /["']bduss["']\s*:\s*["']([^"']+)["']/i.exec(String(text ?? ''))
  const v = m?.[1] ?? ''
  return v.length >= 8 ? v : ''
}

function authPath(root) {
  return join(String(root ?? ''), 'tieba.json')
}

function statePath(root) {
  return join(String(root ?? ''), 'tieba-state.json')
}

export async function readAuth(root) {
  const raw = await readJson(authPath(root), null)
  if (!raw || typeof raw !== 'object') return null
  const cookie = pickCookie(raw.cookie)
  if (!cookie.includes('BDUSS=')) return null
  const name = clip(raw.account?.name, 40)
  return { cookie, account: name ? { name } : null, savedAt: String(raw.savedAt ?? '') }
}

export async function writeAuth(root, { cookie, account } = {}) {
  const picked = pickCookie(cookie)
  if (!picked.includes('BDUSS=')) return { ok: false, why: '没有可用的登录态。' }
  const doc = {
    v: 1,
    cookie: picked,
    account: account?.name ? { name: clip(account.name, 40) } : null,
    savedAt: new Date().toISOString(),
  }
  await writeAtomic(authPath(root), JSON.stringify(doc, null, 2), 0o600)
  return { ok: true, account: doc.account }
}

export async function clearAuth(root) {
  await rm(authPath(root), { force: true })
  return { ok: true }
}

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
  const entries = Object.entries(state?.seen ?? {}).filter(([, at]) => now - Number(at) < SEEN_TTL)
  entries.sort((a, b) => Number(b[1]) - Number(a[1]))
  for (const [id, at] of entries.slice(0, SEEN_MAX)) seen[id] = Number(at) || now
  const next = { version: STATE_VERSION, dateKey: String(state?.dateKey ?? ''), runs: Number(state?.runs) || 0, seen }
  await writeAtomic(statePath(root), JSON.stringify(next, null, 2), 0o600)
  return { ok: true }
}

export function runsToday(state, dk) {
  return state?.dateKey === dk ? Number(state.runs) || 0 : 0
}

async function callApi({ path, method = 'POST', params = {}, cookie = '', fetchImpl, timeoutMs = 12_000 }) {
  const body = formBody(params)
  const url = method === 'GET' ? `${API_HOST}${path}?${body}` : `${API_HOST}${path}`
  // 和 B 站客户端一样给超时：不能因为一条请求卡住，把整轮醒来挂在那儿。
  const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
  const res = await fetchImpl(url, {
    method,
    signal,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
      referer: 'https://tieba.baidu.com/',
      ...(cookie ? { cookie } : {}),
    },
    body: method === 'GET' ? undefined : body,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { ok: res.ok && json && Number(json.error_code ?? 0) === 0, status: res.status, json }
}

function authorFromHead(feed) {
  const head = (feed?.components ?? []).find((c) => c.component === 'feed_head')?.feed_head
  for (const row of head?.main_data ?? []) {
    const text = row?.text?.text
    if (text && row?.business_info_map?.icon_type === 'name_show') return clip(text, 40)
  }
  return ''
}

/** 首页推荐 / 吧列表里的帖子卡片。两种形状都认：新 feed，和旧 thread_list。 */
export function threadsFrom(json) {
  const out = []
  const feeds = json?.page_data?.feed_list ?? []
  for (const row of feeds) {
    const feed = row?.feed
    if (!feed) continue
    const biz = feed.business_info_map ?? {}
    const tid = String((feed.log_param ?? []).find((x) => x?.key === 'tid')?.value ?? biz.thread_id ?? '')
    const title = clip(biz.title, 120)
    if (!tid && !title) continue
    out.push({
      id: tid,
      title: title || '（没有标题）',
      abstract: clip(biz.abstract, 180),
      author: authorFromHead(feed),
      forum: clip(biz.forum_name, 40),
      url: tid ? `https://tieba.baidu.com/p/${tid}` : '',
    })
  }
  for (const t of json?.thread_list ?? []) {
    const id = String(t?.tid ?? t?.id ?? '')
    const title = clip(t?.title, 120)
    if (!id && !title) continue
    out.push({
      id,
      title: title || '（没有标题）',
      abstract: clip(t?.abstract, 180),
      author: clip(t?.author?.name_show || t?.author?.name, 40),
      forum: clip(t?.forum_name, 40),
      url: id ? `https://tieba.baidu.com/p/${id}` : '',
    })
  }
  return out
}

/** 帖子页：标题、吧名、楼层正文。楼中楼本版不收。 */
export function postsFrom(json, limit = 3) {
  const users = new Map()
  for (const u of json?.user_list ?? []) {
    const id = String(u?.id ?? '')
    if (id) users.set(id, clip(u.name_show || u.name, 40))
  }
  const posts = []
  for (const p of json?.post_list ?? []) {
    const text = (p?.content ?? []).map((c) => (c?.type === 0 || c?.text ? c.text : '')).filter(Boolean).join('')
    const clean = clip(text, 400)
    if (!clean) continue
    posts.push({
      author: clip(p?.author?.name_show || users.get(String(p?.author_id ?? '')), 40),
      text: clean,
      floor: Number(p?.floor) || posts.length + 1,
    })
    if (posts.length >= limit) break
  }
  return {
    id: String(json?.thread?.id ?? json?.thread?.tid ?? ''),
    title: clip(json?.thread?.title, 120),
    forum: clip(json?.forum?.name, 40),
    posts,
  }
}

export function renderMaterial({ recommend = [], threads = [], forums = [] } = {}) {
  const lines = ['（贴吧 · 此刻推到你面前的）']
  if (recommend.length) {
    lines.push('### 首页推荐')
    for (const it of recommend) {
      const who = it.author ? `${it.author}：` : ''
      const abs = it.abstract ? ` ${it.abstract}` : ''
      lines.push(`- ${who}${it.title}${abs}`)
      if (it.url) lines.push(`  ${it.url}`)
    }
  }
  for (const th of threads) {
    lines.push('', `### 帖子：${th.title || '（没有标题）'}${th.forum ? `（${th.forum}吧）` : ''}`)
    if (th.id) lines.push(`https://tieba.baidu.com/p/${th.id}`)
    for (const p of th.posts ?? []) lines.push(`- ${p.author ? `${p.author}：` : ''}${p.text}`)
  }
  for (const bar of forums) {
    lines.push('', `### 吧：${bar.name}`)
    for (const it of bar.threads ?? []) {
      lines.push(`- ${it.title}`)
      if (it.url) lines.push(`  ${it.url}`)
    }
  }
  if (lines.length === 1) return ''
  lines.push('（这些是贴吧上的公开内容，不是谁专门说给你的。）')
  return sanitizeForeign(lines.join('\n')).text
}

function pacedOr(fetchImpl) {
  return fetchImpl ?? pacedFetch()
}

export async function openRecommend({ cookie, limit = 8, fetchImpl } = {}) {
  const n = Math.max(1, Math.min(20, Number(limit) || 8))
  const r = await callApi({
    path: '/c/f/excellent/personalized_pc',
    method: 'GET',
    cookie,
    fetchImpl: pacedOr(fetchImpl),
    params: { load_type: 2, pn: 1, rn: n },
  })
  return r.json
}

export async function openThread({ cookie, kz, fetchImpl } = {}) {
  const paced = pacedOr(fetchImpl)
  const tbs = await tbsOf(cookie, paced).catch(() => '')
  const r = await callApi({
    path: '/c/f/pb/page_pc',
    method: 'POST',
    cookie,
    fetchImpl: paced,
    params: { kz, pn: 1, rn: 20, lz: 0, r: 0, ...(tbs ? { tbs } : {}) },
  })
  return r.json
}

export async function openForum({ cookie, kw, sort = 'hot', fetchImpl } = {}) {
  const paced = pacedOr(fetchImpl)
  const tbs = await tbsOf(cookie, paced).catch(() => '')
  const r = await callApi({
    path: '/c/f/frs/page_pc',
    method: 'POST',
    cookie,
    fetchImpl: paced,
    params: {
      kw, pn: 1, rn: 8, rn_need: 8, sort_type: sort === 'new' ? 0 : 2, is_newfrs: 1, is_newfeed: 0,
      ...(tbs ? { tbs } : {}),
    },
  })
  return r.json
}

async function tbsOf(cookie, fetchImpl) {
  const r = await callApi({ path: '/c/s/pc/sync', method: 'GET', cookie, fetchImpl })
  return String(r.json?.data?.anti?.tbs ?? r.json?.anti?.tbs ?? '')
}

async function accountName(cookie, fetchImpl) {
  const r = await callApi({ path: '/c/s/pc/sync', method: 'GET', cookie, fetchImpl }).catch(() => null)
  const user = r?.json?.data?.user ?? r?.json?.user ?? {}
  return clip(user.name_show || user.name || user.uname, 40)
}

export async function fetchTiebaMaterial({ root, cfg, now = new Date(), fetchImpl } = {}) {
  const empty = { ok: false, text: '', picks: [], acted: false, blocked: true, why: '' }
  const tb = cfg?.tieba
  if (!tb || tb.enabled !== true) return { ...empty, why: 'disabled' }
  const cap = dailyQuota(cfg, 'tieba')
  if (cap <= 0) return { ...empty, why: 'quota' }
  const dk = dateKey(now)
  const state = await readState(root)
  const runs = runsToday(state, dk)
  if (runs >= cap) return { ...empty, why: 'quota' }

  const auth = await readAuth(root)
  if (!auth?.cookie) return { ...empty, why: 'login-required' }

  // 2026-11-05：只抓首页推荐，一次抓 = 一个请求。
  // 进帖、进吧不在这里自动做——她想点开哪一条，用 tieba_look 自己点（和刷 B 站选一条看一样）。
  const paced = fetchImpl ?? pacedFetch()
  const n = Math.max(1, Math.min(20, Number(tb.recommendTopN) || 8))
  let recJson
  try {
    recJson = await openRecommend({ cookie: auth.cookie, limit: n, fetchImpl: paced })
  } catch {
    return { ...empty, why: 'error' }
  }
  const seen = { ...(state.seen ?? {}) }
  const recommend = threadsFrom(recJson).filter((it) => it.id && !seen[it.id]).slice(0, n)
  if (!recommend.length) return { ...empty, why: 'empty' }

  const nowMs = now.getTime()
  for (const it of recommend) if (it.id) seen[it.id] = nowMs
  await writeState(root, { dateKey: dk, runs: runs + 1, seen })
  const text = renderMaterial({ recommend })
  return { ok: Boolean(text), text, picks: recommend, acted: true, blocked: false, why: text ? '' : 'empty' }
}

export async function tiebaStatus(root) {
  const auth = await readAuth(root).catch(() => null)
  const state = await readState(root)
  const dk = dateKey()
  return {
    loggedIn: Boolean(auth?.cookie),
    account: auth?.account ?? null,
    runsToday: runsToday(state, dk),
    savedAt: auth?.savedAt ?? '',
  }
}

function headersOf(res) {
  const list = typeof res?.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  return list
}

export async function createQr(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, why: '这个 Node 没有 fetch。' }
  const gid = randomUUID().replace(/-/g, '')
  const tt = Date.now()
  try {
    const url = `https://passport.baidu.com/v2/api/getqrcode?lp=pc&qrloginfrom=pc&gid=${gid}&apiver=v3&tt=${tt}&tpl=tb`
    const res = await fetchImpl(url, { headers: { 'user-agent': UA, referer: 'https://tieba.baidu.com/' } })
    const json = await res.json().catch(() => null)
    if (!res.ok || !json || Number(json.errno) !== 0 || !json.sign) {
      return { ok: false, why: '贴吧没给二维码。' }
    }
    const img = String(json.imgurl ?? '')
    const imgUrl = img.startsWith('http') ? img : `https://${img.replace(/^\/+/, '')}`
    const pic = await fetchImpl(imgUrl, { headers: { 'user-agent': UA, referer: 'https://passport.baidu.com/' } })
    const buf = Buffer.from(await pic.arrayBuffer())
    if (!buf.length) return { ok: false, why: '二维码是空的。' }
    const baiduid = cookieFromSetCookie(headersOf(res)).match(/BAIDUID=([^;]+)/)?.[1] ?? ''
    const id = String(json.sign)
    QR_PENDING.set(id, { gid, baiduid, at: Date.now() })
    if (QR_PENDING.size > 20) {
      const oldest = QR_PENDING.keys().next().value
      if (oldest) QR_PENDING.delete(oldest)
    }
    return { ok: true, id, image: `data:image/png;base64,${buf.toString('base64')}`, expiresIn: QR_TTL_MS }
  } catch {
    return { ok: false, why: '连不上贴吧。' }
  }
}

export async function pollQr(id, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const pending = QR_PENDING.get(String(id ?? ''))
  if (!pending || Date.now() - pending.at > QR_TTL_MS) {
    QR_PENDING.delete(String(id ?? ''))
    return { ok: false, status: 'expired', why: '二维码过期了，重新要一张。' }
  }
  const url = `https://passport.baidu.com/channel/unicast?channel_id=${encodeURIComponent(id)}&gid=${pending.gid}&tpl=tb&apiver=v3&tt=${Date.now()}&callback=cb`
  let text = ''
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(12000) : undefined
    const res = await fetchImpl(url, {
      headers: {
        'user-agent': UA,
        referer: 'https://passport.baidu.com/',
        ...(pending.baiduid ? { cookie: `BAIDUID=${pending.baiduid}` } : {}),
      },
      signal,
    })
    text = await res.text()
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { ok: true, status: 'waiting' }
    return { ok: false, status: 'error', why: '连不上贴吧。' }
  }
  const json = parseJsonp(text)
  if (!json || Number(json.errno) !== 0) return { ok: true, status: 'waiting' }
  let channel = null
  try { channel = JSON.parse(String(json.channel_v ?? '')) } catch { channel = null }
  if (!channel) return { ok: true, status: 'waiting' }
  if (Number(channel.status) === 1 && !channel.v) return { ok: true, status: 'scanned' }
  const v = String(channel.v ?? '')
  if (!v) return { ok: true, status: 'waiting' }
  try {
    const tt = Date.now()
    const login = new URL('https://passport.baidu.com/v3/login/main/qrbdusslogin')
    login.searchParams.set('v', String(tt))
    login.searchParams.set('bduss', v)
    login.searchParams.set('u', 'https://tieba.baidu.com/')
    login.searchParams.set('loginVersion', 'v4')
    login.searchParams.set('qrcode', '1')
    login.searchParams.set('tpl', 'tb')
    login.searchParams.set('apiver', 'v3')
    login.searchParams.set('tt', String(tt))
    login.searchParams.set('alg', 'v3')
    login.searchParams.set('time', String(Math.floor(tt / 1000)))
    login.searchParams.set('callback', 'cb')
    const res = await fetchImpl(login, {
      headers: {
        'user-agent': UA,
        referer: 'https://tieba.baidu.com/',
        ...(pending.baiduid ? { cookie: `BAIDUID=${pending.baiduid}` } : {}),
      },
    })
    const body = await res.text()
    const fromHeader = cookieFromSetCookie(headersOf(res))
    const bduss = bdussFromBody(body)
    const cookie = fromHeader.includes('BDUSS=') ? fromHeader : pickCookie(bduss ? `BDUSS=${bduss}` : '')
    if (!cookie.includes('BDUSS=')) return { ok: false, status: 'error', why: '扫上了，但没拿到登录态。' }
    const name = await accountName(cookie, fetchImpl).catch(() => '')
    if (opts.root) await writeAuth(opts.root, { cookie, account: name ? { name } : null })
    QR_PENDING.delete(String(id))
    return { ok: true, status: 'ok', account: name ? { name } : null }
  } catch {
    return { ok: false, status: 'error', why: '登录没完成。' }
  }
}

export async function savePastedCookie(root, cookie, fetchImpl = globalThis.fetch) {
  const picked = pickCookie(cookie)
  if (!picked.includes('BDUSS=')) return { ok: false, why: '这串里没有贴吧登录态。' }
  const name = await accountName(picked, fetchImpl).catch(() => '')
  return writeAuth(root, { cookie: picked, account: name ? { name } : null })
}

export default {
  signParams, threadsFrom, postsFrom, renderMaterial, fetchTiebaMaterial,
  readAuth, writeAuth, clearAuth, tiebaStatus, createQr, pollQr, runsToday,
}
