/**
 * channels/weixin.js —— 微信 ClawBot 渠道适配器（腾讯官方 iLink 协议）
 *
 * 与 QQ 那条渠道最大的区别：QQ 是「接一个你自己跑的桥」，微信这里是**官方机器人**——
 * 没有桥，登录就是一次扫码（见 lib/weixinqr.js），之后用长轮询收消息、用 sendmessage 发。
 * 所以这个文件本身不碰登录流程，只做三件事：
 *
 *   1. 把 iLink 的消息搬进来看成一条条规范消息（onMessage）；
 *   2. 把她的话交出去（send）；
 *   3. 断线自己重连、游标自己存（cursor 存 <root>/weixin-cursor.json）。
 *
 * 明确不做（越界就是第二个大脑，见 AGENTS.md §9）：
 *   - 不判断该不该回（gate.js），不拼提示词（router.js），不写事件流；
 *   - 不认人、不打分；
 *   - 进来的图会下载、解密、落盘（否则 read_image 看不见）；
 *   - 出去的图只认本机文件：加密后走 CDN，文字和图片各发一条。不抓网上的地址。
 *
 * 协议细节（headers、baseUrl、item 类型）都来自腾讯官方 iLink 与
 * `Tencent/openclaw-weixin`（MIT）：
 *   - 收：POST /ilink/bot/getupdates  { get_updates_buf, base_info }
 *   - 发：POST /ilink/bot/sendmessage { msg: { … }, base_info }
 *   - 出图：POST /ilink/bot/getuploadurl → POST 密文到 CDN → sendmessage 的 image_item
 *   - 上线/下线提示：POST /ilink/bot/msg/notifystart|notifystop（尽力而为，失败不影响收发）
 */

import { basename, isAbsolute, join } from 'path'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'fs/promises'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { sanitizeForeign } from '../guard.js'
import { sniffMime } from '../media.js'
import { writeAtomic } from '../store.js'
import { loadCredential, authHeaders, baseInfo, CDN_BASE_URL } from '../weixinqr.js'

/** 长轮询的默认超时；服务器会用 longpolling_timeout_ms 覆盖它。 */
const LONG_POLL_MS = 35000
const MIN_POLL_MS = 1000
const MAX_POLL_MS = 120000
/** 微信单条文本不宜太长；和 QQ 那边一样按字符切，不劈开 emoji。 */
const SEND_CHUNK_MAX = 1000
/** 去重窗口：断线重连后服务器可能补推，500 条够覆盖一次重连。 */
const SEEN_MAX = 500
/** 凭据过期时服务器回的 ret 码（与 openclaw-weixin 一致）：别当成普通失败猛重试。 */
const STALE_TOKEN_CODE = -14
const STALE_PAUSE_MS = 30000
const RETRY_MS = 1000
const BACKOFF_MS = 5000
const MAX_FAILURES = 8

/** item_list 里的类型编号（协议常量，改了就收不到）。 */
const ITEM = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 }
const MESSAGE_TYPE_USER = 1
/**
 * getuploadurl 的 media_type，和上面 item_list 的 type **不是同一套编号**。
 * 1 图、2 视频、3 文件、4 语音（openclaw UploadMediaType）。
 */
const UPLOAD_MEDIA_IMAGE = 1

/** 一条消息最多收几张图、单张多大、留几天。图和文字不一样：不收下来就永远看不见。 */
const MEDIA_MAX_IMAGES = 2
const MEDIA_MAX_BYTES = 8 * 1024 * 1024
const MEDIA_TTL_MS = 3 * 86_400_000
/** 图片落在这里，和 douyin-profile 同级：属于她的数据目录，不是工程目录。 */
const MEDIA_DIR = 'weixin-media'

function errorText(error) {
  return String(error?.message ?? error).slice(0, 200)
}

function chunkText(text) {
  const chars = Array.from(String(text ?? ''))
  if (chars.length <= SEND_CHUNK_MAX) return [chars.join('')]
  const out = []
  for (let i = 0; i < chars.length; i += SEND_CHUNK_MAX) out.push(chars.slice(i, i + SEND_CHUNK_MAX).join(''))
  return out
}

