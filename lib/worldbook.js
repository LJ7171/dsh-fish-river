/**
 * worldbook.js —— 「她知道的事」
 *
 * 一句话：这是**知识**，不是人格。
 *
 * 为什么单独一层：世界书（SillyTavern 的 World Info / Lorebook）里装的通常是
 * 「她住的城市叫临江」「公司三楼有个茶水间」这类**事实**。事实可以给，
 * 而「她是什么样的人」不能给——后者只能从事件里长出来（见 AGENTS.md §2）。
 *
 * 三条边界，写代码时别越：
 *   1. **只进提示词的「你知道的事」一节，不进身份文档的自我描述**。
 *      写进身份文档就等于写了「你是谁」，那是人格配置。
 *   2. **不改阶段、不进 beliefs、不算事件**。查一条设定不是一段经历。
 *   3. **匹配靠关键词，不靠模型**。这样她记得什么、为什么记得，都能解释。
 *
 * 存储：`<root>/worldbook.json`，0600，一次原子写。
 * 格式：{ version: 1, entries: [{ id, keys: string[], text: string, enabled: boolean, at: number }] }
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { writeAtomic, readJson } from './store.js'

export const WORLDBOOK_FILE = 'worldbook.json'
export const ENTRIES_MAX = 500
export const KEYS_MAX = 24
export const KEY_MAX = 64
export const TEXT_MAX = 2000
/** 一次最多挑几条、共多少字——防止一本大部头把一轮上下文吃光。 */
export const MATCH_MAX = 5
export const MATCH_CHARS = 1200

const fileOf = (root) => path.join(root, WORLDBOOK_FILE)

const str = (v) => (typeof v === 'string' ? v : '')
const clean = (s) => str(s).replace(/\r\n/g, '\n').trim()

let seq = 0
function newId() {
  seq = (seq + 1) % 1e6
  return `w${Date.now().toString(36)}${seq.toString(36)}`
}

/** 把一条外来条目收拾成内部形状；收拾不出来就返回 null。 */
function tidyEntry(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const keys = []
  const push = (k) => {
    const s = clean(k).slice(0, KEY_MAX)
    if (s && !keys.includes(s)) keys.push(s)
  }
  if (Array.isArray(raw.keys)) raw.keys.forEach(push)
  else if (Array.isArray(raw.key)) raw.key.forEach(push)
  else if (typeof raw.keys === 'string') raw.keys.split(/[,，、]/).forEach(push)
  else if (typeof raw.key === 'string') raw.key.split(/[,，、]/).forEach(push)

  const text = clean(raw.text ?? raw.content ?? '').slice(0, TEXT_MAX)
  if (!text) return null
  if (!keys.length) return null

  return {
    id: clean(raw.id).slice(0, 40) || newId(),
    keys: keys.slice(0, KEYS_MAX),
    text,
    enabled: raw.enabled === false || raw.disable === true ? false : true,
    at: Number(raw.at) > 0 ? Number(raw.at) : now,
  }
}

/**
 * 导入 SillyTavern 世界书（两种格式都认）：
 *   · 角色卡里那种 `{ entries: { "0": { key: [...], content, disable } } }`
 *   · 也可能是数组 `[{ key, content }]`
 * 认不出来的条目直接丢，不抛——导入失败不该让整个面板 500。
 *
 * @returns {{ ok: boolean, entries: Array, skipped: number, why: string }}
 */
export function importLorebook(raw) {
  let list = []
  if (Array.isArray(raw)) list = raw
  else if (raw && typeof raw === 'object') {
    const e = raw.entries ?? raw.Entries ?? raw.items
    if (Array.isArray(e)) list = e
    else if (e && typeof e === 'object') list = Object.values(e)
  }
  const out = []
  let skipped = 0
  for (const item of list) {
    const t = tidyEntry(item)
    if (!t) {
      skipped += 1
      continue
    }
    out.push(t)
    if (out.length >= ENTRIES_MAX) break
  }
  return {
    ok: out.length > 0,
    entries: out,
    skipped,
    why: out.length ? '' : '没读出一条带关键词和正文的设定',
  }
}

