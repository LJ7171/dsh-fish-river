/**
 * zhihuBridge.js —— 主包调用知乎子包的唯一接缝。
 *
 * 加载、注入宿主。知乎规则本身不在这里。
 */

import { createFishHost } from './platformHost.js'
import { loadZhihuModule, loadZhihuSync } from './zhihuLoad.js'

let host

export function fishHost() {
  if (!host) host = createFishHost()
  return host
}

export function bindZhihu(mod) {
  if (mod && typeof mod.bindHost === 'function') mod.bindHost(fishHost())
  return mod
}

let synced
let syncTried = false

export function syncPkg() {
  if (syncTried) return synced
  syncTried = true
  synced = bindZhihu(loadZhihuSync())
  return synced
}

export async function loadZhihu(importer) {
  if (typeof importer === 'function') {
    const mod = await loadZhihuModule(importer)
    return mod ? bindZhihu(mod) : null
  }
  return syncPkg()
}

export default { fishHost, bindZhihu, syncPkg, loadZhihu }
