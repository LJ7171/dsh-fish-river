/**
 * dsh-fish-river-douyin —— 抖音渠道（可选装子包）
 *
 * 为什么单开一个包：主包承诺「零依赖、装完就能跑」。抖音做不到——
 * 它要一个**真的** Chromium、要一个能扫码登录的桌面窗口、要这台机器上
 * 装着 Edge 或 Chrome。把这种东西塞进主包，等于让「只想在 DSH 里陪她」
 * 的人也为它付安装代价。所以：主包只认 `dsh-fish-river-douyin` 这个包名，
 * 装了才 import 得到（见 dsh-fish-river/lib/channels/host.js 的 loadAdapter）。
 *
 * 已知的脆点（写在这里，免得下次有人以为它和 QQ 一样稳）：
 *   1. 抖音的 DOM 会变。所有选择器集中在 SELECTORS，一处改、全局生效；
 *   2. 它是「浏览器自动化」，不是官方协议。账号有被风控的真实可能；
 *   3. 只在有图形会话的 Windows / macOS 上工作（Linux 服务器要自己接 Xvfb）。
 *
 * 设计上仍然遵守主包的三条纪律：
 *   · 永不抛（start/stop/send/status 全部 catch，失败用 {ok:false,why} 说话）；
 *   · 凭据不进 status、不进日志（这个包根本不读 cookie，它靠用户在这个浏览器里登录）；
 *   · 模块加载不连网、不启动进程（只有 start() 才拉浏览器）。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** 抖音网页版的私信页。改版之后先改这里。 */
export const CHAT_URL = 'https://www.douyin.com/chat'

/**
 * 一处改、全局生效的选择器。**这些值没有在真机上校准过**——
 * 第一次接通时按浏览器里的实际结构改这一块，别去改下面的逻辑。
 */
export const SELECTORS = {
  // 2026-11-02 真机校准（Edge + 已登录的抖音网页版）：
  // 会话列表在 `[data-e2e="im-dialog"]` 里，每一项是 `[data-e2e="conversation-item"]`；
  // 消息气泡的类名是 `messageMessageBox*`（哈希后的 CSS Module），文字不在气泡节点上，
  // 只能从 `im-dialog` 的 innerText 里按行读。所以下面的 message* 选择器只用于定位容器。
  conversationList: '[data-e2e="im-dialog"]',
  conversationItem: '[data-e2e="conversation-item"]',
  conversationName: '[class*="nickname"], [class*="name"]',
  conversationId: '[data-id], [data-conversation-id]',
  unreadBadge: '[class*="unread"], [class*="badge"]',
  messageList: '[class*="messageMessageListlist"]',
  messageItem: '[class*="messageMessageBox"]',
  messageText: '[class*="text"], [class*="content"]',
  // 2026-11-02 真机：真正的输入框是 `div.zone-container.editor-kit-container.messageEditor*`，
  // 它的 contenteditable 不一定是字面量 "true"，所以只按属性名匹配，再兜住 textarea。
  input: '[contenteditable], .messageEditor, textarea',
  sendButton: '[data-e2e="chat-send"], button[class*="send"]',
}

const DEFAULTS = {
  intervalMs: 6000,
  openWaitMs: 900,
  maxPerPoll: 20,
  maxLen: 900,
  debugPort: 9333,
  profileDir: '',
  browserPath: '',
}

