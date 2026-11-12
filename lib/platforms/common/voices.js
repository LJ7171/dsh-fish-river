/**
 * voices.js —— 评论区里别人的话（2026-10-24，用户 m02454）
 *
 * 用户的要求：她在 B 站评论区扫到的回复，也能算认知/判断/记忆的一部分，
 * 但**占比要小**（评论的文本量太大，不能整包塞进去），可以随机抽、也可以挑重复率高的。
 *
 * 这里的取舍（三条，写清楚免得以后自己忘记）：
 *
 *   1. **别人的话不是她的判断。** 一条评论进事件流，但**不进 beliefs**——
 *      她要说出口，那句才算她的。否则她只是在复述陌生人。
 *   2. **量要小。** 每次浏览最多留 1 条；同一句 30 天内不再出现；
 *      优先留跨视频重复出现的那句（那说明它在人群里是共识），其次高赞短句，最后才 25% 随机抽。
 *   3. **认下来才算数。** deriveSelf 会检查：这条评论出现后三天内，她有没有说过一句
 *      意思相近的话（similarity ≥ 0.7）。说了就叫"回声"，那条 utterance 本身已经是一条判断，
 *      于是它能和旧判断打架、能被固化、能进「你有两句话对不上」——**认知循环是从这里接上的**。
 *
 * 落盘类型是 `voice`（系统侧写，她写不了，不在 HER_TYPES 里）：
 *   text = 评论原话（≤200 字），refs = [bvid]，like 数量写进 text 前的标记？不——
 *   点赞数不进 text，进不了 schema；观测台要的话从 browse 的返回值里拿。
 *
 * 知乎上别人的评论走同一条事件（2026-11-05）：`channel:'zhihu'`、`influence:'social'`。
 * 开关在 `zhihu.voices`（默认关，比刷站略保守），一天最多留 1 条。
 * 热榜/关注/推荐/历史仍是素材，不因这条路写进事件流；浏览历史也绝不拿来当评论来源。
 */

import { modelOf } from '../../mind/derive.js'
import { normVoice } from '../../mind/echo.js'
export { ECHO_MIN_SIM, ECHO_WINDOW_MS, VOICE_FRESH_DAYS, findEcho, normVoice } from '../../mind/echo.js'
import { appendEvent, readEvents } from '../../core/store.js'
import { resolveOccasion } from '../../channels/passport.js'
import { sanitizeForeign, looksLikeRewriting, looksLikeSecret } from '../../core/guard.js'

