/**
 * bili.js —— B站私信渠道适配器（只把私信搬进来 / 把她的话送出去）。
 *
 * 边界（写最前面，免得以后越界）：
 *   - 这里**只管私信**：收 = 轮询私信会话；发 = web_im/send_msg。
 *   - 评论、动态、@、刷站、字幕、弹幕都不在这里——那些在 lib/platforms/bili.js（只读客户端）
 *     与 lib/platforms/speak.js（说话/评论）里。私信登录态不该顺手拿去评论，评论也不该借私信的口。
 *   - 不判断「该不该回」：那是 router/gate 的事。这里只判断「技术上能不能发」。
 *   - 不读写 events.jsonl，不拼提示词，不碰配置。适配器只有两个方向：进、出。
 *
 * 复用 lib/platforms/bili.js 的东西（不另起一套）：
 *   normalizeCookie    —— cookie 可能是 cookies.txt / "a=1; b=2" 两种写法，解析只该有一份；
 *   inCooldown/cooldownLeft —— 风控按账号/IP 算、不按接口算，写冷却必须和评论/点赞共用一份状态；
 *   mixinKey/signQuery —— send_msg 要 wbi 签名，混淆表只该有一张。
 *
 * 为什么不用 createClient：它的 apiPost 只认 api.bilibili.com 的路径，而私信在
 * api.vc.bilibili.com；为了蹭那 40 行请求给客户端加第二套 host 不值得。所以请求自己写，
 * 但 cookie 解析与节流一定走上面那几个导出——重复实现这两样才会真出事。
 */
import { randomUUID } from 'node:crypto'

import { normalizeCookie, inCooldown, cooldownLeft, mixinKey, signQuery } from '../platforms/bili/client.js'
import { sanitizeForeign } from '../core/guard.js'
import { readOwner } from '../core/store.js'

/** 网页端接口的 host。私信（msgfeed / send_msg）全在 vc 上。 */
const API = 'https://api.bilibili.com'
const VC = 'https://api.vc.bilibili.com'
const MESSAGE_REFERER = 'https://message.bilibili.com/'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 默认 8 秒：比网页端（20 秒）勤一点，又不至于每分钟几十个请求。测试会注入更小的值。 */
const DEFAULT_INTERVAL_MS = 8000
/** B站私信单条上限 500 字。超了必须切段，不能截断——截断等于替她少说半句话。 */
const TEXT_MAX = 500
/** 去重表上限。私信量不大，500 条足够覆盖「重启前最近几轮」，再多就是白占内存。 */
const SEEN_MAX = 500
/** 首轮只看最近 10 分钟的会话建基线：再往前翻就是回溯历史，用户明确不要。 */
const BASELINE_WINDOW_MS = 10 * 60_000
/** 请求超时。风控时接口会挂住，不设上限会把整条轮询链卡死。 */
const REQUEST_TIMEOUT_MS = 12_000
/** 昵称缓存：名片接口一个人只该查一次，失败了也记一天，别每 8 秒重试一次。 */
const NAME_TTL_MS = 24 * 3600_000
/**
 * 本地写冷却。lib/platforms/bili.js 的 noteRisk 没导出（那是给评论/点赞用的内部函数），
 * 所以私信拿不到「往共享冷却里记一笔」的入口，只能自己镜像一个。
 * 共享的 inCooldown 仍然先查：别的写操作被风控时，私信也必须停。
 */
const LOCAL_RISK_MS = 5 * 60_000
/** 连发两段之间的间隔，防「一条长回复被拆成五条刷屏」。测试传 0 跑快。 */
const DEFAULT_SEND_GAP_MS = 300

/** 风控码。B站没文档，这三个是实测里最常出现的（-352 请求被拒 / -412 拦截 / -509 频控）。 */
const RISK_CODES = new Set([-352, -412, -509])

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

/** query 串：空值直接丢掉，别让 `begin_seqno=`、`undefined` 发到线上。 */
function qs(params = {}) {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    sp.set(k, String(v))
  }
  return sp.toString()
}

function stemOf(url) {
  const s = String(url ?? '')
  return s.slice(s.lastIndexOf('/') + 1, s.lastIndexOf('.'))
}

function csrfOf(cookie) {
  const m = /(?:^|;\s*)bili_jct=([^;]*)/.exec(String(cookie ?? ''))
  return m ? decodeURIComponent(m[1]) : ''
}

