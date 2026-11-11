/**
 * state.js —— `<root>/zhihu-state.json`
 *
 * 只记「今天抓过几次」和「哪些 id 给过」。不是她的记忆，不进事件流。
 * 写盘走宿主的 writeAtomic，这样维护冻结时这里也不会偷写。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { errorText, hostOf } from './runtime.js'

const STATE_VERSION = 3
const SEEN_MAX = 300
const SEEN_TTL_MS = 7 * 86_400_000

export function statePath(root) {
  return join(String(root ?? ''), 'zhihu-state.json')
}

export async function readState(root) {
  try {
    const parsed = JSON.parse(await readFile(statePath(root), 'utf8'))
    return {
      version: STATE_VERSION,
      dateKey: String(parsed?.dateKey ?? ''),
      runs: Number(parsed?.runs) || 0,
      seen: parsed?.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
    }
  } catch {
    return { version: STATE_VERSION, dateKey: '', runs: 0, seen: {} }
  }
}

export async function writeState(root, state, host) {
  const h = hostOf(host)
  const now = Date.now()
  const seen = {}
  for (const [id, at] of Object.entries(state?.seen ?? {})) {
    if (now - Number(at) <= SEEN_TTL_MS) seen[id] = Number(at)
  }
  const entries = Object.entries(seen).sort((a, b) => a[1] - b[1])
  const trimmed = Object.fromEntries(entries.slice(-SEEN_MAX))
  const next = {
    version: STATE_VERSION,
    dateKey: String(state?.dateKey ?? ''),
    runs: Number(state?.runs) || 0,
    seen: trimmed,
  }
  try {
    await h.writeAtomic(statePath(root), JSON.stringify(next, null, 2), 0o600)
    return { ok: true }
  } catch (error) {
    return { ok: false, why: errorText(error) }
  }
}

export function runsToday(state, dk) {
  return state?.dateKey === dk ? Number(state.runs) || 0 : 0
}

export default { statePath, readState, writeState, runsToday }
