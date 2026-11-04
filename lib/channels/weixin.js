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
 *   - 图片只保留「有图」这个事实（媒体引用原样放着，不解密、不落盘）——
 *     她本来也看不见图，先把「只发了图」这件事告诉她比下载一堆没人看的文件有用。
 *
 * 协议细节（headers、baseUrl、item 类型）都来自腾讯官方 iLink 与
 * `Tencent/openclaw-weixin`（MIT）2.4.6：
 *   - 收：POST /ilink/bot/getupdates  { get_updates_buf, base_info }
 *   - 发：POST /ilink/bot/sendmessage { msg: { … }, base_info }
 *   - 上线/下线提示：POST /ilink/bot/msg/notifystart|notifystop（尽力而为，失败不影响收发）
 */

import { join } from 'path'
import { readFile } from 'fs/promises'
import { sanitizeForeign } from '../guard.js'
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

  /**
   * 一条 iLink 消息 → 渠道契约里的规范消息。
   * 返回 null 表示「这条不算别人说的话」（机器人自己发的、没有发送者的）。
   */
  function normalize(message) {
    if (message?.message_type !== undefined && message.message_type !== MESSAGE_TYPE_USER) return null
    const sender = String(message?.from_user_id ?? '').trim()
    if (!sender) return null

    const texts = []
    const images = []
    for (const item of Array.isArray(message?.item_list) ? message.item_list : []) {
      if (item?.type === ITEM.TEXT) {
        const text = String(item?.text_item?.text ?? '').trim()
        if (text) texts.push(text)
      } else if (item?.type === ITEM.IMAGE) {
        const media = item?.image_item?.media ?? item?.image_item ?? {}
        const param = String(media?.encrypt_query_param ?? '').trim()
        const full = String(media?.full_url ?? '').trim()
        const url = full || (param ? `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(param)}` : '')
        // 纯图片：text 留空（契约里空串就是「只有图」），媒体引用进 images。
        if (url) images.push(url)
      }
    }

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
          const normalized = normalize(message)
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

  async function send({ conversation, text } = {}) {
    try {
      const kind = conversation?.kind === 'group' ? 'group' : conversation?.kind === 'dm' ? 'dm' : null
      if (kind === null) return { ok: false, why: 'bad_target' }
      if (kind === 'group') return { ok: false, why: 'weixin 只有私聊' }
      const target = String(conversation?.id ?? '').trim()
      if (!target) return { ok: false, why: 'bad_target' }
      const body = String(text ?? '').trim()
      if (!body) return { ok: false, why: 'empty' }
      if (!credential) return { ok: false, why: 'login-required' }
      if (!running) return { ok: false, why: 'offline' }

      const contextToken = contextTokens.get(target)
      let lastId = ''
      for (const chunk of chunkText(body)) {
        const clientId = `fish-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        const response = await post('ilink/bot/sendmessage', {
          msg: {
            from_user_id: '',
            to_user_id: target,
            client_id: clientId,
            message_type: 2, // BOT
            message_state: 2, // FINISH
            item_list: [{ type: ITEM.TEXT, text_item: { text: chunk } }],
            ...(contextToken ? { context_token: contextToken } : {}),
          },
          base_info: baseInfo(),
        }, { signal: abort?.signal })
        const code = response?.errcode ?? response?.ret ?? 0
        if (code !== 0) return { ok: false, why: `发消息被拒（${code}）` }
        lastId = clientId
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
