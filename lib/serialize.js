/**
 * serialize.js —— 同一个文件上的读-改-写排成一条链。
 *
 * 为什么需要：`sleep-state.json` / `growth-cards.json` / `outreach-state.json`
 * 都是「读 → 改 → 写」。两个调用点交错时，后写的会拿旧快照覆盖前一个的更新。
 * 进程内单写者（tenancy 保证）下，一条 promise 链就够；跨进程仍由 instance 锁兜底。
 *
 * 只保证**同一 key 串行**，不同文件互不阻塞。key 一般用文件绝对路径。
 */
const chains = new Map()

/**
 * @param {string} key 串行键（文件路径）
 * @param {() => Promise<any>} fn 临界区
 * @returns {Promise<any>} fn 的返回值
 */
export function withSerial(key, fn) {
  const k = String(key ?? '')
  const prev = chains.get(k) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.then(
    () => {},
    () => {},
  )
  chains.set(k, tail)
  tail.finally(() => {
    if (chains.get(k) === tail) chains.delete(k)
  })
  return run
}

/** 测试用：清掉所有链（不会打断在途的 promise）。 */
export function resetSerialForTests() {
  chains.clear()
}

export default { withSerial, resetSerialForTests }