/** 常见安装位置。找不到就让人在设置里填 browserPath。 */
export function browserCandidates(platform = process.platform) {
  if (platform === 'win32') {
    const base = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
    return base
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
}

export async function findBrowser(explicit = '', platform = process.platform) {
  if (explicit) {
    try {
      await fs.access(explicit)
      return explicit
    } catch {
      return ''
    }
  }
  for (const p of browserCandidates(platform)) {
    try {
      await fs.access(p)
      return p
    } catch { /* 下一个 */ }
  }
  return ''
}

/** 按码点切段，避免把 emoji 劈成两半。 */
export function splitText(text, max = DEFAULTS.maxLen) {
  const s = String(text ?? '')
  if (!s) return []
  const out = []
  let cur = ''
  for (const ch of s) {
    if (cur.length + ch.length > max) {
      out.push(cur)
      cur = ''
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 把抓取结果里的一条消息规范化成主包约定的形状。
 * 和 QQ / B站 同一套字段，路由层不需要知道它是从哪来的。
 */
export function normalizeMessage(raw, { conversation = {}, selfId = '', now = Date.now() } = {}) {
  const text = String(raw?.text ?? '').trim()
  const at = Number(raw?.at ?? 0) || now
  const mine = raw?.mine === true || (selfId && String(raw?.senderId ?? '') === String(selfId))
  return {
    channelId: 'douyin',
    kind: conversation.kind === 'group' ? 'group' : 'dm',
    conversationId: String(conversation.id ?? ''),
    conversationName: String(conversation.name ?? ''),
    personId: `u_${String(raw?.senderId ?? conversation.id ?? '')}`,
    personName: String(raw?.senderName ?? conversation.name ?? ''),
    text,
    images: [],
    at,
    mine,
    raw,
  }
}

/** 抓取脚本：在页面里跑，回一个 JSON 字符串。选择器从这里注入。 */
export function scrapeScript() {
  const S = SELECTORS
  return `(() => {
    const S = ${JSON.stringify(S)}
    const qa = (root, sel) => { try { return Array.from(root.querySelectorAll(sel)) } catch { return [] } }
    const items = qa(document, S.conversationItem)
    const convos = items.slice(0, 40).map((el) => {
      const lines = (el.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean)
      const badge = el.querySelector(S.unreadBadge)
      return {
        // 抖音不给你稳定的会话 id，用昵称当 id：同一个人改名会当成新会话，这是可接受的代价。
        id: lines[0] || '',
        name: lines[0] || '',
        unread: badge ? (badge.textContent || '').trim() : '',
        preview: lines.slice(2).join(' ').slice(0, 80),
      }
    }).filter((c) => c.id)
    return JSON.stringify({ ok: true, url: location.href, convos })
  })()`
}

/**
 * 读当前会话的消息（2026-11-02 真机校准后的写法）。
 *
 * 抖音网页版的每条消息是一个 `messageMessageBox*` 容器，但正文不在这些节点上
 * （React 用了虚拟化 + 分层容器，`innerText` 在气泡上是空的），只有整个
 * `[data-e2e="im-dialog"]` 的 innerText 里才有可读的「昵称 / 时间 / 正文」三行一组。
 * 所以这里按行切、丢掉系统提示，交给上层按「说过的最近 N 句」去重。
 */
export function readScript() {
  const S = SELECTORS
  return `(() => {
    const S = ${JSON.stringify(S)}
    const box = document.querySelector('[data-e2e="im-dialog"]')
    if (!box) return JSON.stringify({ ok: false, why: 'no-dialog' })
    const junk = /^(消息|可在|去设置|我们已互相关注|你们已互相关注|打个招呼|开启读屏标签|读屏标签)/
    const time = /^(\\d+\\s*(分钟|小时|天)前|昨天|刚刚|\\d{1,2}:\\d{2})$/
    const lines = (box.innerText || '')
      .split('\\n')
      .map((s) => s.trim())
      .filter((s) => s && !junk.test(s) && !time.test(s) && s !== '​')
    return JSON.stringify({ ok: true, lines: lines.slice(-60) })
  })()`
}

/** 打开某个会话。抖音没有稳定的「跳转 URL」，只能点列表项。 */
export function openScript(conversationId, name) {
  const S = SELECTORS
  return `(() => {
    const S = ${JSON.stringify(S)}
    const want = ${JSON.stringify(String(conversationId ?? ''))}
    const wantName = ${JSON.stringify(String(name ?? ''))}
    const qa = (root, sel) => { try { return Array.from(root.querySelectorAll(sel)) } catch { return [] } }
    const items = qa(document, S.conversationItem)
    const hit = items.find((el) => {
      const idEl = el.querySelector(S.conversationId)
      const id = idEl ? (idEl.getAttribute('data-id') || idEl.getAttribute('data-conversation-id') || '') : ''
      if (want && id === want) return true
      if (wantName && (el.textContent || '').includes(wantName)) return true
      return false
    })
    if (!hit) return JSON.stringify({ ok: false, why: 'conversation-not-found' })
    hit.click()
    return JSON.stringify({ ok: true })
  })()`
}

/** 发送：写入输入框 + 点发送。用 InputEvent 而不是直接改 textContent，React 才认。 */
export function sendScript(text) {
  const S = SELECTORS
  return `(() => {
    const S = ${JSON.stringify(S)}
    const text = ${JSON.stringify(String(text ?? ''))}
    const q = (root, sel) => { try { return root.querySelector(sel) } catch { return null } }
    const input = q(document, S.input)
    if (!input) return JSON.stringify({ ok: false, why: 'no-input' })
    input.focus()
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      input.textContent = text
      input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: text, inputType: 'insertText' }))
    }
    const btn = q(document, S.sendButton)
    if (btn) { btn.click(); return JSON.stringify({ ok: true, via: 'button' }) }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
    return JSON.stringify({ ok: true, via: 'enter' })
  })()`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 从抖音 IM 的 protobuf 帧里把「谁、说了什么」抠出来（2026-11-02 真机验证）。
 *
 * 为什么不写完整的 proto 解码：抖音的 `frontier-im` 帧字段值里，字符串是**裸 UTF-8**
 * （`compress=gzip` 只影响握手参数，不影响帧体）。真机抓到的一帧长这样：
 *   `小满` · `私信了你` · `这条是测试`
 * 也就是说文本原样躺在字节流里，用「扫中文串 + 认 `私信了你` 这个标记」就够收消息了。
 * 代价：只认这种「X 私信了你 Y」的推送；表情包、图片、撤回这些不是这种形状，会漏。
 * 要更全就得按 proto 定义写解码器——那是另一个量级的工作，先不做。
 */
export function parseDmFrame(payloadData) {
  let txt = ''
  try {
    txt = Buffer.from(String(payloadData ?? ''), 'base64').toString('utf8')
  } catch {
    return null
  }
  if (!txt || !txt.includes('私信了你')) return null
  const MARK = '私信了你'
  const at = txt.indexOf(MARK)
  const before = txt.slice(Math.max(0, at - 40), at)
  const after = txt.slice(at + MARK.length, at + MARK.length + 300)
  // 标记前后都可能夹着 protobuf 的控制字节，所以两边都按「最近的一段可读文本」取，不要求紧贴。
  const hits = before.match(/[\u4e00-\u9fa5]{2,20}/g) || []
  const sender = (hits.length ? hits[hits.length - 1] : '').trim()
  const text = ((after.match(/[\u4e00-\u9fa5A-Za-z0-9][\u4e00-\u9fa5A-Za-z0-9，。！？、：；…\-_ ]{0,200}/) || [''])[0] || '')
    .replace(/["'\s]+$/g, '')
    .trim()
  if (!sender || !text) return null
  return { sender, text }
}

/**
 * 刷抖音：推荐页（2026-11-02，用户 m03490 要求「刷抖音视频和刷 B 站一个地位」）。
 *
 * 和私信走同一套浏览器与同一次登录，但目的不同：私信是别人找她，刷视频是她自己去看。
 * 读到的只在素材里出现，不落到事件流——和她说过的话一样，最后长成什么由 `capture.js` 决定。
 */
export const FEED_URL = 'https://www.douyin.com/'

/** 推荐页的卡片与字段。同样没有在真机校准过：第一次接通时改这里，别改逻辑。 */
export const FEED_SELECTORS = {
  item: '[data-e2e="feed-item"], li[data-e2e="scroll-item"], div[class*="video-card"]',
  title: '[data-e2e="video-desc"], [class*="desc"], [class*="title"]',
  author: '[data-e2e="video-author"], [class*="author"], [class*="nickname"]',
  like: '[data-e2e="video-like"], [class*="like"]',
}

/** 从当前页面里抠出推荐流：标题、作者、点赞、链接。返回 JSON 字符串。 */
export function feedScript(limit = 8) {
  return `(() => {
    const S = ${JSON.stringify(FEED_SELECTORS)}
    const lim = ${JSON.stringify(Math.max(1, Math.min(20, Number(limit) || 8)))}
    const q = (root, sel) => { try { return root.querySelector(sel) } catch { return null } }
    const nodes = Array.from(document.querySelectorAll(S.item)).slice(0, lim)
    const items = []
    for (const el of nodes) {
      const a = el.querySelector('a[href*="/video/"]') || (el.closest && el.closest('a[href*="/video/"]'))
      const href = a ? String(a.getAttribute('href') || '') : ''
      const m = href.match(/\\/video\\/(\\d+)/)
      if (!m) continue
      const title = (q(el, S.title)?.textContent || '').trim()
      const author = (q(el, S.author)?.textContent || '').trim()
      const like = (q(el, S.like)?.textContent || '').trim()
      items.push({ id: m[1], href: href.startsWith('http') ? href : 'https://www.douyin.com' + href, title: title.slice(0, 120), author: author.slice(0, 40), like })
    }
    return JSON.stringify({ items })
  })()`
}

/**
 * 拉一批推荐视频。永不抛：拿不到就是 `{ ok:false, why }`，让她照常醒。
 * @param {{transport:object, limit?:number, waitMs?:number, sleep?:Function}} o
 */
export async function browseFeed({ transport, limit = 6, waitMs = 1800, sleep: sleeper } = {}) {
  const nap = typeof sleeper === 'function' ? sleeper : sleep
  if (!transport || typeof transport.evaluate !== 'function') return { ok: false, why: 'no-transport', items: [] }
  try {
    if (typeof transport.navigate === 'function') await transport.navigate(FEED_URL)
    await nap(waitMs)
    const r = await transport.evaluate(feedScript(limit))
    if (!r?.ok) return { ok: false, why: r?.why ?? 'eval-failed', items: [] }
    let parsed = r.value
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed) } catch { return { ok: false, why: 'bad-json', items: [] } }
    }
    const items = Array.isArray(parsed?.items) ? parsed.items.slice(0, limit) : []
    return { ok: true, items }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err), items: [] }
  }
}

/**
 * CDP 传输层。单拆出来是为了测试时可以整个换掉——
 * 渠道逻辑（去重、切段、退避）不该依赖「这台机器上有没有浏览器」。
 */
export function createCdpTransport(opts = {}) {
  let child = null
  let ws = null
  let nextId = 1
  const pending = new Map()
  const watchers = new Set()
  let targetUrl = ''

  const port = Number(opts.debugPort ?? DEFAULTS.debugPort)
  const profileDir = opts.profileDir || path.join(os.tmpdir(), 'dsh-fish-river-douyin-profile')

  async function waitForDevtools(timeoutMs = 15000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (r.ok) return true
      } catch { /* 还没起来 */ }
      await sleep(300)
    }
    return false
  }

  async function pageTarget() {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      return page ?? null
    } catch {
      return null
    }
  }

  function connect(url) {
    return new Promise((resolve, reject) => {
      let sock
      try {
        sock = new WebSocket(url)
      } catch (err) {
        reject(err)
        return
      }
      sock.addEventListener('open', () => {
        ws = sock
        resolve(true)
      })
      sock.addEventListener('error', () => reject(new Error('cdp-connect-failed')))
      sock.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(String(ev.data)) } catch { return }
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message ?? 'cdp-error'))
          else p.resolve(msg.result)
          return
        }
        if (msg.method) {
          for (const fn of watchers) {
            try { fn(msg.method, msg.params) } catch { /* 监听器自己的错不许影响连接 */ }
          }
        }
      })
      sock.addEventListener('close', () => {
        ws = null
        for (const [, p] of pending) p.reject(new Error('cdp-closed'))
        pending.clear()
      })
    })
  }

  function send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!ws) return reject(new Error('cdp-not-connected'))
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('cdp-timeout'))
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  return {
    async launch() {
      const exe = await findBrowser(opts.browserPath, opts.platform)
      if (!exe) return { ok: false, why: '没找到 Edge 或 Chrome；请在插件设置里填 browserPath' }
      try {
        await fs.mkdir(profileDir, { recursive: true })
        child = spawn(exe, [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          'about:blank',
        ], { detached: false, stdio: 'ignore', windowsHide: false })
        child.unref?.()
      } catch (err) {
        return { ok: false, why: `拉不起来浏览器：${String(err?.message ?? err).slice(0, 120)}` }
      }
      const up = await waitForDevtools()
      if (!up) return { ok: false, why: '浏览器起来了，但调试端口没开（可能被别的实例占用）' }
      const page = await pageTarget()
      if (!page) return { ok: false, why: '没有可用的页面目标' }
      targetUrl = page.webSocketDebuggerUrl
      try {
        await connect(targetUrl)
        await send('Page.enable')
        await send('Runtime.enable')
      } catch (err) {
        return { ok: false, why: `连不上调试通道：${String(err?.message ?? err).slice(0, 120)}` }
      }
      return { ok: true }
    },

    // 2026-11-02：主包 `lib/douyinbrowse.js` 调的是 `transport.start()`，
    // 而这里原来只导出 `launch()`——第一次真机跑抖音就死在 `cdp-not-connected` 上
    // （`start` 不存在 → 浏览器根本没被拉起来 → 第一条 CDP 命令就没连接）。
    // 两个名字都留着：`launch` 是内部语义，`start` 是对外的统一接口。
    async start() {
      return this.launch()
    },

    async navigate(url) {
      try {
        await send('Page.navigate', { url })
        return { ok: true }
      } catch (err) {
        return { ok: false, why: String(err?.message ?? err) }
      }
    },

    /**
     * 把窗口提到前台（2026-11-02 真机）。
     *
     * 复用一个已经在跑的 Edge profile 时，新开的窗口经常在后台，
     * `document.visibilityState` 是 `hidden`——抖音的会话列表这时全是 0×0 的盒子，
     * 点哪都点不到。点之前先 bringToFront，一切才正常。
     */
    async bringToFront() {
      try {
        await send('Page.bringToFront')
        return { ok: true }
      } catch (err) {
        return { ok: false, why: String(err?.message ?? err) }
      }
    },

    /** 订阅 CDP 事件（目前只用于抓 WebSocket 帧）。返回取消函数。 */
    onEvent(fn) {
      watchers.add(fn)
      return () => watchers.delete(fn)
    },

    /** 打开网络事件：抖音私信是服务器推的 protobuf 帧，只能从这里拿。 */
    async enableNetwork() {
      try {
        await send('Network.enable', { maxTotalBufferSize: 50000000 })
        return { ok: true }
      } catch (err) {
        return { ok: false, why: String(err?.message ?? err) }
      }
    },

    async evaluate(expression, opts = {}) {
      try {
        // awaitPromise 默认关：老的调用点都是同步表达式。要读 fetch 的结果必须显式开。
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: Boolean(opts?.awaitPromise) })
        if (r?.exceptionDetails) return { ok: false, why: 'page-script-error', raw: r }
        return { ok: true, value: r?.result?.value }
      } catch (err) {
        return { ok: false, why: String(err?.message ?? err) }
      }
    },

    /**
     * 真实鼠标点击（2026-11-02）。
     *
     * 抖音私信列表上 `el.click()` 是**没反应**的：它那套组件只认真实指针事件，
     * 合成 click 被吞掉，会话永远打不开。这里走 CDP 的 `Input.dispatchMouseEvent`，
     * 浏览器内部看起来就是一次真正的左键按下与抬起。
     */
    async clickPoint(x, y) {
      try {
        const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y })
        await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
        await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
        return { ok: true }
      } catch (err) {
        return { ok: false, why: String(err?.message ?? err) }
      }
    },

    /** 选中一个元素、点它中心。找不到就回 `{ok:false}`，永不抛。 */
    async clickSelector(selector) {
      const r = await this.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(String(selector))})
        if (!el) return JSON.stringify({ ok: false, why: 'not-found' })
        el.scrollIntoView({ block: 'center' })
        const b = el.getBoundingClientRect()
        if (!b.width || !b.height) return JSON.stringify({ ok: false, why: 'no-box' })
        return JSON.stringify({ ok: true, x: b.x + b.width / 2, y: b.y + b.height / 2 })
      })()`)
      if (!r.ok) return r
      let box
      try { box = JSON.parse(r.value) } catch { return { ok: false, why: 'bad-rect' } }
      if (!box.ok) return box
      return this.clickPoint(box.x, box.y)
    },

    /** 往当前焦点里打字（`Input.insertText` 走的是输入法那种路径，React 认）。 */
    async typeText(text) {
      try {
        await send('Input.insertText', { text: String(text ?? '') })
        return { ok: true }
      } catch (err) {
        return { ok: false, why: String(err?.message ?? err) }
      }
    },

    /** 回车：抖音的发送在输入法里就是一次 Enter。 */
    async pressEnter() {
      try {
        const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
        return { ok: true }
      } catch (err) {
        return { ok: false, why: String(err?.message ?? err) }
      }
    },

    /** 点第 n 个匹配项（会话列表里没有稳定 id，只能按位置点）。 */
    async clickNth(selector, index = 0) {
      const r = await this.evaluate(`(() => {
        const list = Array.from(document.querySelectorAll(${JSON.stringify(String(selector))}))
        const el = list[${Number(index) || 0}]
        if (!el) return JSON.stringify({ ok: false, why: 'not-found' })
        el.scrollIntoView({ block: 'center' })
        const b = el.getBoundingClientRect()
        if (!b.width || !b.height) return JSON.stringify({ ok: false, why: 'no-box' })
        return JSON.stringify({ ok: true, total: list.length, x: b.x + b.width / 2, y: b.y + b.height / 2 })
      })()`)
      if (!r.ok) return r
      let box
      try { box = JSON.parse(r.value) } catch { return { ok: false, why: 'bad-rect' } }
      if (!box.ok) return box
      const clicked = await this.clickPoint(box.x, box.y)
      return { ...clicked, total: box.total }
    },

    async close() {
      try { ws?.close() } catch { /* ignore */ }
      try { child?.kill() } catch { /* ignore */ }
      ws = null
      child = null
    },
  }
}

export function create(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const transport = opts.transport ?? createCdpTransport(opts)
  // 能抓帧的传输层（真机）就走帧；测试里塞进来的假传输层没有这两个方法，退回读 DOM。
  const canFrames = typeof transport.enableNetwork === 'function' && typeof transport.onEvent === 'function'
  const preferFrames = opts.preferFrames ?? canFrames
  const listeners = new Set()
  const seen = new Map() // id -> 时间戳，上限 500
  let connected = false
  let since = 0
  let lastError = ''
  let timer = null
  let running = false
  let primed = false
  let sent = 0
  let received = 0
  let stopFrameWatcher = null
  let selfId = String(opts.selfId ?? '')
  let lastLookup = []

  const log = (m) => { try { cfg.log?.(m) } catch { /* ignore */ } }

  function remember(id) {
    if (!id) return false
    if (seen.has(id)) return true
    seen.set(id, Date.now())
    if (seen.size > 500) {
      const oldest = [...seen.entries()].sort((a, b) => a[1] - b[1])[0]
      if (oldest) seen.delete(oldest[0])
    }
    return false
  }

  function emit(msg) {
    for (const fn of listeners) {
      try { fn(msg) } catch (err) { log(`listener failed: ${String(err?.message ?? err)}`) }
    }
  }

  // 自己发出去的话会在同一屏里再出现一次（读的是整个会话的 innerText），
  // 60 秒内按文本挡掉，否则她会一直回自己。
  const SENT_TTL_MS = 60000
  const sentRecent = new Map()
  function markSent(text) {
    sentRecent.set(String(text ?? '').slice(0, 80), Date.now())
    for (const [k, t] of sentRecent) if (Date.now() - t > SENT_TTL_MS) sentRecent.delete(k)
  }
  function recentlySent(text) {
    const k = String(text ?? '').slice(0, 80)
    const at = sentRecent.get(k)
    if (!at) return false
    if (Date.now() - at > SENT_TTL_MS) { sentRecent.delete(k); return false }
    return true
  }

  /** 轮询一个返回布尔值的页面表达式，直到真或超时。 */
  async function waitFor(expr, ms = 3000, step = 300) {
    const until = Date.now() + ms
    for (;;) {
      const r = await transport.evaluate(`(() => String(${expr}))()`)
      if (r?.ok && String(r.value) === 'true') return true
      if (Date.now() >= until) return false
      await sleep(step)
    }
  }

  // 2026-11-02 真机：面板关着时 `im-dialog` 还在 DOM 里，只是盒子是 0×0。
  // 所以「开着」不能看有没有这个节点，要看它有没有尺寸。
  const HAS_DLG = `(() => { const d = document.querySelector('[data-e2e="im-dialog"]'); if (!d) return false; const b = d.getBoundingClientRect(); return b.width > 100 && b.height > 100 })()`
  const HAS_ITEM = `(() => [...document.querySelectorAll('[data-e2e="conversation-item"]')].some((e) => { const b = e.getBoundingClientRect(); return b.width > 40 && b.height > 16 }))()`
  const HAS_INPUT = `(() => [...document.querySelectorAll('[contenteditable], .messageEditor, textarea')].some((e) => { const b = e.getBoundingClientRect(); return b.width > 20 && b.height > 5 }))()`

  /**
   * 私信面板被关掉/刷新过就重新点开。
   * 2026-11-02 真机：`im-entry` 是开关，面板已经开着时再点一次会把它关掉——
   * 所以先看 `im-dialog` 在不在，在就什么都不做；点开之后要等列表真的渲染出来。
   */
  async function ensurePanel() {
    if (await waitFor(HAS_DLG, 800, 200)) return true
    const opened = await transport.clickSelector('[data-e2e="im-entry"]')
    if (!opened?.ok) return false
    return waitFor(HAS_ITEM, 4000, 300)
  }

  async function convoIndex(id, name) {
    // 2026-11-02 真机：面板会被页面自己收起来（导航/超时），这时抓到的列表是空的，
    // 直接判「找不到会话」就会把一条已经生成好的话丢掉。所以抓不到就点开面板、等渲染、再抓，
    // 最多三轮；名字匹配也放宽到「包含」——innerText 里昵称后面常粘着「刚刚」「在吗」这类残余。
    const want = String(id ?? name ?? '')
    const look = String(name ?? '')
    lastLookup = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const r = await transport.evaluate(scrapeScript())
      if (r?.ok) {
        try {
          const parsed = JSON.parse(String(r.value ?? '{}'))
          const list = Array.isArray(parsed.convos) ? parsed.convos : []
          lastLookup.push({ attempt, n: list.length, names: list.map((c) => c.name).slice(0, 4), want, look })
          const exact = list.findIndex((c) => c.id === want || c.name === want || c.name === look)
          if (exact >= 0) return exact
          const loose = list.findIndex((c) => look && c.name && (c.name.includes(look) || look.includes(c.name)))
          if (loose >= 0) return loose
        } catch (e) { lastLookup.push({ attempt, parse: String(e?.message ?? e).slice(0, 60) }) }
      } else {
        lastLookup.push({ attempt, err: String(r?.why ?? 'evaluate-failed').slice(0, 80) })
      }
      if (attempt < 2) {
        await ensurePanel()
        await sleep(700)
      }
    }
    return -1
  }

  /**
   * 打开某个人 dm 的会话（2026-11-02 真机反复踩坑后重写）。
   *
   * 之前是「先查 index，再 clickNth」，但抖音的会话列表在面板刚展开时是动画里的，
   * 查到的那一项在点到它之前就可能被重新挂载——`no-box`/`not-found` 都是这么来的。
   * 现在改成：拿到坐标的同一刻就点，点不成就等面板稳定再试，最多五轮。
   */
  async function openConvoByName(name, indexHint = 0) {
    const look = String(name ?? '')
    let last = { ok: false, why: 'open-failed' }
    for (let i = 0; i < 5; i += 1) {
      if (!(await waitFor(HAS_DLG, 600, 200))) {
        await transport.clickSelector('[data-e2e="im-entry"]')
        await waitFor(HAS_ITEM, 3000, 250)
      }
      const pick = await transport.evaluate(`(() => {
        const list = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]'))
        const look = ${JSON.stringify(look)}
        const usable = list.filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 })
        const pool = usable.length ? usable : list
        if (!pool.length) return JSON.stringify({ ok: false, why: 'no-item' })
        const hit = look ? pool.find((e) => (e.innerText || '').includes(look)) : null
        const el = hit ?? pool[${Number(indexHint) || 0}] ?? pool[0]
        if (!el) return JSON.stringify({ ok: false, why: 'no-item' })
        el.scrollIntoView({ block: 'center' })
        const b = el.getBoundingClientRect()
        if (!b.width || !b.height) return JSON.stringify({ ok: false, why: 'no-box' })
        return JSON.stringify({ ok: true, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) })
      })()`)
      if (pick.ok) {
        let box = null
        try { box = JSON.parse(String(pick.value ?? '{}')) } catch { box = null }
        if (box?.ok) {
          await transport.clickPoint(box.x, box.y)
          if (await waitFor(HAS_INPUT, 2500, 250)) return { ok: true }
          last = { ok: false, why: 'not-opened' }
        } else {
          last = { ok: false, why: box?.why ?? 'no-box' }
        }
      } else {
        last = { ok: false, why: pick.why ?? 'evaluate-failed' }
      }
      await sleep(400)
    }
    return last
  }

  async function pollOnce() {
    if (!connected || running) return { ok: true, why: 'busy' }
    running = true
    try {
      const conv = await transport.evaluate(scrapeScript())
      if (!conv.ok) {
        lastError = conv.why ?? ''
        return conv
      }
      let parsed
      try { parsed = JSON.parse(String(conv.value ?? '{}')) } catch { return { ok: false, why: 'bad-json' } }
      const convos = Array.isArray(parsed.convos) ? parsed.convos : []
      let emitted = 0
      for (let i = 0; i < convos.length && emitted < cfg.maxPerPoll; i += 1) {
        const c = convos[i]
        const opened = await openConvo(c.id, c.name, i)
        if (!opened.ok) continue
        await sleep(cfg.openWaitMs)
        const read = await transport.evaluate(readScript())
        if (!read.ok) continue
        let got
        try { got = JSON.parse(String(read.value ?? '{}')) } catch { continue }
        const lines = Array.isArray(got.lines) ? got.lines : []
        if (cfg.preferFrames !== false && preferFrames) continue // 收消息以 protobuf 帧为准，DOM 只用来刷新会话列表
        // `im-dialog` 的 innerText 里同时含会话列表（昵称、预览），这两类是列表不是消息。
        const listNoise = new Set()
        for (const x of convos) {
          if (x.name) listNoise.add(x.name)
          if (x.preview) listNoise.add(x.preview)
        }
        for (const line of lines) {
          const text = String(line ?? '').trim()
          if (!text) continue
          if (listNoise.has(text)) continue
          const key = `${c.id}:${text.slice(0, 60)}`
          if (remember(key)) continue
          // 首轮只记基线、不发：接入之前的对话不是「刚收到」，报出去等于撒谎。
          if (!primed) continue
          // 自己刚发出去的那句会在同一屏里再出现一次，按文本 + 60 秒窗口挡掉。
          if (recentlySent(text)) continue
          const norm = normalizeMessage({ id: key, text, mine: false, at: Date.now() }, {
            conversation: { id: c.id, name: c.name, kind: 'dm' },
            selfId,
          })
          if (!norm.text) continue
          received += 1
          emitted += 1
          emit(norm)
        }
      }
      primed = true
      return { ok: true, count: emitted }
    } catch (err) {
      lastError = String(err?.message ?? err)
      return { ok: false, why: lastError }
    } finally {
      running = false
    }
  }

  return {
    name: 'douyin',

    async start() {
      try {
        const up = await transport.launch()
        if (!up?.ok) {
          lastError = up?.why ?? 'unknown'
          return { ok: false, why: lastError }
        }
        connected = true
        since = Date.now()
        // 2026-11-02：`/chat` 是个独立页，里面的会话点开之后没有 `im-dialog` 容器
        // （消息区是另一套布局）；只有首页右上角那个私信面板才是 `im-dialog`。
        // 所以真机固定走「首页 → 点 im-entry」这条路，别改成 /chat。
        // 落哪一页由用户定（推荐频道 / 精选 / 关注…）：抖音的频道是首页上的 tab，
        // 地址不同但都是同一个 DOM，`im-entry` 都在右上角。
        const home = String(cfg.homeUrl ?? '').trim()
        const target = home
          ? (/^https?:\/\//i.test(home) ? home : `https://${home}`)
          : (preferFrames ? 'https://www.douyin.com/jingxuan' : CHAT_URL)
        const nav = await transport.navigate(target)
        if (!nav?.ok) log(`navigate failed: ${nav?.why ?? ''}`)
        await transport.bringToFront?.()
        const bootWait = Number.isFinite(Number(cfg.bootWaitMs)) ? Number(cfg.bootWaitMs) : (preferFrames ? 5000 : 0)
        if (bootWait > 0) await sleep(bootWait)
        if (preferFrames) await ensurePanel()
        // 2026-11-02：私信从 CDP 的 WebSocket 帧里收（protobuf，见 `parseDmFrame`），
        // DOM 那边只负责会话列表与发送。
        let offFrames = null
        const net = await transport.enableNetwork?.()
        if (net?.ok) {
          offFrames = transport.onEvent?.((method, params) => {
            if (method !== 'Network.webSocketFrameReceived') return
            const dm = parseDmFrame(params?.response?.payloadData)
            if (!dm) return
            if (recentlySent(dm.text)) return
            received += 1
            emit(normalizeMessage({ id: `frame:${Date.now()}:${dm.text.slice(0, 24)}`, text: dm.text, mine: false, at: Date.now() }, {
              conversation: { id: dm.sender, name: dm.sender, kind: 'dm' },
              selfId,
            }))
          })
        } else {
          log(`enableNetwork failed: ${net?.why ?? ''}`)
        }
        stopFrameWatcher = () => { try { offFrames?.() } catch { /* ignore */ } }
        // 首轮不报：接入之前的历史不是「新消息」。宁可漏接入前那条，不要撒谎说刚收到。
        await pollOnce()
        timer = setInterval(() => { void pollOnce() }, Math.max(2000, Number(cfg.intervalMs) || 6000))
        timer.unref?.()
        return { ok: true }
      } catch (err) {
        lastError = String(err?.message ?? err)
        return { ok: false, why: lastError }
      }
    },

    async stop() {
      try { clearInterval(timer) } catch { /* ignore */ }
      timer = null
      connected = false
      try { stopFrameWatcher?.() } catch { /* ignore */ }
      stopFrameWatcher = null
      try { await transport.close?.() } catch { /* ignore */ }
    },

    onMessage(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    async send({ conversation = {}, text = '' } = {}) {
      try {
        if (!connected) return { ok: false, why: 'not-connected' }
        const body = String(text ?? '').trim()
        if (!body) return { ok: false, why: 'empty' }
        const target = String(conversation.id ?? conversation.name ?? '')
        if (!target) return { ok: false, why: 'bad_target' }
        // 窗口在后台时抖音的列表全是 0×0 的盒子，先提到前台再点。
        await transport.bringToFront?.()
        // 2026-11-02 真机：先查 index 再点，中间列表会被重新挂载（no-box）。
        // 现在一次拿坐标一次点，点完以「输入框出现」为准。
        const opened = await openConvoByName(conversation.name || conversation.id)
        if (!opened.ok) return { ok: false, why: `open-failed:${opened.why ?? ''}` }
        await sleep(cfg.openWaitMs)
        // 2026-11-02 真机：点开会话后消息区和输入框是异步渲染的，
        // 固定睡一会儿常常还没出来，所以等到输入框真出现再动手。
        if (!(await waitFor(HAS_INPUT, 4000, 300))) return { ok: false, why: 'no-input' }
        const parts = splitText(body, cfg.maxLen)
        for (const part of parts) {
          // 输入框是 contenteditable：先点它拿到焦点，再 insertText，最后回车。
          const focused = await transport.clickSelector(SELECTORS.input)
          if (!focused?.ok) return { ok: false, why: focused?.why ?? 'no-input' }
          const typed = await transport.typeText(part)
          if (!typed?.ok) return { ok: false, why: typed?.why ?? 'type-failed' }
          const sentKey = await transport.pressEnter()
          if (!sentKey?.ok) return { ok: false, why: sentKey?.why ?? 'send-failed' }
          markSent(part)
          sent += 1
          await sleep(600)
        }
        return { ok: true, id: `${Date.now()}` }
      } catch (err) {
        return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
      }
    },

    status() {
      return {
        ok: connected,
        connected,
        since,
        lastError,
        queued: 0,
        sent,
        received,
      }
    },

    // 测试用：不经过定时器直接走一轮
    _poll: pollOnce,
    _setSelfId(v) { selfId = String(v ?? '') },
    // 调试用：真机上「找不到会话」时用它看清 scrape 到底返回了什么
    _transport: transport,
    _convo: convoIndex,
    _scrape: () => transport.evaluate(scrapeScript()),
    _lookup: () => lastLookup,
  }
}

export default { create }