/** 把一段文本里命中的设定挑出来。纯函数，方便测试。 */
export function matchEntries(entries, text, { limit = MATCH_MAX, chars = MATCH_CHARS } = {}) {
  const hay = clean(text).toLowerCase()
  if (!hay) return []
  const hits = []
  for (const e of entries) {
    if (!e || e.enabled === false) continue
    const key = e.keys.find((k) => k && hay.includes(String(k).toLowerCase()))
    if (!key) continue
    hits.push({ entry: e, key })
  }
  // 关键词越长越具体：先给「临江三中」这类，再给「学校」这类。
  hits.sort((a, b) => b.key.length - a.key.length || b.entry.at - a.entry.at)

  const out = []
  let used = 0
  for (const h of hits) {
    if (out.length >= limit) break
    const room = chars - used
    if (room <= 0) break
    const text2 = h.entry.text.length > room ? `${h.entry.text.slice(0, Math.max(0, room - 1))}…` : h.entry.text
    out.push({ id: h.entry.id, keys: h.entry.keys, text: text2, key: h.key })
    used += text2.length
  }
  return out
}

/**
 * 打开（或初始化）一本世界书。
 * 只读路径不建文件：没导入过就是空册子，不该在数据目录里留个空文件。
 */
export function createWorldbook(root) {
  let cache = null
  let cacheAt = -1

  async function load() {
    let st = null
    try {
      st = await fs.stat(fileOf(root))
    } catch {
      return { version: 1, entries: [] }
    }
    if (cache && cacheAt === st.mtimeMs) return cache
    const raw = await readJson(fileOf(root), { version: 1, entries: [] })
    const entries = Array.isArray(raw?.entries) ? raw.entries.filter((e) => e && typeof e === 'object') : []
    cache = { version: 1, entries }
    cacheAt = st.mtimeMs
    return cache
  }

  async function save(entries) {
    const body = JSON.stringify({ version: 1, entries }, null, 2)
    await writeAtomic(fileOf(root), body, 0o600)
    cache = null
    cacheAt = -1
    return { ok: true, count: entries.length }
  }

  return {
    /** 全部条目（管理面板用）。 */
    async list() {
      const b = await load()
      return b.entries.map((e) => ({ ...e }))
    },

    /** 按一段话挑设定（回复用）。 */
    async match(text, opts) {
      const b = await load()
      return matchEntries(b.entries, text, opts)
    },

    /** 整本替换（导入用）。旧的全丢——导入是"这本册子现在是这样"。 */
    async replace(entries) {
      const tidy = []
      for (const e of Array.isArray(entries) ? entries : []) {
        const t = tidyEntry(e)
        if (t) tidy.push(t)
        if (tidy.length >= ENTRIES_MAX) break
      }
      return save(tidy)
    },

    /** 追加（不全量覆盖，导入多本时可以叠加）。 */
    async add(entries) {
      const b = await load()
      const have = new Map(b.entries.map((e) => [e.id, e]))
      for (const e of Array.isArray(entries) ? entries : []) {
        const t = tidyEntry(e)
        if (t) have.set(t.id, t)
        if (have.size >= ENTRIES_MAX) break
      }
      return save([...have.values()])
    },

    async remove(id) {
      const b = await load()
      const left = b.entries.filter((e) => e.id !== id)
      return save(left)
    },

    async clear() {
      return save([])
    },

    async stats() {
      const b = await load()
      return {
        count: b.entries.length,
        enabled: b.entries.filter((e) => e.enabled !== false).length,
        chars: b.entries.reduce((n, e) => n + str(e.text).length, 0),
      }
    },
  }
}

/**
 * 提示词里「你知道的事」那一节。
 *
 * 只写事实，不写「你是一个……」；没有命中就什么都不加。
 */
export function knowledgeBlock(matches) {
  const list = (matches ?? []).filter((m) => m && m.text)
  if (!list.length) return ''
  const out = ['', '（你知道的事——这些是事实，不是要求：']
  for (const m of list) out.push(`· ${m.text}`)
  out.push('）')
  return out.join('\n')
}
