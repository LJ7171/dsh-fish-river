/**
 * pacing.js —— 所有平台的数据抓取请求共用一个节奏（2026-11-05，用户要求）
 *
 * 设置页「请求节奏」原来只作用于 B 站客户端；现在知乎抓取、抖音推荐页也按同一份
 * 间隔 + 抖动来排队。写操作（发评论/回复）仍由 B 站客户端自己那套风控管，不走这里。
 *
 * 三个约定：
 *   - 全局串行：一次只放一个请求出去（多平台同时刷也不会叠在一起）；
 *   - 实际间隔 = minIntervalMs + 0..jitterMs 的随机数；
 *   - 测试/注入 fetch 时绕开：调用方显式给了 fetchImpl 就不在这里等。
 */

const DEFAULTS = Object.freeze({ minIntervalMs: 800, jitterMs: 500 })

const PACE = { ...DEFAULTS }
let lastAt = 0
let chain = Promise.resolve()

function num(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

export function setPacing(o = {}) {
  PACE.minIntervalMs = Math.max(200, Math.min(120_000, num(o.minIntervalMs, DEFAULTS.minIntervalMs)))
  PACE.jitterMs = Math.max(0, Math.min(60_000, num(o.jitterMs, DEFAULTS.jitterMs)))
}

export function getPacing() {
  return { ...PACE }
}

/** 测试用：恢复默认、清掉排队与上次时间。 */
export function resetPacingForTests() {
  PACE.minIntervalMs = DEFAULTS.minIntervalMs
  PACE.jitterMs = DEFAULTS.jitterMs
  lastAt = 0
  chain = Promise.resolve()
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

/** 包一层 fetch：每次请求前排一下队。 */
export function pacedFetch(fetchImpl = globalThis.fetch) {
  return async (url, init) => {
    await pace()
    return fetchImpl(url, init)
  }
}

export default { setPacing, getPacing, pace, pacedFetch, noteRequest, resetPacingForTests }
