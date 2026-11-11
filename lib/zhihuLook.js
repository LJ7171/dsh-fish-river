/**
 * zhihuLook.js —— `zhihu_look` 的主包侧入口。
 *
 * 工具注册和点进去的规则在子包。这里负责注入宿主。
 */

import { fishHost, syncPkg } from './zhihuBridge.js'

function pkg() {
  return syncPkg()
}

export function parseTarget(value) {
  const mod = pkg()
  if (!mod) return {}
  return mod.parseTarget(value)
}

export async function saveImages(opts = {}) {
  const mod = pkg()
  if (!mod) return []
  return mod.saveImages({ ...opts, host: opts.host ?? fishHost() })
}

export async function zhihuLookOnce(opts = {}) {
  const mod = pkg()
  if (!mod) return { ok: false, text: '', picks: [], note: '现在看不了。' }
  return mod.zhihuLookOnce({ ...opts, host: opts.host ?? fishHost() })
}

export function registerZhihuLook(ctx, deps = {}) {
  const mod = pkg()
  if (!mod) return null
  return mod.registerZhihuLook(ctx, { ...deps, host: fishHost() })
}

export default { registerZhihuLook, zhihuLookOnce, parseTarget }
