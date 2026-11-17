/**
 * sticker.js —— 评论表情包
 *
 * 一份账，两处来源：你在设置页放的（by:'owner'），她用 keep_sticker 收的（by:'her'）。
 * 不写 events.jsonl，不进 beliefs。名字和「什么时候用」都必填，缺了就不入库。
 * 她不能改、不能删你放的。你在设置页可以改这两句，也可以删任意一张。
 */

import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { sniffMime, IMAGE_MIME } from '../core/media.js'
import { screenOutgoing, sanitizeForeign } from '../core/guard.js'
import { rootDir, readJson, writeAtomic } from '../core/store.js'
import { loadConfig } from '../core/settings.js'
import { defineTool } from '../core/tool.js'
import { isInside, isInsideStrict } from '../core/paths.js'
import { guardWrite } from './tenant.js'

export const STICKER_MAX_BYTES = 2 * 1024 * 1024
export const STICKER_PAGE = 6
export const NAME_MAX = 8
export const WHEN_MAX = 30

const LEDGER = 'stickers.json'

function ledgerFile(root) {
  return join(root, LEDGER)
}

function stickerDir(root) {
  return join(root, 'stickers')
}

async function load(root) {
  const db = await readJson(ledgerFile(root), { items: [] })
  const items = Array.isArray(db?.items) ? db.items.filter((it) => it && it.id && it.name) : []
  return { items }
}

async function save(root, db) {
  await writeAtomic(ledgerFile(root), JSON.stringify({ items: db.items }, null, 2))
}

function pub(it) {
  return {
    id: String(it.id),
    name: String(it.name),
    when: String(it.when ?? ''),
    by: it.by === 'her' ? 'her' : 'owner',
    mime: String(it.mime ?? ''),
    bytes: Number(it.bytes) || 0,
    at: String(it.at ?? ''),
  }
}

/** 按文件头认宽高。认不出就 null，不猜。 */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf.slice(0, 3).toString('latin1') === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue }
      const mark = buf[i + 1]
      if (mark === 0xc0 || mark === 0xc1 || mark === 0xc2) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      const len = buf.readUInt16BE(i + 2)
      if (!len) break
      i += 2 + len
    }
    return null
  }
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    const tag = buf.slice(12, 16).toString('latin1')
    if (tag === 'VP8X' && buf.length >= 30) {
      return {
        width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
      }
    }
    if (tag === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
    if (tag === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const b0 = buf[21]
      const b1 = buf[22]
      const b2 = buf[23]
      const b3 = buf[24]
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      }
    }
  }
  return null
}

function phrase(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return { ok: false, why: 'empty' }
  if ([...s].length > max) return { ok: false, why: 'long' }
  const clean = sanitizeForeign(s)
  if (clean.dropped || clean.text.trim() !== s) return { ok: false, why: 'foreign' }
  if (!screenOutgoing(s).ok) return { ok: false, why: 'secret' }
  return { ok: true, text: s }
}

function checkName(text) {
  const n = phrase(text, NAME_MAX)
  if (!n.ok) return n
  if (/[\[\]【】]/.test(n.text)) return { ok: false, why: 'brackets' }
  return n
}

async function realOrEmpty(p) {
  try { return await realpath(p) } catch { return '' }
}

/**
 * 把一张图的字节收进账。by 是 'owner' 或 'her'。
 * @returns {Promise<{ok:boolean, note:string, id:string, name:string}>}
 */
