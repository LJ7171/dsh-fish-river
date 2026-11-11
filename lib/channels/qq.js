/**
 * qq.js —— QQ 渠道适配器：OneBot 11 正向 WebSocket（默认 ws://127.0.0.1:3001）。
 *
 * 职责与边界（以 channels/README.md 为准，改之前先读那份契约）：
 *  - 只做两件事：把外面的话搬进来（onMessage 回调规范化消息），把她的话送出去（send）。
 *  - 不认人、不建会话、不判断"该不该回"——那些是 router.js / gate.js 的事。
 *  - 断线重连自己管；token 只出现在 WS 的 URL 里，不进日志、不进 status()。
 *
 * 为什么是"接桥"而不是内置 QQ 协议：AGENTS.md 第 7 条把协议、登录、收发都划给独立桥
 * （SnowLuma / NapCat / Lagrange / go-cqhttp…），本插件只当 OneBot 客户端。这也是零依赖
 * 唯一走得通的路——Node 22+ 自带 globalThis.WebSocket，不用引 ws 包。
 *
 * 踩过的坑（细节写在对应代码旁边）：
 *  - 自己发的消息也会以 post_type=message 回推（self_id === user_id），不挡掉她会看见
 *    "自己说的话"被当成别人说的，然后开始自问自答；
 *  - 桥重连后可能补推一段历史，按 message_id 去重是"同一句话被喂两遍"的唯一防线；
 *  - post_format 可能是 array 也可能是 string（CQ 码），两种都得认，否则 @ 会漏成
 *    `[CQ:at,qq=123]` 原文进上下文；
 *  - 只有图/表情的消息 text 是空串，但**不能丢**——她得知道有人发了图；
 *  - 发送不能重试：超时后桥可能其实已经发出去了，重试就是让对方收两遍。
 */

import { sanitizeForeign } from '../core/guard.js'

const DEFAULT_WS_URL = 'ws://127.0.0.1:3001'
/** 阶梯退避：过了 30s 就一直按 30s 重试，不无限翻倍——桥重启通常几十秒内就回来了。 */
const RECONNECT_STEPS_MS = [1000, 2000, 5000, 10_000, 30_000]
const CALL_TIMEOUT_MS = 15_000
const SEND_CHUNK_MAX = 1500
/** 去重窗口：500 条足够覆盖"断线几秒后补推"的量，又不至于把内存当账本。 */
const SEEN_MAX = 500
const IMAGE_MAX = 4

/**
 * @param {object} opts
 * @param {(...a: any[]) => void} [opts.log]
 * @param {{enabled?: boolean, wsUrl?: string, token?: string, accessToken?: string}} [opts.config]
 * @param {typeof WebSocket} [opts.WebSocketImpl] 测试注入；缺省 globalThis.WebSocket
 * @param {() => number} [opts.now]
 * @param {(fn: Function, ms: number) => any} [opts.setTimeout] 测试注入（快进超时/退避）
 * @param {(handle: any) => void} [opts.clearTimeout]
 */