/** AES-128-ECB + PKCS7 之后的字节数。PKCS7 至少补 1 字节，所以先 +1 再按 16 向上取整。 */
function aesEcbPaddedSize(rawsize) {
  return Math.ceil((Number(rawsize) + 1) / 16) * 16
}

function encryptAesEcb(buf, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(buf), cipher.final()])
}

/**
 * 官方发送器把 32 位 hex 密钥当成 ASCII 再 base64。
 * 收图那边两种都认（16 字节原钥，或这 32 个 hex 字符），发出去跟官方同一条。
 */
function mediaAesKey(key) {
  const hex = Buffer.from(key).toString('hex')
  return { hex, b64: Buffer.from(hex, 'utf8').toString('base64') }
}

function responseHeader(response, name) {
  const headers = response?.headers
  if (!headers) return ''
  if (typeof headers.get === 'function') {
    const value = headers.get(name) ?? headers.get(String(name).toLowerCase())
    return value == null ? '' : String(value)
  }
  const found = Object.keys(headers).find((key) => key.toLowerCase() === String(name).toLowerCase())
  return found ? String(headers[found] ?? '') : ''
}

function httpsUrl(raw) {
  try {
    const url = new URL(String(raw ?? '').trim())
    return url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

/** 出站只读本机绝对路径。远程地址不在这里抓——抓了就变成渠道自己在上网。 */
async function readLocalImage(filePath) {
  const file = String(filePath ?? '').trim()
  const name = basename(file) || '图'
  if (!file) return { ok: false, why: '没有图片路径' }
  if (/^https?:\/\//i.test(file)) return { ok: false, why: '只发本机文件，不抓网上的图' }
  if (!isAbsolute(file)) return { ok: false, why: '图片路径得是本机绝对路径' }
  let buf
  try {
    buf = await readFile(file)
  } catch {
    return { ok: false, why: `读不到这张图（${name}）` }
  }
  if (!buf.length) return { ok: false, why: `这张图是空的（${name}）` }
  if (buf.length > MEDIA_MAX_BYTES) {
    return { ok: false, why: `图太大了（${(buf.length / 1048576).toFixed(1)}MB，上限 ${MEDIA_MAX_BYTES / 1048576}MB）` }
  }
  if (!sniffMime(buf)) return { ok: false, why: `认不出这是图片（${name}）` }
  return { ok: true, buf, name }
}

/**
 * @param {object} opts
 * @param {string} opts.root 她的家（凭据与游标都在这里，不在 config 里）
 * @param {object} [opts.config] 这个渠道自己的配置段
 * @param {(...a:any[]) => void} [opts.log]
 * @param {typeof fetch} [opts.fetchImpl] 测试注入
 * @param {() => number} [opts.now] 测试注入
 */
export function create(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const config = opts.config !== null && typeof opts.config === 'object' ? opts.config : (opts ?? {})
  const root = String(opts.root ?? '')
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const now = typeof opts.now === 'function' ? opts.now : Date.now

  let credential = null
  let running = false
  let connected = false
  let since = 0
  let lastError = ''
  let sent = 0
  let received = 0
  let abort = null
  let loopTask = null
  const listeners = new Set()
  const seen = new Set()
  /** 每个会话最近一次的 context_token：机器人回复要带上它，否则微信那边接不上这段话。 */
  const contextTokens = new Map()

  const cursorPath = () => join(root, 'weixin-cursor.json')

  function remember(key) {
    if (seen.has(key)) return true
    seen.add(key)
    while (seen.size > SEEN_MAX) {
      const oldest = seen.values().next().value
      if (oldest === undefined) break
      seen.delete(oldest)
    }
    return false
  }

  function messageKey(message) {
    if (message?.message_id !== undefined && message.message_id !== null) return String(message.message_id)
    if (String(message?.client_id ?? '').trim()) return String(message.client_id)
    return JSON.stringify(message).slice(0, 400)
  }

  async function loadCursor() {
    try {
      const parsed = JSON.parse(await readFile(cursorPath(), 'utf8'))
      return typeof parsed?.get_updates_buf === 'string' ? parsed.get_updates_buf : ''
    } catch {
      return ''
    }
  }

  async function saveCursor(value) {
    try {
      await writeAtomic(cursorPath(), JSON.stringify({ get_updates_buf: value }), 0o600)
    } catch (error) {
      // 游标存不下只会导致下次重复收几条，不该让整条渠道停下来。
      lastError = `游标没存下：${errorText(error)}`
    }
  }

  function abortableSleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) { resolve(); return }
      const timer = setTimeout(done, ms)
      timer?.unref?.()
      function done() {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', done)
        resolve()
      }
      signal?.addEventListener?.('abort', done, { once: true })
    })
  }

  function requestSignal(ms, signal) {
    // 长轮询要同时受「一次请求的超时」和「渠道被停掉」两个约束，缺一个都会卡住退出。
    if (signal && typeof AbortSignal?.any === 'function' && typeof AbortSignal?.timeout === 'function') {
      return AbortSignal.any([signal, AbortSignal.timeout(ms)])
    }
    if (signal) return signal
    return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined
  }

  async function post(endpoint, body, { timeoutMs = 15000, signal } = {}) {
    const url = new URL(endpoint, `${credential.baseUrl.replace(/\/+$/, '')}/`).toString()
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: authHeaders(credential.token),
      body: JSON.stringify(body),
      signal: requestSignal(timeoutMs, signal),
    })
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? '?'}`)
    return await response.json()
  }

  function emit(message) {
    for (const fn of listeners) {
      try { fn(message) } catch (error) { log(`onMessage 回调出错：${errorText(error)}`) }
    }
  }

  /** 从 magic bytes 认图片格式（不信文件名，也不信 MIME）。 */
  function sniffExt(buf) {
    if (!buf || buf.length < 12) return ''
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
    if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif'
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
    return ''
  }

  /** iLink 的图片密钥有两种写法：顶层 aeskey（hex）或 media.aes_key（base64）。 */
  function imageKey(image) {
    const hex = String(image?.aeskey ?? '').trim()
    if (/^[0-9a-fA-F]{32}$/.test(hex)) return Buffer.from(hex, 'hex')
    const b64 = String(image?.media?.aes_key ?? '').trim()
    if (!b64) return null
    try {
      const buf = Buffer.from(b64, 'base64')
      if (buf.length === 16) return buf
      const ascii = buf.toString('ascii')
      if (buf.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, 'hex')
    } catch { /* 认不出就当没有密钥 */ }
    return null
  }

  function decrypt(buf, key) {
    try {
      const d = createDecipheriv('aes-128-ecb', key, null)
      return Buffer.concat([d.update(buf), d.final()])
    } catch {
      return null
    }
  }

  /**
   * 把一条 iLink 图片消息下载 + 解密 + 落盘。
   *
   * 为什么必须落盘：她的 `read_image` 只能读本机文件；iLink 给的是**加密 CDN 地址**，
   * 不落地就等于没有图。失败返回 null（这条消息照常交出去，只是少一张图）。
   */
  async function fetchImage(image, messageId, index, signal) {
    try {
      const param = String(image?.media?.encrypt_query_param ?? '').trim()
      const full = String(image?.media?.full_url ?? '').trim()
      const url = full || (param ? `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(param)}` : '')
      if (!url) return null
      const res = await fetchImpl(url, { method: 'GET', signal: requestSignal(20000, signal) })
      if (!res?.ok) return null
      const raw = Buffer.from(await res.arrayBuffer())
      if (!raw.length || raw.length > MEDIA_MAX_BYTES) return null
      const key = imageKey(image)
      // 有的 CDN 给明文、有的给密文：先按有密钥解，解不出可识别格式就退回原字节。
      let data = key ? decrypt(raw, key) : null
      let ext = sniffExt(data ?? Buffer.alloc(0))
      if (!ext) { data = raw; ext = sniffExt(raw) }
      if (!ext) return null

      const dir = join(root, MEDIA_DIR)
      await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {})
      const safeId = String(messageId ?? '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40) || `${now()}`
      const file = join(dir, `${safeId}-${index}.${ext}`)
      await writeFile(file, data, { mode: 0o600 })
      return file
    } catch (error) {
      log(`图片没收到（${errorText(error)}）`)
      return null
    }
  }

  /** 清掉过期的图片：3 天没被提过就删，最多留 50 个。 */
  async function sweepMedia() {
    try {
      const dir = join(root, MEDIA_DIR)
      const names = await readdir(dir).catch(() => [])
      const rows = []
      for (const name of names) {
        const full = join(dir, name)
        const st = await stat(full).catch(() => null)
        if (!st) continue
        if (now() - st.mtimeMs > MEDIA_TTL_MS) await unlink(full).catch(() => {})
        else rows.push({ full, mtime: st.mtimeMs })
      }
      rows.sort((a, b) => a.mtime - b.mtime)
      for (const row of rows.slice(0, Math.max(0, rows.length - 50))) await unlink(row.full).catch(() => {})
    } catch { /* 清理失败不影响收消息 */ }
  }

  /**
   * 一条 iLink 消息 → 渠道契约里的规范消息。
   * 返回 null 表示「这条不算别人说的话」（机器人自己发的、没有发送者的）。
   */
  async function normalize(message, signal) {
    if (message?.message_type !== undefined && message.message_type !== MESSAGE_TYPE_USER) return null
    const sender = String(message?.from_user_id ?? '').trim()
    if (!sender) return null

    const texts = []
    const images = []
    const messageId = String(message?.message_id ?? message?.client_id ?? `${now()}`)
    for (const item of Array.isArray(message?.item_list) ? message.item_list : []) {
      if (item?.type === ITEM.TEXT) {
        const text = String(item?.text_item?.text ?? '').trim()
        if (text) texts.push(text)
      } else if (item?.type === ITEM.IMAGE && images.length < MEDIA_MAX_IMAGES) {
        // 纯图片：text 留空（契约里空串就是「只有图」），图片落盘后把**本地路径**放进 images。
        const file = await fetchImage(item?.image_item ?? {}, messageId, images.length, signal)
        // 下载失败也留一个空位：她至少知道「有人发了一张图」，而不是整条消息凭空消失。
        images.push(file || '')
      }
    }
    if (images.length) void sweepMedia()

    const raw = texts.join('\n').trim()
    // 进站文本必须过 guard：这里是「她根本没看见」的那道闸，不是劝她别听。
    const text = raw ? sanitizeForeign(raw).text : ''
    if (!text && !images.length) return null

    const token = String(message?.context_token ?? '').trim()
    if (token) {
      contextTokens.set(sender, token)
      while (contextTokens.size > 200) {
        const oldest = contextTokens.keys().next().value
        if (oldest === undefined) break
        contextTokens.delete(oldest)
      }
    }

    return {
      channelId: 'weixin',
      kind: 'dm', // ClawBot 只有私聊：没有群号，也没有 @ 的概念
      conversationId: sender,
      conversationName: '',
      personId: `u_${sender}`,
      personName: '',
      text,
      images,
      at: now(),
      raw: { message_id: message?.message_id ?? '', client_id: message?.client_id ?? '' },
    }
  }

  async function loop(signal) {
    let cursor = await loadCursor()
    let timeoutMs = LONG_POLL_MS
    let failures = 0
    while (!signal.aborted) {
      try {
        const response = await post('ilink/bot/getupdates', {
          get_updates_buf: cursor,
          base_info: baseInfo(),
        }, { timeoutMs, signal })
        if (signal.aborted) return
        const code = response?.errcode ?? response?.ret ?? 0
        if (code !== 0) {
          if (code === STALE_TOKEN_CODE) {
            // 凭据暂时被判过期：别退出、别重登，等一会儿再问（协议的重试语义）。
            lastError = '微信那边说这份登录暂时失效了，等一会儿再试'
            await abortableSleep(STALE_PAUSE_MS, signal)
            continue
          }
          failures += 1
          lastError = `收消息失败（${code}）：${String(response?.errmsg ?? '').slice(0, 80)}`
          await abortableSleep(failures >= MAX_FAILURES ? BACKOFF_MS : RETRY_MS, signal)
          if (failures >= MAX_FAILURES) failures = 0
          continue
        }
        failures = 0
        if (!connected) {
          connected = true
          since = now()
          lastError = ''
        }
        if (Number(response?.longpolling_timeout_ms) > 0) {
          timeoutMs = Math.max(MIN_POLL_MS, Math.min(Number(response.longpolling_timeout_ms), MAX_POLL_MS))
        }
        const next = String(response?.get_updates_buf ?? '')
        if (next && next !== cursor) {
          await saveCursor(next)
          cursor = next
        }
        for (const message of Array.isArray(response?.msgs) ? response.msgs : []) {
          if (signal.aborted) return
          const key = messageKey(message)
          if (remember(key)) continue
          const normalized = await normalize(message, signal)
          if (!normalized) continue
          received += 1
          emit(normalized)
        }
      } catch (error) {
        if (signal.aborted) return
        failures += 1
        connected = false
        lastError = `收消息中断：${errorText(error)}`
        await abortableSleep(failures >= MAX_FAILURES ? BACKOFF_MS : RETRY_MS, signal)
        if (failures >= MAX_FAILURES) failures = 0
      }
    }
    connected = false
  }

  /** 起：拿凭据、打一声招呼、开始轮询。没凭据时返回 login-required，让界面去扫码。 */
  async function start() {
    try {
      if (config.enabled === false) return { ok: false, why: 'disabled' }
      if (running) return { ok: true }
      if (!root) return { ok: false, why: '没有数据目录' }
      credential = await loadCredential(root)
      if (!credential) return { ok: false, why: 'login-required' }

      abort = new AbortController()
      running = true
      // notifystart 是「上线」提示，失败不该拦住收消息——微信服务器偶尔不认它。
      try {
        await post('ilink/bot/msg/notifystart', { base_info: baseInfo() }, { signal: abort.signal })
      } catch (error) {
        log(`notifystart 没成功（不影响收消息）：${errorText(error)}`)
      }
      loopTask = loop(abort.signal).catch((error) => {
        lastError = `轮询退出：${errorText(error)}`
        connected = false
      })
      connected = true
      since = now()
      log(`已连上（机器人 ${credential.accountId.slice(0, 10)}…）`)
      return { ok: true }
    } catch (error) {
      lastError = `启动失败：${errorText(error)}`
      running = false
      return { ok: false, why: lastError }
    }
  }

  async function stop() {
    try {
      running = false
      connected = false
      if (abort) {
        abort.abort()
        abort = null
      }
      if (loopTask) {
        try { await loopTask } catch { /* 停的时候不许抛 */ }
        loopTask = null
      }
      if (credential) {
        try {
          await post('ilink/bot/msg/notifystop', { base_info: baseInfo() }, { timeoutMs: 3000 })
        } catch { /* 下线提示失败没人关心 */ }
      }
    } catch { /* 关不掉也不能抛给调用方 */ }
  }

  async function postBytes(url, body, { timeoutMs = 20000, signal } = {}) {
    // CDN 不带登录头：token 只该出现在 iLink 那几个接口上。
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
      signal: requestSignal(timeoutMs, signal),
    })
  }

  function newClientId() {
    return `fish-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  async function sendItem(target, contextToken, item) {
    const clientId = newClientId()
    const response = await post('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: target,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: [item],
        ...(contextToken ? { context_token: contextToken } : {}),
      },
      base_info: baseInfo(),
    }, { signal: abort?.signal })
    const code = response?.errcode ?? response?.ret ?? 0
    if (code !== 0) return { ok: false, why: `发消息被拒（${code}）` }
    return { ok: true, id: clientId }
  }

  /**
   * 一张本机图：getuploadurl → AES-128-ECB 密文 POST 到 CDN → 返回 image_item。
   * 文字说明不放进这条 item；官方是文字、图片各发一条 sendmessage。
   */
  async function uploadImage(target, buf) {
    const rawsize = buf.length
    const rawfilemd5 = createHash('md5').update(buf).digest('hex')
    const filesize = aesEcbPaddedSize(rawsize)
    const filekey = randomBytes(16).toString('hex')
    const aes = mediaAesKey(randomBytes(16))
    const ticket = await post('ilink/bot/getuploadurl', {
      filekey,
      media_type: UPLOAD_MEDIA_IMAGE,
      to_user_id: target,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aes.hex,
      base_info: baseInfo(),
    }, { signal: abort?.signal })
    const code = ticket?.errcode ?? ticket?.ret ?? 0
    if (code !== 0) return { ok: false, why: `申请上传被拒（${code}）` }

    const full = httpsUrl(ticket?.upload_full_url)
    const param = String(ticket?.upload_param ?? '').trim()
    const cdnUrl = full || (param
      ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(param)}&filekey=${encodeURIComponent(filekey)}`
      : '')
    if (!cdnUrl) return { ok: false, why: '微信没给上传地址' }

    const cipher = encryptAesEcb(buf, Buffer.from(aes.hex, 'hex'))
    if (cipher.length !== filesize) return { ok: false, why: '加密后的大小对不上' }
    const uploaded = await postBytes(cdnUrl, cipher, { signal: abort?.signal })
    if (!uploaded?.ok) return { ok: false, why: `图传不上去（${uploaded?.status ?? '?'}）` }
    const downloadParam = responseHeader(uploaded, 'x-encrypted-param').trim()
    if (!downloadParam) return { ok: false, why: '微信没给下载参数' }

    return {
      ok: true,
      item: {
        type: ITEM.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: downloadParam,
            aes_key: aes.b64,
            encrypt_type: 1,
          },
          mid_size: cipher.length,
        },
      },
    }
  }

  async function send({ conversation, text, images } = {}) {
    try {
      // 代发走 kind:'private'（journal 的线程键是 dm，HTTP 却写成 private）。两种都是私聊。
      const rawKind = conversation?.kind
      const kind = rawKind === 'group' ? 'group' : (rawKind === 'dm' || rawKind === 'private') ? 'dm' : null
      if (kind === null) return { ok: false, why: 'bad_target' }
      if (kind === 'group') return { ok: false, why: 'weixin 只有私聊' }
      const target = String(conversation?.id ?? '').trim()
      if (!target) return { ok: false, why: 'bad_target' }
      if (images != null && !Array.isArray(images)) return { ok: false, why: 'images 得是路径数组' }
      const files = (Array.isArray(images) ? images : []).map((p) => String(p ?? '').trim()).filter(Boolean)
      const body = String(text ?? '').trim()
      if (!body && !files.length) return { ok: false, why: 'empty' }
      if (files.length > MEDIA_MAX_IMAGES) return { ok: false, why: `一次最多 ${MEDIA_MAX_IMAGES} 张图` }
      if (!credential) return { ok: false, why: 'login-required' }
      if (!running) return { ok: false, why: 'offline' }

      // 先把图读完再发文字：路径不对就整次不发，免得对方只收到半句说明。
      const loaded = []
      for (const file of files) {
        const img = await readLocalImage(file)
        if (!img.ok) return img
        loaded.push(img.buf)
      }

      const contextToken = contextTokens.get(target)
      let lastId = ''
      if (body) {
        for (const chunk of chunkText(body)) {
          const sentText = await sendItem(target, contextToken, { type: ITEM.TEXT, text_item: { text: chunk } })
          if (!sentText.ok) return sentText
          lastId = sentText.id
        }
      }
      for (const buf of loaded) {
        const uploaded = await uploadImage(target, buf)
        if (!uploaded.ok) return uploaded
        const sentImage = await sendItem(target, contextToken, uploaded.item)
        if (!sentImage.ok) return sentImage
        lastId = sentImage.id
      }
      sent += 1
      return { ok: true, id: lastId }
    } catch (error) {
      return { ok: false, why: errorText(error) || 'send_failed' }
    }
  }

  function onMessage(fn) {
    if (typeof fn !== 'function') return () => {}
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }

  function status() {
    // 一个配置值都不能带出去：token 就在凭据文件里（AGENTS.md §9 的「凭据不进 status」）。
    return {
      ok: connected,
      connected,
      since: since || 0,
      lastError,
      queued: 0,
      sent,
      received,
    }
  }

  return { name: 'weixin', start, stop, send, onMessage, status }
}

export default { create }