export async function addSticker(root, { by = 'owner', name = '', when = '', buf, now = Date.now() } = {}) {
  const home = String(root || '')
  if (!home) return { ok: false, note: '[没有数据文件夹]', id: '', name: '' }
  const named = checkName(name)
  if (!named.ok) return { ok: false, note: '[没写名字]', id: '', name: '' }
  const used = phrase(when, WHEN_MAX)
  if (!used.ok) return { ok: false, note: '[没写什么时候用]', id: '', name: '' }
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.alloc(0)
  if (!bytes.length) return { ok: false, note: '[不是图]', id: '', name: '' }
  if (bytes.length > STICKER_MAX_BYTES) return { ok: false, note: '[太大]', id: '', name: '' }
  const mime = sniffMime(bytes)
  const ext = mime ? IMAGE_MIME[mime] : ''
  if (!ext) return { ok: false, note: '[不是图]', id: '', name: '' }

  const sha = createHash('sha256').update(bytes).digest('hex')
  const db = await load(home)
  const dupImg = db.items.find((it) => it.sha === sha)
  if (dupImg) return { ok: false, note: `[已经有这张] ${dupImg.name}`, id: dupImg.id, name: dupImg.name }
  if (db.items.some((it) => it.name === named.text)) {
    return { ok: false, note: '[重名]', id: '', name: named.text }
  }

  const id = randomUUID().replace(/-/g, '').slice(0, 8)
  const file = `${id}.${ext}`
  const dir = stickerDir(home)
  const dest = join(dir, file)
  const box = imageSize(bytes)
  await mkdir(dir, { recursive: true })
  await writeFile(dest, bytes)
  await chmod(dest, 0o600).catch(() => {})
  db.items.push({
    id,
    name: named.text,
    when: used.text,
    by: by === 'her' ? 'her' : 'owner',
    file,
    mime,
    bytes: bytes.length,
    sha,
    width: box?.width || 0,
    height: box?.height || 0,
    at: new Date(now).toISOString(),
    uploaded: null,
  })
  try {
    await save(home, db)
  } catch (err) {
    await unlink(dest).catch(() => {})
    return { ok: false, note: '[没写下]', id: '', name: '' }
  }
  return { ok: true, note: `[收下了] ${named.text}`, id, name: named.text }
}

/** 设置页上传：JSON 里的 base64，不解析 multipart。 */
export async function saveOwnerSticker(root, { name = '', when = '', data = '' } = {}) {
  const raw = String(data || '')
  if (!raw) return { ok: false, note: '[不是图]', id: '', name: '' }
  const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
  let buf
  try { buf = Buffer.from(base64, 'base64') } catch { buf = Buffer.alloc(0) }
  return addSticker(root, { by: 'owner', name, when, buf })
}

/** 她收一张已经在本机的图。path、name、when 都必填。 */
export async function keepSticker(root, { path = '', name = '', when = '' } = {}) {
  const asked = String(path ?? '').trim()
  if (!asked || /^https?:\/\//i.test(asked) || /^file:/i.test(asked) || !isAbsolute(asked)) {
    return { ok: false, note: '[路径不对]', id: '', name: '' }
  }
  let st
  try { st = await lstat(asked) } catch { return { ok: false, note: '[没有这张]', id: '', name: '' } }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, note: '[路径不对]', id: '', name: '' }
  if (st.size <= 0) return { ok: false, note: '[不是图]', id: '', name: '' }
  if (st.size > STICKER_MAX_BYTES) return { ok: false, note: '[太大]', id: '', name: '' }
  const real = await realOrEmpty(asked)
  const home = await realOrEmpty(root)
  if (!real || !home || !isInside(home, real)) return { ok: false, note: '[路径不对]', id: '', name: '' }
  let buf
  try { buf = await readFile(real) } catch { return { ok: false, note: '[没有这张]', id: '', name: '' } }
  return addSticker(root, { by: 'her', name, when, buf })
}

export async function updateSticker(root, { id = '', name = '', when = '' } = {}) {
  const db = await load(root)
  const it = db.items.find((x) => x.id === String(id || ''))
  if (!it) return { ok: false, note: '[没有这张]' }
  const named = checkName(name)
  if (!named.ok) return { ok: false, note: '[没写名字]' }
  const used = phrase(when, WHEN_MAX)
  if (!used.ok) return { ok: false, note: '[没写什么时候用]' }
  if (db.items.some((x) => x.id !== it.id && x.name === named.text)) return { ok: false, note: '[重名]' }
  it.name = named.text
  it.when = used.text
  await save(root, db)
  return { ok: true, note: '[改好了]' }
}

