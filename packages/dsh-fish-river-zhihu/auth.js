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
      const list = typeof res?.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : []
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

/** 存 cookie（0600 原子写）。account 只用于界面显示。 */
export async function saveCookie(root, { cookie, account = null } = {}) {
  const value = String(cookie ?? '').trim()
  if (!value) return { ok: false, why: '空 cookie' }
  const file = credentialPath(root)
  try {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ cookie: value, account, savedAt: new Date().toISOString() }, null, 2), 'utf8')
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, file)
    return { ok: true }
  } catch (error) {
    return { ok: false, why: `凭据没写进去：${errorText(error)}` }
  }
}

/** 读凭据；没有 / 坏了都返回 null。 */
export async function readAuth(root) {
  try {
    const raw = await readFile(credentialPath(root), 'utf8')
    const parsed = JSON.parse(raw)
    const cookie = String(parsed?.cookie ?? '').trim()
    if (!cookie) return null
    return { cookie, account: parsed?.account ?? null, savedAt: String(parsed?.savedAt ?? '') }
  } catch {
    return null
  }
}

export async function loadCookie(root) {
  return (await readAuth(root))?.cookie ?? ''
}

export async function clearAuth(root) {
  try {
    await unlink(credentialPath(root))
    return { ok: true }
  } catch (error) {
    if (String(error?.code ?? '') === 'ENOENT') return { ok: true }
    return { ok: false, why: errorText(error) }
  }
}

export default { createQr, pollQr, saveCookie, readAuth, loadCookie, clearAuth, credentialPath }
