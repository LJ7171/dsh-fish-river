/**
 * replyDelivery.js —— 别人回她的评论，怎么递到她面前（2026-11-18）
 *
 * 以前只有一条路：扫到先攒进盒子，等她下一次醒来时由 wake() 一起递。
 * 现在多一条：**她醒着就立刻递**（用户 2026-11-18 定）。睡着、请假、正在说一轮时
 * 仍然留在盒子里，等醒来或下一拍再递。
 *
 * 三条边界：
 *   1. 递送本身**不算一次醒来**：不写 `wake:`、不占配额、不推成长卡、不 setWakeTurn；
 *      但要用 holdWake() —— 这一轮她写下的判断不算「他来过」，否则冷落检测失真。
 *   2. 递送**不碰作息台账**：不写 sleep-state，也就不会把她下次入睡时间往后推。
 *   3. 递出去就算看过：成功后写各平台的 `*-cseen:`，同一条回复不会再出现；
 *      投递失败就把条目放回盒子，不留半截。
 *
 * 正文走 system prompt 的 `fish:wake` 段（和叫醒同一条路），对话里只留一句括号旁白。
 */

import { appendEvent, ensureHer, rootDir } from '../core/store.js'
import { dateKey } from '../core/settings.js'
import { addReplies, hasReplies, takeReplies } from './replybox.js'
import { commentOpen, readSleep } from './schedule/sleep.js'
import { holdWake } from './schedule/wakewin.js'
import { clearWakeSection, setWakeSection } from '../mind/identity.js'
import { talkSessionId } from '../house/home.js'
import { acquireTurn } from '../talk/turnLock.js'
import { landCommentImages } from '../platforms/bili/commentImages.js'
import { renderReplies as renderBiliReplies } from '../platforms/bili/comment.js'
import { renderReplies as renderZhihuReplies } from '../platforms/zhihu/comment.js'
import { renderReplies as renderTiebaReplies } from '../platforms/tieba/comment.js'

/** 两次立投之间至少隔这么久；一次也只递一批，避免连着开好几轮。 */
export const PUSH_MIN_MS = 5 * 60_000
/** 这一轮最多挂多久：turn/end 不来时兜底清段、放锁。 */
export const DELIVERY_SECTION_MS = 5 * 60_000
/** 对话里唯一出现的那句话（和叫醒一样是括号旁白，不是谁说的话）。 */
export const REPLY_TRIGGER = '（有人回了你一句。）'
const REPLY_HINT = '对话里那条括号不是谁说的话，是门口有人递了一句过来。'

/** 已递标记：三平台各自的「看过」前缀。 */
const SEEN_PREFIX = { bili: 'cseen', zhihu: 'zhihu-cseen', tieba: 'tieba-cseen' }

let lastPushAt = 0
// 同一时刻只允许一个立投在跑：按钮和 tick 可能同时到。
let delivering = false

/** 测试用：清掉节流计时。 */
export function resetReplyDeliveryForTests() {
  lastPushAt = 0
  delivering = false
}

/** 这次要给哪些平台递。enabled 关着的平台盒子不动。 */
function sourcesOf(config) {
  const out = []
  if (config?.comment?.enabled === true) {
    out.push({
      key: 'bili',
      file: '',
      images: config?.browse?.images,
      prefix: 'bili-reply',
      referer: 'https://www.bilibili.com/',
      render: (list) => renderBiliReplies(list),
    })
  }
  if (config?.zhihu?.comment?.enabled === true) {
    out.push({
      key: 'zhihu',
      file: 'zhihu-reply-box.json',
      images: config?.zhihu?.images,
      prefix: 'zhihu-reply',
      referer: 'https://www.zhihu.com/',
      render: (list) => renderZhihuReplies(list, list.find((x) => x?.owner)?.owner ?? config?.zhihu?.owner),
    })
  }
  if (config?.tieba?.comment?.enabled === true) {
    out.push({
      key: 'tieba',
      file: 'tieba-reply-box.json',
      images: config?.tieba?.images,
      prefix: 'tieba-reply',
      referer: 'https://tieba.baidu.com/',
      render: (list) => renderTiebaReplies(list, list.find((x) => x?.owner)?.owner ?? config?.tieba?.owner),
    })
  }
  return out
}

/**
 * 盒子里有没有东西。只读、不取，用来在每拍最前面便宜地短路。
 */
