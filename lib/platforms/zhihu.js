/**
 * zhihu.js —— 知乎子包的主包侧入口。
 *
 * 抓取、去重、素材措辞都在 `packages/dsh-fish-river-zhihu`。
 * 这里只加载那个包，并把宿主门面注进去。
 */

import { fishHost, loadZhihu, syncPkg } from './zhihuBridge.js'

export { loadZhihu }

const MISSING_FETCH = { ok: false, text: '', picks: [], acted: false, blocked: true, why: 'no-subpackage' }
const MISSING_GATHER = { ok: false, text: '', picks: [], why: '没装 dsh-fish-river-zhihu（知乎是可选子包）' }

function pkg() {
  return syncPkg()
}

export function statePath(root) {
  const mod = pkg()
  if (!mod) return ''
  return mod.statePath(root)
}

export async function readState(root) {
  const mod = pkg()
  if (!mod) return { version: 3, dateKey: '', runs: 0, seen: {} }
  return mod.readState(root)
}

export async function writeState(root, state) {
  const mod = pkg()
  if (!mod) return { ok: false, why: 'no-subpackage' }
  return mod.writeState(root, state, fishHost())
}

export function runsToday(state, dk) {
  const mod = pkg()
  if (!mod) return state?.dateKey === dk ? Number(state.runs) || 0 : 0
  return mod.runsToday(state, dk)
}

export async function fetchMainBatch(opts = {}) {
  const mod = pkg()
  if (!mod) return { ok: false, items: [] }
  return mod.fetchMainBatch(opts)
}

export async function fetchRecommendBatch(opts = {}) {
  const mod = pkg()
  if (!mod) return { ok: false, items: [] }
  return mod.fetchRecommendBatch(opts)
}

export function renderQuestions(questions) {
  const mod = pkg()
  if (!mod) return ''
  return mod.renderQuestions(questions)
}

export function renderMaterial(items, config) {
  const mod = pkg()
  if (!mod) return ''
  return mod.renderMaterial(items, config, fishHost())
}

export async function fetchZhihuMaterial(opts = {}) {
  const mod = pkg()
  if (!mod?.fetchZhihuMaterial) return { ...MISSING_FETCH }
  return mod.fetchZhihuMaterial({ ...opts, host: opts.host ?? fishHost() })
}

export async function gatherZhihu(opts = {}) {
  const mod = pkg()
  if (!mod?.gatherZhihu) return { ...MISSING_GATHER }
  return mod.gatherZhihu({ ...opts, host: opts.host ?? fishHost() })
}

export async function zhihuStatus(root, cfg) {
  const mod = pkg()
  if (!mod?.zhihuStatus) {
    return {
      installed: false,
      enabled: cfg?.zhihu?.enabled === true,
      loggedIn: false,
      account: null,
      runsToday: 0,
      savedAt: '',
    }
  }
  return mod.zhihuStatus(root, cfg, fishHost())
}

export default {
  loadZhihu,
  gatherZhihu,
  fetchZhihuMaterial,
  renderMaterial,
  renderQuestions,
  readState,
  writeState,
  runsToday,
  zhihuStatus,
  statePath,
}
