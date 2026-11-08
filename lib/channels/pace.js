/**
 * pace.js —— 进站之前的两件节奏事
 *
 * 1. 静默窗：同一会话（渠道 + 对方）里连着来的几条，先攒着，到点并成一次再想。
 *    新的一条会把计时清掉重来。0 表示关。
 *    默认按场合：重要的人、家门近聊大约 2 秒；群（含出门的群）不等。
 *    刷站、看画面、素材不读这里。
 *
 * 2. 确认静默：整段去掉空白之后只是一声确认、单独一个表情，或单独一个句号 / 省略号，
 *    就不叫醒她。带着新内容、问句、点名，仍走原来的调度。
 *
 * 两件都是「要不要现在问她」，不是她是谁。不进 beliefs，不改 influence。
 */

/** 家门近聊、重要的人私聊：等这么久再开一轮。 */
export const HOME_CLOSE_SILENCE_MS = 2000
/** 静默窗上限。再长就像把人晾着。 */
export const SILENCE_MAX_MS = 60000

/**
 * 整段正好是这些，才当成确认。设置页可以改这份短名单。
 * 问句、点名、多出来的内容不在这里判断——那些根本对不上整段。
 */
export const DEFAULT_ACK_PHRASES = Object.freeze([
  '嗯', '嗯嗯', '嗯嗯嗯', '嗯呢', '嗯啊',
  '好', '好的', '好呀', '好啊', '好哦', '好哒', '好滴', '好吧',
  'ok', 'okay', 'okk',
  '收到', '收到了',
  '行', '行的', '行吧',
  '可以', '可以的',
  '哈哈', '哈哈哈', '哈哈哈哈',
  '呵呵', '嘿嘿',
  '对', '对的', '是', '是的',
  '知道了', '了解', '明白', '懂了', '晓得',
])

function imOf(config) {
  return config?.im ?? config?.config?.im
}

/**
 * 这一场要等多久再开一轮思考。
 * 显式数字（含 0）盖过场合默认。缺键或 null 才按场合。
 *
 * @param {object} [occ] resolveOccasion 的返回
 * @param {object} [config]
 * @returns {number} 毫秒，0 = 不等
 */
export function silenceMsFor(occ, config) {
  const im = imOf(config)
  if (im && Object.prototype.hasOwnProperty.call(im, 'inboundSilenceMs')) {
    const v = im.inboundSilenceMs
    if (v != null && v !== '') {
      const n = Number(v)
      if (Number.isFinite(n)) return Math.max(0, Math.min(SILENCE_MAX_MS, Math.round(n)))
    }
  }
  if (!occ || occ.kind === 'group' || occ.kind === 'comment') return 0
  if (occ.isOwner) return HOME_CLOSE_SILENCE_MS
  if (occ.isClose === true) return HOME_CLOSE_SILENCE_MS
  return 0
}

/** 确认静默默认开。只有显式 false 才关。 */
export function ackSilenceOn(config) {
  return imOf(config)?.ackSilence !== false
}

/** 短名单。缺键用默认；显式空数组就是空的（表情和单独句号仍算）。 */
export function ackPhrasesOf(config) {
  const list = imOf(config)?.ackPhrases
  if (!Array.isArray(list)) return [...DEFAULT_ACK_PHRASES]
  return list.map((s) => String(s ?? '').trim()).filter(Boolean)
}

/** 同一会话：渠道 + 这场 + 对方。群里不同的人各算各的。 */
export function sessionKey(msg) {
  const channel = String(msg?.channel ?? '')
  const kind = msg?.kind === 'group' ? 'group' : 'dm'
  const conv = String(msg?.conversationId ?? '')
  const person = String(msg?.personId ?? '')
  return `${channel}:${kind}:${conv}:${person}`
}

function graphemes(s) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map((x) => x.segment)
  }
  return [...s]
}

function isLoneEmoji(s) {
  const g = graphemes(s)
  if (g.length !== 1) return false
  return /\p{Extended_Pictographic}/u.test(g[0])
}

function isLoneMark(s) {
  return s === '。' || s === '.' || s === '…' || s === '...' || s === '……'
}

/**
 * 这一小段是不是纯确认。
 * 问号和 @ 直接不算——那是在问，或在点名。
 * 句尾带一个句号、感叹号、波浪线，仍算同一声确认（「好的。」「嗯！」）。
 *
 * @param {string} text
 * @param {string[]} [phrases]
 */
export function isAckOnly(text, phrases = DEFAULT_ACK_PHRASES) {
  const raw = String(text ?? '').trim()
  if (!raw) return false
  if (/[?？@]/.test(raw)) return false
  if (isLoneMark(raw)) return true
  if (isLoneEmoji(raw)) return true
  // 收尾符号不算新内容：「好的。」「嗯！」仍是同一声确认。
  const core = raw.replace(/^[\s~～。.!！…,，、]+|[\s~～。.!！…,，、]+$/g, '')
  if (!core) return false
  const set = new Set((phrases ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))
  return set.has(core.toLowerCase())
}

/**
 * 攒起来的整段：每一行都是确认，才整段不回。
 * 有一行带着新内容，就照常问她。
 */
export function isAckSegment(text, phrases = DEFAULT_ACK_PHRASES) {
  const lines = String(text ?? '').split(/\n+/).map((s) => s.trim()).filter(Boolean)
  if (!lines.length) return false
  return lines.every((line) => isAckOnly(line, phrases))
}

/**
 * 静默窗里攒下的几条，合成一条再交给后面的记账和思考。
 * 文字用换行接上，不丢；图最多四张；有一条点了名，整段就算被点名。
 */
export function mergeHeld(msgs) {
  const list = (Array.isArray(msgs) ? msgs : []).filter(Boolean)
  if (!list.length) return null
  const last = list[list.length - 1]
  const texts = []
  const images = []
  let mentioned = false
  for (const m of list) {
    const t = String(m.text ?? '').trim()
    if (t) texts.push(t)
    if (m.mentionedSelf === true) mentioned = true
    for (const img of Array.isArray(m.images) ? m.images : []) {
      if (images.length >= 4) break
      if (img && !images.includes(img)) images.push(img)
    }
  }
  return {
    ...last,
    text: texts.join('\n'),
    images,
    mentionedSelf: mentioned,
  }
}
