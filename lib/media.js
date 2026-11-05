/**
 * media.js —— 让她「看得见」：图片落盘 + 视频抽帧拼图
 *
 * 为什么这么做（2026-10-23 定案，已实测）：
 *   她的会话是一个正常的 DSH 会话，**有 read_image 工具**。实测把一张写着 7
 *   的图片路径递给她，她用 read_image 读出来答「七」——原生多模态是通的。
 *   所以这里完全不需要去拼 `image` content block（那套 attachment 体系是给
 *   附件上传用的，插件侧没有稳定入口）。我们要做的只有一件事：
 *   **把画面变成她磁盘上的一个文件，然后把路径告诉她。**
 *
 * 依赖只有 ffmpeg（本机已有）。装/查的规矩（用户 2026-10-23 要求）：
 *   - 先探测，本机已装就直接用，不重复安装；
 *   - 没装时不静默失败，也不往插件包里塞二进制（几十 MB 且要跟着平台分发），
 *     而是把「怎么装」原样交给自检面板显示。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const FFMPEG_ENV = 'DSH_FISH_FFMPEG'

// 插件根目录：`lib/media.js` 的上两级。
// 为什么要有这么一个「自带的 ffmpeg」查找点（2026-11-02，用户 m03816）：
// 他直接把官方 essentials 包丢进了工作区，要求「打进项目」——装在 Windows 上
// 又不进 git（ffmpeg.exe 100 MB，GitHub 单文件上限就是 100 MB），所以做成
// 「放在 bin/<平台>-<架构>/ 里就会被优先用到」，由 tools/setup-ffmpeg.mjs 负责解压。
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 打包位置：bin/win32-x64/ffmpeg.exe、bin/linux-x64/ffmpeg… */
export function bundledFfmpegPath({ platform = process.platform, arch = process.arch } = {}) {
  const exe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  return join(PKG_ROOT, 'bin', `${platform}-${arch}`, exe)
}

// 允许 MIME 白名单：与宿主 ImageAttachmentRef 的枚举一致
export const IMAGE_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

// 单张图上限。base64 会膨胀 4/3，太大会把请求体撑爆（观测台那边 8MB 上限）
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024

/** 按魔数判类型；不信浏览器给的 mime（它会骗人，也会给空） */
export function sniffMime(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  return null
}

/**
 * 探测 ffmpeg 是否可用。**只读**，不安装任何东西。
 * @returns {{ok:boolean, bin:string, version:string, why:string}}
 */
export function detectFfmpeg(env = process.env) {
  // 环境变量被设成空串时要退回默认值：spawn('') 会直接抛
  // `TypeError: The argument 'file' cannot be empty`，而不是走「没找到 ffmpeg」这条路
  // （2026-10-30 在 CI 上把 ffmpeg 从 PATH 拿掉时踩到）。
  //
  // 查找顺序（2026-11-02 起）：
  //   1. DSH_FISH_FFMPEG —— 用户显式指了路径就只认这一条，不再偷偷回落。
  //      静默回落会让「我明明指了它却用了别的」这种问题永远查不出来。
  //   2. 插件自带的 bin/<平台>-<架构>/ffmpeg.exe（tools/setup-ffmpeg.mjs 解压出来）。
  //   3. PATH 里的 ffmpeg。
  const explicit = String(env[FFMPEG_ENV] ?? '').trim()
  const candidates = explicit ? [explicit] : []
  if (!explicit) {
    const bundled = bundledFfmpegPath()
    if (existsSync(bundled)) candidates.push(bundled)
    candidates.push('ffmpeg')
  }

  let last = null
  for (const bin of candidates) {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    if (r.error) {
      last = { bin, missing: r.error.code === 'ENOENT', message: String(r.error.message ?? r.error) }
      continue
    }
    const first = String(r.stdout ?? '').split('\n')[0] ?? ''
    const m = first.match(/ffmpeg version (\S+)/)
    if (m) return { ok: true, bin, version: m[1], why: '' }
    last = { bin, missing: false, message: '跑起来了但不是 ffmpeg' }
  }

  // 一种都没成：把最相关的那条原因交出去。
  const bin = last?.bin ?? 'ffmpeg'
  const why = explicit
    ? `没找到 ffmpeg（DSH_FISH_FFMPEG 指向的 ${bin} 不可用）`
    : last?.missing
      ? '没找到 ffmpeg'
      : (last?.message ?? '没找到 ffmpeg')
  return { ok: false, bin, version: '', why }
}

