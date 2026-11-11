/**
 * maintenance.js —— 换档/恢复期间冻结写入。
 *
 * 为什么需要：`/backup/restore`、`/reset` 会把整个状态库 rename/替换；如果调度器
 * 或渠道这时正好在 `appendEvent` / `writeAtomic`，新目录里会混进半截写入，
 * 甚至写到已经被 rename 走的旧 inode 上。冻结不是「少写一条」，是让换档本身成立。
 *
 * 边界：
 *   - 只冻结 `store.writeAtomic` / `store.appendEvent`；reset/restore 自己用的是
 *     `fs.writeFile/rename`，不受影响。
 *   - 只活在本进程；换档期间不要多实例。
 */
let depth = 0

export function beginMaintenance() {
  depth += 1
}

export function endMaintenance() {
  depth = Math.max(0, depth - 1)
}

export function inMaintenance() {
  return depth > 0
}

/** 写入口调用；维护中直接抛，调用方按普通失败处理。 */
export function assertWritable() {
  if (depth <= 0) return
  const err = new Error('正在换档或恢复，暂不写入')
  err.code = 'MAINTENANCE'
  throw err
}

/** 测试用。 */
export function resetMaintenanceForTests() {
  depth = 0
}

export default { beginMaintenance, endMaintenance, inMaintenance, assertWritable, resetMaintenanceForTests }
