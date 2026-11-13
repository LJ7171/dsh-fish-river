/**
 * auth.js —— 知乎扫码登录（纯接口，不用浏览器）
 *
 * 流程（2026-11-04 实测可用）：
 *   1. GET  /signin                    拿 _xsrf / d_c0
 *   2. POST /udid                      补设备 cookie
 *   3. POST /api/v3/account/api/login/qrcode?…  → { token, link }
 *   4. GET  /api/v3/account/api/login/qrcode/{token}/scan_info  轮询
 *      - 未扫 / 未确认：403 {"need_login":true}
 *      - 已确认：200，服务端 Set-Cookie: z_c0=…
 *
 * 凭据就是一个 cookie 串（`z_c0; _xsrf; d_c0` 等），只写 `<root>/zhihu-auth.json`（0600）。
 * 这里不做自动重登：cookie 失效就让设置页提示重新扫码。
 */

import { readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { mkdir, rename, chmod, writeFile } from 'node:fs/promises'

const WEB = 'https://www.zhihu.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const TIMEOUT_MS = 12000

function errorText(error) {
  return String(error?.message ?? error).slice(0, 200)
}

function timeoutSignal(ms = TIMEOUT_MS) {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined
}

/** 极简 cookie jar：只要 name=value，够走完扫码。 */
export function createJar(cookies = {}) {
  const jar = { ...cookies }
  return {
    get(name) { return jar[name] ?? '' },
    all() { return { ...jar } },
    header() { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
    absorb(res) {
      let list = typeof res?.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : []
      if (!Array.isArray(list) || !list.length) {
        // 某些 fetch 实现只暴露合并后的 set-cookie 字符串。
        const raw = typeof res?.headers?.get === 'function' ? res.headers.get('set-cookie') : ''
        if (raw) list = String(raw).split(/,(?=[^;=]+=)/g)
      }
      for (const sc of list) {
        const pair = String(sc).split(';')[0]
        const i = pair.indexOf('=')
        if (i <= 0) continue
        jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
      }
    },
    set(name, value) { if (name) jar[name] = String(value ?? '') },
  }
}

async function request(jar, url, init = {}, fetchImpl = fetch) {
  const headers = {
    'user-agent': UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    ...(jar?.header() ? { cookie: jar.header() } : {}),
    ...(init.headers ?? {}),
  }
  const res = await fetchImpl(url, { ...init, headers, signal: init.signal ?? timeoutSignal() })
  jar?.absorb(res)
  return res
}

/**
 * 要一张登录二维码。
 * @returns {Promise<{ok:boolean, token?:string, link?:string, jar?:object, why?:string}>}
 */
export async function createQr({ fetchImpl = fetch } = {}) {
  try {
    const jar = createJar()
    await request(jar, `${WEB}/signin`, {}, fetchImpl)
    await request(jar, `${WEB}/udid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', referer: `${WEB}/signin`, origin: WEB, 'x-requested-with': 'fetch' },
      body: '{}',
    }, fetchImpl).catch(() => {})
    await request(jar, `${WEB}/api/v3/oauth/captcha?lang=en`, {}, fetchImpl).catch(() => {})
    if (!jar.get('_xsrf')) await request(jar, `${WEB}/signin`, {}, fetchImpl)

    const res = await request(jar, `${WEB}/api/v3/account/api/login/qrcode`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        referer: `${WEB}/signin`,
        origin: WEB,
        'x-requested-with': 'fetch',
        'x-xsrftoken': jar.get('_xsrf'),
      },
      body: '{}',
    }, fetchImpl)
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    const token = String(json?.token ?? json?.qrcode_token ?? '').trim()
    const link = String(json?.link ?? '').trim()
    if (!token || !link) return { ok: false, why: `没拿到二维码（HTTP ${res.status}）` }
    return { ok: true, token, link, jar: jar.all() }
  } catch (error) {
    return { ok: false, why: `要二维码失败：${errorText(error)}` }
  }
}

/**
 * 问一次扫码状态（单次，轮询由调用方负责）。
 *
 * @returns {Promise<{ok:boolean, status:'wait'|'confirmed'|'expired'|'error', cookie?:string, why?:string}>}
 */
export async function pollQr({ token, jar, fetchImpl = fetch } = {}) {
  const id = String(token ?? '').trim()
  if (!id) return { ok: false, status: 'error', why: '缺 token' }
  const j = createJar(jar ?? {})
  try {
    const res = await request(j, `${WEB}/api/v3/account/api/login/qrcode/${id}/scan_info`, {
      headers: {
        referer: `${WEB}/signin?next=%2F`,
        accept: '*/*',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'x-requested-with': 'fetch',
        'x-zse-93': '101_3_3.0',
      },
    }, fetchImpl)
    const text = await res.text()
    const cookies = j.all()
    if (cookies.z_c0) {
      return { ok: true, status: 'confirmed', cookie: j.header(), jar: cookies }
    }
    if (res.status === 200 && /access_token/.test(text)) {
      return { ok: true, status: 'confirmed', cookie: j.header(), jar: cookies }
    }
    return { ok: true, status: 'wait', jar: cookies }
  } catch (error) {
    return { ok: false, status: 'error', why: errorText(error) }
  }
}

export function credentialPath(root) {
  return join(String(root ?? ''), 'zhihu-auth.json')
}

function slotOwner(value, fallback) {
  return value === 'her' || value === 'owner' ? value : fallback
}

function emptyZhihuSlot(id, owner) {
  return { id, cookie: '', owner, allowed: false, account: null, savedAt: '' }
}

function publicZhihu(slot) {
  const cookie = String(slot?.cookie ?? '')
  const account = slot?.account && typeof slot.account === 'object' ? slot.account : null
  return {
    id: slot?.id === 'b' ? 'b' : 'a',
    owner: slot?.owner === 'her' ? 'her' : 'owner',
    allowed: Boolean(slot?.allowed) && Boolean(cookie),
    hasCookie: Boolean(cookie),
    name: String(account?.name ?? ''),
    mid: String(account?.id ?? account?.mid ?? ''),
    savedAt: String(slot?.savedAt ?? ''),
  }
}

/** 旧的单条 cookie 进槽 a。ownerLabel 由调用方传入，缺省按知乎现在的默认（重要的人）。 */
export function accountsFromAuth(parsed, ownerLabel = 'owner') {
  const label = slotOwner(ownerLabel, 'owner')
  const other = label === 'her' ? 'owner' : 'her'
  if (Array.isArray(parsed?.accounts)) {
    const byId = new Map()
    for (const raw of parsed.accounts) {
      const id = raw?.id === 'b' ? 'b' : 'a'
      if (byId.has(id)) continue
      const cookie = String(raw?.cookie ?? '').trim()
      byId.set(id, {
        id,
        cookie,
        owner: slotOwner(raw?.owner, id === 'a' ? label : other),
        allowed: cookie ? raw?.allowed !== false : false,
        account: raw?.account ?? null,
        savedAt: String(raw?.savedAt ?? ''),
      })
    }
    return ['a', 'b'].map((id) => byId.get(id) ?? emptyZhihuSlot(id, id === 'a' ? label : other))
  }
  const cookie = String(parsed?.cookie ?? '').trim()
  return [
    {
      id: 'a',
      cookie,
      owner: label,
      allowed: Boolean(cookie),
      account: parsed?.account ?? null,
      savedAt: String(parsed?.savedAt ?? ''),
    },
    emptyZhihuSlot('b', other),
  ]
}

async function readParsed(root) {
  try {
    return JSON.parse(await readFile(credentialPath(root), 'utf8'))
  } catch {
    return null
  }
}

async function writeDoc(root, doc) {
  const file = credentialPath(root)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8')
  await chmod(tmp, 0o600).catch(() => {})
  await rename(tmp, file)
}

function identityOf(slot) {
  const account = slot?.account
  return String(account?.id ?? account?.mid ?? '').trim()
}

export async function readAccounts(root, ownerLabel = 'owner') {
  const parsed = await readParsed(root)
  const accounts = accountsFromAuth(parsed, ownerLabel)
  if (parsed && !Array.isArray(parsed.accounts) && (parsed.cookie || parsed.account)) {
    try { await writeDoc(root, { v: 2, accounts }) } catch { /* 迁不了也不挡这次读取 */ }
  }
  return accounts
}

function legacyOf(slot) {
  if (!slot?.cookie) return null
  return {
    cookie: slot.cookie,
    account: slot.account ?? null,
    savedAt: String(slot.savedAt ?? ''),
    id: slot.id,
    owner: slot.owner,
    allowed: slot.allowed === true,
  }
}

/**
 * 不指定槽时：恰好一个可用号就返回它（旧调用方不用改）。
 * 两个都可用时不挑，返回 needChoice，调用方自己问她。
 */
export async function readAuth(root, slotId = '', ownerLabel = 'owner') {
  const accounts = await readAccounts(root, ownerLabel)
  if (slotId === 'a' || slotId === 'b') return legacyOf(accounts.find((s) => s.id === slotId))
  const usable = accounts.filter((s) => s.cookie && s.allowed)
  if (usable.length === 1) return legacyOf(usable[0])
  if (usable.length > 1) return { needChoice: true, choices: usable.map(publicZhihu) }
  return null
}

/** 存 cookie（0600 原子写）。account 只用于界面显示。slot 缺省写槽 a，不动另一槽。 */
export async function saveCookie(root, { cookie, account = null, slot, owner, allowed, ownerLabel = 'owner' } = {}) {
  const value = String(cookie ?? '').trim()
  if (!value) return { ok: false, why: '空 cookie' }
  try {
    let accounts = await readAccounts(root, ownerLabel)
    const id = slot === 'b' ? 'b' : 'a'
    const ident = String(account?.id ?? account?.mid ?? '').trim()
    // 同一个号扫到另一个槽：自动从旧槽移走，不拒绝（2026-11-13 用户确认）。
    if (ident) {
      const other = accounts.find((s) => s.id !== id && identityOf(s) === ident)
      if (other) accounts = accounts.map((s) => (s.id === other.id ? emptyZhihuSlot(other.id, other.owner) : s))
    }
    const cur = accounts.find((s) => s.id === id) ?? emptyZhihuSlot(id, ownerLabel)
    const next = accounts.map((s) => (s.id === id ? {
      id,
      cookie: value,
      owner: slotOwner(owner, cur.owner || (id === 'a' ? ownerLabel : (ownerLabel === 'her' ? 'owner' : 'her'))),
      allowed: allowed === undefined ? true : allowed === true,
      account,
      savedAt: new Date().toISOString(),
    } : s))
    await writeDoc(root, { v: 2, accounts: next })
    return { ok: true, id }
  } catch (error) {
    return { ok: false, why: `凭据没写进去：${errorText(error)}` }
  }
}

export async function loadCookie(root, slotId = '') {
  return (await readAuth(root, slotId))?.cookie ?? ''
}

export async function clearAuth(root, slotId = '') {
  if (slotId !== 'a' && slotId !== 'b') {
    try {
      await unlink(credentialPath(root))
      return { ok: true }
    } catch (error) {
      if (String(error?.code ?? '') === 'ENOENT') return { ok: true }
      return { ok: false, why: errorText(error) }
    }
  }
  try {
    const accounts = await readAccounts(root)
    const next = accounts.map((s) => (s.id === slotId ? emptyZhihuSlot(slotId, s.owner) : s))
    await writeDoc(root, { v: 2, accounts: next })
    return { ok: true }
  } catch (error) {
    return { ok: false, why: errorText(error) }
  }
}

export async function patchZhihuSlot(root, slotId, patch = {}, ownerLabel = 'owner') {
  const id = slotId === 'b' ? 'b' : 'a'
  const accounts = await readAccounts(root, ownerLabel)
  const next = accounts.map((s) => {
    if (s.id !== id) return s
    const owner = patch.owner !== undefined ? slotOwner(patch.owner, s.owner) : s.owner
    const allowed = !s.cookie ? false : (patch.allowed !== undefined ? patch.allowed === true : s.allowed)
    return { ...s, owner, allowed }
  })
  await writeDoc(root, { v: 2, accounts: next })
  return { ok: true, accounts: next.map(publicZhihu) }
}

export { publicZhihu }

export default {
  createQr, pollQr, saveCookie, readAuth, loadCookie, clearAuth, credentialPath,
  readAccounts, patchZhihuSlot, publicZhihu, accountsFromAuth,
}