export async function hasAnyReply(root, config) {
  for (const src of sourcesOf(config)) {
    if (await hasReplies(root, { file: src.file || undefined })) return true
  }
  return false
}

/**
 * 把各平台盒子里的回复全部取出来，下载图、拼成递给她的一段正文。
 *
 * 取走即清空：调用方负责在投递失败时 restoreReplyBatch() 放回去。
 * @returns {Promise<{text:string, batches:Array<{key:string,file:string,items:Array}>}>}
 */
export async function collectReplyBatch(root, config) {
  const batches = []
  const blocks = []
  for (const src of sourcesOf(config)) {
    const taken = await takeReplies(root, { file: src.file || undefined }).catch(() => [])
    // 2026-11-18：旧盒子里可能还留着「同号自己说的话」（回声）或 her 角色的回复；
    // 这些不该再递，取出来就直接丢掉，不再放回。
    const items = taken.filter((x) => x?.sameAccount !== true && x?.authorRole !== 'her')
    if (!items.length) continue
    // 先下图、再渲染：renderReplies 读的是 pics（和醒来那条路一致）。
    if (src.images?.enabled !== false) {
      const max = Math.max(1, Math.min(6, Number(src.images?.max) || 2))
      await landCommentImages(root, items, { prefix: src.prefix, referer: src.referer, max }).catch(() => {})
    }
    let text = ''
    try {
      text = src.render(items)
    } catch {
      text = ''
    }
    if (!text) {
      // 渲染不出来（子包没装等）：原样放回去，别吞掉。
      await addReplies(root, items, { file: src.file || undefined }).catch(() => {})
      continue
    }
    batches.push({ key: src.key, file: src.file, items })
    blocks.push(text)
  }
  return { text: blocks.join('\n\n'), batches }
}

/** 投递失败：把这一批原样放回盒子（去重/上限由 addReplies 兜）。 */
export async function restoreReplyBatch(root, batches = []) {
  for (const b of batches) {
    if (!b?.items?.length) continue
    await addReplies(root, b.items, { file: b.file || undefined }).catch(() => {})
  }
}

/**
 * 递出去就算看过：一条一个 id，写对应平台的前缀。
 * 旧读者照旧只认第一条 id，新写法不改变任何解析格式。
 */
export async function markReplyBatchSeen(root, batches = [], dk = dateKey()) {
  for (const b of batches) {
    const prefix = SEEN_PREFIX[b?.key]
    if (!prefix) continue
    for (const it of b.items ?? []) {
      const id = String(it?.rpid ?? it?.id ?? '').trim()
      if (!id) continue
      await appendEvent(
        { type: 'meta', text: `${prefix}:${dk} ${id}` },
        { day: 0, stage: 1, source: 'system' },
        root,
      ).catch(() => {})
    }
  }
}

/**
 * 醒着就立刻递一批。所有前置判断都在这里，返回 { ok, why, pushed }，**永不抛出**。
 *
 * @param {object} ctx 宿主 ctx（要 sessionController；有 on 才能等 turn/end）
 * @param {object} o { config, now, log, isBusy }
 */
