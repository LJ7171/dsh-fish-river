/**
 * router.js —— 渠道消息的另一半：从「收到一句」到「她回了一句」
 *
 * 这条链路上有五步，每一步都可能出错，所以每一步都只做一件事：
 *
 *   收（适配器） → 记（事件流 + 流水） → 判（gate） → 问（叫醒她） → 发（适配器）
 *
 * 三个设计上必须守住的点：
 *
 * 1. **一次只问她一句。** 群里可能同时三个人说话。并发叫醒她，她会在同一个会话里
 *    同时开好几轮，回复互相串台，而且宿主的会话队列本来也是串行的。
 *    所以这里有一条进程内的队列：满了就丢新的（丢的那条已经在事件流里，她以后翻得到），
 *    不排队等——等下去只会越积越旧。
 *
 * 2. **空回合是合法的。** 她可以一句话不说。这不是失败，是她拒绝。
 *    调用方（观测台）看到的是 `{ sent:false, why:'silent' }`，不是错误。
 *
 * 3. **出门三道闸，顺序不能反。**
 *    先 `screenOutgoing`（凭据/路径/手机号），再 `looksLikePrivateLeak`（别人的私事），
 *    最后才交给渠道。反过来的话，被拦下的句子已经在对方手机上了。
 */

import { appendEvent, readEvents } from '../store.js'
import { sanitizeForeign, looksLikeRewriting, screenOutgoing } from '../guard.js'
import { buildIndex, looksLikePrivateLeak } from '../leakcheck.js'
import { knowledgeBlock } from '../worldbook.js'
import { bumpTurns, homeStatus, rotateTalkSession } from '../home.js'
import { refreshSelfDoc } from '../selfdoc.js'
import { beginExternalTurn, endExternalTurn } from '../extturn.js'
import { describeAweme, findDouyinLinks, lookDouyin } from '../dylink.js'
import { canReply, explain } from './gate.js'

/** 队列上限：超过就丢新的。已经在事件流里的东西，她以后翻得到。 */
export const QUEUE_MAX = 5
/** 等她一轮最多等多久。超时不发，也不重试——重试等于让她把同一句话说两遍。 */
export const TURN_TIMEOUT_MS = 120000
/** 拼进提示词的流水句数。 */
export const CONTEXT_LINES = 8
/** 社会层开闸后，最多带几条「外面见过的做法」进提示词。多了就成清单了。 */
export const SOCIAL_LINES = 5

const CHANNEL_LABEL = { qq: 'QQ', bili: 'B站', douyin: '抖音', dsh: '这边' }

/**
 * 从宿主的 `assistant/message` 里取她说出口的话。
 * 与 `turns.js` 的 `assistantText` 同源，但这里只留一段最薄的实现——
 * 两个模块各自演化时不会因为改一处而互相踩。
 */
function saidText(data) {
  const blocks = data?.message?.content ?? data?.content
  if (typeof blocks === 'string') return blocks.trim()
  if (!Array.isArray(blocks)) return typeof data?.text === 'string' ? data.text.trim() : ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim())
    .map((b) => b.text.trim())
    .join('\n')
    .trim()
}

/**
 * 拼她看到的那段话。
 *
 * 原则：只给**处境**，不给台词。
 *   ✅ 「QQ 群「XX」里，Lily 在说：……」
 *   ❌ 「你是一个 QQ 群里的猫娘，请回复……」
 * 前者是事实，后者是角色扮演——后者一出现，这个项目就变回普通的聊天机器人了。
 *
 * @param {object} msg 规范化后的消息
 * @param {Array<{role:string,text:string}>} lines 这个会话最近的流水
 * @param {{isOwner:boolean, impression?:string}} opts
 * @returns {string}
 */
