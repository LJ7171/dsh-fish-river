/**
 * passport.js —— 渠道护照
 *
 * 每个渠道只有两格只读元数据，写的是场合，不是性格：
 *   accountOf  这个号是家门还是出门号
 *   bond       这一场是近场合还是公共场
 *
 * 默认（用户已更正）：
 *   微信 home / close —— 绑定会话整渠近场合
 *   知乎 home / close —— 素材家门；评论另算公共场
 *   B 站 / QQ / 抖音 outing / open —— 登录号是出门号
 *   对上重要的人的私聊（ownerId）一律改记 close，分量仍走现有 isOwner → constitution
 *
 * 不引进 0–100 的权重。群和评论区强制 open，避免群友靠一格配置改她是谁。
 */

export const ACCOUNT_OF = Object.freeze(['home', 'outing'])
export const BOND = Object.freeze(['close', 'open'])

/** 代码默认。设置页可以改号主和档，非法值回落到这里。 */
export const PASSPORT_DEFAULTS = Object.freeze({
  weixin: Object.freeze({ accountOf: 'home', bond: 'close' }),
  zhihu: Object.freeze({ accountOf: 'home', bond: 'close' }),
  bili: Object.freeze({ accountOf: 'outing', bond: 'open' }),
  qq: Object.freeze({ accountOf: 'outing', bond: 'open' }),
  douyin: Object.freeze({ accountOf: 'outing', bond: 'open' }),
  dsh: Object.freeze({ accountOf: 'home', bond: 'close' }),
})

const LABEL = Object.freeze({
  qq: 'QQ',
  bili: 'B站',
  douyin: '抖音',
  weixin: '微信',
  zhihu: '知乎',
  dsh: '这边',
})

/** 家门近聊带进提示词的流水句数。其余场合仍是 8 句。 */
export const HOME_CONTEXT_LINES = 16

/**
 * 这个渠道的护照。知乎不在 channels 里，读 `config.zhihu`。
 * @param {object} [config]
 * @param {string} channel
 */
export function passportOf(config, channel) {
  const name = String(channel ?? '')
  const def = PASSPORT_DEFAULTS[name] ?? { accountOf: 'outing', bond: 'open' }
  const raw = name === 'zhihu' ? (config?.zhihu ?? {}) : (config?.channels?.[name] ?? {})
  const accountOf = ACCOUNT_OF.includes(raw.accountOf) ? raw.accountOf : def.accountOf
  const bond = BOND.includes(raw.bond) ? raw.bond : def.bond
  return { channel: name, accountOf, bond }
}

/** 逗号 / 顿号 / 分号 / 空白隔开的 id，跟 `u_` 前缀的 personId 对得上就算同一个。 */
export function idsMatch(want, got) {
  const ids = String(want ?? '').split(/[,，、;；\s]+/).filter(Boolean)
  const g = String(got ?? '')
  if (!g || !ids.length) return false
  return ids.some((id) => g === id || g === `u_${id}`)
}

/**
 * 这一条落在什么场合。bond 在写入时定格，跟 influence 一样不事后重算。
 *
 *   群、评论 → 一律 open
 *   对上重要的人的私聊、近人名单里的私聊 → close
 *   其余跟渠道护照的默认档走（微信默认整渠 close，出门号默认 open）
 *
 * isClose 只影响场合和提示词，不把 influence 抬成 constitution。
 */
export function resolveOccasion({ channel, kind, personId, isOwner = false, config } = {}) {
  const pass = passportOf(config, channel)
  const k = kind === 'group' || kind === 'comment' ? kind : (kind || 'dm')
  const closeIds = pass.channel === 'zhihu' ? '' : (config?.channels?.[pass.channel]?.closeIds ?? '')
  const dm = k !== 'group' && k !== 'comment'
  const owner = Boolean(isOwner)
  const isClose = dm && !owner && idsMatch(closeIds, personId)
  let bond = pass.bond
  if (!dm) bond = 'open'
  else if (owner || isClose) bond = 'close'
  return {
    channel: pass.channel,
    accountOf: pass.accountOf,
    bond,
    kind: k,
    isOwner: owner,
    isClose,
  }
}

/**
 * 短场合句。事实，不是性格，也不是禁令清单。
 * @param {object} occ resolveOccasion 的返回
 * @param {{material?: boolean, comment?: boolean}} [opts]
 */
export function occasionLine(occ = {}, opts = {}) {
  const label = LABEL[occ.channel] ?? (occ.channel || '这边')
  const comment = opts.comment === true || occ.kind === 'comment'
  if (comment) {
    return occ.channel === 'zhihu' || !occ.channel ? '这是知乎上别人的评论。' : `这是${label}上别人的话。`
  }
  if (occ.channel === 'zhihu') {
    return occ.accountOf === 'outing' ? '这是她在知乎上出门看见的。' : '这是重要的人知乎账号上刷到的。'
  }
  // 素材（刷站、推荐流）不是「跟谁说话」：先按号主判，不要落进「只有你们俩」那句。
  if (opts.material === true) {
    return occ.accountOf === 'home'
      ? `这是她在 ${label} 上，用家里的号看见的。`
      : `这是她在 ${label} 上出门看见的。`
  }
  if (occ.channel === 'weixin' && occ.bond === 'close' && occ.kind !== 'group') {
    return occ.isOwner ? '这是微信，只有你们俩。说话的是重要的人。' : '这是微信，只有你们俩。'
  }
  if (occ.isOwner && occ.bond === 'close') return `这是${label}上，跟重要的人单独说话。`
  if (occ.bond === 'close' && occ.kind !== 'group') return `这是${label}上，只有你们俩。`
  if (occ.accountOf === 'outing') return `这是她在 ${label} 上出门听见的。`
  return `这是${label}上的公共场合。`
}

/** 家门且近场合的私聊多带几句上下文。群和出门号维持原来的句数。 */
export function contextLinesFor(occ, base = 8) {
  if (occ?.accountOf === 'home' && occ?.bond === 'close' && occ?.kind !== 'group' && occ?.kind !== 'comment') {
    return HOME_CONTEXT_LINES
  }
  return base
}

/** 家门私聊可以插到出门消息前面。群不算，哪怕号被标成家门。 */
export function queueRank(msg, config) {
  if (!msg || msg.kind === 'group' || msg.kind === 'comment') return 0
  return passportOf(config, msg.channel).accountOf === 'home' ? 1 : 0
}

/** 同分保持原来的先后。队列空时不要调用。 */
export function nextQueueIndex(queue, config) {
  let best = 0
  let bestScore = queueRank(queue[0], config)
  for (let i = 1; i < queue.length; i++) {
    const score = queueRank(queue[i], config)
    if (score > bestScore) {
      best = i
      bestScore = score
    }
  }
  return best
}
