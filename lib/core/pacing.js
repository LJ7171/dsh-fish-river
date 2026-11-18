/**
 * pacing.js —— 所有平台的数据抓取请求共用一个节奏（2026-11-05，用户要求）
 *
 * 设置页「请求节奏」原来只作用于 B 站客户端；现在知乎、贴吧、抖音推荐页也按同一份
 * 间隔 + 抖动来排队。
 *
 * 2026-11-18（这次改动的补充）：公开写操作（发评论 / 回楼中楼 / 写回答）除了各自
 * 客户端的风控熔断，再加一道**回复间隔**：两条公开回复之间至少错开
 * `maxReplyGapSec × (0.7~1.0)` 秒，避免「有人在评论区回她一句，她一秒就答」。
 * 这一道是跨平台的（三平台共用同一个计时），渠道回话（微信 / QQ / 私信）不走这里。
 *
 * 四个约定：
 *   - 抓取全局串行：一次只放一个请求出去（多平台同时刷也不会叠在一起）；
 *   - 抓取实际间隔 = minIntervalMs + 0..jitterMs 的随机数；
 *   - 写操作实际间隔 = maxReplyGapSec × 0.7~1.0，且只在**真要发出去**之前等；
 *   - 测试/注入 fetch 时绕开：调用方显式给了 fetchImpl 就不在这里等。
 */

// maxReplyGapSec 的 0 不是产品默认值：真实默认（30 秒）由 core/settings 的 DEFAULTS.bili
// 注入，启动时 onConfigLoaded 会把整组 cfg.bili 推进来。模块自己留 0，是为了让
// 单测里直接调平台模块（没走插件启动、没配置过节奏）时不被凭空延迟 30 秒。
const DEFAULTS = Object.freeze({ minIntervalMs: 800, jitterMs: 500, maxReplyGapSec: 0 })

const PACE = { ...DEFAULTS }
let lastAt = 0
let chain = Promise.resolve()
// 上一次真正发出去的公开回复（毫秒）。跨平台共用，进程重启清零。
let lastWriteAt = 0
let writeChain = Promise.resolve()

function num(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

export function setPacing(o = {}) {
  PACE.minIntervalMs = Math.max(200, Math.min(120_000, num(o.minIntervalMs, DEFAULTS.minIntervalMs)))
  PACE.jitterMs = Math.max(0, Math.min(60_000, num(o.jitterMs, DEFAULTS.jitterMs)))
  PACE.maxReplyGapSec = Math.max(0, Math.min(3600, num(o.maxReplyGapSec, DEFAULTS.maxReplyGapSec)))
}

export function getPacing() {
  return { ...PACE }
}

/** 测试用：恢复默认、清掉排队与上次时间。 */
export function resetPacingForTests() {
  PACE.minIntervalMs = DEFAULTS.minIntervalMs
  PACE.jitterMs = DEFAULTS.jitterMs
  PACE.maxReplyGapSec = DEFAULTS.maxReplyGapSec
  lastAt = 0
  chain = Promise.resolve()
  lastWriteAt = 0
  writeChain = Promise.resolve()
}

/**
 * 排一个请求的队。所有平台共用同一个串行队列。
 * @returns {Promise<void>}
 */
export function pace(now = Date.now) {
  chain = chain.then(async () => {
    const gap = PACE.minIntervalMs + Math.floor(Math.random() * Math.max(0, PACE.jitterMs))
    const wait = Math.max(0, lastAt + gap - now())
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastAt = now()
  })
  return chain
}

/** B 站客户端有自己的队列：它发请求时顺手记一下，别的平台才有得等。 */
export function noteRequest(now = Date.now) {
  lastAt = now()
}

/**
 * 距离「下一次允许公开回复」还有多久（毫秒）。
 *
 * 随机系数取 0.7–1.0，所以实际间隔永远不超过配置里的最大值——配置名字叫
 * 「最大回复间隔」，就得真的守住这个上限。0 表示不限制。
 */
export function replyGapMs(now = Date.now()) {
  const max = PACE.maxReplyGapSec * 1000
  if (!(max > 0)) return 0
  const gap = max * (0.7 + Math.random() * 0.3)
  return Math.max(0, lastWriteAt + gap - now)
}

/**
 * 等够回复间隔再说。**只在真的要发出去之前调用**，被校验拒掉的调用不占这个计时。
 *
 * 并发写（理论上不会，工具是一轮一个）也用一条链串起来，避免两个写同时看到
 * 同一个 lastWriteAt 然后一起发出去。
 * @returns {Promise<void>}
 */
export async function waitReplyGap(now = Date.now) {
  const prev = writeChain
  let release = () => {}
  writeChain = new Promise((r) => { release = r })
  try {
    await prev
    const wait = replyGapMs(now())
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastWriteAt = now()
  } finally {
    release()
  }
}

/** 包一层 fetch：每次请求前排一下队。 */
export function pacedFetch(fetchImpl = globalThis.fetch) {
  return async (url, init) => {
    await pace()
    return fetchImpl(url, init)
  }
}

export default { setPacing, getPacing, pace, pacedFetch, noteRequest, replyGapMs, waitReplyGap, resetPacingForTests }
