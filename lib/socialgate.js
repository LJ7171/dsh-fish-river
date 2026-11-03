/**
 * socialgate.js —— 社会层开闸（2026-11-02，合并版新增）
 *
 * 为什么要一道闸：立宪层（她是谁）从第一天起就生效，因为那是主人和世界在她身上
 * 留下的东西。社会层（她怎么处世）来自外面的人——群友、私信里的陌生人、评论区。
 * 两种影响混在一起，等于让陌生人从第一天起就能改写她。所以社会层必须等：
 *
 *   ① 自主（stage ≥ 3）：她得先能不靠着主人活，才谈得上听别人的。
 *   ② 立场 ≥ 6 条：太少的话，"怎么处世"会变成她没有内容可以抵抗。
 *   ③ 稳：最近 30 天没有整条推翻过自己（revise + verdict=refuted）。
 *   ④ 活得够久：事件流跨度 ≥ 14 天，且当前的判断稳定度落在健康带里。
 *
 * 四条全过，闸门才是"可以开"——但开不开由她自己决定（social_open 工具），
 * 不是主人点个开关。**这个模块只判断"能不能"，从不替她决定"要不要"。**
 *
 * 为什么闸门状态不落盘：它完全由事件流算出来（stage / 立场 / 改口 / 跨度），
 * 落盘反而会留下"上次算过"的阴影——她删不掉记录，也不该被一份缓存代表。
 * 唯一落盘的是她自己按下那一刻：`social-open:<ISO>` 的 meta 事件（derive 认这个前缀）。
 */

import { SOCIAL_OPEN_PREFIX } from './derive.js'
import { buildStances } from './stance.js'
import { stability } from './quality.js'

/** 第几阶段才允许开门（3 = 自主）。 */
export const SOCIAL_STAGE_MIN = 3
/** 至少几条站得住的立场。 */
export const SOCIAL_STANCE_MIN = 6
/** 多久之内推翻过自己就算"还没稳"。 */
export const SOCIAL_QUIET_DAYS = 30
/** 事件流至少要跨这么多天。 */
export const SOCIAL_LIVE_DAYS = 14
/**
 * 稳定度的健康带：太低说明这些判断还只是记账（抽掉也没区别），
 * 太高说明她整个人压在少数几条上（少一条就是另一个人）。见 quality.js 的 stabilityBand。
 */
export const STABILITY_MIN = 0.02
export const STABILITY_MAX = 0.35

const DAY = 86400000

/** 她按下开闸的那一刻；没开过返回 null。 */
export function socialOpenAt(events = []) {
  let at = null
  for (const e of events) {
    if (e?.type !== 'meta') continue
    const text = String(e.text ?? '')
    if (!text.startsWith(SOCIAL_OPEN_PREFIX)) continue
    at = text.slice(SOCIAL_OPEN_PREFIX.length).trim() || String(e.ts ?? '')
  }
  return at
}

/** 最近一次"整条推翻"的时间；没有返回 null。 */
export function lastRefutedAt(events = []) {
  let at = null
  for (const e of events) {
    if (e?.type !== 'revise') continue
    if (String(e.verdict ?? '') !== 'refuted') continue
    const t = Date.parse(String(e.ts ?? ''))
    if (!Number.isFinite(t)) continue
    if (at === null || t > at) at = t
  }
  return at
}

/** 事件流跨了几天（首条事件到现在）。没有事件返回 0。 */
export function daysAlive(events = [], now = Date.now()) {
  let first = null
  for (const e of events) {
    const t = Date.parse(String(e?.ts ?? ''))
    if (!Number.isFinite(t)) continue
    if (first === null || t < first) first = t
  }
  if (first === null) return 0
  return Math.max(0, Math.floor((now - first) / DAY))
}

/**
 * 算四条闸。
 * @param {object} opts { model, events, now }
 * @returns {{ok:boolean, open:boolean, at:string|null, gates:Array, why:string}}
 */