/**
 * 删一张。by:'her' 时不能删你放的。
 */
export async function removeSticker(root, { id = '', by = 'owner' } = {}) {
  const db = await load(root)
  const it = db.items.find((x) => x.id === String(id || ''))
  if (!it) return { ok: false, note: '[没有这张]' }
  if (by === 'her' && it.by !== 'her') return { ok: false, note: '[这张是你放的]' }
  db.items = db.items.filter((x) => x.id !== it.id)
  await save(root, db)
  const file = join(stickerDir(root), String(it.file || ''))
  const dir = await realOrEmpty(stickerDir(root))
  const real = await realOrEmpty(file)
  if (dir && real && isInsideStrict(dir, real)) await unlink(real).catch(() => {})
  return { ok: true, note: '[删了]' }
}

export async function pageStickers(root, page = 1) {
  const items = (await load(root)).items.slice().reverse()
  const pages = Math.max(1, Math.ceil(items.length / STICKER_PAGE))
  const p = Math.min(pages, Math.max(1, Math.floor(Number(page) || 1)))
  const start = (p - 1) * STICKER_PAGE
  return {
    page: p,
    pages,
    total: items.length,
    items: items.slice(start, start + STICKER_PAGE).map(pub),
  }
}

/** 出图。路径必须落在 stickers/ 里，否则当没有。 */
export async function readStickerImage(root, id) {
  const want = String(id || '')
  if (!/^[a-f0-9]{8}$/.test(want)) return null
  const it = (await load(root)).items.find((x) => x.id === want)
  if (!it?.file || !/^[a-f0-9]{8}\.(png|jpg|webp|gif)$/.test(String(it.file))) return null
  const dir = await realOrEmpty(stickerDir(root))
  const real = await realOrEmpty(join(stickerDir(root), it.file))
  if (!dir || !real || !isInsideStrict(dir, real)) return null
  try {
    const buf = await readFile(real)
    return { buf, mime: String(it.mime || 'application/octet-stream') }
  } catch {
    return null
  }
}

/** 名字对不上时，回执里最多带 8 个现有名字。 */
export async function stickerMissNote(root, name) {
  const names = (await load(root)).items.map((it) => it.name).slice(-8)
  const tail = names.length ? `现有的：${names.join('、')}。` : ''
  const shown = screenOutgoing(name).ok ? String(name || '').trim().slice(0, NAME_MAX) : ''
  if (!shown) return `没有这张表情包，只发了文字。${tail}`
  return `没有叫「${shown}」的表情包，只发了文字。${tail}`
}

/**
 * 她想带图又想不起名字时自己查。没有定时，也不在每条回复里替她调。
 * 开关关着只说用不上，不报名字。空词、对不上，都不倒出账本。
 * @returns {Promise<{ok:boolean, note:string}>}
 */
export async function findStickers(root, word, { on = false } = {}) {
  if (on !== true) return { ok: false, note: '现在用不上。' }
  const q = String(word ?? '').replace(/\s+/g, ' ').trim()
  if (!q) return { ok: false, note: '要给一个词。' }
  if (!screenOutgoing(q).ok) return { ok: false, note: '这个词不能查。' }
  const shown = [...q].slice(0, WHEN_MAX).join('')
  const hits = (await load(root)).items.slice().reverse()
    .filter((it) => String(it.when ?? '').includes(shown))
    .slice(0, 3)
  if (!hits.length) return { ok: false, note: `没有对上「${shown}」。` }
  return { ok: true, note: hits.map((it) => `${it.name} —— ${it.when}`).join('\n') }
}

/**
 * 按名字取出本机文件，供发图。路径必须落在 stickers/ 里。
 * @returns {Promise<{ok:boolean, path:string, note:string}>}
 */
