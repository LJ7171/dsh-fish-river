/**
 * zhihuSpeak.js —— `zhihu_speak` 的主包侧入口。
 *
 * 工具说明和拒词在子包。这里注入宿主。
 */

import { fishHost, syncPkg } from './zhihuBridge.js'

function pkg() {
  return syncPkg()
}

export function noteZhihuSpeak(state) {
  const mod = pkg()
  if (!mod) return
  return mod.noteZhihuSpeak(state)
}

export async function zhihuSpeakOnce(o = {}) {
  const mod = pkg()
  if (!mod) return { ok: false, said: '', note: '没说出来。' }
  return mod.zhihuSpeakOnce({ ...o, host: o.host ?? fishHost() })
}

export function registerZhihuSpeak(ctx, deps = {}) {
  const mod = pkg()
  if (!mod) return null
  return mod.registerZhihuSpeak(ctx, { ...deps, host: fishHost() })
}

export default { registerZhihuSpeak, zhihuSpeakOnce, noteZhihuSpeak }
