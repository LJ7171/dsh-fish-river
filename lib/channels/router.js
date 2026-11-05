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
 *
 * 4. **分段连发是送达，不是成长。** `config.im.bubbleSplit` 开着时，三道闸都过了
 *    才按空行 / 换行 / 句末切成最多 4 条，泡间停 300–800ms 再 send。
 *    journal 和 utterance 仍记筛过的全文一条。关掉时一次 send，提示词也不多那句。
 *    代发不走这条：那是主人的话，原样送出去。
 *
 * 5. **标点轻整理也是送达，不是成长。** `config.im.casualPunctuation` 默认开。分段（若开了）
 *    之后、真正 send 之前，每条气泡各自把连续标点收成一个、空白收一收。
 *    句末句号留着。流水和 utterance 仍记筛过的原文。
 *    显式关掉则一个字不改。代发同样不走：那是主人的原话。
 *
 * 6. **进站静默窗是节奏，不是人格。** 同一会话（渠道 + 对方）的新消息会把计时清掉重来，
 *    到点并成一次 `heard` 再叫醒她。重要的人 / 家门近聊默认约 2 秒，群不等。
 *    `config.im.inboundSilenceMs` 为 0 时关掉。刷站和看画面不走这条。
 *
 * 7. **纯确认可以不回。** 调度前看整段：只是短名单里的确认、单独表情、单独句号或省略号，
 *    就记账、不叫醒。问句、点名、带着新内容的，照常。默认开，名单可改。
 */

import { fileURLToPath } from 'node:url'
import { setChannelTurn, clearChannelTurn, setChannelSender, currentChannelTurn } from '../channelTurn.js'
import { appendEvent, readEvents } from '../store.js'
import { sanitizeForeign, looksLikeRewriting, screenOutgoing } from '../guard.js'
import { buildIndex, looksLikePrivateLeak } from '../leakcheck.js'
import { knowledgeBlock } from '../worldbook.js'
import { bumpTurns, homeStatus, rotateTalkSession } from '../home.js'
import { refreshSelfDoc } from '../selfdoc.js'
import { beginExternalTurn, endExternalTurn } from '../extturn.js'
import { describeAweme, findDouyinLinks, lookDouyin } from '../dylink.js'
import { canReply, explain } from './gate.js'
import { noteWeixin } from '../sleep.js'
import { casualPunctuationOn, casualizePunctuation } from './casual.js'
import { resolveOccasion, occasionLine, contextLinesFor, nextQueueIndex } from './passport.js'
import {
  ackPhrasesOf,
  ackSilenceOn,
  isAckSegment,
  mergeHeld,
  sessionKey,
  silenceMsFor,
} from './pace.js'

/** 队列上限：超过就丢新的。已经在事件流里的东西，她以后翻得到。 */
export const QUEUE_MAX = 5
/** 等她一轮最多等多久。超时不发，也不重试——重试等于让她把同一句话说两遍。 */
export const TURN_TIMEOUT_MS = 120000
/** 拼进提示词的流水句数。 */
export const CONTEXT_LINES = 8
/** 社会层开闸后，最多带几条「外面见过的做法」进提示词。多了就成清单了。 */
export const SOCIAL_LINES = 5
/** 一条回复最多拆成几条气泡。再多就并进这几条里，不许丢字，也不许刷屏。 */
export const BUBBLE_MAX = 4
/** 泡与泡之间停多久。太短像机器连发，太长像掉线。 */
export const BUBBLE_GAP_MIN_MS = 300
export const BUBBLE_GAP_MAX_MS = 800

/**
 * 渠道回复要不要分段连发。
 * 只认显式的 `true`：缺这个键、或者关掉，都是一次 send（跟以前一样）。
 * `getConfig` 有时给的是配置本身，有时套一层 `{ config }`，两种都认。
 */
export function bubbleSplitOn(config) {
  const im = config?.im ?? config?.config?.im
  return im?.bubbleSplit === true
}

export { casualPunctuationOn, casualizePunctuation }

