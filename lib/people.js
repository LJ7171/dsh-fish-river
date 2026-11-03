/**
 * people.js —— 关系层：她认识的每一个人
 *
 * 三层记忆里最薄的一层，因为它只存**印象**，不存经历。
 * 经历在 `events.jsonl`（唯一可信源，只追加）；这里的东西随时可以丢掉重算——
 * 丢了只是她对某个人的看法回到「没什么印象」，不会少掉任何一件真发生过的事。
 *
 * 为什么不用 SQLite：这一层的数据量是「几十个人 × 150 字」，一个 JSON 文件足够。
 * 换成数据库就得多一个运行时依赖、或者一段按 Node 版本分支的适配，而收益只是
 * 省几次读盘。能用文件说清的东西不要引入引擎——这是零依赖铁律在数据层的延续。
 *
 * **覆盖语义与事件流相反**：这里允许覆盖。她今天觉得这个人「话少但讲理」，
 * 明天可以改成「其实挺热心」。事件流不许改，是因为那是「发生过什么」；
 * 印象可以改，是因为那是「她现在的看法」。
 *
 * 谁写这一层：不是她（她没有这个工具），是渠道层在每轮结束后替她记一笔。
 * 这样做的代价是「印象不完全是她的原话」，收益是**她没法被人骗着改掉对某人的判断**
 * ——和 identity 一样，写入口收在代码里，比收在提示词里可靠。
 */

import path from 'node:path'
import { writeAtomic, readJson } from './store.js'

/** 印象硬上限：超过这个长度，人读的就不是印象，是一篇小作文。 */
export const IMPRESSION_MAX = 150
/** 名字上限：够放一个群昵称就行。 */
export const NAME_MAX = 40
/** 备注条数上限（「他上次说要考试」这类临时事实）。 */
export const NOTES_MAX = 8
export const NOTE_MAX = 120
/** 一个家最多记这么多人。超了按最后见面时间淘汰——她不可能真的记得一万人。 */
export const PEOPLE_MAX = 500

function str(v, max) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) : s
}

function empty(id) {
  return { id, name: '', impression: '', notes: [], first: 0, last: 0, count: 0, channels: [] }
}

/** 读出来的东西不一定可信（可能是人手动改过的），一律按字段白名单重建。 */
function normalizePerson(id, raw) {
  const p = empty(String(id))
  if (!raw || typeof raw !== 'object') return p
  p.name = str(raw.name, NAME_MAX)
  p.impression = str(raw.impression, IMPRESSION_MAX)
  p.first = Number(raw.first) > 0 ? Math.floor(Number(raw.first)) : 0
  p.last = Number(raw.last) > 0 ? Math.floor(Number(raw.last)) : 0
  p.count = Number(raw.count) > 0 ? Math.floor(Number(raw.count)) : 0
  p.channels = Array.isArray(raw.channels)
    ? [...new Set(raw.channels.map((c) => String(c ?? '')).filter((c) => c && c.length <= 16))].slice(0, 8)
    : []
  p.notes = Array.isArray(raw.notes)
    ? raw.notes
        .map((n) => (typeof n === 'string' ? { text: str(n, NOTE_MAX), at: 0 } : { text: str(n?.text, NOTE_MAX), at: Math.floor(Number(n?.at) || 0) }))
        .filter((n) => n.text)
        .slice(-NOTES_MAX)
    : []
  return p
}

function normalizeFile(raw) {
  const out = { version: 1, people: {} }
  const src = raw && typeof raw === 'object' && raw.people && typeof raw.people === 'object' ? raw.people : {}
  for (const [id, p] of Object.entries(src)) {
    const key = str(id, 64)
    if (!key) continue
    out.people[key] = normalizePerson(key, p)
  }
  return out
}

/**
 * 打开一个家的关系层。
 * @param {string} root 数据目录（~/.dsh-fish-river）
 */