export async function stickerPath(root, name) {
  const want = String(name ?? '').trim()
  const it = (await load(root)).items.find((x) => x.name === want)
  if (!it) return { ok: false, path: '', note: await stickerMissNote(root, want) }
  if (!it.file || !/^[a-f0-9]{8}\.(png|jpg|webp|gif)$/.test(String(it.file))) {
    return { ok: false, path: '', note: '这张图没带上。' }
  }
  const dir = await realOrEmpty(stickerDir(root))
  const real = await realOrEmpty(join(stickerDir(root), it.file))
  if (!dir || !real || !isInsideStrict(dir, real)) return { ok: false, path: '', note: '这张图没带上。' }
  return { ok: true, path: real, note: '' }
}

/**
 * 按名字取出一张，供顶层评论上传。不存在就给出说明。
 */
export async function commentSticker(root, name) {
  const want = String(name ?? '').trim()
  const db = await load(root)
  const it = db.items.find((x) => x.name === want)
  if (!it) return { ok: false, note: await stickerMissNote(root, want), picture: null }
  const img = await readStickerImage(root, it.id)
  if (!img) return { ok: false, note: '这张图没带上，只发了文字。', picture: null }
  const box = imageSize(img.buf)
  return {
    ok: true,
    note: '',
    picture: {
      id: it.id,
      file: it.file,
      mime: img.mime,
      buf: img.buf,
      width: box?.width || Number(it.width) || 0,
      height: box?.height || Number(it.height) || 0,
      uploaded: it.uploaded && it.uploaded.img_src ? it.uploaded : null,
    },
  }
}

export async function rememberUpload(root, id, uploaded) {
  if (!uploaded?.img_src) return { ok: false }
  const db = await load(root)
  const it = db.items.find((x) => x.id === id)
  if (!it) return { ok: false }
  it.uploaded = {
    img_src: String(uploaded.img_src),
    img_width: Number(uploaded.img_width) || 0,
    img_height: Number(uploaded.img_height) || 0,
    img_size: Number(uploaded.img_size) || 0,
  }
  if (it.uploaded.img_width) it.width = it.uploaded.img_width
  if (it.uploaded.img_height) it.height = it.uploaded.img_height
  await save(root, db)
  return { ok: true }
}

export function registerKeepSticker(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const tenancy = { root, herDir: String(deps.tenant?.herDir ?? ''), tenant: deps.tenant?.tenant ?? { ok: true } }
  return ctx.tools.register(
    defineTool({
      name: 'keep_sticker',
      description: '把一张本地图收成评论表情包。path、name、when 都要有。name 是名字，when 是什么时候用。缺了就不收。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本机图片的绝对路径。' },
          name: { type: 'string', description: '名字。最多 8 个字，不要加方括号。' },
          when: { type: 'string', description: '什么时候用。最多 30 个字，写画面上的词。' },
        },
        required: ['path', 'name', 'when'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: String(out?.note ?? '') }],
      },
      async execute(args, exec) {
        const who = guardWrite(tenancy, exec, 'keep_sticker')
        if (!who.ok) return { ok: false, note: `[没留下：${who.note}]` }
        return keepSticker(root, { path: args?.path, name: args?.name, when: args?.when })
      },
    }),
  )
}

export function registerFindSticker(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const tenancy = { root, herDir: String(deps.tenant?.herDir ?? ''), tenant: deps.tenant?.tenant ?? { ok: true } }
  return ctx.tools.register(
    defineTool({
      name: 'find_sticker',
      description: '想带表情包又想不起名字时，用一个词来查。查到再决定填不填。不想带就不用查。',
      parameters: {
        type: 'object',
        properties: {
          word: { type: 'string', description: '一个词，对着什么时候用去对。' },
        },
        required: ['word'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: String(out?.note ?? '') }],
      },
      async execute(args, exec) {
        const who = guardWrite(tenancy, exec, 'find_sticker')
        if (!who.ok) return { ok: false, note: `[没查：${who.note}]` }
        const { config } = await loadConfig(root)
        return findStickers(root, args?.word, { on: config?.comment?.sticker === true })
      },
    }),
  )
}
