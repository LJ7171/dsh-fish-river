/**
 * journal.js —— 流水层：每个会话最近说了什么
 *
 * 这一层只为一件事存在：**接得住话头**。
 * 群里的「他刚才说的那个梗」「上一句我问了什么」，都在这里；它们**不进事件流**，
 * 因为「看到过」和「成为她的一部分」是两件事。流水是她的短期记忆，不是她的经历。
 *
 * 三个硬规矩：
 *   1. **可覆盖、可淘汰**。每人每群只留最近 `JOURNAL_KEEP` 条，超了从最旧的丢。
 *      丢掉的不是遗忘——是她压根没打算记住，和 events.jsonl 的「只能追加」不冲突。
 *   2. **不进提示词的全局区**。只在她正要回这个会话时，才把这一条线程贴进去。
 *      否则群聊会像弹幕一样铺满她所有的上下文。
 *   3. **不进 `deriveSelf`**。这一层怎么写都不会改变她是谁。
 *
 * 存的形态是「一个 JSON 文件里的 map」，不是逐行追加：
 * 淘汰旧行需要重写文件，追加式反而要额外的压缩流程。数据量是
 * 「几十个会话 × 30 条 × 几十字」，一次重写几十 KB，比维护两套逻辑便宜。
 */

import path from 'node:path'
import { writeAtomic, readJson } from './store.js'

/** 每个会话留多少条。30 条大约是一段连续对话的可见范围。 */
export const JOURNAL_KEEP = 30
/** 最多同时保留多少个会话线程。 */
export const THREADS_MAX = 200
/** 单条上限。 */
export const LINE_MAX = 500

function str(v, max) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) : s
}

/**
 * 会话键：`渠道:类型:会话 id`。
 * 带上渠道不是洁癖——同一个 uid 在 QQ 和 B 站可能是两个人。
 */
export function threadKey({ channel = 'dsh', kind = 'dm', conversationId = '' } = {}) {
  return `${str(channel, 16) || 'dsh'}:${str(kind, 8) || 'dm'}:${str(conversationId, 64)}`
}

function normalizeFile(raw) {
  const out = { version: 1, threads: {} }
  const src = raw && typeof raw === 'object' && raw.threads && typeof raw.threads === 'object' ? raw.threads : {}
  for (const [key, t] of Object.entries(src)) {
    if (!t || typeof t !== 'object') continue
    const lines = Array.isArray(t.lines)
      ? t.lines
          .map((l) => ({
            role: l?.role === 'her' ? 'her' : 'me',
            text: str(l?.text, LINE_MAX),
            at: Math.floor(Number(l?.at) || 0),
          }))
          .filter((l) => l.text)
          .slice(-JOURNAL_KEEP)
      : []
    if (!lines.length) continue
    out.threads[str(key, 96)] = {
      key: str(key, 96),
      channel: str(t.channel, 16),
      kind: str(t.kind, 8),
      name: str(t.name, 40),
      lines,
    }
  }
  // 线程数超限时，按最后一句的时间淘汰。
  const keys = Object.keys(out.threads)
  if (keys.length > THREADS_MAX) {
    keys
      .sort((a, b) => {
        const la = out.threads[a].lines.at(-1)?.at ?? 0
        const lb = out.threads[b].lines.at(-1)?.at ?? 0
        return la - lb
      })
      .slice(0, keys.length - THREADS_MAX)
      .forEach((k) => delete out.threads[k])
  }
  return out
}

/**
 * 打开一个家的流水层。
 * @param {string} root
 */
export function createJournal(root) {
  const file = path.join(root, 'journal.json')
  let cache = null
  let tail = Promise.resolve()

  async function read() {
    if (cache) return cache
    cache = normalizeFile(await readJson(file, null))
    return cache
  }

  async function flush() {
    const data = await read()
    await writeAtomic(file, JSON.stringify(data), 0o600)
    return data
  }

  function mutate(fn) {
    const run = tail.then(async () => {
      const data = await read()
      const result = await fn(data)
      await flush()
      return result
    })
    tail = run.then(
      () => {},
      () => {},
    )
    return run
  }

  return {
    file,

    /**
     * 记一句。
     * @param {{channel?:string, kind?:string, conversationId?:string, name?:string,
     *          role?:'me'|'her', text?:string, at?:number}} entry
     */
    async append(entry = {}) {
      const text = str(entry.text, LINE_MAX)
      if (!text) return null
      const key = threadKey(entry)
      const at = Math.floor(Number(entry.at) || Date.now())
      return mutate((data) => {
        const t = data.threads[key] ?? {
          key,
          channel: str(entry.channel, 16) || 'dsh',
          kind: str(entry.kind, 8) || 'dm',
          name: str(entry.name, 40),
          lines: [],
        }
        if (entry.name) t.name = str(entry.name, 40)
        t.lines = [...t.lines, { role: entry.role === 'her' ? 'her' : 'me', text, at }].slice(-JOURNAL_KEEP)
        data.threads[key] = t
        return { ...t, lines: [...t.lines] }
      })
    },

    /** 这个会话最近 N 句，按时间正序（最老的在前，方便直接拼进提示词）。 */
    async recent(entry = {}, n = JOURNAL_KEEP) {
      const data = await read()
      const t = data.threads[threadKey(entry)]
      if (!t) return []
      const keep = Math.max(1, Math.min(JOURNAL_KEEP, Number(n) || JOURNAL_KEEP))
      return t.lines.slice(-keep).map((l) => ({ ...l }))
    },

    /** 观测台：最近活跃的线程。 */
    async threads({ limit = 50 } = {}) {
      const data = await read()
      return Object.values(data.threads)
        .sort((a, b) => (b.lines.at(-1)?.at ?? 0) - (a.lines.at(-1)?.at ?? 0))
        .slice(0, Math.max(1, Math.min(THREADS_MAX, Number(limit) || 50)))
        .map((t) => ({
          key: t.key,
          channel: t.channel,
          kind: t.kind,
          name: t.name,
          count: t.lines.length,
          last: t.lines.at(-1)?.at ?? 0,
          preview: t.lines.at(-1)?.text ?? '',
        }))
    },

    /** 手动清一个会话（她「不想再翻这段」时，观测台可以点）。 */
    async clear(entry = {}) {
      const key = threadKey(entry)
      return mutate((data) => {
        const had = Boolean(data.threads[key])
        delete data.threads[key]
        return had
      })
    },

    /** 全清：只删派生物，事件流一根不动。 */
    async clearAll() {
      return mutate((data) => {
        const n = Object.keys(data.threads).length
        data.threads = {}
        return n
      })
    },

    async stats() {
      const data = await read()
      const all = Object.values(data.threads)
      return {
        threads: all.length,
        lines: all.reduce((n, t) => n + t.lines.length, 0),
        lastAt: all.reduce((m, t) => Math.max(m, t.lines.at(-1)?.at ?? 0), 0),
      }
    },

    invalidate() {
      cache = null
    },
  }
}