export function createPeople(root) {
  const file = path.join(root, 'people.json')
  let cache = null
  // 所有写操作排成一条链：两个渠道同时到消息时，后一个不能读到前一个之前的快照。
  let tail = Promise.resolve()

  async function read() {
    if (cache) return cache
    cache = normalizeFile(await readJson(file, null))
    return cache
  }

  async function flush() {
    const data = await read()
    // 0600：这份文件里有「她怎么看别人」，不该被同机的其他账号随手读到。
    await writeAtomic(file, JSON.stringify(data, null, 2), 0o600)
    return data
  }

  function mutate(fn) {
    const run = tail.then(async () => {
      const data = await read()
      const result = await fn(data)
      await flush()
      return result
    })
    // 链本身不能被一次失败掐断，但调用方要拿到这次失败。
    tail = run.then(
      () => {},
      () => {},
    )
    return run
  }

  return {
    file,

    /** 她认识这个人吗。 */
    async get(id) {
      const key = str(id, 64)
      if (!key) return null
      const data = await read()
      return data.people[key] ? { ...data.people[key], notes: [...data.people[key].notes] } : null
    },

    /**
     * 记一笔。
     *
     * `impression` 只在**明确给了字符串**时才覆盖——`undefined` 表示「这次没有新看法」，
     * 空字符串表示「把印象清掉」。这两件事必须分开，否则每次打招呼都会把她对一个人的
     * 判断擦成空白。
     */
    async upsert(id, patch = {}) {
      const key = str(id, 64)
      if (!key) return null
      return mutate((data) => {
        const p = data.people[key] ?? empty(key)
        const now = Number(patch.now) > 0 ? Math.floor(Number(patch.now)) : Date.now()
        if (patch.name !== undefined) {
          const name = str(patch.name, NAME_MAX)
          if (name) p.name = name
        }
        if (patch.impression !== undefined) p.impression = str(patch.impression, IMPRESSION_MAX)
        if (patch.channel) {
          const c = str(patch.channel, 16)
          if (c && !p.channels.includes(c)) p.channels = [...p.channels, c].slice(0, 8)
        }
        if (patch.note) {
          const text = str(patch.note, NOTE_MAX)
          if (text) p.notes = [...p.notes, { text, at: now }].slice(-NOTES_MAX)
        }
        if (!p.first) p.first = now
        p.last = now
        p.count += 1
        data.people[key] = p
        // 淘汰：只按「最后一次见面」排，不按认识时间——她记得的是最近的人。
        const ids = Object.keys(data.people)
        if (ids.length > PEOPLE_MAX) {
          ids
            .sort((a, b) => (data.people[a].last || 0) - (data.people[b].last || 0))
            .slice(0, ids.length - PEOPLE_MAX)
            .forEach((old) => delete data.people[old])
        }
        return { ...p, notes: [...p.notes] }
      })
    },

    /** 给观测台用：最近见过的人排在前面。 */
    async list({ limit = 200 } = {}) {
      const data = await read()
      return Object.values(data.people)
        .sort((a, b) => (b.last || 0) - (a.last || 0))
        .slice(0, Math.max(1, Math.min(PEOPLE_MAX, Number(limit) || 200)))
        .map((p) => ({ ...p, notes: [...p.notes] }))
    },

    async remove(id) {
      const key = str(id, 64)
      if (!key) return false
      return mutate((data) => {
        const had = Boolean(data.people[key])
        delete data.people[key]
        return had
      })
    },

    /**
     * 从事件流重算「见过谁、见过几次、最近一次是什么时候」。
     *
     * 只补**计数与时间**，不动印象——印象本来就不是事件的函数，硬算出来只会是
     * 「最后一句原话」，那不是印象。名字也不动：事件里没有可靠的名字来源。
     */
    async rebuild(events = []) {
      return mutate((data) => {
        const seen = new Map()
        for (const e of events) {
          const who = str(e?.person, 64)
          if (!who) continue
          const at = Number(e?.ts ?? e?.t) || 0
          const cur = seen.get(who) ?? { count: 0, first: at, last: at, channels: [] }
          cur.count += 1
          if (at && (!cur.first || at < cur.first)) cur.first = at
          if (at && at > cur.last) cur.last = at
          if (e?.channel && !cur.channels.includes(e.channel)) cur.channels.push(e.channel)
          seen.set(who, cur)
        }
        for (const [who, s] of seen) {
          const p = data.people[who] ?? empty(who)
          p.count = s.count
          p.first = s.first || p.first
          p.last = s.last || p.last
          p.channels = [...new Set([...p.channels, ...s.channels])].slice(0, 8)
          data.people[who] = p
        }
        return { ok: true, people: seen.size }
      })
    },

    /** 观测台顶部那行「认识 N 个人」。 */
    async stats() {
      const data = await read()
      const all = Object.values(data.people)
      return {
        total: all.length,
        withImpression: all.filter((p) => p.impression).length,
        lastSeen: all.reduce((m, p) => Math.max(m, p.last || 0), 0),
      }
    },

    /** 测试与「重建」按钮用：丢掉内存副本，下次读盘。 */
    invalidate() {
      cache = null
    },
  }
}