export function buildPrompt(msg, lines = [], opts = {}) {
  const label = CHANNEL_LABEL[msg.channel] ?? msg.channel
  const where =
    msg.kind === 'group'
      ? `${label} 的群「${msg.conversationName || msg.conversationId}」`
      : `${label} 上，跟一个人单独说话`
  const who = String(msg.personName || '').trim() || '一个没写名字的人'
  const out = []

  out.push(
    opts.isOwner
      ? `（${where}。是他本人。）`
      : `（${where}。说话的是 ${who}。${opts.impression ? `你对他有印象：${opts.impression}` : '你对他没什么印象。'}）`,
  )

  const tail = lines.slice(-CONTEXT_LINES)
  if (tail.length) {
    out.push('')
    out.push('（前面几句：')
    for (const l of tail) out.push(`${l.role === 'her' ? '你' : who}：${l.text}`)
    out.push('）')
  }

  // 世界书（2026-11-02）：只加事实，不加要求。
  // 这一节来自 worldbook.json，是「你知道的事」，不是「你是谁」——后者只能长出来。
  const knowledge = knowledgeBlock(opts.knowledge)
  if (knowledge) out.push(knowledge)

  // 社会层（2026-11-02）：开闸之后，她在外面见过的做法也会出现在这里。
  // 写的是「见过的做法」，不是「你应该」——这一层永远不是命令，也不是身份。
  const social = Array.isArray(opts.social) ? opts.social.slice(-SOCIAL_LINES) : []
  if (social.length) {
    out.push('')
    out.push(`（在外面见过的做法：${social.map((b) => String(b?.text ?? b)).join('；')}）`)
  }

  // 她点开看过的东西（2026-11-03）：抖音链接解析出来的真实文案与数据。
  // 只写事实，不写「你应该评价一下」——评价不评价是她的事。
  const video = String(opts.video ?? '').trim()
  if (video) {
    out.push('')
    out.push(video)
  }

  out.push('')
  out.push(`${who}：${msg.text || (msg.images?.length ? '（只发了图，没写字）' : '（没有文字）')}`)
  out.push('')
  // 说的是「这里可以不说话」，不是「你要温柔一点」——前者是处境，后者是人格。
  out.push('（回不回、说几句，你自己定。不想接就什么都不用说。）')
  return out.join('\n')
}

/**
 * 建一个渠道路由器。
 *
 * @param {object} deps
 * @param {object} deps.ctx            宿主 ctx（要有 on 与 sessionController）
 * @param {string} deps.root           数据目录
 * @param {(...a:any[])=>void} [deps.log]
 * @param {object} deps.journal        createJournal 的返回值
 * @param {object} deps.people         createPeople 的返回值
 * @param {Map<string,object>} deps.adapters 渠道名 → 适配器
 * @param {()=>Promise<object>} deps.getConfig 现读配置（别缓存：用户改完要立刻生效）
 * @param {()=>Promise<{sessionId:string, stage:number}>} deps.getState 她住哪、第几阶段
 * @param {()=>Promise<Array<{text:string}>>} [deps.socialBeliefs] 社会层开闸后她在外面学到的做法
 */