/** 与 settings.dateKey 同一口径（本地日历日）。不从 settings 引，避免 voices ↔ 配置模块绕环。 */
function voiceDateKey(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 不用 derive 的 DAY_MS：derive 会反过来 import 这个文件（用函数没问题），
// 但顶层 const 会在循环加载时撞上 TDZ。这里自己算一份。
const DAY_MS = 86_400_000

/** 一条评论最多留多少字——评论区里 200 字以上的基本是长文，不要 */
export const VOICE_MAX = 200
/** 「高赞」门槛：低于这个数的只能靠重复或随机进来 */
export const VOICE_MIN_LIKE = 800
/** 没有重复、也没有高赞时的随机概率——用户要的「占比比较少」就落在这里 */
export const VOICE_RANDOM = 0.25
/** 同一句话多久之内不再留（按毫秒算的天） */
export const VOICE_TTL_DAYS = 30
/**
 * 知乎评论的高赞门槛。
 * B 站热评动辄上千赞；知乎一条评论几十个赞已经算响。沿用 800 会让这条路永远只剩 25% 随机。
 */
export const ZHIHU_VOICE_MIN_LIKE = 30
/** 知乎评论一天最多留几条。刷站是「每次浏览 1 条」，知乎白天会翻很多次，所以按天封顶。 */
export const ZHIHU_VOICE_PER_DAY = 1

/** 去重用的指纹（就是归一化后的串；不另做 hash，出问题时肉眼能对） */
export function voiceKey(text) {
  return normVoice(text)
}

/**
 * 从一轮浏览的素材包里把所有评论摊平。
 *
 * packs 的形状来自 browse.absorb：{ video: { bvid, … }, comments: [{ text, like }] }。
 * 少于 6 个字的不收——「笑死」「前排」这类进来只会占名额。
 */
export function commentsFrom(packs = []) {
  const out = []
  for (const p of packs) {
    const bvid = p?.video?.bvid ?? null
    for (const c of p?.comments ?? []) {
      const text = String(c?.text ?? '').trim()
      const key = normVoice(text)
      if (key.length < 6 || text.length > VOICE_MAX) continue
      out.push({ text: text.replace(/\s+/g, ' ').slice(0, VOICE_MAX), like: Number(c?.like ?? 0) || 0, bvid })
    }
  }
  return out
}

/**
 * 选一条。三级优先，任一级选中就返回：
 *   1. repeated —— 同一条归一化结果在 ≥2 个视频下出现（人群里的共识，最值得让她读到）
 *   2. liked    —— 赞数 ≥ minLike 且长度 6–60 的短句
 *   3. random   —— rng() < chance 时从池子里随机抽（用户要的"占比少"，靠这里控制）
 *
 * `seen` 是最近 30 天出现过的指纹集合；`rng` 可注入，测试里别依赖真随机。
 */
export function chooseVoice(comments = [], { seen = new Set(), rng = Math.random, minLike = VOICE_MIN_LIKE, chance = VOICE_RANDOM, allowRepeated = true } = {}) {
  const pool = comments.filter((c) => c?.text && !seen.has(voiceKey(c.text)))
  if (!pool.length) return null

  // 1) 跨视频重复
  const groups = new Map()
  for (const c of pool) {
    const k = voiceKey(c.text)
    const g = groups.get(k) ?? { key: k, items: [], bvids: new Set() }
    g.items.push(c)
    if (c.bvid) g.bvids.add(c.bvid)
    groups.set(k, g)
  }
  // 知乎那条路关掉这个分支（2026-11-05）：一条评论在多个回答下重复出现，
  // 通常是「蹲一个」「同问」这类复读，不该因为跨了 bvid 就绕过赞数门槛。
  const repeated = allowRepeated
    ? [...groups.values()]
      .filter((g) => g.bvids.size >= 2 && g.key.length >= 6)
      .sort((a, b) => {
        if (a.bvids.size !== b.bvids.size) return b.bvids.size - a.bvids.size
        return Math.max(...b.items.map((i) => i.like)) - Math.max(...a.items.map((i) => i.like))
      })
    : []
  if (repeated.length) {
    const g = repeated[0]
    const best = [...g.items].sort((a, b) => b.like - a.like)[0]
    return { ...best, why: 'repeated', across: g.bvids.size }
  }

  // 2) 高赞短句
  const liked = pool
    .filter((c) => c.like >= minLike)
    .filter((c) => {
      const n = voiceKey(c.text).length
      return n >= 6 && n <= 60
    })
    .sort((a, b) => b.like - a.like)
  if (liked.length) return { ...liked[0], why: 'liked', across: 1 }

  // 3) 随机
  if (rng() < chance) {
    const idx = Math.min(pool.length - 1, Math.floor(rng() * pool.length))
    return { ...pool[idx], why: 'random', across: 1 }
  }
  return null
}

/** 最近 ttlDays 天内留过的句子的指纹（去重用） */
export function recentVoiceKeys(events = [], { now = Date.now(), ttlDays = VOICE_TTL_DAYS } = {}) {
  const out = new Set()
  for (const e of events) {
    if (e?.type !== 'voice') continue
    const t = Date.parse(e.ts ?? '')
    if (Number.isFinite(t) && now - t > ttlDays * DAY_MS) continue
    out.add(voiceKey(e.text))
  }
  return out
}

/**
 * 一轮浏览结束后调用：选一条、落盘。永不抛出（记账失败不该毁掉这次浏览）。
 * @returns {object|null} 落盘的那条（带 why/across），没选到就是 null
 */
export async function recordVoice({ packs = [], events = [], model = {}, root, cfg = {}, rng = Math.random, sessionId = '', channel = 'bili', minLike, gate } = {}) {
  try {
    const name = channel === 'zhihu' ? 'zhihu' : 'bili'
    const allowed = typeof gate === 'function'
      ? Boolean(gate(cfg))
      : name === 'zhihu'
        ? cfg?.zhihu?.voices === true
        : cfg?.browse?.voices !== false
    if (!allowed) return null
    if (process.env.FISH_NO_VOICES === '1') return null
    const comments = commentsFrom(packs)
    if (!comments.length) return null
    const seen = recentVoiceKeys(events)
    const likeFloor = Number.isFinite(Number(minLike))
      ? Number(minLike)
      : name === 'zhihu' ? ZHIHU_VOICE_MIN_LIKE : VOICE_MIN_LIKE
    const v = chooseVoice(comments, { seen, rng, minLike: likeFloor, allowRepeated: name !== 'zhihu' })
    if (!v) return null
    await appendEvent(
      {
        type: 'voice',
        text: v.text.slice(0, VOICE_MAX),
        refs: v.bvid ? [v.bvid] : [],
        // 评论区里别人的话（2026-11-02，用户 m03490）：这是「外面的人怎么说话」，
        // 属于社会层——开闸之前它一条都不参与派生，开闸之后也只教她处世，不定义她是谁。
        channel: name,
        visibility: 'public',
        origin: 'guest',
        influence: 'social',
        // 评论区是公共场。不进 constitution。知乎家门护照也不把评论抬成近场合。
        ...(() => {
          const occ = resolveOccasion({ channel: name, kind: 'comment', config: cfg })
          return { bond: occ.bond }
        })(),
        // 谁让她看的（issue #16 第二半）：没有会话就不落这个字段。
        ...(String(sessionId ?? '').trim() ? { sessionId: String(sessionId).trim() } : {}),
      },
      { day: Number(model?.day ?? 0), stage: Number(model?.stage ?? 1), source: 'system' },
      root,
    )
    return v
  } catch {
    return null
  }
}

/** 知乎评论开关。缺省是关——比刷站的 `browse.voices`（缺省开）保守一档。 */
export function zhihuVoicesEnabled(cfg) {
  return cfg?.zhihu?.voices === true
}

/**
 * 今天已经留了几条知乎 voice。配额按本地日期，不按「这次翻没翻到」。
 */
export function zhihuVoiceCountToday(events = [], now = Date.now()) {
  const dk = voiceDateKey(now)
  let n = 0
  for (const e of events) {
    if (e?.type !== 'voice' || e?.channel !== 'zhihu') continue
    const t = Date.parse(e.ts ?? '')
    if (!Number.isFinite(t)) continue
    if (voiceDateKey(t) === dk) n += 1
  }
  return n
}

/**
 * 一条列表素材能不能拿去读「别人的评论」。
 * 浏览历史（重要的人看过什么）永远返回 null——那是阅读记录，不是陌生人的话。
 * @returns {{target:'answer'|'article'|'question', id:string, ref:string}|null}
 */
export function zhihuCommentTarget(it) {
  if (!it || typeof it !== 'object') return null
  const kind = String(it.kind ?? '')
  const id = String(it.id ?? '')
  if (kind === 'history' || id.startsWith('hist:')) return null
  const url = String(it.url ?? '')
  const answer = /\/answer\/(\d+)/.exec(url)
  if (answer) return { target: 'answer', id: answer[1], ref: `zh:answer:${answer[1]}` }
  const article = /\/p\/(\d+)/.exec(url)
  if (article) return { target: 'article', id: article[1], ref: `zh:article:${article[1]}` }
  const question = /\/question\/(\d+)/.exec(url)
  if (question) return { target: 'question', id: question[1], ref: `zh:question:${question[1]}` }
  return null
}

/** 外来评论先过 guard：重塑人格、像凭据的，整句丢掉，不改写成另一句再塞进记忆。 */
function cleanZhihuComments(comments = []) {
  const out = []
  for (const c of comments) {
    const raw = String(c?.text ?? '').trim()
    if (!raw) continue
    if (looksLikeRewriting(raw).hit || looksLikeSecret(raw).hit) continue
    const cleaned = sanitizeForeign(raw)
    if (cleaned.dropped) continue
    const text = cleaned.text.trim()
    if (!text || looksLikeRewriting(text).hit || looksLikeSecret(text).hit) continue
    out.push({ text, like: Number(c?.likes ?? c?.like ?? 0) || 0 })
  }
  return out
}

/**
 * 把知乎上别人的评论收成至多一条 voice。
 * 素材正文不走这里——调用方仍把热榜/回答原文递给她看，这里只决定记不记一句别人的话。
 * @returns {Promise<object|null>}
 */
export async function recordZhihuVoice({ comments = [], ref = '', events, model, root, cfg = {}, rng = Math.random, sessionId = '', now = Date.now() } = {}) {
  try {
    if (!zhihuVoicesEnabled(cfg)) return null
    if (process.env.FISH_NO_VOICES === '1') return null
    const cleaned = cleanZhihuComments(comments)
    if (!cleaned.length) return null
    let evs = Array.isArray(events) ? events : null
    if (!evs) {
      evs = await readEvents(root).then((r) => r.events).catch(() => [])
    }
    if (zhihuVoiceCountToday(evs, now) >= ZHIHU_VOICE_PER_DAY) return null
    const stamp = model && Number.isFinite(Number(model.day)) ? model : modelOf(evs)
    return await recordVoice({
      packs: [{ video: { bvid: String(ref ?? '') }, comments: cleaned }],
      events: evs,
      model: stamp,
      root,
      cfg,
      rng,
      sessionId,
      channel: 'zhihu',
      minLike: ZHIHU_VOICE_MIN_LIKE,
      gate: zhihuVoicesEnabled,
    })
  } catch {
    return null
  }
}