function dedeOf(cookie) {
  const m = /(?:^|;\s*)DedeUserID=(\d+)/.exec(String(cookie ?? ''))
  return m ? m[1] : ''
}

/**
 * 大整数先转字符串再 JSON.parse。
 * 为什么：msg_key / msg_seqno 是 uint64，JS 的 number 只有 53 位精度，
 * 直接 parse 会悄悄改掉末几位——拿去当游标或去重键就会错位，表现为「同一条私信回两遍」。
 */
function parseImJson(text) {
  const safe = String(text ?? '').replace(
    /("(?:msg_key|msg_seqno|sender_uid|receiver_id|talker_id|session_ts|ack_seqno|max_seqno|ack_ts|top_ts)"\s*:\s*)(\d{16,})/g,
    '$1"$2"'
  )
  return JSON.parse(safe)
}

/** content 在私信里是一段 JSON 字符串（偶尔已经是对象）。解不开就当空对象，不抛。 */
function parseContent(raw) {
  if (raw && typeof raw === 'object') return raw
  try {
    return JSON.parse(String(raw ?? '')) || {}
  } catch {
    return {}
  }
}

export function create(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : (...args) => globalThis.fetch(...args)
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const readOwnerImpl = typeof opts.readOwnerImpl === 'function' ? opts.readOwnerImpl : readOwner
  const intervalMs = Number.isFinite(Number(opts.intervalMs)) && Number(opts.intervalMs) > 0
    ? Number(opts.intervalMs)
    : DEFAULT_INTERVAL_MS
  const sendGapMs = Number.isFinite(Number(opts.sendGapMs)) && Number(opts.sendGapMs) >= 0
    ? Number(opts.sendGapMs)
    : DEFAULT_SEND_GAP_MS

  let cookie = ''
  let cookieResolved = false
  let selfUid = ''
  let selfName = ''
  let mk = ''
  let wbiTriedAt = 0
  let devId = ''
  let connected = false
  let since = 0
  let lastError = ''
  let timer = null
  let polling = false
  let baselined = false
  let sessionTs = 0 // 微秒，new_sessions 的 begin_ts
  let received = 0
  let sent = 0
  let inflight = 0
  let localWriteUntil = 0

  /** 会话游标：conversationId → 已处理到的 msg_seqno。 */
  const cursors = new Map()
  /** 消息去重：`talker:msg_key` → 1。上限 SEEN_MAX，超了丢最老的。 */
  const seen = new Map()
  /** 昵称：talker → {name, at}。拿不到也记空串，省得对同一个人反复查。 */
  const names = new Map()
  const listeners = new Set()

  function remember(key) {
    seen.set(key, 1)
    while (seen.size > SEEN_MAX) {
      const oldest = seen.keys().next().value
      seen.delete(oldest)
    }
  }

  function ensureDevId() {
    // send_msg 要求发端带一个 dev_id；网页端每次登录会生成，这里一个适配器生命周期内固定即可。
    if (!devId) devId = randomUUID().toUpperCase()
    return devId
  }

  /**
   * 拿 cookie。显式传 `opts.cookie`（哪怕空串）就以它为准——测试要能确定地构造
   * 「没 cookie」的场景，不能因为本机恰好存过 owner.json 就变成有登录。
   */
  async function ensureCookie() {
    if (cookieResolved) return cookie
    cookieResolved = true
    if (opts.cookie !== undefined) {
      cookie = normalizeCookie(opts.cookie)
      return cookie
    }
    try {
      const owner = await readOwnerImpl()
      cookie = normalizeCookie(owner?.cookie)
    } catch {
      // owner.json 读不到/读坏了都等于没登录，启动阶段不该因此抛异常。
      cookie = ''
    }
    return cookie
  }

  async function requestJson(url, { method = 'GET', form, referer = MESSAGE_REFERER } = {}) {
    const headers = {
      'user-agent': UA,
      referer,
      accept: 'application/json, text/plain, */*',
    }
    if (cookie) headers.cookie = cookie
    const init = { method, headers }
    if (form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      init.body = new URLSearchParams(form).toString()
    }
    // 超时用 AbortController 而不是 AbortSignal.timeout：后者在部分运行时不会随请求结束清掉。
    const ctl = typeof AbortController === 'function' ? new AbortController() : null
    const timeout = ctl ? setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS) : null
    timeout?.unref?.()
    if (ctl) init.signal = ctl.signal
    let res
    let text = ''
    try {
      res = await fetchImpl(url, init)
      // 读 body 也算请求的一部分：只给 headers 设超时、body 挂住照样能把轮询卡死。
      if (res && typeof res.text === 'function') text = await res.text()
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    if (!text && res && typeof res.json === 'function') return await res.json()
    return parseImJson(text)
  }

  /** nav：登录态 + wbi 密钥。expired cookie 也会回 code 0（isLogin:false），所以两样都要看。 */
  async function navOnce() {
    const json = await requestJson(`${API}/x/web-interface/nav`, { referer: 'https://www.bilibili.com/' })
    const img = String(json?.data?.wbi_img?.img_url ?? '')
    const sub = String(json?.data?.wbi_img?.sub_url ?? '')
    if (img && sub) mk = mixinKey(stemOf(img), stemOf(sub))
    // start 之外还可能因为补 wbi 密钥走到这里：顺手把 uid 也补上，
    // 免得「没 start 就直接 send」时明明登录着却报 no uid。
    const mid = String(json?.data?.mid ?? '')
    if (mid !== '' && selfUid === '') selfUid = mid
    return json
  }

  /**
   * send_msg 要 wbi 签名。正常路径 start() 已经从 nav 拿到密钥；只有「没 start 直接 send」
   * 或 nav 恰好没给 wbi_img 时才补一次，失败也不挡发送（让服务端返回真实错误，而不是本地瞎猜）。
   */
  async function ensureWbi() {
    if (mk !== '') return true
    if (now() - wbiTriedAt < 10 * 60_000) return false
    wbiTriedAt = now()
    try {
      await navOnce()
    } catch (error) {
      log('warn', `[bili] 取 wbi 密钥失败（不影响已签名的会话）：${String(error instanceof Error ? error.message : error)}`)
    }
    return mk !== ''
  }

  function emit(msg) {
    received++
    for (const fn of [...listeners]) {
      try {
        const ret = fn(msg)
        if (ret && typeof ret.then === 'function') ret.catch((error) => log('warn', `[bili] onMessage 处理失败：${String(error instanceof Error ? error.message : error)}`))
      } catch (error) {
        // 一个监听器炸了不能连带别的监听器，也不能把轮询弄停。
        log('warn', `[bili] onMessage 抛异常：${String(error instanceof Error ? error.message : error)}`)
      }
    }
  }

  /**
   * 对方昵称。私信的会话/消息报文里**都不带**昵称（只有 uid），所以要露名字就得查一次名片。
   * 为什么值得多打一个请求：只剩一串 mid 的入站消息对「谁在跟我说话」几乎没有帮助；
   * 但名字只是展示用的，查不到（未登录可见性、风控、网络）必须回空串，不能挡住消息本身。
   */
  async function personNameOf(talker, session) {
    const inline = String(session?.talker_name ?? session?.nickname ?? '').trim()
    if (inline) return inline
    const hit = names.get(talker)
    if (hit !== undefined && now() - hit.at < NAME_TTL_MS) return hit.name
    let name = ''
    try {
      const json = await requestJson(`${API}/x/web-interface/card?${qs({ mid: talker })}`, {
        referer: `https://space.bilibili.com/${talker}`,
      })
      if (Number(json?.code) === 0) name = String(json?.data?.card?.name ?? '').trim()
    } catch {
      // 拿不到就空串。名字不值得让一条私信丢掉。
    }
    names.set(talker, { name, at: now() })
    while (names.size > SEEN_MAX) names.delete(names.keys().next().value)
    return name
  }

  /** 一条私信 → 契约里的入站消息。非真人可读内容（撤回/系统/红包等）返回 null。 */
  async function normalizeIncoming(m, talker, session) {
    const type = Number(m?.msg_type ?? 0)
    const content = parseContent(m?.content)
    const images = []
    let rawText = ''
    if (type === 1) {
      rawText = String(content.content ?? '')
    } else if (type === 2) {
      // 纯图片：text 留空（契约里空串就是「只有图」），url 进 images。
      if (content.url) images.push(String(content.url))
    } else if (type === 6) {
      // 表情包也走图床，和图片一样处理。
      if (content.url) images.push(String(content.url))
    } else if (type === 7) {
      // 分享卡片：只留标题，够她判断「对方发了什么」，不要替对方脑补内容。
      const title = String(content.title ?? content.headline ?? '').slice(0, 60)
      rawText = title ? `【分享：${title}】` : '【分享】'
    } else {
      return null
    }
    if (Array.isArray(content.pictures)) {
      for (const pic of content.pictures) {
        const url = String(pic?.url ?? pic ?? '')
        if (url) images.push(url)
      }
    }
    // 进站文本一律过 guard：她该「没看见」冒充系统消息的那几行，而不是被劝住。
    const text = sanitizeForeign(rawText).text.trim()
    if (text === '' && images.length === 0) return null
    const name = await personNameOf(talker, session)
    const at = Number(m?.timestamp) > 0 ? Number(m.timestamp) * 1000 : now()
    return {
      channelId: 'bili',
      kind: 'dm',
      conversationId: talker,
      conversationName: name,
      personId: `u_${talker}`,
      personName: name,
      text,
      images,
      at,
      raw: m,
    }
  }

  async function pollConversation(session, talker, baseline) {
    let cursor = cursors.get(talker)
    if (cursor === undefined) {
      // 不是首轮才出现的会话：用对方已读位当起点，避免把这个人以前的历史一口气倒出来。
      cursor = baseline ? 0 : Number(session?.ack_seqno ?? 0) || 0
    }
    const lastSeq = Number(session?.last_msg?.msg_seqno ?? session?.max_seqno ?? 0) || 0
    if (baseline && lastSeq > 0) {
      // 首轮连正文都不用拉：会话上的 last_msg.msg_seqno 就是「现在最新一条」。
      // 少数返回不带 last_msg，才退回拉一页、只取最大 seqno 当基线。
      cursors.set(talker, lastSeq)
      return true
    }
    // 不做「last_seq <= cursor 就跳过」：会话列表本身已经按 begin_ts 筛过，
    // 而 last_msg 万一没跟着更新（服务端延迟、代理缓存），跳过就等于永久漏消息。
    const url = `${VC}/svr_sync/v1/svr_sync/fetch_session_msgs?${qs({
      talker_id: talker,
      session_type: 1,
      size: 20,
      begin_seqno: cursor,
      build: 0,
      mobi_app: 'web',
    })}`
    const json = await requestJson(url)
    if (Number(json?.code) !== 0) {
      lastError = `fetch_session_msgs ${json?.code ?? '?'}`
      return false
    }
    const msgs = (Array.isArray(json?.data?.messages) ? json.data.messages : [])
      .slice()
      .sort((a, b) => (Number(a?.msg_seqno) || 0) - (Number(b?.msg_seqno) || 0))
    let maxSeq = cursor
    for (const m of msgs) {
      const seq = Number(m?.msg_seqno ?? 0) || 0
      if (seq > maxSeq) maxSeq = seq
      if (baseline) {
        // 首轮的每一条都只是「基线」，记下 id 但不报。
        remember(`${talker}:${String(m?.msg_key ?? '') || String(seq) || String(m?.timestamp ?? '')}`)
        continue
      }
      if (seq <= cursor) continue
      if (m?.msg_status !== undefined && Number(m.msg_status) !== 0) continue
      if (String(m?.sender_uid ?? '') !== talker) continue
      const key = `${talker}:${String(m?.msg_key ?? '') || String(seq) || String(m?.timestamp ?? '')}`
      if (seen.has(key)) continue
      remember(key)
      const msg = await normalizeIncoming(m, talker, session)
      if (msg) emit(msg)
    }
    // 基线时也要把游标推到最新：否则下一轮会把「基线那条」当成新消息报出来。
    cursors.set(talker, Math.max(cursor, maxSeq, baseline ? lastSeq : 0))
    return true
  }

  /**
   * 轮询一次：new_sessions 找有新消息的会话 → 每个会话按游标取新消息。
   * 首轮（baselined === false）只建基线、一条都不报：
   *   刚接上渠道时，会话里躺着的可能是几天前的对话。把它们当「新消息」喂给她，
   *   等于一开机就被塞一嘴历史，还会让她以为对方刚刚才说话。宁可漏掉接入前的那条，
   *   也不要凭空造一轮对话——漏的那条对方会再问。
   */
  async function pollOnce() {
    if (!connected || polling) return
    await ensureCookie()
    if (!cookie) return
    if (inCooldown('read', now())) return
    polling = true
    try {
      const baseline = !baselined
      const begin = baseline || sessionTs === 0
        ? Math.max(0, (now() - BASELINE_WINDOW_MS) * 1000)
        : sessionTs
      const json = await requestJson(`${VC}/session_svr/v1/session_svr/new_sessions?${qs({
        begin_ts: begin,
        build: 0,
        mobi_app: 'web',
      })}`)
      if (Number(json?.code) !== 0) {
        lastError = `new_sessions ${json?.code ?? '?'}`
        return
      }
      const list = Array.isArray(json?.data?.session_list) ? json.data.session_list : []
      // 按会话时间升序处理：她读到的时间线才和真实发生顺序一致。
      const sessions = list.slice().sort((a, b) => (Number(a?.session_ts) || 0) - (Number(b?.session_ts) || 0))
      let maxTs = sessionTs
      let allOk = true
      for (const s of sessions) {
        const ts = Number(s?.session_ts ?? 0) || 0
        if (ts > maxTs) maxTs = ts
        if (Number(s?.session_type ?? 1) !== 1) continue // 0 是系统会话，不是人
        if (Number(s?.system_msg_type ?? 0) !== 0) continue // 关注/点赞/系统提示之类
        const talker = String(s?.talker_id ?? '')
        if (talker === '' || talker === selfUid) continue
        // 别用 && 短路：即使前一个会话失败，后面的也要照常处理。
        const ok = await pollConversation(s, talker, baseline)
        if (!ok) allOk = false
      }
      sessionTs = maxTs
      baselined = true
      // 单个会话的失败已经写进 lastError 了，不能被这一轮别的成功抹掉。
      if (allOk) lastError = ''
    } catch (error) {
      // 轮询失败只记，不下线：下一轮还要接着试。
      lastError = String(error instanceof Error ? error.message : error).slice(0, 200)
    } finally {
      polling = false
    }
  }

  async function start() {
    try {
      if (timer !== null && connected) return { ok: true }
      await ensureCookie()
      if (!cookie) {
        lastError = 'no cookie'
        return { ok: false, why: 'no cookie' }
      }
      const nav = await navOnce()
      if (Number(nav?.code) !== 0) {
        // 未登录时 nav 回 -101；这里不能当成「连上了」。
        lastError = `nav ${nav?.code ?? '?'}${nav?.message ? ` ${nav.message}` : ''}`
        return { ok: false, why: lastError }
      }
      const data = nav?.data ?? {}
      // 过期 cookie 的真实表现是 code 0 + isLogin false（不是 -101），必须单独挡一次。
      if (data.isLogin === false) {
        lastError = 'not logged in'
        return { ok: false, why: 'not logged in' }
      }
      selfUid = String(data.mid ?? '') || dedeOf(cookie)
      selfName = String(data.uname ?? '')
      if (selfUid === '') {
        lastError = 'no uid'
        return { ok: false, why: 'no uid' }
      }
      ensureDevId()
      connected = true
      since = now()
      lastError = ''
      // 先同步建一次基线，再开定时器：这样「首轮不回溯」是确定的，而不是取决于 8 秒后谁先醒。
      await pollOnce()
      timer = setInterval(() => { void pollOnce() }, intervalMs)
      timer.unref?.()
      return { ok: true }
    } catch (error) {
      lastError = String(error instanceof Error ? error.message : error).slice(0, 200)
      return { ok: false, why: lastError }
    }
  }

  async function stop() {
    try {
      connected = false
      if (timer !== null) clearInterval(timer)
      timer = null
    } catch {
      // 停不下来也不能抛，调用方可能正在退出流程里。
    }
  }

  /**
   * 发一条私信。conversation 可以是契约对象（{kind,id,name}），也容忍直接给 uid 字符串。
   * 返回 {ok:true,id}（id 是最后一段的 msg_key）或 {ok:false,why}。
   */
  async function send(input = {}) {
    inflight++
    try {
      const conv = input?.conversation
      const rawId = typeof conv === 'string' ? conv : conv?.id
      const receiver = String(rawId ?? '').trim().replace(/^u_/, '')
      if (receiver === '') return { ok: false, why: 'bad conversation' }
      const text = String(input?.text ?? '').trim()
      if (text === '') return { ok: false, why: 'empty text' }

      // 冷却先查：命中了就不发请求。风控是按账号算的，硬发只会把冷却越拖越长。
      if (inCooldown('write', now())) {
        return { ok: false, why: `cooldown ${Math.ceil(cooldownLeft('write', now()) / 1000)}s` }
      }
      if (now() < localWriteUntil) {
        return { ok: false, why: `cooldown ${Math.ceil((localWriteUntil - now()) / 1000)}s` }
      }

      await ensureCookie()
      if (!cookie) return { ok: false, why: 'no cookie' }
      const csrf = csrfOf(cookie)
      if (csrf === '') return { ok: false, why: 'no csrf (bili_jct)' }
      if (selfUid === '') selfUid = dedeOf(cookie)
      // 先补 wbi 密钥：这一步会打 nav，也能把 cookie 里的 uid 补齐。
      await ensureWbi()
      if (selfUid === '') return { ok: false, why: 'no uid' }
      const chunks = splitText(text, TEXT_MAX)
      let lastId = ''
      for (let i = 0; i < chunks.length; i++) {
        const json = await sendOne(receiver, chunks[i], csrf)
        if (Number(json?.code) !== 0) {
          if (RISK_CODES.has(Number(json?.code))) localWriteUntil = now() + LOCAL_RISK_MS
          const code = Number(json?.code)
          lastError = `send_msg ${Number.isFinite(code) ? code : '?'}${json?.message ? ` ${json.message}` : ''}`
          // 前面几段已经发出去了：不重试，避免同一句话被对方看到两遍。
          return { ok: false, why: lastError }
        }
        sent++
        const id = String(json?.data?.msg_key ?? json?.data?.msg_key_str ?? '')
        if (id !== '') lastId = id
        lastError = ''
        if (i < chunks.length - 1 && sendGapMs > 0) await sleep(sendGapMs)
      }
      return { ok: true, id: lastId }
    } catch (error) {
      lastError = String(error instanceof Error ? error.message : error).slice(0, 200)
      return { ok: false, why: lastError }
    } finally {
      inflight--
    }
  }

  async function sendOne(receiver, chunk, csrf) {
    const ts = Math.floor(now() / 1000)
    const wbiParams = { w_sender_uid: selfUid, w_receiver_id: receiver, w_dev_id: ensureDevId() }
    // 有密钥就签名；没有也照发（服务端会给出真实原因，比本地拦下来好排查）。
    const query = mk !== '' ? signQuery(wbiParams, mk, ts) : qs(wbiParams)
    const url = `${VC}/web_im/v1/web_im/send_msg?${query}`
    return await requestJson(url, {
      method: 'POST',
      referer: MESSAGE_REFERER,
      form: {
        'msg[sender_uid]': selfUid,
        'msg[receiver_id]': receiver,
        'msg[receiver_type]': 1,
        'msg[msg_type]': 1,
        'msg[msg_status]': 0,
        'msg[dev_id]': ensureDevId(),
        'msg[timestamp]': ts,
        'msg[new_face_version]': 1,
        'msg[content]': JSON.stringify({ content: chunk }),
        csrf_token: csrf,
        csrf,
        build: 0,
        mobi_app: 'web',
      },
    })
  }

  function onMessage(fn) {
    if (typeof fn !== 'function') return () => {}
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  /** 只报「连没连上、发了多少、收了多少」。cookie / token / wbi 一律不出现。 */
  function status() {
    return {
      ok: connected,
      connected,
      since,
      lastError,
      queued: inflight,
      sent,
      received,
    }
  }

  return {
    name: 'bili',
    start,
    stop,
    send,
    onMessage,
    status,
    // 测试用：轮询是定时器驱动的，单测不能等 8 秒，必须能手动推一轮。
    _poll: pollOnce,
    _debug: () => ({ hasTimer: timer !== null, selfUid, selfName, baselined, intervalMs, cursors: new Map(cursors) }),
  }
}

/** 按 Unicode 码点切段：不能按 UTF-16 下标切，否则 emoji 会被劈成两个乱码。 */
export function splitText(text, max = TEXT_MAX) {
  const chars = Array.from(String(text ?? ''))
  if (chars.length <= max) return [String(text ?? '')]
  const out = []
  for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max).join(''))
  return out
}
