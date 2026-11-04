/**
 * weixinqr.js —— 微信 ClawBot（官方 iLink 协议）的扫码登录与凭据存放
 *
 * 为什么单独一份：渠道适配器（channels/weixin.js）只认「已经拿到的凭据」，
 * 而「怎么拿到凭据」是另一件事——要二维码、要轮询、可能有数字校验码、还可能被
 * 服务器切到别的节点。把这两件事混在一个文件里，适配器就读不动了。
 *
 * 协议来源：腾讯官方 iLink / ClawBot，与 `Tencent/openclaw-weixin`（MIT）一致；
 * 本文件只用了三个接口：
 *
 *   1. 要码   POST /ilink/bot/get_bot_qrcode?bot_type=3   → { qrcode, qrcode_img_content }
 *   2. 问状态 GET  /ilink/bot/get_qrcode_status?qrcode=…  → { status, … }
 *              status: wait / scaned / need_verifycode / scaned_but_redirect /
 *                      expired / verify_code_blocked / binded_redirect / confirmed
 *   3. 发消息 POST /ilink/bot/sendmessage                （见 channels/weixin.js）
 *
 * 硬约束（与整个渠道层一致）：
 *   - 零依赖：只用 globalThis.fetch 与 node:crypto；
 *   - 永不抛：网络 / 解析问题一律变成 { ok:false, why }，让界面有话可说；
 *   - 凭据只落本机：`<root>/weixin.json`，0600，原子写；日志里只出现账号 id 的短形式。
 */

import { randomBytes } from 'crypto'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { renderSVG } from './vendor/uqr.mjs'
import { writeAtomic } from './store.js'

/** 登录与发消息都走这个域；扫码成功后服务器可能给一个不同的 baseUrl。 */
export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
/** 图片 / 文件的加密中转（发媒体时才用到；文本收发不碰它）。 */
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
/** bot_type=3 是 ClawBot 这一档；换别的值拿到的是另一种码，扫了也不通。 */
export const BOT_TYPE = '3'
/** 与 openclaw-weixin 2.4.6 对齐的客户端版本号：2.4.6 → 0x020406。 */
export const APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6
const APP_ID = 'bot'
/** 二维码大约两分钟过期；这里只给界面画倒计时，判定仍以服务器状态为准。 */
export const QR_TTL_MS = 120000
const REQUEST_TIMEOUT_MS = 15000
/** get_qrcode_status 是长轮询：服务器会挂住这条 GET 直到状态变化。等太短会白白丢响应。 */
const STATUS_LONG_POLL_MS = 35000

/** 凭据落在她的家里，和 owner.json 平级——不是配置项，不进 config.json。 */
export function credentialPath(root) {
  return join(root, 'weixin.json')
}

function nowMs() {
  return Date.now()
}

function errorText(error) {
  return String(error?.message ?? error).slice(0, 200)
}

function normalizeBase(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ILINK_BASE_URL
  const trimmed = raw.replace(/\/+$/, '')
  try {
    const u = new URL(trimmed)
    // 只认 https：凭据会跟着这个地址走，http 等于把 token 明文发出去。
    return u.protocol === 'https:' ? trimmed : ILINK_BASE_URL
  } catch {
    return ILINK_BASE_URL
  }
}

function commonHeaders() {
  return {
    'Content-Type': 'application/json',
    'iLink-App-Id': APP_ID,
    'iLink-App-ClientVersion': String(APP_CLIENT_VERSION),
  }
}

/**
 * 带凭据的请求头。X-WECHAT-UIN 是随机 uin 的 base64（协议要求，不是身份）——
 * 每次请求现算，不落盘。
 */
export function authHeaders(token) {
  const uin = randomBytes(4).readUInt32BE(0)
  return {
    ...commonHeaders(),
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': Buffer.from(String(uin)).toString('base64'),
  }
}

/** 请求体里常见的 base_info：iLink 用它做客户端识别，字段名不能改。 */
export function baseInfo() {
  return { app_id: APP_ID, client_version: String(APP_CLIENT_VERSION) }
}

function timeoutSignal(ms) {
  // Node 22 自带 AbortSignal.timeout；拿不到就退回一个「不超时」的控制器。
  if (typeof AbortSignal?.timeout === 'function') return AbortSignal.timeout(ms)
  return new AbortController().signal
}

async function requestJson(url, init, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await fetchImpl(url, { ...init, signal: timeoutSignal(timeoutMs) })
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? '?'}`)
  return await response.json()
}

/**
 * 要一张登录二维码。
 *
 * `svg` 是给设置页直接内联画的（`data:image/svg+xml,…`），
 * `url` 才是二维码里真正的内容——手机微信扫的是它。
 *
 * @returns {Promise<{ok:boolean, id?:string, url?:string, svg?:string, expiresIn?:number, why?:string}>}
 */
export async function createQr(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    const data = await requestJson(
      `${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
      {
        method: 'POST',
        headers: commonHeaders(),
        body: JSON.stringify({ local_token_list: Array.isArray(opts.existingTokens) ? opts.existingTokens.slice(-10) : [] }),
      },
      fetchImpl,
      opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
    )
    const id = String(data?.qrcode ?? '').trim()
    const url = String(data?.qrcode_img_content ?? '').trim()
    if (!id || !url) return { ok: false, why: '微信没有返回可用的二维码' }
    let svg = ''
    try {
      svg = renderSVG(url, { whiteColor: '#ffffff', blackColor: '#111111', border: 2 })
    } catch { /* 画不出来不影响扫码：url 本身还能用 */ }
    return { ok: true, id, url, svg, expiresIn: QR_TTL_MS }
  } catch (error) {
    return { ok: false, why: `要二维码失败：${errorText(error)}` }
  }
}