export function create(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const config = opts.config !== null && typeof opts.config === 'object' ? opts.config : {}
  const WSImpl = opts.WebSocketImpl ?? globalThis.WebSocket
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  // 定时器可注入：单测要把 15s 超时 / 30s 退避"快进"，否则一条用例得真等半分钟。
  const setT = typeof opts.setTimeout === 'function' ? opts.setTimeout : (fn, ms) => setTimeout(fn, ms)
  const clearT = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : (handle) => clearTimeout(handle)

  let socket = null // 当前连接；null = 没有连接
  let connected = false // onopen 之后才为 true（构造出 WebSocket 不等于连上）
  let stopped = true // 出生就是停的：没调 start() 之前绝不碰网络
  let attempt = 0 // 连续失败次数，决定退避档位；连上就归零
  let reconnectTimer = null
  let since = 0
  let lastError = ''
  let selfId = '' // 桥那边登录的 QQ 号；判断"这条是不是我自己发的"靠它
  let nickname = ''
  let sent = 0
  let received = 0
  let seq = 0

  const listeners = new Set()
  /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
  const pending = new Map()
  /** message_id → true，Map 保持插入序，超窗口时删最老的 */
  const seen = new Map()

  function token() {
    const value = config.token ?? config.accessToken
    return value === undefined || value === null ? '' : String(value)
  }

  /** 任何进日志/返回值的文本都过这里：token 绝不出门（README 规则 3）。 */
  function scrub(text) {
    const secret = token()
    const s = String(text ?? '')
    return secret === '' ? s : s.split(secret).join('***')
  }

  function errorText(error) {
    if (error && typeof error === 'object' && typeof error.why === 'string') return scrub(error.why)
    if (error instanceof Error) return scrub(error.message)
    return scrub(String(error ?? 'unknown'))
  }

  function info(message) {
    try { log('info', scrub(`[qq] ${message}`)) } catch { /* 日志坏了不能连带渠道挂掉 */ }
  }

  function warn(message) {
    try { log('warn', scrub(`[qq] ${message}`)) } catch { /* 同上 */ }
  }

  function buildUrl() {
    let raw = String(config.wsUrl ?? '').trim() || DEFAULT_WS_URL
    // 允许只填 `127.0.0.1:3001`（设置页里很常见），补个 ws:// 再解析。
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `ws://${raw}`
    const url = new URL(raw)
    const secret = token()
    // OneBot 11 正向 WS 的鉴权就是这一条 query 参数；放 header 很多实现不认。
    if (secret !== '') url.searchParams.set('access_token', secret)
    return url.toString()
  }

  function closeSocket() {
    const ws = socket
    socket = null
    connected = false
    for (const p of pending.values()) {
      clearT(p.timer)
      // 用普通对象而不是 Error：上层只关心"能不能发"，一个 Error 只会被 String() 成废话。
      p.reject({ ok: false, why: 'closed' })
    }
    pending.clear()
    if (ws !== null) {
      try { ws.close() } catch { /* 已经关了 */ }
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return
    const delay = RECONNECT_STEPS_MS[Math.min(attempt, RECONNECT_STEPS_MS.length - 1)]
    attempt += 1
    reconnectTimer = setT(() => {
      reconnectTimer = null
      connect()
    }, delay)
    // unref：进程要退出时别被这个定时器吊着（插件卸载后尤其明显）。
    reconnectTimer?.unref?.()
  }

  function connect() {
    if (stopped) return
    if (typeof WSImpl !== 'function') {
      lastError = '没有可用的 WebSocket（需要 Node 22+，或注入 WebSocketImpl）'
      warn(lastError)
      return
    }
    let ws
    try {
      ws = new WSImpl(buildUrl())
    } catch (error) {
      // 构造就抛基本只有一种原因：wsUrl 写错了（协议不支持 / 不是合法 URL）。
      // 这种情况重连一万次也没用，所以不排定时器，把原因留在 status().lastError 里。
      lastError = `wsUrl 无法连接：${errorText(error)}`
      warn(lastError)
      return
    }
    socket = ws

    ws.onopen = () => {
      if (socket !== ws) return
      connected = true
      attempt = 0
      lastError = ''
      since = now()
      info('已连上 OneBot，正在确认登录信息')
      // 不 await：start() 不等握手完成，连上后该干嘛是后台的事。
      void afterOpen()
    }

    ws.onmessage = (ev) => {
      if (socket !== ws) return
      const data = ev?.data
      let text = ''
      if (typeof data === 'string') text = data
      else if (data instanceof Uint8Array) text = new TextDecoder().decode(data)
      else return // 心跳二进制包之类，本渠道不认
      handleFrame(text)
    }

    ws.onerror = (ev) => {
      if (socket !== ws) return
      const detail = ev?.message ?? ev?.error?.message ?? ''
      lastError = detail === '' ? '连接出错（桥没开 / 端口不对 / token 不对）' : `连接出错：${detail}`
    }

    ws.onclose = (ev) => handleClose(ws, ev)
  }

  function handleClose(ws, ev) {
    if (socket !== ws) return
    const wasConnected = connected
    closeSocket()
    const code = ev?.code
    if (code === 1008 || code === 4001 || code === 403) {
      lastError = '访问令牌被拒绝（检查 config.channels.qq.token）'
    } else if (lastError === '') {
      lastError = `连接断开（${code ?? '?'}）`
    }
    if (wasConnected) warn(`和 OneBot 的连接断开（${code ?? '?'}），按阶梯重连`)
    scheduleReconnect()
  }

  async function afterOpen() {
    try {
      const data = await call('get_login_info')
      if (data !== null && typeof data === 'object') {
        selfId = String(data.user_id ?? selfId)
        nickname = String(data.nickname ?? '')
      }
      info(`已确认在线：${nickname || '?'} / ${selfId || '?'}`)
    } catch (error) {
      // 桥能连上但 get_login_info 失败：有些实现要等登录完成才认这个 action。
      // 只记一笔、不断开——断开反而丢掉已经连上的事件流。
      warn(`get_login_info 失败：${errorText(error)}`)
    }
  }

  function handleFrame(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return } // 非 JSON 的噪声直接丢
    if (msg === null || typeof msg !== 'object') return

    if (msg.echo !== undefined) {
      const key = String(msg.echo)
      const p = pending.get(key)
      if (p === undefined) return // 超时之后才回来的响应，没人等了
      pending.delete(key)
      clearT(p.timer)
      // OneBot 11 各实现的成功标志不统一：有的 status==='ok'，有的只给 retcode===0。
      if (msg.status === 'ok' || msg.retcode === 0) p.resolve(msg.data ?? null)
      else {
        const why = msg.wording || msg.message || msg.msg || 'onebot_error'
        p.reject({ ok: false, why: scrub(String(why)).slice(0, 120), retcode: msg.retcode ?? null })
      }
      return
    }

    if (msg.post_type === 'meta_event') {
      // 有的实现先推 meta_event 再回 get_login_info；先记下 self_id，@ 判断不用等。
      if (selfId === '' && msg.self_id !== undefined) selfId = String(msg.self_id)
      return
    }

    if (msg.post_type !== 'message') return // notice / request 不归渠道管
    const item = normalizeMessage(msg)
    if (item === null) return

    received += 1
    // 回调里出错不能把整条连接带崩，也不能让后面的人收不到这条消息。
    for (const fn of [...listeners]) {
      try { fn(item) } catch (error) { warn(`onMessage 回调出错：${errorText(error)}`) }
    }
  }

  function normalizeMessage(msg) {
    const kind = msg.message_type === 'group' ? 'group' : msg.message_type === 'private' ? 'dm' : null
    if (kind === null) return null // 频道 / 临时会话等，本渠道不管

    const self = String(msg.self_id ?? selfId ?? '')
    const userId = String(msg.user_id ?? msg.sender?.user_id ?? '')
    if (userId === '') return null
    // 自己发的消息也会以 message 事件回推；不挡掉她会看见"自己说的话"被当成别人说的。
    if (self !== '' && userId === self) return null

    const messageId = String(msg.message_id ?? '')
    if (messageId !== '' && seen.has(messageId)) return null // 重连后桥补推的历史

    const groupId = kind === 'group' ? String(msg.group_id ?? '') : ''
    if (kind === 'group' && groupId === '') return null

    const sender = msg.sender !== null && typeof msg.sender === 'object' ? msg.sender : {}
    // 群名片才是群里"这个人"的名字；私聊没有名片，用昵称。
    const card = String(sender.card ?? '').trim()
    const nick = String(sender.nickname ?? msg.nickname ?? '').trim()
    const personName = kind === 'group' ? card || nick : nick || card

    const body = readBody(msg, self)

    if (messageId !== '') {
      seen.set(messageId, true)
      // Map 保持插入序 = 最早的那条先走，不用自己维护链表。
      if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value)
    }

    const seconds = Number(msg.time)
    return {
      channelId: 'qq',
      kind,
      conversationId: kind === 'group' ? groupId : userId,
      conversationName: kind === 'group' ? card || nick : nick,
      personId: `u_${userId}`,
      personName,
      text: body.text,
      images: body.images,
      mentionedSelf: body.mentionedSelf === true,
      at: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : now(),
      raw: msg, // 只给排查用，不许进提示词（README 的规范化消息注释）
    }
  }

  function readBody(msg, self) {
    const parts = []
    const images = []
    // 2026-11-03：群里只在她被 @ 时开口（见 gate.js 的 mentionOnly）。
    // @ 她的段既不进正文（模型不需要看到「@鱼」），又要留下「叫过她」这件事。
    const flags = { mentionedSelf: false }
    const segments = msg.message

    if (Array.isArray(segments)) {
      for (const seg of segments) {
        if (seg === null || typeof seg !== 'object') continue
        const data = seg.data !== null && typeof seg.data === 'object' ? seg.data : {}
        if (seg.type === 'text') {
          parts.push(String(data.text ?? ''))
        } else if (seg.type === 'at') {
          const qq = String(data.qq ?? '')
          // @她本人：正文里不出现（模型不需要看到"@鱼"）；@别人保留成 @名字，免得
          // "你们俩"这种话失去指代。self 为空（还没拿到登录信息）时保守地按别人处理。
          if (self !== '' && qq === self) { flags.mentionedSelf = true; continue }
          if (qq === 'all') parts.push('@全体成员 ')
          else if (qq !== '') parts.push(`@${String(data.name ?? '').trim() || qq} `)
        } else if (seg.type === 'image') {
          // 只有图/表情的消息 text 会是空串，但这条消息仍然要上报（见文件头）。
          const url = data.url || data.file
          if (url) images.push(String(url))
        }
        // 其它段（face / record / video / reply…）这里不展开成【表情】这类标注：
        // 那是 router/gate 的措辞，渠道只保证"话和图"到场。
      }
    } else if (typeof segments === 'string' && segments !== '') {
      // post_format=string：整条是 CQ 码字符串。
      parts.push(readCqString(segments, self, images, flags))
    } else if (typeof msg.raw_message === 'string' && msg.raw_message !== '') {
      // 极少数实现只给 raw_message。
      parts.push(readCqString(msg.raw_message, self, images, flags))
    }

    return { text: finalizeText(parts.join('')), images: images.slice(0, IMAGE_MAX), mentionedSelf: flags.mentionedSelf === true }
  }

  function readCqString(raw, self, images, flags = {}) {
    let out = String(raw)
    out = out.replace(/\[CQ:at,([^\]]*)\]/g, (_whole, params) => {
      const p = parseCqParams(params)
      const qq = String(p.qq ?? '')
      if (qq === 'all') return '@全体成员 '
      if (self !== '' && qq === self) { flags.mentionedSelf = true; return '' }
      return qq === '' ? '' : `@${qq} `
    })
    out = out.replace(/\[CQ:image,([^\]]*)\]/g, (_whole, params) => {
      const p = parseCqParams(params)
      const url = p.url || p.file
      if (url) images.push(String(url))
      return ''
    })
    // 剩下的 CQ 码（face / mface / record / reply…）在纯文本模式下没有可读形态，
    // 整段删掉，免得把 `[CQ:face,id=1]` 这种机器码递进上下文。
    out = out.replace(/\[CQ:[^\]]*\]/g, '')
    return unescapeCq(out)
  }

  function parseCqParams(raw) {
    const out = {}
    for (const pair of String(raw ?? '').split(',')) {
      const at = pair.indexOf('=')
      if (at > 0) out[pair.slice(0, at)] = pair.slice(at + 1)
    }
    return out
  }

  function unescapeCq(text) {
    return String(text)
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .replace(/&#44;/g, ',')
      .replace(/&amp;/g, '&')
  }

  function finalizeText(raw) {
    // 外来文本必须过 guard：她是"根本没看见"那句试图改她人格的话，而不是看见了被劝住。
    const { text } = sanitizeForeign(raw)
    return String(text ?? '').trim()
  }

  function call(action, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const ws = socket
      if (ws === null || !connected) { reject({ ok: false, why: 'offline' }); return }
      const echo = `qq-${now().toString(36)}-${++seq}`
      const timer = setT(() => {
        pending.delete(echo)
        // 超时不是"没发出去"：桥可能已经在发，只是没来得及回话。所以只报超时，
        // 调用方（send）不许重试——重试就是让对方收两遍。
        reject({ ok: false, why: 'timeout' })
      }, timeoutMs)
      timer?.unref?.()
      pending.set(echo, { resolve, reject, timer })
      try {
        ws.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        clearT(timer)
        pending.delete(echo)
        reject({ ok: false, why: `发送失败：${errorText(error)}` })
      }
    })
  }

  function splitText(text) {
    // 按"字符"切而不是按 UTF-16 长度切：Array.from 才不会把 emoji 劈成两个半截。
    const chars = Array.from(text)
    if (chars.length <= SEND_CHUNK_MAX) return [text]
    const chunks = []
    for (let i = 0; i < chars.length; i += SEND_CHUNK_MAX) {
      chunks.push(chars.slice(i, i + SEND_CHUNK_MAX).join(''))
    }
    return chunks
  }

  function asNumericId(id) {
    // OneBot 的 group_id/user_id 是数字；但有的桥传字符串。纯数字才转，
    // 免得 Number('abc') 变 NaN，被 JSON 序列化成 null 发出去。
    return /^\d{1,15}$/.test(id) ? Number(id) : id
  }

  async function send({ conversation, text } = {}) {
    try {
      const kind = conversation?.kind === 'group' ? 'group' : conversation?.kind === 'dm' ? 'dm' : null
      if (kind === null) return { ok: false, why: 'bad_target' }
      const target = String(conversation?.id ?? '').trim()
      if (target === '') return { ok: false, why: 'bad_target' }
      const body = String(text ?? '').trim()
      // 空消息 OneBot 本身会拒，不如直接说清楚；这也防止 router 误把空串交下来。
      if (body === '') return { ok: false, why: 'empty' }
      if (!connected) return { ok: false, why: 'offline' }

      const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
      const targetField = kind === 'group' ? 'group_id' : 'user_id'
      const targetId = asNumericId(target)
      let lastId = ''

      for (const chunk of splitText(body)) {
        // 逐段串行发：并发发对方观感是乱的，失败时也说不清发到第几段。
        // 用消息段数组而不是裸字符串：NapCat/Lagrange/SnowLuma 都按 array 走，
        // 字符串模式的老实现也认 array（OneBot 11 两种都允许）。
        const data = await call(action, {
          [targetField]: targetId,
          message: [{ type: 'text', data: { text: chunk } }],
        })
        lastId = String(data?.message_id ?? lastId)
      }

      sent += 1
      return { ok: true, id: lastId }
    } catch (error) {
      // 超时 / 被禁言 / 桥报错在 call 里已经归一成 {ok:false, why}，这里只保证不抛。
      const out = { ok: false, why: errorText(error) || 'send_failed' }
      if (error && typeof error === 'object' && error.retcode !== undefined) out.retcode = error.retcode
      return out
    }
  }

  function onMessage(fn) {
    if (typeof fn !== 'function') return () => {}
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }

  function start() {
    try {
      // 配置里明确关掉的渠道不连：调用方就算一刀切 start() 也不会偷偷上线。
      if (config.enabled === false) return { ok: false, why: 'disabled' }
      // 已经在跑（或正在等重连）不建第二条连接，否则一条消息会被上报两遍。
      if (socket !== null || reconnectTimer !== null) return { ok: true }
      stopped = false
      attempt = 0
      connect()
      if (socket !== null) return { ok: true }
      return { ok: false, why: lastError || 'connect_failed' }
    } catch (error) {
      lastError = `启动失败：${errorText(error)}`
      warn(lastError)
      return { ok: false, why: lastError }
    }
  }

  function stop() {
    try {
      stopped = true // 先立旗：onclose 里就不会再排重连
      if (reconnectTimer !== null) {
        clearT(reconnectTimer)
        reconnectTimer = null
      }
      closeSocket()
    } catch { /* 关不掉也不能抛给调用方 */ }
  }

  function status() {
    // 这里一个配置值都不能带出去：README 规则 3 盯的就是这个（token 就在 config 里）。
    return {
      ok: connected,
      connected,
      since: since || 0,
      lastError,
      queued: pending.size,
      sent,
      received,
    }
  }

  return { name: 'qq', start, stop, send, onMessage, status }
}