/** 跑一个命令，返回 {code, stderr}；不抛（ffmpeg 有进度输出，统一吞掉） */
function run(bin, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let err = ''
    let done = false
    const p = spawn(bin, args, { windowsHide: true })
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try { p.kill('SIGKILL') } catch { /* ignore */ }
      resolve({ code: -1, stderr: `${err}\n(timeout ${timeoutMs}ms)` })
    }, timeoutMs)
    p.stderr.on('data', (c) => { if (err.length < 8000) err += String(c) })
    p.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: -2, stderr: String(e?.message ?? e) })
    })
    p.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: code ?? -3, stderr: err })
    })
  })
}

/** 媒体目录（她看过的画面都在这），返回绝对路径 */
export async function mediaDir(root) {
  const dir = join(root, 'media')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * 几张图并成一张（图文的「画面」）。
 *
 * 抖音的图文作品没有视频流，`ffmpeg -i a.webp -i b.webp` 加 hstack 就能拼；
 * 只有一张时按高度缩放后直接转 PNG。拼不出来就返回 {ok:false}——调用方不许因此改口。
 */
export async function imageSheet(o = {}) {
  const files = (o.inputs ?? []).filter(Boolean).slice(0, 3)
  if (!files.length) return { ok: false, why: '没有图' }
  const height = Math.max(160, Math.min(480, Number(o.height) || 360))
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  for (const f of files) args.push('-i', f)
  if (files.length === 1) {
    args.push('-vf', `scale=-2:${height}`, '-frames:v', '1', o.out)
  } else {
    const chains = files.map((_, i) => `[${i}:v]scale=-2:${height}[s${i}]`).join(';')
    const joined = files.map((_, i) => `[s${i}]`).join('')
    args.push('-filter_complex', `${chains};${joined}hstack=inputs=${files.length}`, '-frames:v', '1', o.out)
  }
  const r = await run(o.bin, args)
  if (r.code !== 0) return { ok: false, why: String(r.stderr || '拼图失败').trim().slice(0, 120) }
  const st = await fs.stat(o.out).catch(() => null)
  if (!st || !st.size) return { ok: false, why: '拼出来是空图' }
  return { ok: true, path: o.out }
}

/**
 * 把一张图落到磁盘，返回路径。她之后用 read_image 读这个路径。
 * @param {string} root 状态库根
 * @param {Buffer} buf 图片字节
 * @param {{prefix?:string}} o
 */
export async function saveImage(root, buf, o = {}) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, why: '空图' }
  const cap = Number(o.maxBytes) > 0 ? Number(o.maxBytes) : MAX_IMAGE_BYTES
  if (buf.length > cap) {
    return { ok: false, why: `图太大了（${(buf.length / 1048576).toFixed(1)}MB，上限 ${cap / 1048576}MB）` }
  }
  const mime = sniffMime(buf)
  if (!mime) return { ok: false, why: '这不是 png/jpg/webp/gif，或者文件坏了' }
  const dir = await mediaDir(root)
  const name = `${o.prefix ?? 'img'}-${Date.now()}-${randomUUID().slice(0, 8)}.${IMAGE_MIME[mime]}`
  const path = join(dir, name)
  await fs.writeFile(path, buf)
  return { ok: true, path, mime, bytes: buf.length, name }
}

/**
 * 把几张 http(s) 图下载进 media/。认不出、太大、请求失败就跳过这一张。
 * 给「她正在看的这一页」用，不要拿去扫整条信息流。
 * @returns {Promise<string[]>} 本地绝对路径
 */
export async function saveFetchedImages(root, urls, { fetchImpl = fetch, referer = '', prefix = 'img', max = 3, maxBytes = 8 * 1024 * 1024 } = {}) {
  const out = []
  for (const url of (urls ?? []).slice(0, Math.max(0, Number(max) || 0))) {
    try {
      const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15000) : undefined
      const headers = { 'user-agent': 'Mozilla/5.0' }
      if (referer) headers.referer = referer
      const res = await fetchImpl(url, { headers, signal })
      if (!res?.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      const saved = await saveImage(root, buf, { prefix, maxBytes })
      if (saved.ok) out.push(saved.path)
    } catch { /* 单张失败不影响其它 */ }
  }
  return out
}

