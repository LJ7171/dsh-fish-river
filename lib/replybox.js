/**
 * replybox.js —— 别人回她的评论，先攒着，等她下一次醒来再递（2026-11-06 用户定 A 案）
 *
 * 为什么单独放：回复不再挂在掷骰/叫醒上。按 `comment.scanEveryMin` 自己的节奏扫，
 * 扫到的新回复进 `<root>/reply-box.json`；醒来时只读这个盒子，不再现场打接口。
 * 她没醒的时候扫到了也等着，不额外叫醒她。
 *
 * 只存扫描结果（不含凭据）。去重按 rpid；盒子最多留 20 条。
 */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { writeAtomic } from './store.js'

const MAX = 20
const VERSION = 1

export function replyBoxPath(root) {
  return join(String(root ?? ''), 'reply-box.json')
}

export async function readReplyBox(root) {
  try {
    const raw = JSON.parse(await readFile(replyBoxPath(root), 'utf8'))
    return {
      version: VERSION,
      items: Array.isArray(raw?.items) ? raw.items.filter((x) => x && x.rpid) : [],
      scannedAt: String(raw?.scannedAt ?? ''),
    }
  } catch {
    return { version: VERSION, items: [], scannedAt: '' }
  }
}

/** 新回复进盒；同一个 rpid 只留一条；满了丢最旧的。 */
export async function addReplies(root, list = [], { scannedAt = '' } = {}) {
  if (!Array.isArray(list) || !list.length) return { ok: true, added: 0 }
  const box = await readReplyBox(root)
  const seen = new Set(box.items.map((x) => String(x.rpid)))
  const fresh = []
  for (const it of list) {
    const id = String(it?.rpid ?? '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    fresh.push(it)
  }
  if (!fresh.length) return { ok: true, added: 0 }
  const items = [...box.items, ...fresh].slice(-MAX)
  await writeAtomic(replyBoxPath(root), JSON.stringify({ version: VERSION, items, scannedAt }, null, 2), 0o600)
  return { ok: true, added: fresh.length }
}

/** 取走盒子里的回复（醒来递给她之后清空）。 */
export async function takeReplies(root) {
  const box = await readReplyBox(root)
  if (!box.items.length) return []
  await writeAtomic(replyBoxPath(root), JSON.stringify({ version: VERSION, items: [], scannedAt: box.scannedAt }, null, 2), 0o600)
  return box.items
}

export default { replyBoxPath, readReplyBox, addReplies, takeReplies }
