/**
 * gate.js —— 该不该接这句话
 *
 * 渠道层唯一一个**做判断**的地方，其余都在搬运。
 * 判断分两类，混在一起就会出事：
 *
 *   1. **环境类**（用户可配）：这个群在不在白名单、一天回几句、隔多久回一句。
 *      这些改了不会让她变成另一个人，只改变她出现在哪、多久出现一次。
 *   2. **成长类**（不可配，写死在代码里）：她到第几阶段才搭理陌生人。
 *      这不是"反应速度"，是"她敢不敢跟不认识的人说话"——前两个阶段她连自己是谁
 *      都还没弄清楚，一个陌生群友 @ 她，她凭什么接。
 *
 * 所以第一类从 `config.channels.*` 读，第二类只能读阶段，且**没有配置键**。
 * 用户想让她早点搭理陌生人，办法是陪她走完前两个阶段，不是改一个数字。
 *
 * 这里只回答"要不要问她"，不回答"她会不会回"。后者是她的自由：
 * 我们把她叫醒，她可以一句话不说（见 router.js 的空回合处理）。
 */

/** 她到第几阶段才搭理陌生人。三 = 自主。 */
export const STRANGER_STAGE = 3

/** 一个会话里两条回复之间至少隔多久（毫秒）。防刷屏，也是防她自己被风控。 */
export const REPLY_COOLDOWN_MS = 8000

/** 渠道默认配置。`enabled` 默认全关——装完不配，她哪儿也不去。 */
export const CHANNEL_DEFAULTS = Object.freeze({
  enabled: false,
  replyInGroup: false,
  /** 群号白名单。空数组 = 一个群都不回。私聊不受它管。 */
  groups: [],
  /** 群里只在她被 @ 时开口。2026-11-03 用户要求：192 人的群，主人一说话她就回，太吵。 */
  mentionOnly: true,
  /** 问她之前先等这么久，把连着几条合成一次（毫秒）。0 = 不等。 */
  batchWindowMs: 0,
})

/**
 * 这个渠道的配置，补上缺省值。
 * @param {object} config 全量配置
 * @param {string} channel
 */
export function channelConfig(config, channel) {
  const raw = config?.channels?.[channel]
  const base = raw && typeof raw === 'object' ? raw : {}
  return {
    ...CHANNEL_DEFAULTS,
    ...base,
    groups: Array.isArray(base.groups) ? base.groups.map((g) => String(g).trim()).filter(Boolean) : [],
    enabled: base.enabled === true,
    replyInGroup: base.replyInGroup === true,
    mentionOnly: base.mentionOnly !== false,
  }
}

/**
 * 要不要把这句话递给她。
 *
 * @param {object} p
 * @param {string} p.channel    'qq' | 'bili' | 'douyin'
 * @param {'dm'|'group'} p.kind
 * @param {string} p.conversationId
 * @param {boolean} p.isOwner   这个人是不是他本人
 * @param {boolean} [p.mentioned] 群里这条有没有 @ 她
 * @param {number} p.stage      她现在第几阶段
 * @param {object} p.config     全量配置
 * @param {number} [p.lastReplyAt] 这个会话上一条回复的时间
 * @param {number} [p.now]
 * @returns {{ok:boolean, why:string}}
 */
export function canReply({ channel, kind, conversationId, isOwner, stage, config, mentioned = false, lastReplyAt = 0, now = Date.now() }) {
  const c = channelConfig(config, channel)
  if (!c.enabled) return { ok: false, why: 'channel-off' }
  if (kind === 'group') {
    if (!c.replyInGroup) return { ok: false, why: 'group-reply-off' }
    if (!c.groups.includes(String(conversationId))) return { ok: false, why: 'group-not-allowed' }
    // 群聊默认只在被 @ 时开口：群里几十号人聊天，她不该每条都接。
    if (c.mentionOnly && mentioned !== true) return { ok: false, why: 'group-not-mentioned' }
  }
  // 陌生人：阶段不够就不叫醒她。她不是客服，没有义务接每一个人的话。
  if (!isOwner && Number(stage) < STRANGER_STAGE) return { ok: false, why: 'stage-too-early' }
  // 冷却只防刷屏：群里连着几十条要压住；主人自己在私聊里连说三句，不该被当成刷屏。
  const ownerDm = isOwner && kind !== 'group'
  if (!ownerDm && lastReplyAt && now - lastReplyAt < REPLY_COOLDOWN_MS) return { ok: false, why: 'cooldown' }
  return { ok: true, why: '' }
}

/**
 * 给观测台看的一句话解释。用户最常问的是"为什么她不回我"，
 * 答案是这五个之一，不该让他去翻日志。
 */
export function explain(why) {
  switch (why) {
    case 'channel-off':
      return '这个渠道还没开'
    case 'group-reply-off':
      return '开了渠道，但没允许在群里说话'
    case 'group-not-allowed':
      return '这个群不在白名单里'
    case 'group-not-mentioned':
      return '群里没点她的名（要 @ 她）'
    case 'stage-too-early':
      return `她还没到能搭理陌生人的阶段（要到第 ${STRANGER_STAGE} 阶段）`
    case 'cooldown':
      return '刚回过一句，等一下'
    case 'busy':
      return '她正在回别人'
    default:
      return ''
  }
}
