/**
 * turnLock.js —— 同一个会话同一时刻只允许一轮在跑。
 *
 * 为什么需要它：唤醒（定时/手动）、渠道回复、`/say` 都会往同一条会话 `prompt`。
 * 宿主的 prompt 是入队语义，不排队冲突；两轮同时进来时，`turn/end` 分不清是谁的，
 * 就会出现「A 的话记到 B 头上」「A 结束把 B 的处境清掉」。
 *
 * 这里只做进程内的互斥：谁先拿到锁，谁活到自己的 `turn/end` 再放。
 * 拿不到（默认等 180 秒）就返回 null，调用方应当**跳过这一轮**而不是硬闯。
 *
 * 边界：锁只活在本进程；跨进程仍由 `tenant.js` 的 instance 锁兜底。
 */

const tails = new Map()

/**
 * @param {string} sessionId
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<null|(()=>void)>} 拿到锁返回一个幂等的 release；超时返回 null
 */
export function acquireTurn(sessionId, { timeoutMs = 180_000 } = {}) {
  const key = String(sessionId ?? '')
  if (!key) return Promise.resolve(() => {})
  const prev = tails.get(key) ?? Promise.resolve()
  let open
  const gate = new Promise((resolve) => { open = resolve })
  const tail = prev.then(() => gate)
  tails.set(key, tail)

  let released = false
  const release = () => {
    if (released) return
    released = true
    open()
    if (tails.get(key) === tail) tails.delete(key)
  }

  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      release()
      resolve(null)
    }, timeoutMs)
    // 长等待不该把宿主进程留着（默认 180 秒、代发 30 秒）。
    // 短等待必须能叫醒事件循环，否则定时器被 unref 之后这一拍永远等不到。
    if (timeoutMs >= 1000) timer.unref?.()
    prev.then(() => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(release)
    })
  })
}

/** 测试用：清掉所有链（不会打断在途的 promise）。 */
export function resetTurnLocksForTests() {
  tails.clear()
}

/** 诊断用：还有几个会话占着锁。 */
export function turnLockSize() {
  return tails.size
}

export default { acquireTurn, resetTurnLocksForTests, turnLockSize }