/**
 * 问一次「扫了没有」。
 *
 * 成功（confirmed）时把凭据原样交回去，由调用方决定存哪——
 * 这个文件不写盘，存盘是 saveCredential 的事。
 *
 * @returns {Promise<{ok:boolean, status:string, note?:string, redirectHost?:string,
 *                    credential?:{token:string, accountId:string, baseUrl:string, userId?:string}, why?:string}>}
 */
export async function pollQr(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const id = String(opts.id ?? '').trim()
  if (!id) return { ok: false, status: 'error', why: '没有二维码 id' }
  const base = normalizeBase(opts.baseUrl ?? ILINK_BASE_URL)
  const query = new URLSearchParams({ qrcode: id })
  const verifyCode = String(opts.verifyCode ?? '').trim()
  if (verifyCode) query.set('verify_code', verifyCode)
  let data
  try {
    data = await requestJson(
      `${base}/ilink/bot/get_qrcode_status?${query.toString()}`,
      { method: 'GET', headers: commonHeaders() },
      fetchImpl,
      // 这里不能用 15s：状态接口是长轮询，服务器确认/扫码时才回包。
      opts.timeoutMs ?? STATUS_LONG_POLL_MS,
    )
  } catch (error) {
    // 轮询本来就会碰到瞬时失败：调用方按「还没扫」继续问，不该当成登录失败。
    return { ok: false, status: 'retry', why: `查询扫码状态失败：${errorText(error)}` }
  }
  const status = String(data?.status ?? '').trim()
  if (status === 'wait') return { ok: true, status: 'wait' }
  if (status === 'scaned') return { ok: true, status: 'scanned' }
  if (status === 'need_verifycode') {
    return { ok: true, status: 'need_verifycode', note: '微信里显示了几个数字，填进来才能继续。' }
  }
  if (status === 'scaned_but_redirect') {
    return { ok: true, status: 'redirect', redirectHost: String(data?.redirect_host ?? '').trim() }
  }
  if (status === 'expired') return { ok: true, status: 'expired', note: '二维码过期了，重新要一张。' }
  if (status === 'verify_code_blocked') return { ok: true, status: 'blocked', note: '数字错了太多次，重新要一张码。' }
  if (status === 'binded_redirect') {
    return { ok: true, status: 'binded', note: '这个微信 ClawBot 已经绑在别处了，先在微信里解除旧连接。' }
  }
  if (status === 'confirmed') {
    const token = String(data?.bot_token ?? '').trim()
    const accountId = String(data?.ilink_bot_id ?? '').trim()
    if (!token || !accountId) return { ok: false, status: 'error', why: '微信确认了，但没给全凭据' }
    const credential = {
      token,
      accountId,
      baseUrl: normalizeBase(data?.baseurl ?? base),
      ...(String(data?.ilink_user_id ?? '').trim() ? { userId: String(data.ilink_user_id).trim() } : {}),
      savedAt: new Date(nowMs()).toISOString(),
    }
    return { ok: true, status: 'confirmed', credential }
  }
  return { ok: false, status: 'error', why: `微信返回了没见过的状态：${status || '（空）'}` }
}

function validateCredential(value) {
  if (value === null || typeof value !== 'object') return null
  const token = String(value.token ?? '').trim()
  const accountId = String(value.accountId ?? '').trim()
  if (!token || !accountId) return null
  const baseUrl = normalizeBase(value.baseUrl)
  return {
    token,
    accountId,
    baseUrl,
    ...(String(value.userId ?? '').trim() ? { userId: String(value.userId).trim() } : {}),
    ...(String(value.savedAt ?? '').trim() ? { savedAt: String(value.savedAt) } : {}),
  }
}

/** 读凭据；没有 / 坏了都返回 null（「没登录」和「文件坏了」对调用方是同一件事）。 */
export async function loadCredential(root) {
  try {
    const raw = await readFile(credentialPath(root), 'utf8')
    return validateCredential(JSON.parse(raw))
  } catch {
    return null
  }
}

/** 存凭据：0600 原子写。token 只出现在这一个文件里，不进 config、不进日志。 */
export async function saveCredential(root, credential) {
  const clean = validateCredential(credential)
  if (!clean) return { ok: false, why: '凭据不完整（缺 token 或账号 id）' }
  try {
    await writeAtomic(credentialPath(root), JSON.stringify(clean, null, 2), 0o600)
    return { ok: true, accountId: clean.accountId }
  } catch (error) {
    return { ok: false, why: `凭据没写进去：${errorText(error)}` }
  }
}

/** 退出登录 / 换号：删掉凭据（连 token 一起，不能只是「忽略」）。 */
export async function clearCredential(root) {
  try {
    const { unlink } = await import('fs/promises')
    await unlink(credentialPath(root))
    return { ok: true }
  } catch (error) {
    if (String(error?.code ?? '') === 'ENOENT') return { ok: true }
    return { ok: false, why: errorText(error) }
  }
}

/** 给界面看的凭据摘要：**没有 token**，只有「登的是哪个机器人」。 */
export function publicCredential(credential) {
  if (!credential) return null
  return {
    accountId: credential.accountId,
    baseUrl: credential.baseUrl,
    ...(credential.userId ? { userId: credential.userId } : {}),
    ...(credential.savedAt ? { savedAt: credential.savedAt } : {}),
  }
}

export default {
  ILINK_BASE_URL,
  CDN_BASE_URL,
  createQr,
  pollQr,
  loadCredential,
  saveCredential,
  clearCredential,
  publicCredential,
  credentialPath,
}
