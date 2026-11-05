/**
 * album.js —— 她的相册：想留的图，从缓存里抄一份出来
 *
 * 媒体缓存（media/、zhihu-media/、weixin-media/）都有 TTL，过几天就没了。
 * 相册是另一处：`album/<日期>/` + `album.json` 台账。她调用 `keep_image` 才抄进来。
 *
 * 这不是成长。不写 events.jsonl，不进 beliefs，不进 constitution / social。
 * 台账只记「哪张图留下了」，跟纪念品一样是事实，不是她是谁。
 *
 * 回执只报机器状态（`[收进相册]` / `[太大]` / `[不是图]` / `[路径不对]` / `[没有这张]`）。
 * 不写成她能接着念的句子。
 */

import { randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'

import { IMAGE_MIME, sniffMime } from './media.js'
import { dateKey, loadConfig } from './settings.js'
import { rootDir, writeAtomic } from './store.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'
import { slashed } from './posix.js'

/** 与微信单张上限、send_image 的 8MB 对齐。设置里可以改。 */
export const ALBUM_MAX_BYTES_DEFAULT = 8 * 1024 * 1024

const LEDGER = 'album.json'
const SCHEMA = 1

export function albumFile(root) {
  return join(root, LEDGER)
}

export function albumDir(root, dk = '') {
  return dk ? join(root, 'album', dk) : join(root, 'album')
}

function inside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function realOrEmpty(p) {
  try { return await realpath(p) } catch { return '' }
}

function readLedger(raw) {
  try {
    const db = JSON.parse(raw)
    if (db && Array.isArray(db.items)) return { version: SCHEMA, items: db.items }
  } catch { /* 坏档当空 */ }
  return { version: SCHEMA, items: [] }
}

async function loadLedger(root) {
  try {
    return readLedger(await readFile(albumFile(root), 'utf8'))
  } catch {
    return { version: SCHEMA, items: [] }
  }
}

async function saveLedger(root, db) {
  const file = albumFile(root)
  await mkdir(root, { recursive: true, mode: 0o700 }).catch(() => {})
  // 原子写：写一半崩掉不会把台账截断成空档（坏档会被当成空的，图还在但索引没了）。
  await writeAtomic(file, `${JSON.stringify({ version: SCHEMA, items: db.items }, null, 2)}\n`, 0o600)
}

/** 读相册台账（坏档不抛）。 */
export async function readAlbum(root) {
  return loadLedger(root)
}

/**
 * 把一张本机图抄进相册。
 * @returns {Promise<{ok:boolean, note:string, path:string}>}
 */
export async function keepImage(root, { path = '', why = '', maxBytes = ALBUM_MAX_BYTES_DEFAULT, now = Date.now() } = {}) {
  const cap = Number(maxBytes) > 0 ? Number(maxBytes) : ALBUM_MAX_BYTES_DEFAULT
  const asked = String(path ?? '').trim()
  if (!asked || /^https?:\/\//i.test(asked) || /^file:/i.test(asked) || !isAbsolute(asked)) {
    return { ok: false, note: '[路径不对]', path: '' }
  }

  let st
  try { st = await lstat(asked) } catch { return { ok: false, note: '[没有这张]', path: '' } }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, note: '[路径不对]', path: '' }
  if (st.size <= 0) return { ok: false, note: '[不是图]', path: '' }
  if (st.size > cap) return { ok: false, note: '[太大]', path: '' }

  const real = await realOrEmpty(asked)
  const home = await realOrEmpty(root)
  if (!real || !home || !inside(home, real)) return { ok: false, note: '[路径不对]', path: '' }

  const albumRoot = await realOrEmpty(albumDir(root)) 
  if (albumRoot && inside(albumRoot, real)) {
    return { ok: true, note: `[已经在相册] ${slashed(real)}`, path: slashed(real) }
  }

  // 同一张源图收过就不再多复制一份：回它已经待着的那条路径。
  const srcKey = slashed(real)
  const prior = (await loadLedger(root)).items.find((it) => it?.src === srcKey)
  if (prior?.path) {
    const still = await realOrEmpty(prior.path)
    if (still) return { ok: true, note: `[已经在相册] ${slashed(still)}`, path: slashed(still) }
  }

  let buf
  try { buf = await readFile(real) } catch { return { ok: false, note: '[没有这张]', path: '' } }
  if (buf.length > cap) return { ok: false, note: '[太大]', path: '' }
  const mime = sniffMime(buf)
  if (!mime || !IMAGE_MIME[mime]) return { ok: false, note: '[不是图]', path: '' }

  const dk = dateKey(new Date(now))
  const dir = albumDir(root, dk)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const id = randomUUID().slice(0, 8)
  const dest = join(dir, `${id}.${IMAGE_MIME[mime]}`)
  await copyFile(real, dest)
  await chmod(dest, 0o600).catch(() => {})

  const noteWhy = String(why ?? '').trim().slice(0, 80)
  const db = await loadLedger(root)
  db.items.push({
    id,
    at: new Date(now).toISOString(),
    src: slashed(real),
    path: slashed(dest),
    bytes: buf.length,
    mime,
    why: noteWhy,
  })
  await saveLedger(root, db)

  return { ok: true, note: `[收进相册] ${slashed(dest)}`, path: slashed(dest) }
}

/** 注册 keep_image。留不留由她调用决定，没有「总是保存」的开关。 */
export function registerKeepImage(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const tenancy = { root, herDir: String(deps.tenant?.herDir ?? ''), tenant: deps.tenant?.tenant ?? { ok: true } }

  return ctx.tools.register(
    defineTool({
      name: 'keep_image',
      description:
        '把一张你已经看见的本地图片收进相册。path 填那条绝对路径（微信里收到的、知乎回答或评论里的、B 站拼图或评论里的）。' +
        '想留才留。太大、不是图、路径不对，回执会直接标出来。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本机图片的绝对路径。' },
          why: { type: 'string', description: '可选：为什么留。一句就够，不写也行。' },
        },
        required: ['path'],
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
        const who = guardWrite(tenancy, exec, 'keep_image')
        if (!who.ok) return { ok: false, note: `[没留下：${who.note}]`, path: '' }
        const { config } = await loadConfig(root)
        const maxBytes = Number(config?.album?.maxBytes) || ALBUM_MAX_BYTES_DEFAULT
        return keepImage(root, { path: args?.path, why: args?.why, maxBytes })
      },
    }),
  )
}

export default { keepImage, registerKeepImage, readAlbum, ALBUM_MAX_BYTES_DEFAULT }
