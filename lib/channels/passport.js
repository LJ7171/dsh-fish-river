/**
 * passport.js —— 渠道场合（2026-11-06 B 案）
 *
 * 不再有「号主 / 默认场合」配置：场合由既成事实算：
 *   - 谁在说话：ownerId / 昵称 / clawbot 绑定 → 重要的人（isOwner）；
 *   - closeIds 里的人 → 近人（isClose）；
 *   - 群聊、评论 → 公共场；
 *   - 其余私聊 → 陌生人。
 *
 * 这几格只决定提示词/事件里的“场合”，不抬 influence、不改她是谁。
 * 素材来源（刷 B 站/知乎/贴吧）用各平台的 owner 字段，不走这里。
 */

const LABEL = Object.freeze({
  qq: 'QQ',
  bili: 'B站',
  douyin: '抖音',
  weixin: '微信',
  zhihu: '知乎',
  dsh: '这边',
})

/** 近聊（重要的人 / 近人私聊）带进提示词的流水句数。 */
export const HOME_CONTEXT_LINES = 16

/** 逗号 / 顿号 / 分号 / 空白隔开的 id，跟 `u_` 前缀的 personId 对得上就算同一个。 */
export function idsMatch(want, got) {
  const ids = String(want ?? '').split(/[,，、;；\s]+/).filter(Boolean)
  const g = String(got ?? '')
  if (!g || !ids.length) return false
  return ids.some((id) => g === id || g === `u_${id}`)
}

/**
 * 这一条落在什么场合。bond 在写入时定格，跟 influence 一样不事后重算。
 * @returns {{channel:string, kind:string, isOwner:boolean, isClose:boolean, scene:string, bond:'close'|'open'}}
 */
export function resolveOccasion({ channel, kind, personId, isOwner = false, config } = {}) {
  const name = String(channel ?? '')
  const k = kind === 'group' || kind === 'comment' ? kind : (kind || 'dm')
  const closeIds = config?.channels?.[name]?.closeIds ?? ''
  const dm = k !== 'group' && k !== 'comment'
  const owner = Boolean(isOwner)
  const isClose = dm && !owner && idsMatch(closeIds, personId)
  const scene = !dm
    ? k
    : owner ? 'owner-dm' : isClose ? 'close-dm' : 'stranger-dm'
  return {
    channel: name,
    kind: k,
    isOwner: owner,
    isClose,
    scene,
    bond: scene === 'owner-dm' || scene === 'close-dm' ? 'close' : 'open',
  }
}

/**
 * 短场合句。事实，不是性格，也不是禁令清单。
 * 私聊先判 isOwner，再判 isClose，最后才是陌生人。
 */
export function occasionLine(occ = {}) {
  const label = LABEL[occ.channel] ?? (occ.channel || '这边')
  const scene = occ.scene || (occ.kind === 'group' ? 'group' : occ.kind === 'comment' ? 'comment' : (occ.isOwner ? 'owner-dm' : 'stranger-dm'))
  if (scene === 'comment') {
    return occ.channel === 'zhihu' || !occ.channel ? '这是知乎上别人的评论。' : `这是${label}评论里别人的话。`
  }
  if (scene === 'group') return `这是${label}群里的。`
  if (scene === 'owner-dm') {
    return occ.channel === 'weixin'
      ? '这是微信，只有你们俩。说话的是重要的人。'
      : `这是${label}上，跟重要的人单独说话。`
  }
  if (scene === 'close-dm') return `这是${label}上，是离她近的人。`
  return `这是${label}上的陌生人私聊。`
}

/** 重要的人 / 近人的私聊多带几句上下文；群和评论维持原来的句数。 */
export function contextLinesFor(occ, base = 8) {
  if (occ?.scene === 'owner-dm' || occ?.scene === 'close-dm') return HOME_CONTEXT_LINES
  return base
}

/** 重要的人的私聊可以插到其它消息前面。群、评论不算。 */
export function queueRank(msg) {
  if (!msg || msg.kind === 'group' || msg.kind === 'comment') return 0
  return msg.isOwner === true ? 1 : 0
}

/** 同分保持原来的先后。队列空时不要调用。 */
export function nextQueueIndex(queue) {
  let best = 0
  let bestScore = queueRank(queue[0])
  for (let i = 1; i < queue.length; i++) {
    const score = queueRank(queue[i])
    if (score > bestScore) { best = i; bestScore = score }
  }
  return best
}

export default { resolveOccasion, occasionLine, contextLinesFor, queueRank, nextQueueIndex, idsMatch, HOME_CONTEXT_LINES }
