/**
 * leakcheck.js —— 私聊内容的外泄检测
 *
 * 与 `guard.js` 的 `looksLikeLeak` 分工不同：
 *   - `looksLikeLeak` 认的是**形状**（路径、cookie、手机号），不管内容是什么；
 *   - 这个文件认的是**内容**——「这句话是别人在私聊里跟我说的」。
 *
 * 为什么需要它：可见性过滤能挡住「她主动去翻别人的私聊」，挡不住
 * 「她记得，然后用自己的话复述出来」。前者是检索范围问题，后者是泄露问题。
 * 正则认不出「Lily 上周说她老公要出差」——那里面没有任何敏感形状，但它确实是私事。
 *
 * 做法是**字符 n-gram 指纹**，不是语义理解：
 *   私聊里的一段话切成 8 个字一格，存成指纹集；她要发出去的话同样切格，
 *   命中够多格就判泄露。宁可误伤（少说一句），不可漏放（说出去收不回）。
 *
 * 已知局限（写在这里比藏着好）：
 *   - 她**改写**过的话（换词、换语序）可能漏检。这是 n-gram 的天然上限，
 *     所以它只是第二道闸，第一道仍然是「检索时就看不见」。
 *   - 中文没有空格，8 字一格对短句（<8 字）完全不生效——那种句子本来也泄露不了什么。
 */

/** 一格多少字。8 是对中文的折中：再短会误伤常用短语，再长则整句改写就漏。 */
export const SHINGLE = 8
/** 命中多少格才算泄露。3 格 ≈ 连续 10 个字左右的重合。 */
export const HIT_MIN = 3
/** 建索引时最多扫多少条事件：私聊能有几万条，全量建索引没必要。 */
export const INDEX_EVENTS_MAX = 20000

/**
 * 归一化：去空白、去标点符号、全角转半角、小写。
 * 只为了比对，不为了显示——所以不保留任何格式。
 */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * 切成指纹集合。
 * @param {string} text
 * @param {number} [n]
 * @returns {Set<string>}
 */
export function shingles(text, n = SHINGLE) {
  const s = normalize(text)
  const size = Math.max(4, Math.min(16, Number(n) || SHINGLE))
  const out = new Set()
  if (s.length < size) return out
  for (let i = 0; i + size <= s.length; i++) out.add(s.slice(i, i + size))
  return out
}

/**
 * 用事件流建「私聊指纹 → 属于谁」的索引。
 *
 * 只收 `visibility === 'private'` 且有 `person` 的事件：
 * `owner` 级（他和她之间的话）不进这个索引——那些是「家里的事」，
 * 由 `guard.js` 的形状规则与 `visibility` 过滤负责，不按内容拦。
 *
 * @param {Array<object>} events
 * @returns {Map<string, string>}
 */
export function buildIndex(events = [], { n = SHINGLE } = {}) {
  const index = new Map()
  const list = Array.isArray(events) ? events.slice(-INDEX_EVENTS_MAX) : []
  for (const e of list) {
    if (e?.visibility !== 'private') continue
    const who = String(e?.person ?? '')
    if (!who) continue
    const text = String(e?.text ?? '')
    if (text.length < 12) continue
    for (const g of shingles(text, n)) {
      // 先到先得：一句话被两个人说过时，记第一个——反正只要有一个人对不上就拦。
      if (!index.has(g)) index.set(g, who)
    }
  }
  return index
}

/**
 * 这段话里有没有别人的私聊内容。
 *
 * @param {string} text 她准备发出去的话
 * @param {Map<string,string>} index buildIndex 的结果
 * @param {{person?:string, sameAs?:string[], hitMin?:number}} [opts] person = 现在这个听众是谁；
 *   sameAs = 「同一个人在其他渠道的 id」（主人在 B 站是 u_10001、在抖音是昵称，得算一个人）
 * @returns {{hit:boolean, why:string, from:string, matched:number}}
 */
export function looksLikePrivateLeak(text, index, opts = {}) {
  const audience = String(opts.person ?? '')
  // 2026-11-02：同一个人在两个平台是两串 id（B 站 uid / 抖音昵称）。只按字符串比的话，
  // 她跟主人在抖音复述主人在 B 站说过的话，会被当成「外泄别人的私聊」拦掉。
  // 2026-11-03 补：配置里填的是裸 id（`10002`），而事件里的 person 带 `u_` 前缀
  // （`u_10002`）。只比对裸串的话，主人在群聊里被她复述自己的私聊内容也会被误判，
  // 真机踩到（「拦下一条出门的话（leak）」）。所以两种写法都收进同一个集合。
  const same = new Set()
  for (const raw of [audience, ...(Array.isArray(opts.sameAs) ? opts.sameAs.map(String) : [])]) {
    const id = String(raw ?? '').trim()
    if (!id) continue
    same.add(id)
    same.add(id.startsWith('u_') ? id.slice(2) : `u_${id}`)
  }
  const hitMin = Math.max(1, Number(opts.hitMin) || HIT_MIN)
  const none = { hit: false, why: '', from: '', matched: 0 }
  if (!(index instanceof Map) || index.size === 0) return none
  const parts = shingles(text)
  if (!parts.size) return none
  let matched = 0
  let from = ''
  for (const g of parts) {
    const owner = index.get(g)
    if (!owner) continue
    // 听众本人说过的话不算法泄露：那是「我们俩的事」，当面对他说没问题。
    if (same.has(owner)) continue
    matched++
    if (!from) from = owner
  }
  if (matched < hitMin) return { ...none, matched }
  return { hit: true, why: 'private-recall', from, matched }
}