/** 泡间间隔，闭区间 [300, 800]。`rand` 给测试钉死。 */
export function bubbleGapMs(rand = Math.random) {
  const n = Number(typeof rand === 'function' ? rand() : rand)
  const u = Number.isFinite(n) ? Math.min(0.999999, Math.max(0, n)) : 0
  const span = BUBBLE_GAP_MAX_MS - BUBBLE_GAP_MIN_MS
  return BUBBLE_GAP_MIN_MS + Math.floor(u * (span + 1))
}

/**
 * 把已经筛过的回复切成 IM 气泡。
 *
 * 切点只有空行、换行，和句末（。！？）。不按英文句号切——网址和小数会被劈开。
 * 切不出来就原样返回一整段，调用方只 send 一次，字一个不改。
 * 超过 {@link BUBBLE_MAX} 条时按条数摊进这几条，用换行接上，不丢字。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitBubbles(text) {
  const src = String(text ?? '')
  const pieces = sentencePieces(src)
  if (pieces.length <= 1) return [src]
  return packBubbles(pieces, BUBBLE_MAX)
}

function sentencePieces(src) {
  const out = []
  for (const block of src.replace(/\r\n/g, '\n').split(/\n+/)) {
    const line = block.trim()
    if (!line) continue
    const bits = line.split(/([。！？]+)/)
    let buf = ''
    for (const bit of bits) {
      if (!bit) continue
      if (/^[。！？]+$/.test(bit)) {
        buf += bit
        if (buf.trim()) out.push(buf.trim())
        buf = ''
      } else if (buf) {
        out.push(buf.trim())
        buf = bit
      } else {
        buf = bit
      }
    }
    if (buf.trim()) out.push(buf.trim())
  }
  return out
}

/** 多于 max 条时摊匀，前面的组先多带一条，避免最后一条变成一整段。 */
function packBubbles(pieces, max) {
  if (pieces.length <= max) return pieces
  const base = Math.floor(pieces.length / max)
  let extra = pieces.length % max
  const out = []
  let i = 0
  for (let g = 0; g < max; g++) {
    const take = base + (extra > 0 ? 1 : 0)
    if (extra > 0) extra -= 1
    const chunk = pieces.slice(i, i + take)
    i += take
    if (chunk.length) out.push(chunk.join('\n'))
  }
  return out
}

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

/** 她这一轮带上的本机图。只认绝对路径；远程地址留给渠道自己拒绝，这里不抓。 */
function saidImages(data) {
  const blocks = data?.message?.content ?? data?.content
  if (!Array.isArray(blocks)) return []
  const out = []
  for (const block of blocks) {
    const file = localImageRef(block)
    if (file && !out.includes(file)) out.push(file)
  }
  return out
}