export async function deliverAwakeReplyBatch(ctx, root = rootDir(), o = {}) {
  const { config, now = Date.now(), log = () => {}, isBusy } = o
  if (delivering) return { ok: false, why: 'busy', pushed: 0 }
  delivering = true
  try {
    if (now - lastPushAt < PUSH_MIN_MS) return { ok: false, why: 'throttled', pushed: 0 }
    if (!(await hasAnyReply(root, config))) return { ok: false, why: 'empty', pushed: 0 }

    // 醒着的判据和「能不能在评论区说话」同一套：dice_awake 或 session_awake；
    // asleep / 请假由调用方挡住（请假时 tick 根本走不到这里）。
    const st = await readSleep(root).catch(() => null)
    const gate = commentOpen(config, st)
    if (gate.governed && !gate.open) return { ok: false, why: 'asleep', pushed: 0 }
    // 段首那次醒留给 runSleep 的段首唤醒，别让立投抢在它前面。
    if (st && st.mode === 'dice_awake' && st.looked === false) return { ok: false, why: 'segment-start', pushed: 0 }

    const sc = ctx?.sessionController
    if (!sc?.prompt) return { ok: false, why: 'no-session-controller', pushed: 0 }

    // 生产这条路自己现读会话（会话轮换后 deps.sessionId 可能过期）；
    // 单测 / 外部调用可以显式给一个 sessionId，免去建屋子的副作用。
    let sid = String(o.sessionId ?? '')
    if (!sid) sid = await talkSessionId(ctx, { root, log }).catch(() => '')
    if (!sid) return { ok: false, why: 'no-session', pushed: 0 }
    if (typeof isBusy === 'function' && isBusy(sid)) return { ok: false, why: 'busy', pushed: 0 }

    const batch = await collectReplyBatch(root, config)
    if (!batch.text) return { ok: false, why: 'empty', pushed: 0 }

    const releaseTurn = await acquireTurn(`${root}:${sid}`, { timeoutMs: 1_000 })
    if (!releaseTurn) {
      await restoreReplyBatch(root, batch.batches)
      return { ok: false, why: 'busy', pushed: 0 }
    }

    let turnReleased = false
    const releaseTurnOnce = () => {
      if (turnReleased) return
      turnReleased = true
      releaseTurn()
    }
    // 这一轮她写下的判断不算「他来过」：和叫醒同一个窗口。
    const releaseWake = holdWake()
    let closed = false
    let off = null
    const close = () => {
      if (closed) return
      closed = true
      try { off?.() } catch { /* 注销失败也不影响放锁 */ }
      clearWakeSection()
      releaseWake()
      releaseTurnOnce()
    }
    // turn/end 不来时兜底：清段、放锁（和叫醒同一个形状）。
    // 她要是还真的在那一轮里（回几条评论、每两条之间还有回复间隔），就别抽走处境、别放锁。
    let grace = 0
    const fallback = () => {
      if (closed) return
      // 最多再宽限 3 次（1.5 分钟）：turn/end 丢了也不能把家会话一直锁着。
      if (grace < 3 && typeof isBusy === 'function' && isBusy(sid)) {
        grace += 1
        setTimeout(fallback, 30_000).unref?.()
        return
      }
      close()
    }
    setTimeout(fallback, DELIVERY_SECTION_MS).unref?.()
    if (typeof ctx?.on === 'function') {
      const maybe = ctx.on('session/event', (session, event) => {
        const id = session?.header?.id ?? session?.id
        if (id !== sid || event?.type !== 'turn/end') return
        close()
      })
      off = typeof maybe === 'function' ? maybe : null
    }

    const ac = new AbortController()
    const kill = setTimeout(() => ac.abort(), 30_000)
    kill.unref?.()
    let marked = false
    try {
      const herDir = await ensureHer(root)
      try { await sc.create({ sessionId: sid, cwd: herDir }) } catch { /* 已存在就接着用 */ }
      setWakeSection(`${REPLY_HINT}\n\n${batch.text}`)
      await sc.prompt(
        { requestId: `nudge-reply-${dateKey()}-${Date.now()}`, sessionId: sid, mode: 'queue', content: [{ type: 'text', text: REPLY_TRIGGER }] },
        ac.signal,
      )
      await markReplyBatchSeen(root, batch.batches)
      marked = true
      lastPushAt = now
      // 没有会话事件总线（单测/老宿主）时等不到 turn/end：当场收尾，
      // 免得那段处境挂到下一个人的回合里。
      if (!off) {
        clearWakeSection()
        releaseWake()
        releaseTurnOnce()
      }
      const pushed = batch.batches.reduce((n, b) => n + (b.items?.length ?? 0), 0)
      log('replies', `醒着，直接递了 ${pushed} 条`)
      return { ok: true, why: '', pushed }
    } catch (err) {
      clearTimeout(kill)
      close()
      // 已经标过「看过」的不能再放回盒子，否则同一条会被递两遍。
      if (!marked) await restoreReplyBatch(root, batch.batches)
      return { ok: false, why: String(err?.message ?? err), pushed: 0 }
    } finally {
      clearTimeout(kill)
    }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err), pushed: 0 }
  } finally {
    delivering = false
  }
}

export default {
  PUSH_MIN_MS,
  DELIVERY_SECTION_MS,
  REPLY_TRIGGER,
  hasAnyReply,
  collectReplyBatch,
  restoreReplyBatch,
  markReplyBatchSeen,
  deliverAwakeReplyBatch,
  resetReplyDeliveryForTests,
}
