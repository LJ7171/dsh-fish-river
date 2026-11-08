/**
 * meme.js —— 按画面上的词挑一张表情（2026-11-05）
 *
 * 标签描述的是图（比心、无语、睡觉），不是她的情绪分数，也不是人设。
 * 她自己调 `pick_meme` 才挑。没有每轮自动发。
 * 挑到的是本机绝对路径；要发出去，她再调已经有的 `send_image`。
 *
 * 包从两处读：插件自带的 `meme-packs/`，以及数据目录 `meme-packs/<id>/`。
 * 同名时用数据目录那份。不进事件流。
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sniffMime } from './media.js'
import { readAlbum, ALBUM_MAX_BYTES_DEFAULT } from './album.js'
import { loadConfig } from './settings.js'
import { rootDir } from './store.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'
import { slashed } from './posix.js'
import { isInsideStrict } from './paths.js'
import { currentChannelTurn } from './channelTurn.js'

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/

/**
 * 这一轮（渠道轮）已经挑过几张。没有渠道轮时（她在家）不受这个限制。
 * 上限是环境参数 `meme.maxPerTurn`：0 = 不限（默认），N = 一轮最多 N 张。
 */
let pickedKey = ''
let pickedCount = 0

export function resetMemePickForTests() {
  pickedKey = ''
  pickedCount = 0
}

export function bundledMemeDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'meme-packs')
}

function tagHit(tags, query) {
  const q = String(query ?? '').trim()
  if (!q) return false
  const low = q.toLowerCase()
  for (const raw of tags ?? []) {
    const t = String(raw ?? '').trim()
    if (!t) continue
    if (t === q || t.toLowerCase() === low) return true
    if (q.length >= 2 && (t.includes(q) || t.toLowerCase().includes(low))) return true
  }
  return false
}

async function readPackDir(dir, id) {
  let raw
  try { raw = await readFile(join(dir, 'pack.json'), 'utf8') } catch { return [] }
  let json
  try { json = JSON.parse(raw) } catch { return [] }
  const items = []
  for (const it of Array.isArray(json?.items) ? json.items : []) {
    const file = String(it?.file ?? '').trim()
    if (!file || isAbsolute(file) || file.split(/[\\/]/).includes('..')) continue
    const tags = (Array.isArray(it?.tags) ? it.tags : [])
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 8)
    if (!tags.length) continue
    const full = resolve(dir, file)
    if (!isInsideStrict(resolve(dir), full)) continue
    items.push({ file: full, tags, pack: id })
  }
  return items
}

/**
 * 启用的包里，标签对得上的图。数据目录同名包盖过自带的。
 * @returns {Promise<{file:string, tags:string[], pack:string, from:string}[]>}
 */
export async function memeCandidates(root, { packs = [], tag = '' } = {}) {
  const ids = [...new Set((packs ?? []).map((s) => String(s ?? '').trim()).filter((s) => ID_RE.test(s)))]
  const bundled = bundledMemeDir()
  const out = []
  for (const id of ids) {
    const userDir = join(root, 'meme-packs', id)
    let from = 'user'
    let items = await readPackDir(userDir, id)
    if (!items.length) {
      items = await readPackDir(join(bundled, id), id)
      from = 'bundled'
    }
    for (const it of items) {
      if (!tagHit(it.tags, tag)) continue
      out.push({ ...it, from })
    }
  }
  return out
}

async function usable(file, maxBytes) {
  const st = await stat(file).catch(() => null)
  if (!st?.isFile() || st.size <= 0) return null
  if (st.size > maxBytes) return 'big'
  const head = await readFile(file).catch(() => null)
  if (!head || !sniffMime(head)) return null
  return 'ok'
}

/**
 * 按词挑一张。
 * @returns {Promise<{ok:boolean, note:string, path:string}>}
 */
export async function pickMeme(root, {
  tag = '',
  packs = ['plain'],
  enabled = false,
  maxBytes = ALBUM_MAX_BYTES_DEFAULT,
  maxPerTurn = 0,
  now = Date.now(),
} = {}) {
  if (enabled !== true) return { ok: false, note: '[没开]', path: '' }
  const q = String(tag ?? '').trim().slice(0, 40)
  if (!q) return { ok: false, note: '[没说]', path: '' }

  const turn = currentChannelTurn(now)
  const key = turn ? `${turn.channel}|${turn.conversationId}|${turn.at}` : ''
  const limit = Math.max(0, Math.min(5, Math.round(Number(maxPerTurn) || 0)))
  if (key && limit > 0 && pickedKey === key && pickedCount >= limit) {
    return { ok: false, note: `[这轮已经挑过 ${pickedCount} 张]`, path: '' }
  }

  const cap = Number(maxBytes) > 0 ? Number(maxBytes) : ALBUM_MAX_BYTES_DEFAULT
  const found = await memeCandidates(root, { packs, tag: q })

  // 相册里她留过、why 对得上这个词的，也算一张能用的图。没有标签市场。
  try {
    const db = await readAlbum(root)
    for (const it of db.items ?? []) {
      const why = String(it?.why ?? '')
      if (!tagHit([why], q)) continue
      const file = String(it?.path ?? '')
      if (!file) continue
      found.push({ file, tags: [why], pack: 'album', from: 'album' })
    }
  } catch { /* 没有相册就只看包 */ }

  let sawBig = false
  for (const it of found) {
    const kind = await usable(it.file, cap)
    if (kind === 'big') { sawBig = true; continue }
    if (kind !== 'ok') continue
    if (key) {
      if (pickedKey === key) pickedCount += 1
      else { pickedKey = key; pickedCount = 1 }
    }
    const path = slashed(it.file)
    return { ok: true, note: `[挑到] ${path}`, path }
  }
  if (sawBig) return { ok: false, note: '[太大]', path: '' }
  return { ok: false, note: '[没有这张]', path: '' }
}

export function registerPickMeme(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const tenancy = { root, herDir: String(deps.tenant?.herDir ?? ''), tenant: deps.tenant?.tenant ?? { ok: true } }

  return ctx.tools.register(
    defineTool({
      name: 'pick_meme',
      description:
        '按画面上的词挑一张表情图。tag 填那个词。挑到就给你本机路径。想发出去再调 send_image。',
      parameters: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: '画面上的词，比如比心、无语、睡觉。' },
        },
        required: ['tag'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
            path: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: String(out?.note ?? '') }],
      },
      async execute(args, exec) {
        const who = guardWrite(tenancy, exec, 'pick_meme')
        if (!who.ok) return { ok: false, note: `[没挑：${who.note}]`, path: '' }
        const { config } = await loadConfig(root)
        return pickMeme(root, {
          tag: args?.tag,
          packs: config?.meme?.packs,
          enabled: config?.meme?.enabled === true,
          maxBytes: config?.album?.maxBytes,
          maxPerTurn: config?.meme?.maxPerTurn,
        })
      },
    }),
  )
}

export default { pickMeme, registerPickMeme, memeCandidates, resetMemePickForTests, bundledMemeDir }