/** 从 base64（可带 data: 前缀）还原成 Buffer */
export function decodeBase64Image(data) {
  const s = String(data ?? '')
  const m = s.match(/^data:([^;]+);base64,(.*)$/s)
  const b64 = m ? m[2] : s
  if (!b64) return { ok: false, why: '没有图的数据' }
  try {
    return { ok: true, buf: Buffer.from(b64, 'base64'), declared: m?.[1] ?? '' }
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e) }
  }
}

/** 用 ffmpeg 打印的 stderr 里抓时长（不额外依赖 ffprobe） */
export function parseDuration(stderr) {
  const m = String(stderr).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** 视频总时长（秒）。读不到返回 0 —— 调用方要当「不知道」处理，别当 0 秒 */
export async function probeDuration(bin, input, { headers = '' } = {}) {
  const args = ['-hide_banner', '-i', input, '-f', 'null', '-t', '0.1', '-']
  if (headers) args.unshift('-headers', headers)
  const r = await run(bin, args, { timeoutMs: 30_000 })
  return parseDuration(r.stderr)
}

/**
 * 抽帧 + 拼 contact sheet。
 *
 * 为什么按「镜头切换」选而不是等间隔：等间隔抽帧正好会漏掉笑点/反转/突然出现
 * 的东西——那才是人希望她看见的。`select='gt(scene,T)'` 就是镜头变了才取。
 * 素材太静（比如一张 PPT 讲到底）时镜头切换为空，这时退回等间隔。
 *
 * @param {{bin:string, input:string, out:string, headers?:string, cols?:number, rows?:number,
 *          fromSec?:number, toSec?:number, scale?:number}} o
 */
export async function contactSheet(o) {
  const cols = Math.max(1, Math.min(4, o.cols ?? 3))
  const rows = Math.max(1, Math.min(4, o.rows ?? 3))
  const n = cols * rows
  const scale = Math.max(160, Math.min(480, o.scale ?? 320))
  const from = Math.max(0, Number(o.fromSec ?? 0))
  const to = Number(o.toSec ?? 0)

  const base = ['-hide_banner', '-loglevel', 'error', '-y']
  if (o.headers) base.push('-headers', o.headers)
  if (from > 0) base.push('-ss', String(from))
  if (to > from) base.push('-t', String(to - from))

  // 第一轮：按镜头切换取 n 张（帧率极低，等价于「最多 n 张」）
  const scene = [
    ...base, '-i', o.input,
    '-vf', `select='gt(scene,0.25)',scale=${scale}:-2,tile=${cols}x${rows}`,
    '-frames:v', '1', o.out,
  ]
  let r = await run(o.bin, scene)
  let stat = await fs.stat(o.out).catch(() => null)
  let mode = 'scene'

  // 镜头切换太少（静态画面 / 纯口播）：退回等间隔
  if (!stat || stat.size < 1024) {
    const dur = to > from ? to - from : 0
    const every = dur > 0 ? Math.max(0.5, dur / n) : 5
    const even = [
      ...base, '-i', o.input,
      '-vf', `fps=1/${every.toFixed(3)},scale=${scale}:-2,tile=${cols}x${rows}`,
      '-frames:v', '1', o.out,
    ]
    r = await run(o.bin, even)
    stat = await fs.stat(o.out).catch(() => null)
    mode = 'even'
  }

  if (!stat || stat.size < 1024) {
    return { ok: false, mode, why: (r.stderr || 'ffmpeg 没出图').slice(0, 400) }
  }
  return { ok: true, mode, path: o.out, bytes: stat.size, cols, rows }
}

/** 图片/截图留在硬盘上的时间。三天够她"回头看那天看到的东西"，也不会积成垃圾。 */
export const MEDIA_TTL_MS = 3 * 24 * 60 * 60 * 1000

/**
 * 清掉过期的图片与截图。**只删自己写在 media/ 下的文件**，不碰别处。
 * 返回 {removed, kept}。删不掉不算错（可能正被别的程序占着），静默跳过。
 */
export async function sweepMedia(root, { now = Date.now(), ttlMs = MEDIA_TTL_MS } = {}) {
  const dir = await mediaDir(root)
  let removed = 0
  let kept = 0
  let names = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return { removed, kept }
  }
  for (const name of names) {
    const p = join(dir, name)
    try {
      const st = await fs.stat(p)
      if (!st.isFile()) continue
      if (now - st.mtimeMs > ttlMs) {
        await fs.unlink(p)
        removed++
      } else kept++
    } catch {
      kept++
    }
  }
  return { removed, kept }
}