function localImageRef(block) {
  if (!block || typeof block !== 'object') return ''
  const type = String(block.type ?? '')
  if (type !== 'image' && type !== 'image_file') return ''
  let file = String(block.path ?? block.file ?? block.source?.path ?? block.source?.file ?? '').trim()
  if (!file) {
    const url = String(block.url ?? block.source?.url ?? '').trim()
    if (url.startsWith('file:')) {
      try { file = fileURLToPath(url) } catch { file = '' }
    }
  }
  if (file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file)) return file
  return ''
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
  const who = String(msg.personName || '').trim() || '一个没写名字的人'
  const occ = opts.occasion ?? resolveOccasion({
    channel: msg.channel,
    kind: msg.kind,
    personId: msg.personId,
    isOwner: opts.isOwner === true,
    config: opts.config,
  })
  const scene = occasionLine(occ)
  const out = []
  const impression = opts.impression ? `你对他有印象：${opts.impression}` : '你对他没什么印象。'

  if (msg.kind === 'group') {
    const room = msg.conversationName || msg.conversationId
    out.push(
      opts.isOwner
        ? `（${scene}群是「${room}」。说话的是重要的人。）`
        : `（${scene}群是「${room}」。说话的是 ${who}。${impression}）`,
    )
  } else if (opts.isOwner) {
    out.push(`（${scene}）`)
  } else {
    out.push(`（${scene}说话的是 ${who}。${impression}）`)
  }

  // 场合（2026-11-04，用户 m11031）：跟别人说话时，她老把自己的心理话摊在台面上，出戏。
  // 对主人可以，对陌生人不必——群里更不必。只说眼前这件事。
  // 2026-11-04 用户 m11046 真机打回：群里主人 @ 她，她照样把心里话摊开——
  // 判据看错了，用的"跟谁说话"，该看的是"在什么地方说话"。群里就是有人旁听。
  if (!opts.isOwner || msg.kind === 'group') {
    out.push('（这里不是只有你和他：只回答问的那件事，说眼前这件事就行，不用交代你怎么想、为什么这么说。）')
  }

  const tail = lines.slice(-(Number(opts.contextLines) || contextLinesFor(occ, CONTEXT_LINES)))
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
  // 图片已经落盘（微信那条会下载解密）：告诉她路径，让她自己决定要不要 read_image 看。
  // 只在**本地路径**时加这句——QQ/B 站给的是 http 地址，read_image 读不了，加了等于骗她。
  const localImages = (Array.isArray(msg.images) ? msg.images : []).filter((p) => typeof p === 'string' && p.startsWith('/'))
  if (localImages.length) {
    out.push(localImages.map((p) => `（他发了一张图，存在 ${p}，用 read_image 看图。）`).join('\n'))
  }
  out.push('')
  // 说的是「这里可以不说话」，不是「你要温柔一点」——前者是处境，后者是人格。
  out.push('（回不回、说几句，你自己定。不想接就什么都不用说。）')
  // 处境，不是人设（2026-11-04）：只在「分段连发」开着时告诉她这是聊天窗口。
  // 不写「你是话少的人」——那是处方，小模型会把它背出来。
  if (opts.bubbleSplit === true) {
    out.push('（这是聊天窗口，不是一篇文章。能短就短，也可以分成几句。）')
  }
  // 标点跟着语气走。不写硬性的句号配额——那种句子会被小模型当成要背的指令。
  // 后处理只收连续标点和空白，不替她删句号。
  if (opts.casualPunctuation === true) {
    out.push('（标点跟着语气走：轻松的时候，句号可以少一点；要强调可以用感叹号；停顿用逗号或空行。别写成没有标点的电报，也别一句一句堆成作文。）')
  }
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
  const sleep = typeof deps.sleep === 'function'
    ? deps.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const nextGap = typeof deps.bubbleGapMs === 'function' ? deps.bubbleGapMs : () => bubbleGapMs()
  const schedule = typeof deps.schedule === 'function'
    ? deps.schedule
    : (fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref?.()
        return t
      }
  const cancel = typeof deps.cancel === 'function' ? deps.cancel : (t) => clearTimeout(t)

  // 她要主动发图（`send_image`）时走这里。工具只认「这一轮是谁」，发不发得出去由适配器说了算。
  // 代发不经过这条：那是主人以自己的名义说话，见 sendAs。
  setChannelSender(async ({ path, caption = '' } = {}) => {
    const turn = currentChannelTurn()
    if (!turn) return { ok: false, why: '现在没有在跟谁说话' }
    const adapter = adapters?.get?.(turn.channel)
    if (!adapter) return { ok: false, why: '这个渠道没有连上' }
    if (adapter.supportsImages !== true) return { ok: false, why: '这个渠道还发不了图' }
    const sent = await adapter
      .send({
        conversation: { kind: turn.kind, id: turn.conversationId, name: turn.conversationName ?? '' },
        text: String(caption ?? ''),
        images: [path],
      })
      .catch((err) => ({ ok: false, why: String(err?.message ?? err).slice(0, 120) }))
    if (sent?.ok === false) return { ok: false, why: sent.why || '没发出去' }
    try {
      await journal?.append?.({
        role: 'her',
        text: caption || '（图）',
        channel: turn.channel,
        kind: turn.kind,
        conversationId: turn.conversationId,
        name: turn.personName ?? '',
      })
    } catch { /* 流水写不进去不影响已经发出去的图 */ }
    return { ok: true }
  })

  const queue = []
  /** 静默窗里还没到点的会话。key → { msgs, timer, ticket } */
  const holds = new Map()
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

  async function recordHeard(msg, text, isOwner = false, occ = null) {
    try {
      const { events } = await readEvents(root)
      const last = events[events.length - 1]
      const scene = occ ? occasionLine(occ) : ''
      await appendEvent(
        {
          type: 'heard',
          text: `${scene}${msg.personName || msg.personId}：${text}`,
          person: msg.personId,
          visibility: msg.kind === 'group' ? 'public' : 'private',
          channel: msg.channel,
          origin: isOwner ? 'owner' : 'guest',
          // 陌生人说的话一开始只能算「社会层」：它教她怎么处世，不定义她是谁。
          // 重要的人说的话是立宪层——同一个人在私信里说同一句话，分量不该看渠道。
          // 近人（closeIds）只改场合，不改这一格。
          influence: isOwner ? 'constitution' : 'social',
          ...(occ ? { accountOf: occ.accountOf, bond: occ.bond } : {}),
        },
        { day: Number(last?.day ?? 1) || 1, stage: Number(last?.stage ?? 1) || 1, source: 'system' },
        root,
      )
    } catch (err) {
      log('router · 记 heard 失败', err?.message ?? err)
    }
  }

  /** 记一条她自己说出去的。 */
  async function recordSaid(msg, text, isOwner, occ = null) {
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
          ...(occ ? { accountOf: occ.accountOf, bond: occ.bond } : {}),
        },
        { day: Number(last?.day ?? 1) || 1, stage: Number(last?.stage ?? 1) || 1, source: 'system' },
        root,
      )
    } catch (err) {
      log('router · 记 utterance 失败', err?.message ?? err)
    }
  }

  /** 流水和事件流各记一条她说出去的话。文本用合并后的全文，不按气泡拆。 */
  async function rememberHer(msg, text, isOwner, occ = null) {
    await journal
      ?.append({ role: 'her', text, at: now(), channel: msg.channel, kind: msg.kind, conversationId: msg.conversationId, name: msg.personName })
      .catch(() => {})
    await recordSaid(msg, text, isOwner, occ)
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

    const reached = { sessionId, texts: [], images: [], sayIds: new Set() }
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
      const images = reached.images.slice(0, 4)
      if (why === 'timeout') return { ok: false, text, images, why: 'timeout' }
      if (why === 'error') return { ok: false, text, images, why: 'prompt-failed' }
      return { ok: true, text, images, why: '' }
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
    const occ = resolveOccasion({
      channel: msg.channel,
      kind: msg.kind,
      personId: msg.personId,
      isOwner,
      config,
    })
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
    await recordHeard(msg, clean || '（图）', isOwner, occ)
    await journal
      ?.append({ role: 'me', text: clean || '（图）', at: now(), channel: msg.channel, kind: msg.kind, conversationId: msg.conversationId, name: msg.personName })
      .catch(() => {})
    await people
      ?.upsert(msg.personId, { name: msg.personName, channel: msg.channel, now: now() })
      .catch(() => {})

    if (!verdict.ok) {
      // 「被阶段挡住」最常见的原因不是陌生人，是主人还没把自己的 id 填进渠道页——
      // 2026-11-04 真机踩到：微信登录通了、流水里也有消息，但这条一句都不提，
      // 看起来像「渠道坏了」。把下一步要说清楚，但**仍然不递**（她本来就不该看见）。
      const hint = verdict.why === 'stage-too-early'
        ? `（如果是你本人：渠道页「重要的人的 id」那一格还空着，把 ${msg.conversationId} 填进去。）`
        : ''
      log(`router · 不接（${msg.channel}/${msg.personId}）：${explain(verdict.why) || verdict.why}${hint}`)
      return { sent: false, why: verdict.why }
    }
    // 纯确认：听见了，流水也有，但不叫醒。问句、点名、图、新内容不走这里。
    // 静默窗若把几条并成一段，要整段都是确认才停。看链接也不提前做——没到思考那一轮。
    if (
      ackSilenceOn(config)
      && images.length === 0
      && msg.mentionedSelf !== true
      && isAckSegment(clean, ackPhrasesOf(config))
    ) {
      log(`router · 纯确认，不叫醒（${msg.channel}/${msg.personId}）`)
      return { sent: false, why: 'ack' }
    }
    if (!st.sessionId) return { sent: false, why: 'no-session' }

    // 微信能把她从睡眠里叫醒：先记成会话苏醒（只回话）。窗外不升级成掷骰。
    if (msg.channel === 'weixin') {
      try { await noteWeixin(root, now()) } catch { /* 作息没记上也不挡这句回复 */ }
    }

    // 一条抖音链接递过来时，替她真去看一眼：解析短链 → 问详情 → 能下到视频就抽三帧。
    // 拿不到就照实说拿不到——「分享图文」那四个字不许被补全成想象出来的内容。
    // 静默窗只挡住「开一轮思考」，看链接发生在到点之后的这一轮里，不另开一条闸。
    const video = await lookAtLinks(msg, clean, isOwner)

    const contextN = contextLinesFor(occ, CONTEXT_LINES)
    const lines = (await journal?.recent({ channel: msg.channel, kind: msg.kind, conversationId: msg.conversationId }, contextN + 1).catch(() => [])) ?? []
    // 最后一行就是刚记进去的这句，别在提示词里说两遍。
    // 流水会把换行收成空格，攒段之后要用收过的那一版对上。
    const shown = (clean || '（图）').replace(/\s+/g, ' ').trim()
    if (lines.length && lines.at(-1).role === 'me' && lines.at(-1).text === shown) lines.pop()
    const person = await people?.get(msg.personId).catch(() => null)
    // 她手上那本册子里有没有跟这段话对得上的设定：有就带着，没有就不提。
    const knowledge = worldbook
      ? await worldbook.match(`${clean} ${msg.conversationName ?? ''}`).catch(() => [])
      : []
    // 社会层（2026-11-02）：开闸之后，她在外面见过的做法也进提示词。
    // 没开闸时 provider 返回空数组——那时她连"外面的人怎么处世"这件事都不该知道。
    const social = socialBeliefs ? await socialBeliefs().catch(() => []) : []
    // 分段连发开着才在提示词里加一句聊天窗口的处境；关掉时这句不出现。
    // 标点轻整理默认开，提示词里说标点跟着语气走；显式关掉时这句也不出现。
    const splitOn = bubbleSplitOn(config)
    const casualOn = casualPunctuationOn(config)
    const prompt = buildPrompt(
      { ...msg, text: clean },
      lines,
      {
        isOwner,
        impression: person?.impression ?? '',
        knowledge,
        social,
        video,
        bubbleSplit: splitOn,
        casualPunctuation: casualOn,
        config,
        occasion: occ,
        contextLines: contextN,
      },
    )

    // 这一轮是渠道在问她：叫醒轮那套记账要让开，否则同一句话会被记两次
    // （一次 channel: dsh、一次 channel: qq/bili/douyin），判断重复进 beliefs。
    let reply
    beginExternalTurn()
    // 这一轮她是在跟谁说话：`send_image` 要据此决定发给谁。说完就清掉。
    setChannelTurn({
      channel: msg.channel,
      kind: msg.kind,
      conversationId: msg.conversationId,
      conversationName: msg.conversationName ?? '',
      personId: msg.personId,
    })
    try {
      reply = await askHer(st.sessionId, prompt)
    } finally {
      clearChannelTurn()
      endExternalTurn()
    }
    const text = String(reply.text ?? '')
    const replyImages = (Array.isArray(reply.images) ? reply.images : []).filter((p) => typeof p === 'string' && p.trim())
    if (!reply.ok && !text && !replyImages.length) {
      log(`router · 这一轮没拿到话（${reply.why}）`)
      return { sent: false, why: reply.why || 'silent' }
    }
    // 她一句话没说、也没带图：这是拒绝，不是错误。
    if (!text && !replyImages.length) return { sent: false, why: 'silent' }

    // 有字才过出站闸。图是本机路径，不跟这句话一起过筛——筛的是她说出去的字。
    let screened = ''
    if (text) {
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
      screened = screen.text
    }

    const adapter = adapters?.get(msg.channel)
    if (!adapter) return { sent: false, why: 'no-adapter' }
    // 关掉时 pieces 就是原文一条，只 send 一次，中间也不停。
    // 开着时按空行 / 句末切，最多 4 条；泡间才停。记账仍用筛过的全文，不按泡各记一条。
    // 标点轻整理在切完之后、send 之前，对每一条各自做。句号留着。
    // 整理完没有字的那条不发。全都空了就当她没说——别把空消息送出去。
    // 流水仍记原文，不记整理过的字。
    // 图另发一次：文字适配器看见空 text 会拒，所以不把 images 塞进文字那一次。
    const pieces = screened ? (splitOn ? splitBubbles(screened) : [screened]) : []
    const rawOutbound = pieces.length ? pieces : (screened ? [screened] : [])
    const outbound = []
    for (const piece of rawOutbound) {
      if (!casualOn) {
        outbound.push(piece)
        continue
      }
      const spoken = casualizePunctuation(piece)
      if (spoken) outbound.push(spoken)
    }
    if (!outbound.length && !replyImages.length) return { sent: false, why: 'silent' }
    const conversation = { kind: msg.kind, id: msg.conversationId, name: msg.conversationName ?? '' }
    const sentParts = []
    for (let i = 0; i < outbound.length; i++) {
      if (i > 0) await sleep(nextGap())
      const r = await adapter.send({ conversation, text: outbound[i] })
      if (!r?.ok) {
        log(`router · 发出失败（${msg.channel}）：${r?.why ?? 'unknown'}`)
        // 已经发出去的并成一条记下来。一条都没出去：跟以前一样不记。
        if (sentParts.length) await rememberHer(msg, sentParts.join('\n'), isOwner, occ)
        return { sent: false, why: 'send-failed', text: sentParts.join('\n') }
      }
      sentParts.push(outbound[i])
    }
    if (replyImages.length) {
      const r = await adapter.send({ conversation, text: '', images: replyImages })
      if (!r?.ok) {
        log(`router · 图没发出去（${msg.channel}）：${r?.why ?? 'unknown'}`)
        if (sentParts.length) await rememberHer(msg, sentParts.join('\n'), isOwner, occ)
        return { sent: false, why: 'send-failed', text: sentParts.join('\n') }
      }
    }

    lastReplyAt.set(key, now())
    await rememberHer(msg, screened || '（图）', isOwner, occ)
    // 2026-11-03（真机：会话攒到 47k，撞上游上下文上限）：渠道这边也要结账轮数。
    // 以前只有 her 那条会话（turns.js）与 /say 会 bumpTurns，渠道消息永远不涨 turns，
    // 于是 chat.rotateAfter 对渠道对话等于不存在——她的会话可以无限长下去。
    await turnOver().catch(() => {})
    return { sent: true, why: '', text: screened }
  }

  /**
   * 代发（2026-11-02）：她不说的时候，主人以自己的名义回一句。
   *
   * 三条边界，改之前先看 `AGENTS.md` §9：
   *   · 不经过她、不过 gate、不过出站筛——这是主人的话，不是她的话；
   *   · **不写事件流**：她的记忆里不该多出一句她没说过的话；
   *   · 只写一行 journal 流水（role:'owner'），面板上看得见"这句是谁说的"。
   * 分段连发不作用在代发上：那是主人的原话，一次送出去。
   * 标点轻整理也不作用在代发上：那只改她说出去的话。
   *
   * @returns {Promise<{ok:boolean, why:string}>} 永不抛。
   */
  async function sendAs({ channel, kind, conversationId, conversationName = '', text, images } = {}) {
    const body = String(text ?? '').replace(/\s+$/, '')
    const pics = (Array.isArray(images) ? images : []).map((p) => String(p ?? '').trim()).filter(Boolean).slice(0, 4)
    if (!body.trim() && !pics.length) return { ok: false, why: 'empty' }
    if (body.length > 1000) return { ok: false, why: 'too-long' }
    const adapter = adapters.get(channel)
    if (!adapter) return { ok: false, why: 'no-adapter' }
    const k = kind === 'group' ? 'group' : 'private'
    try {
      const r = await adapter.send({
        conversation: { kind: k, id: conversationId, name: conversationName },
        text: body,
        ...(pics.length ? { images: pics } : {}),
      })
      if (r && r.ok === false) return { ok: false, why: r.why || 'send-failed' }
    } catch (err) {
      log('router · 代发失败', err?.message ?? err)
      return { ok: false, why: 'send-failed' }
    }
    const line = body.trim() ? body : '（图）'
    try {
      await journal?.append({ role: 'owner', text: line, at: now(), channel, kind: k, conversationId, name: conversationName })
    } catch { /* 发都发出去了，记不上流水不该让她背锅 */ }
    log(`router · 代发（${channel}/${conversationId}）：${line.slice(0, 40)}`)
    return { ok: true, why: '' }
  }

  function enqueue(msg) {
    if (stopped || !msg) return { queued: false, why: 'stopped' }
    if (queue.length >= QUEUE_MAX) {
      log(`router · 队列满了，丢掉一条（${msg.channel}/${msg.personId}）`)
      return { queued: false, why: 'queue-full' }
    }
    queue.push(msg)
    void drain()
    return { queued: true, why: '' }
  }

  /** 这一条该等多久。读配置失败就当 0，别把消息卡在静默窗里。 */
  async function measureSilence(msg) {
    try {
      const config = await getConfig()
      const owners = await ownerIdsOf().catch(() => ({}))
      const isOwner = String(msg.personId) === 'owner' || ownIdOf(msg, owners) !== ''
      const occ = resolveOccasion({
        channel: msg.channel,
        kind: msg.kind,
        personId: msg.personId,
        isOwner,
        config,
      })
      return silenceMsFor(occ, config)
    } catch {
      return 0
    }
  }

  function flushHold(key, ticket) {
    const cur = holds.get(key)
    if (!cur || cur.ticket !== ticket) return
    holds.delete(key)
    cur.timer = null
    const merged = mergeHeld(cur.msgs)
    if (merged) enqueue(merged)
  }

  /**
   * 进站先看静默窗。同一会话的新消息把计时清掉重来，到点并成一条再进队列。
   * 0 毫秒不攒：每条自己进队列，跟以前一样。
   */
  async function routeIn(msg) {
    const key = sessionKey(msg)
    let slot = holds.get(key)
    if (!slot) {
      slot = { msgs: [], timer: null, ticket: 0 }
      holds.set(key, slot)
    }
    slot.msgs.push(msg)
    const ticket = ++slot.ticket
    if (slot.timer) {
      cancel(slot.timer)
      slot.timer = null
    }
    const ms = await measureSilence(msg)
    const cur = holds.get(key)
    if (!cur || cur.ticket !== ticket || stopped) return
    if (!(ms > 0)) {
      holds.delete(key)
      for (const m of cur.msgs) enqueue(m)
      return
    }
    cur.timer = schedule(() => flushHold(key, ticket), ms)
  }

  async function drain() {
    if (busy || stopped) return
    busy = true
    try {
      while (queue.length && !stopped) {
        const config = await getConfig().catch(() => ({}))
        const msg = queue.splice(nextQueueIndex(queue, config), 1)[0]
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
      void routeIn(msg)
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
            for (const file of saidImages(event?.data)) {
              if (!pending.images.includes(file)) pending.images.push(file)
            }
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
      for (const slot of holds.values()) {
        if (slot.timer) cancel(slot.timer)
      }
      holds.clear()
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
      const out = { busy, queued: queue.length, holding: holds.size, channels: {} }
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
