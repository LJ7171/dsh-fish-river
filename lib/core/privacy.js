/**
 * privacy.js —— 「主人能看到哪些私聊」的唯一口径。
 *
 * 2026-11-02 / AGENTS §9：私聊事件只对该 person 可见，连主人都看不到原文。
 * 以前这条只写在 `guard.visibleTo()` 里，生产代码没有调用点；现在在
 * owner 侧的只读接口（/events /status /reports /channels）统一走这里。
 *
 * 两条边界：
 *   - **只脱敏正文**，保留类型、时间、person id：面板仍能看见「有人私聊过她」，
 *     但看不到别人说了什么；这不是删除记录，事件流本身不变。
 *   - **她自己翻记忆（`her_recall`）不经过这里**：那是她自己的经历，
 *     不是给主人看的窗口。对外引用仍由 `leakcheck` 的出站闸拦。
 */

export const PRIVATE_REDACTED = '（别人的私聊，原文不显示）'

/** 每个渠道上「重要的人」的 id 集合；裸 id 与 `u_` 前缀两种写法都收。 */
export function ownerIdSets(config = {}) {
  const out = new Map()
  for (const [name, c] of Object.entries(config?.channels ?? {})) {
    const raw = String(c?.ownerId ?? '').trim()
    if (!raw) continue
    const set = new Set()
    for (const id of raw.split(/[,，、;；\s]+/).filter(Boolean)) {
      set.add(id)
      set.add(id.startsWith('u_') ? id.slice(2) : `u_${id}`)
    }
    out.set(String(name), set)
  }
  return out
}

/**
 * 这条私有事件能不能给主人看原文。
 * 非私有事件一律可见；私有事件只有「主人自己说的 / 主人 id 对得上」才可见。
 * 没有 origin 的老事件按 person 是否等于 ownerId 判——宁可多遮，不漏。
 */
export function isOwnerEvent(ev, sets = new Map()) {
  if (!ev || ev.visibility !== 'private') return true
  if (ev.origin === 'owner') return true
  const set = sets.get(String(ev.channel ?? ''))
  return Boolean(set && set.has(String(ev.person ?? '')))
}

/** 一条事件 → 给主人看的版本（不改原对象）。 */
export function redactEvent(ev, sets = new Map()) {
  if (!ev || ev.visibility !== 'private' || isOwnerEvent(ev, sets)) return ev
  return { ...ev, text: PRIVATE_REDACTED, redacted: true }
}

/** 事件流 → 给主人看的版本。只换私有非主人事件的 text，别的一字不动。 */
export function redactEvents(events, config = {}) {
  const sets = ownerIdSets(config)
  const list = Array.isArray(events) ? events : []
  return list.map((ev) => redactEvent(ev, sets))
}

/** 派生出来的信念（`/social`）按来源事件 id 反查可见性。 */
export function redactBeliefsForOwner(beliefs, events, config = {}) {
  const sets = ownerIdSets(config)
  const byId = new Map((Array.isArray(events) ? events : []).map((e) => [String(e?.id ?? ''), e]))
  return (Array.isArray(beliefs) ? beliefs : []).map((b) => {
    const ev = byId.get(String(b?.id ?? ''))
    if (!ev) return b
    const visible = isOwnerEvent({ visibility: ev.visibility, origin: ev.origin, channel: ev.channel, person: ev.person }, sets)
    return visible ? b : { ...b, text: PRIVATE_REDACTED, redacted: true }
  })
}

/** 流水里一个线程的预览能不能给主人看：群/评论可见，私聊只有主人那个会话可见。 */
export function redactThreads(threads, config = {}) {
  const sets = ownerIdSets(config)
  return (Array.isArray(threads) ? threads : []).map((t) => {
    if (!t || t.kind === 'group' || t.kind === 'comment') return t
    const set = sets.get(String(t.channel ?? ''))
    if (set && set.has(String(t.conversationId ?? ''))) return t
    return { ...t, preview: PRIVATE_REDACTED, redacted: true }
  })
}

export default {
  PRIVATE_REDACTED,
  ownerIdSets,
  isOwnerEvent,
  redactEvent,
  redactEvents,
  redactBeliefsForOwner,
  redactThreads,
}