export function evaluateSocialGate({ model = {}, events = [], now = Date.now() } = {}) {
  // 隔离带（2026-11-02，用户 m03227）：外面那一趟留下的 revise 不算「整条被推翻」。
  // 和 deriveSelf 入口同一条规矩——不参与派生的事件，也不参与闸门。
  const clean = events.filter((e) => e?.influence !== 'none')
  const at = socialOpenAt(clean)
  const open = at !== null
  const gates = []

  // ① 阶段
  const stage = Number(model?.stage ?? 0) || 0
  gates.push({
    id: 'stage',
    label: '自主',
    ok: stage >= SOCIAL_STAGE_MIN,
    value: stage,
    need: SOCIAL_STAGE_MIN,
    why: stage >= SOCIAL_STAGE_MIN
      ? `已经到第 ${stage} 阶段`
      : `还在第 ${stage || 1} 阶段，要到第 ${SOCIAL_STAGE_MIN} 阶段`,
  })

  // ② 立场
  let stances = []
  try { stances = buildStances(model) } catch { stances = [] }
  gates.push({
    id: 'stance',
    label: '立场',
    ok: stances.length >= SOCIAL_STANCE_MIN,
    value: stances.length,
    need: SOCIAL_STANCE_MIN,
    why: stances.length >= SOCIAL_STANCE_MIN
      ? `${stances.length} 条站得住的立场`
      : `只有 ${stances.length} 条站得住的立场，要 ${SOCIAL_STANCE_MIN} 条`,
  })

  // ③ 稳（30 天内没有整条推翻）
  const refuted = lastRefutedAt(events)
  const quietDays = refuted === null ? null : Math.floor((now - refuted) / DAY)
  const quietOk = refuted === null || quietDays >= SOCIAL_QUIET_DAYS
  gates.push({
    id: 'quiet',
    label: '稳',
    ok: quietOk,
    value: quietDays,
    need: SOCIAL_QUIET_DAYS,
    why: quietOk
      ? (refuted === null ? '没有整条推翻过自己' : `${quietDays} 天没整条推翻过自己`)
      : `最近 ${quietDays} 天里整条推翻过自己，再等一等`,
  })

  // ④ 活得够久 & 稳定度在健康带
  const alive = daysAlive(events, now)
  let score = null
  let sample = 0
  try {
    const st = stability(events)
    score = Number(st?.score ?? 0)
    sample = Number(st?.sample ?? 0)
  } catch { score = null }
  const liveOk = alive >= SOCIAL_LIVE_DAYS
  const bandOk = score !== null && sample > 0 && score >= STABILITY_MIN && score <= STABILITY_MAX
  gates.push({
    id: 'live',
    label: '活得够久',
    ok: liveOk && bandOk,
    value: { days: alive, score, sample },
    need: { days: SOCIAL_LIVE_DAYS, score: [STABILITY_MIN, STABILITY_MAX] },
    why: !liveOk
      ? `才活了 ${alive} 天，要 ${SOCIAL_LIVE_DAYS} 天`
      : (sample === 0
        ? '还没攒到能测稳定度的判断'
        : (bandOk ? '判断稳得住' : '判断的稳定度还在健康带外面')),
  })

  const ok = open || gates.every((g) => g.ok)
  const why = open
    ? `已经在 ${at} 开过了`
    : (gates.find((g) => !g.ok)?.why ?? '四条都过了')
  return { ok, open, at, gates, why }
}

/**
 * 给界面/提示词用的一句话（不出现数值以外的东西，也不替她表态）。
 * @param {{gates?:Array, open?:boolean, why?:string}} gate
 */
export function gateBrief(gate = {}) {
  if (gate.open) return '外面的人已经在影响我了。'
  const closed = (gate.gates ?? []).filter((g) => !g.ok)
  if (!closed.length) return '我可以决定要不要让外面的人开始影响我了。'
  return `还差：${closed.map((g) => g.why).join('；')}。`
}