export function createRouter(deps = {}) {
  const { ctx, root, journal, people, adapters, worldbook, socialBeliefs } = deps
  /**
   * 每个渠道上「他本人」的账号 id。渠道适配器只给原始 id，认不认得主人是这里的事。
   * 可以给对象（测试里固定一份），也可以给函数（宿主每来一条现读配置，
   * 用户在设置页填完就生效，不用重启）。
   */
  const ownerIdsOf = typeof deps.ownerIds === 'function'
    ? deps.ownerIds
    : async () => deps.ownerIds ?? {}
  const log = deps.log ?? (() => {})
  const getConfig = deps.getConfig ?? (async () => ({}))
  const getState = deps.getState ?? (async () => ({ sessionId: '', stage: 1 }))
  const now = deps.now ?? (() => Date.now())

  const queue = []
  let busy = false
  let stopped = false
  let offBus = null
  /** 正在等她的那一轮：{ sessionId, texts:[], sayIds:Set, done:Promise } */
  let pending = null
  /** 每个会话上一条回复的时间（冷却用）。 */
  const lastReplyAt = new Map()
  /** 私聊指纹索引：只在事件流变了之后重建一次。 */
  let leakIndex = null
  let leakIndexAt = 0

  async function stateOf() {
    try {
      const s = await getState()
      return { sessionId: String(s?.sessionId ?? ''), stage: Number(s?.stage) || 1 }
    } catch {
      return { sessionId: '', stage: 1 }
    }
  }

  async function indexOf(events) {
    // 事件流是追加式的：只要长度没变，索引就还能用。
    if (leakIndex && leakIndexAt === events.length) return leakIndex
    leakIndex = buildIndex(events)
    leakIndexAt = events.length
    return leakIndex
  }

  /** 记一条「她听见了」。这是系统侧写的，她自己写不出来。 */
  /**
   * 他的话里带了抖音链接？替她去看一眼。
   * 返回能拼进提示词的那一行；没链接、或没打开，返回空串。
   * 拿不到就照实写「没拉到」，绝不替那四个字编内容。
   */
  async function lookAtLinks(msg, text, isOwner) {
    const links = findDouyinLinks(text)
    if (!links.length) return ''
    // 借哪个浏览器：登录态在抖音那个渠道里，跟消息从哪个渠道来无关——
    // QQ 群里递来的抖音链接，也得用抖音那个已登录的浏览器去看。
    const pick = (n) => (typeof adapters?.get === 'function' ? adapters.get(n) : null)
    const adapter = typeof pick('douyin')?.api === 'function' ? pick('douyin') : pick(msg.channel)
    const api = typeof adapter?.api === 'function' ? (p) => adapter.api(p) : undefined
    const out = []
    for (const l of links) {
      const r = await lookDouyin(l.url, { api, root }).catch((err) => ({ ok: false, why: String(err?.message ?? err) }))
      if (!r?.ok) {
        log(`router · 抖音链接没打开（${l.url}）：${r?.why ?? '未知'}`)
        // 打不开也要让她知道「他递了一样东西过来，但我没打开」——
        // 装没看见，比说「打不开」更糟。
        out.push('（他递给你一条抖音链接，但这边的浏览器没打开它。别猜里面是什么。）')
        continue
      }
      // 画面抽到了也只是**存成一张图**，这一轮对话里没有图片通道——不能写「你看了三帧」，
      // 那是句假话，她说完就会被问「画面里是什么」，只能说不知道（2026-11-03 真机踩过：
      // 她以为没看到，还去拿 bili_watch 试了一次）。
      // 但图是存在的，她手上有 read_image：把路径给她，让她自己决定看不看、看完说什么。
      out.push(
        `（他递给你一条抖音：${describeAweme(r.item)}${r.frames?.ok
          ? `；画面截了三帧，存在 ${r.frames.path}——想看就自己用 read_image 读它，不想看也可以不看`
          : '；画面没拉到，只看到文字'}）`,
      )
      // 画面没拉到要留一行日志：她自己只会说「画面没进来」，运维得知道是没 ffmpeg、
      // 视频太大，还是 CDN 拒了（2026-11-03 真机就是不带 Referer 被 403）。
      if (!r.frames?.ok) log(`router · 抖音画面没拉到（${r.id}）：${r.frames?.why ?? '未知'}`)
      try {
        const { events } = await readEvents(root)
        const last = events[events.length - 1]
        await appendEvent(
          { type: 'meta', text: `looked:dy_${r.id}` },
          { day: Number(last?.day ?? 1) || 1, stage: Number(last?.stage ?? 1) || 1, source: 'system' },
          root,
        )
      } catch { /* 记账失败不影响这一轮 */ }
    }
    return out.join('\n')
  }

  async function recordHeard(msg, text, isOwner = false) {
    try {
      const { events } = await readEvents(root)
      const last = events[events.length - 1]
      await appendEvent(
        {
          type: 'heard',
          text: `${msg.personName || msg.personId}：${text}`,
          person: msg.personId,
          visibility: msg.kind === 'group' ? 'public' : 'private',
          channel: msg.channel,
          origin: isOwner ? 'owner' : 'guest',
          // 陌生人说的话一开始只能算「社会层」：它教她怎么处世，不定义她是谁。
          // 主人说的话是立宪层——同一个人在私信里说同一句话，分量不该看渠道。
          influence: isOwner ? 'constitution' : 'social',
        },
        { day: Number(last?.day ?? 1) || 1, stage: Number(last?.stage ?? 1) || 1, source: 'system' },
        root,
      )
    } catch (err) {
      log('router · 记 heard 失败', err?.message ?? err)
    }
  }

  /** 记一条她自己说出去的。 */
  async function recordSaid(msg, text, isOwner) {
    try {
      const { events } = await readEvents(root)
      const last = events[events.length - 1]
      await appendEvent(
        {
          type: 'utterance',
          text,
          person: msg.personId,
          visibility: msg.kind === 'group' ? 'public' : 'private',
          channel: msg.channel,
          origin: 'self',
          influence: isOwner ? 'constitution' : 'social',
        },
        { day: Number(last?.day ?? 1) || 1, stage: Number(last?.stage ?? 1) || 1, source: 'system' },
        root,
      )
    } catch (err) {
      log('router · 记 utterance 失败', err?.message ?? err)
    }
  }

  /**
   * 结账一轮（2026-11-03，真机撞上下文上限之后补的）。
   *
   * 渠道这边每回完一句就 bumpTurns；到 `chat.rotateAfter` 就换一间会话。
   * 为什么必须有：宿主那条会话是**共享**的——GUI 里说的、QQ 里说的、B 站私信里说的
   * 都堆在同一条上下文里，而宿主只在「新会话」时才清。以前只有 GUI 那条路结账，
   * 渠道一侧永远不涨 turns，于是一条会话可以攒到 47k token、把本地模型的 32k 撑爆。
   *
   * 边界：读配置失败、换会话失败都只记一行，不影响这句已经发出去的话。
   * @returns {Promise<{rotated:boolean, turns:number, after:number}>} 永不抛。
   */
  async function turnOver() {
    const cfg = await getConfig().catch(() => null)
    const after = Number(cfg?.config?.chat?.rotateAfter ?? cfg?.chat?.rotateAfter ?? 0) || 0
    const turns = await bumpTurns(root).catch(() => 0)
    if (!after || turns < after) return { rotated: false, turns, after }
    const st = await homeStatus(root).catch(() => null)
    const wsId = String(st?.wsId ?? '').trim()
    if (!wsId) return { rotated: false, turns, after }
    const r = await rotateTalkSession(ctx, { root, wsId, log }).catch(() => ({ ok: false }))
    if (!r?.ok) {
      log(`轮换没成（第 ${turns} 轮）：${r?.why ?? '未知'}`)
      return { rotated: false, turns, after, why: r?.why ?? '' }
    }
    try {
      const { events } = await readEvents(root)
      const last = events[events.length - 1]
      await appendEvent(
        { type: 'meta', text: `rotate:${new Date().toISOString()} ${r.sessionId}` },
        { day: Number(last?.day ?? 1) || 1, stage: Number(last?.stage ?? 1) || 1, source: 'system' },
        root,
      )
    } catch {
      /* 记账失败不影响换会话这件事本身 */
    }
    await refreshSelfDoc(root).catch(() => {})
    log(`会话攒到 ${turns} 轮，换了一间（${r.sessionId}）`)
    return { rotated: true, turns, after, sessionId: r.sessionId }
  }

  /**
   * 叫醒她，等她把这一轮说完。
   * @returns {Promise<{ok:boolean, text:string, why:string}>}
   */
  async function askHer(sessionId, prompt) {
    const sc = ctx?.get?.('sessionController') ?? ctx?.sessionController
    if (!sc?.prompt) return { ok: false, text: '', why: 'no-session-controller' }

    const reached = { sessionId, texts: [], sayIds: new Set() }
    pending = reached
    const done = new Promise((resolve) => {
      reached.resolve = resolve
      reached.timer = setTimeout(() => resolve('timeout'), TURN_TIMEOUT_MS)
      reached.timer.unref?.()
    })
    try {
      // signal 必须给：宿主 `prompt()` 第一句就 `signal.throwIfAborted()`（issue #1）。
      await sc
        .prompt(
          {
            requestId: `chan-${now()}-${Math.random().toString(36).slice(2, 8)}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: prompt }],
          },
          new AbortController().signal,
        )
        .catch((err) => {
          log('router · 叫醒失败', err?.message ?? err)
          reached.resolve('error')
        })
      const why = await done
      const text = reached.texts.join('\n').trim()
      if (why === 'timeout') return { ok: false, text, why: 'timeout' }
      if (why === 'error') return { ok: false, text, why: 'prompt-failed' }
      return { ok: true, text, why: '' }
    } finally {
      clearTimeout(reached.timer)
      if (pending === reached) pending = null
    }
  }

  /**
   * 这条消息是不是他本人发的。
   * 每个渠道可以配一个或多个 id（B站/抖音是 uid，QQ 是号），用逗号/顿号/分号/空格隔开。
   * 命中就返回那个 id，否则空串。只做字符串比较——不猜昵称、不看头像，
   * 认错一次就是把她对别人说的话当成对主人说的。
   */
  function ownIdOf(msg, owners) {
    const want = String(owners?.[String(msg.channel ?? '')] ?? '').trim()
    if (want === '') return ''
    const got = String(msg.personId ?? '')
    const ids = want.split(/[,，、;；\s]+/).filter(Boolean)
    for (const id of ids) {
      if (got === `u_${id}` || got === id) return id
    }
    return ''
  }

  /** 处理一条进来的消息。 */
  async function handleOne(msg) {
    const raw = String(msg.text ?? '').trim()
    const images = Array.isArray(msg.images) ? msg.images.slice(0, 4) : []
    if (!raw && !images.length) return { sent: false, why: 'empty' }

    // 想改她的人：这句话她**根本没见过**。不是劝她别听，是不递。
    if (raw && looksLikeRewriting(raw).hit) {
      log(`router · 拦下一条重塑尝试（${msg.channel}/${msg.personId}）`)
      return { sent: false, why: 'rewrite-blocked' }
    }
    const clean = raw ? sanitizeForeign(raw).text : ''

    const config = await getConfig().catch(() => ({}))
    const owners = await ownerIdsOf().catch(() => ({}))
    const isOwner = String(msg.personId) === 'owner' || ownIdOf(msg, owners) !== ''
    const st = await stateOf()
    const key = `${msg.channel}:${msg.kind}:${msg.conversationId}`
    const verdict = canReply({
      channel: msg.channel,
      kind: msg.kind,
      conversationId: msg.conversationId,
      mentioned: msg.mentionedSelf === true,
      isOwner,
      stage: st.stage,
      config,
      lastReplyAt: lastReplyAt.get(key) ?? 0,
      now: now(),
    })

    // 名单外的群：她把这句话留在**流水**里（回头能看见那一带在说什么），但不记成「听见」。
    // 没听见的事不能长到她身上——这就是白名单挡的是「长」，不只是「说」。
    if (verdict.why === 'group-not-allowed' || verdict.why === 'channel-off') {
      await journal
        ?.append({ role: 'me', text: clean || '（图）', at: now(), channel: msg.channel, kind: msg.kind, conversationId: msg.conversationId, name: msg.personName })
        .catch(() => {})
      log(`router · 没听（${msg.channel}/${msg.personId}）：${explain(verdict.why) || verdict.why}`)
      return { sent: false, why: verdict.why }
    }

    // 先记账：不管回不回，她「听见了」这件事都发生过。
    await recordHeard(msg, clean || '（图）', isOwner)
    await journal
      ?.append({ role: 'me', text: clean || '（图）', at: now(), channel: msg.channel, kind: msg.kind, conversationId: msg.conversationId, name: msg.personName })
      .catch(() => {})
    await people
      ?.upsert(msg.personId, { name: msg.personName, channel: msg.channel, now: now() })
      .catch(() => {})

    if (!verdict.ok) {
      log(`router · 不接（${msg.channel}/${msg.personId}）：${explain(verdict.why) || verdict.why}`)
      return { sent: false, why: verdict.why }
    }
    if (!st.sessionId) return { sent: false, why: 'no-session' }

    // 一条抖音链接递过来时，替她真去看一眼：解析短链 → 问详情 → 能下到视频就抽三帧。
    // 拿不到就照实说拿不到——「分享图文」那四个字不许被补全成想象出来的内容。
    const video = await lookAtLinks(msg, clean, isOwner)

    const lines = (await journal?.recent({ channel: msg.channel, kind: msg.kind, conversationId: msg.conversationId }, CONTEXT_LINES + 1).catch(() => [])) ?? []
    // 最后一行就是刚记进去的这句，别在提示词里说两遍。
    if (lines.length && lines.at(-1).role === 'me' && lines.at(-1).text === (clean || '（图）')) lines.pop()
    const person = await people?.get(msg.personId).catch(() => null)
    // 她手上那本册子里有没有跟这段话对得上的设定：有就带着，没有就不提。
    const knowledge = worldbook
      ? await worldbook.match(`${clean} ${msg.conversationName ?? ''}`).catch(() => [])
      : []
    // 社会层（2026-11-02）：开闸之后，她在外面见过的做法也进提示词。
    // 没开闸时 provider 返回空数组——那时她连"外面的人怎么处世"这件事都不该知道。
    const social = socialBeliefs ? await socialBeliefs().catch(() => []) : []
    const prompt = buildPrompt(
      { ...msg, text: clean },
      lines,
      { isOwner, impression: person?.impression ?? '', knowledge, social, video },
    )

    // 这一轮是渠道在问她：叫醒轮那套记账要让开，否则同一句话会被记两次
    // （一次 channel: dsh、一次 channel: qq/bili/douyin），判断重复进 beliefs。
    let reply
    beginExternalTurn()
    try {
      reply = await askHer(st.sessionId, prompt)
    } finally {
      endExternalTurn()
    }
    if (!reply.ok && !reply.text) {
      log(`router · 这一轮没拿到话（${reply.why}）`)
      return { sent: false, why: reply.why || 'silent' }
    }
    const text = reply.text
    // 她一句话没说：这是拒绝，不是错误。
    if (!text) return { sent: false, why: 'silent' }

    const screen = screenOutgoing(text)
    if (!screen.ok) {
      log(`router · 拦下一条出门的话（${screen.why}）`)
      return { sent: false, why: screen.why }
    }
    const { events } = await readEvents(root).catch(() => ({ events: [] }))
    const idx = await indexOf(events)
    // 主人可能同时在 B 站和抖音说话：两边的 id 算同一个人，不然「跟主人复述主人自己说过的话」会被误拦。
  const sameAs = isOwner ? Object.values(owners ?? {}).filter(Boolean) : []
  const leak = looksLikePrivateLeak(screen.text, idx, { person: msg.personId, sameAs })
    if (leak.hit) {
      log(`router · 拦下一条私聊内容（来自 ${leak.from}，命中 ${leak.matched} 格）`)
      return { sent: false, why: 'private-leak' }
    }

    const adapter = adapters?.get(msg.channel)
    if (!adapter) return { sent: false, why: 'no-adapter' }
    const r = await adapter.send({
      conversation: { kind: msg.kind, id: msg.conversationId, name: msg.conversationName ?? '' },
      text: screen.text,
    })
    if (!r?.ok) {
      log(`router · 发出失败（${msg.channel}）：${r?.why ?? 'unknown'}`)
      return { sent: false, why: 'send-failed' }
    }

    lastReplyAt.set(key, now())
    await journal
      ?.append({ role: 'her', text: screen.text, at: now(), channel: msg.channel, kind: msg.kind, conversationId: msg.conversationId, name: msg.personName })
      .catch(() => {})
    await recordSaid(msg, screen.text, isOwner)
    // 2026-11-03（真机：会话攒到 47k，撞上游上下文上限）：渠道这边也要结账轮数。
    // 以前只有 her 那条会话（turns.js）与 /say 会 bumpTurns，渠道消息永远不涨 turns，
    // 于是 chat.rotateAfter 对渠道对话等于不存在——她的会话可以无限长下去。
    await turnOver().catch(() => {})
    return { sent: true, why: '', text: screen.text }
  }

  /**
   * 代发（2026-11-02）：她不说的时候，主人以自己的名义回一句。
   *
   * 三条边界，改之前先看 `AGENTS.md` §9：
   *   · 不经过她、不过 gate、不过出站筛——这是主人的话，不是她的话；
   *   · **不写事件流**：她的记忆里不该多出一句她没说过的话；
   *   · 只写一行 journal 流水（role:'owner'），面板上看得见"这句是谁说的"。
   *
   * @returns {Promise<{ok:boolean, why:string}>} 永不抛。
   */
  async function sendAs({ channel, kind, conversationId, conversationName = '', text }) {
    const body = String(text ?? '').replace(/\s+$/, '')
    if (!body.trim()) return { ok: false, why: 'empty' }
    if (body.length > 1000) return { ok: false, why: 'too-long' }
    const adapter = adapters.get(channel)
    if (!adapter) return { ok: false, why: 'no-adapter' }
    const k = kind === 'group' ? 'group' : 'private'
    try {
      const r = await adapter.send({ conversation: { kind: k, id: conversationId, name: conversationName }, text: body })
      if (r && r.ok === false) return { ok: false, why: r.why || 'send-failed' }
    } catch (err) {
      log('router · 代发失败', err?.message ?? err)
      return { ok: false, why: 'send-failed' }
    }
    try {
      await journal?.append({ role: 'owner', text: body, at: now(), channel, kind: k, conversationId, name: conversationName })
    } catch { /* 发都发出去了，记不上流水不该让她背锅 */ }
    log(`router · 代发（${channel}/${conversationId}）：${body.slice(0, 40)}`)
    return { ok: true, why: '' }
  }

  async function drain() {
    if (busy || stopped) return
    busy = true
    try {
      while (queue.length && !stopped) {
        const msg = queue.shift()
        try {
          await handleOne(msg)
        } catch (err) {
          log('router · 处理失败', err?.message ?? err)
        }
      }
    } finally {
      busy = false
    }
  }

  return {
    /** 适配器接上来的入口。同一个 msg 只处理一次，不做去重（去重是适配器的活）。 */
    accept(msg) {
      if (stopped || !msg) return { queued: false, why: 'stopped' }
      if (queue.length >= QUEUE_MAX) {
        log(`router · 队列满了，丢掉一条（${msg.channel}/${msg.personId}）`)
        return { queued: false, why: 'queue-full' }
      }
      queue.push(msg)
      void drain()
      return { queued: true, why: '' }
    },

    /** 直接处理一条（测试与「补发」用，不进队列）。 */
    handle: handleOne,

    /** 代发：主人以自己的名义说一句。见上面 `sendAs` 的三条边界。 */
    sendAs,

    async start() {
      stopped = false
      if (typeof ctx?.on === 'function') {
        offBus = ctx.on('session/event', (session, event) => {
          if (!pending) return
          const sessionId = String(session?.header?.id ?? session?.id ?? '')
          if (sessionId !== pending.sessionId) return
          const type = String(event?.type ?? '')
          if (type === 'assistant/message') {
            const mid = String(event?.data?.message?.id ?? '')
            if (mid && pending.sayIds.has(mid)) return
            if (mid) pending.sayIds.add(mid)
            const said = saidText(event?.data)
            if (said) pending.texts.push(said)
          } else if (type === 'turn/end') {
            pending.resolve?.('end')
          }
        })
      }
      const results = []
      for (const [name, a] of adapters ?? []) {
        try {
          const off = a.onMessage?.((msg) => this.accept({ ...msg, channel: msg.channel || name }))
          if (typeof off === 'function') a.__off = off
          const r = await a.start?.()
          results.push({ name, ok: r?.ok !== false, why: r?.why ?? '' })
        } catch (err) {
          results.push({ name, ok: false, why: String(err?.message ?? err).slice(0, 120) })
        }
      }
      return results
    },

    async stop() {
      stopped = true
      queue.length = 0
      pending?.resolve?.('stop')
      try {
        if (typeof offBus === 'function') offBus()
      } catch { /* ignore */ }
      for (const [, a] of adapters ?? []) {
        try { a.__off?.() } catch { /* ignore */ }
        try { await a.stop?.() } catch { /* ignore */ }
      }
    },

    /** 观测台：四个渠道各自活着没有，队列里还有几条。 */
    status() {
      const out = { busy, queued: queue.length, channels: {} }
      for (const [name, a] of adapters ?? []) {
        try {
          out.channels[name] = a.status?.() ?? { ok: false, why: 'no status' }
        } catch {
          out.channels[name] = { ok: false, why: 'status failed' }
        }
      }
      return out
    },
  }
}
