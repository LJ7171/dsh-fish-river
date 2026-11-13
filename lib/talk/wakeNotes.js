/**
 * wakeNotes.js —— 「你睡着的时候，他回过什么」。
 *
 * 纯确认（好 / 嗯 / 收到）不叫醒她，但必须让她下一次醒来知道；
 * 她问过的事（ask）有回答时，也一样——尤其「以后再说」不是「没答」。
 *
 * 事件流只追加，所以用 meta 记已读：
 *   ack-wait:<heard event id>   纯确认先挂着，等她下一次醒来
 *   ack-read:<heard event id>   已经递给她了
 *   ask-shown:<ask event id>    这条请求的回答已经递给她了
 *
 * 不新造事件类型；不写 schema 版本。
 */

import { readEvents, appendEvent, rootDir } from '../core/store.js'

const DAY_MS = 86_400_000
const MAX_LINES = 3
const MAX_AGE_MS = DAY_MS
const MAX_TEXT = 120

function tsOf(e) {
  return Date.parse(String(e?.ts ?? '')) || 0
}

function clip(s, n = MAX_TEXT) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

function clock(ms) {
  const d = new Date(ms)
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return d.toDateString() === now.toDateString() ? `${hh}:${mm}` : `${d.getMonth() + 1}-${d.getDate()} ${hh}:${mm}`
}

function heardText(ev) {
  // heard 的格式是「场合 + 人名：原话」；只取最后那个「：」之后的原话。
  const raw = String(ev?.text ?? '')
  const at = raw.lastIndexOf('：')
  return clip(at >= 0 ? raw.slice(at + 1) : raw)
}

function askText(ev) {
  return clip(ev?.text)
}

function answerLine(answer, ask) {
  const v = String(answer?.ask?.verdict ?? '')
  const label = v === 'approve' ? '可以' : v === 'reject' ? '这次不行' : '以后再说'
  const reason = String(answer?.ask?.reason ?? '').trim()
  const extra = v === 'later'
    ? '（这是先放着，不是没回你。）'
    : reason && reason !== label ? `（${clip(reason, 80)}）` : ''
  return `- 你问「${askText(ask)}」——他答了：「${label}」${extra}`
}

/**
 * 下一次醒来要补的几行。只读、不标记已读；调用方在她这一轮真的送出去之后再 mark。
 * @returns {Promise<{text:string, ackIds:string[], askIds:string[]}>}
 */
export async function collectWakeNotes(root = rootDir(), { now = Date.now() } = {}) {
  try {
    const { events } = await readEvents(root)
    const byId = new Map((events ?? []).filter((e) => e?.id).map((e) => [e.id, e]))
    const ackRead = new Set()
    const askShown = new Set()
    const ackWait = []
    for (const e of events ?? []) {
      if (e?.type !== 'meta') continue
      const t = String(e.text ?? '')
      if (t.startsWith('ack-read:')) ackRead.add(t.slice('ack-read:'.length))
      else if (t.startsWith('ask-shown:')) askShown.add(t.slice('ask-shown:'.length))
      else if (t.startsWith('ack-wait:')) ackWait.push(t.slice('ack-wait:'.length))
    }

    const rows = []
    for (const id of ackWait) {
      if (ackRead.has(id)) continue
      const heard = byId.get(id)
      if (!heard || heard.type !== 'heard') continue
      if (heard.origin !== 'owner' || heard.visibility !== 'private') continue
      const at = tsOf(heard)
      if (!at || now - at > MAX_AGE_MS) continue
      rows.push({ at, kind: 'ack', id, text: `- ${clock(at)} 他回过你：「${heardText(heard)}」` })
    }

    for (const e of events ?? []) {
      if (e?.type !== 'answer') continue
      const askId = String(e?.ask?.askId ?? '')
      if (!askId || askShown.has(askId)) continue
      const ask = byId.get(askId)
      if (!ask || ask.type !== 'ask') continue
      const at = tsOf(e)
      if (!at || now - at > MAX_AGE_MS) continue
      rows.push({ at, kind: 'ask', id: askId, text: answerLine(e, ask) })
    }

    rows.sort((a, b) => a.at - b.at)
    const keep = rows.slice(-MAX_LINES)
    if (!keep.length) return { text: '', ackIds: [], askIds: [] }
    return {
      text: ['## 你睡着的时候', ...keep.map((r) => r.text)].join('\n'),
      ackIds: keep.filter((r) => r.kind === 'ack').map((r) => r.id),
      askIds: keep.filter((r) => r.kind === 'ask').map((r) => r.id),
    }
  } catch {
    return { text: '', ackIds: [], askIds: [] }
  }
}

/** 真正递出去之后标记已读；失败不影响这一轮。 */
export async function markWakeNotesRead(root = rootDir(), { ackIds = [], askIds = [] } = {}) {
  const ctx = { source: 'system' }
  for (const id of ackIds) {
    await appendEvent({ type: 'meta', text: `ack-read:${id}` }, ctx, root).catch(() => {})
  }
  for (const id of askIds) {
    await appendEvent({ type: 'meta', text: `ask-shown:${id}` }, ctx, root).catch(() => {})
  }
}

export default { collectWakeNotes, markWakeNotesRead }
