/**
 * replybox.js —— 别人回她的评论，先放盒子里，递出去之前不清空
 *
 * 为什么单独放：回复不再挂在掷骰/叫醒上。按 `comment.scanEveryMin` 自己的节奏扫，
 * 扫到的新回复进 `<root>/reply-box.json`；递的时候只读这个盒子，不再现场打接口。
 *
 * 2026-11-18 起：她**醒着**（dice_awake / session_awake）就由 replyDelivery 立刻取走
 * 递给她，不再等下一次醒来；睡着、请假、正在说一轮时仍留在盒里，等醒来或下一拍。
 *
 * 只存扫描结果（不含凭据）。去重按 rpid；盒子最多留 50 条。
 */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { writeAtomic } from '../core/store.js'

const MAX = 50
const VERSION = 1

export function replyBoxPath(root, file = 'reply-box.json') {
  return join(String(root ?? ''), file || 'reply-box.json')
}

export async function readReplyBox(root, { file } = {}) {
  try {
    const raw = JSON.parse(await readFile(replyBoxPath(root, file), 'utf8'))
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
export async function addReplies(root, list = [], { scannedAt = '', file } = {}) {
  if (!Array.isArray(list) || !list.length) return { ok: true, added: 0 }
  const box = await readReplyBox(root, { file })
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
  await writeAtomic(replyBoxPath(root, file), JSON.stringify({ version: VERSION, items, scannedAt }, null, 2), 0o600)
  return { ok: true, added: fresh.length }
}

/** 盒子里有没有还没递出去的东西（只读文件，不取走）。 */
export async function hasReplies(root, { file } = {}) {
  const box = await readReplyBox(root, { file })
  return box.items.length > 0
}

/** 取走盒子里的回复（递给她之后清空）。 */
export async function takeReplies(root, { file } = {}) {
  const box = await readReplyBox(root, { file })
  if (!box.items.length) return []
  await writeAtomic(replyBoxPath(root, file), JSON.stringify({ version: VERSION, items: [], scannedAt: box.scannedAt }, null, 2), 0o600)
  return box.items
}

export default { replyBoxPath, readReplyBox, hasReplies, addReplies, takeReplies }
