/**
 * 抖音链接：把「一条链接」变成「她看过的东西」。
 *
 * 为什么单独一个文件：
 * - 抖音的分享卡片（私信里点「分享」发过来的那种）在 WebSocket 帧里只剩四个字
 *   「分享图文」，没有 aweme_id、没有标题、没有封面。那条路要解 protobuf，脆且贵。
 * - 但链接是干净的：`v.douyin.com/xxx`、`douyin.com/video/<id>`、`iesdouyin.com/share/video/<id>`。
 *   把 id 取出来，用她自己那个浏览器（登录态在里面）去问 aweme/detail，就能拿到
 *   文案、作者、时长、互动数——这是「看过了」里可核对的部分。
 * - 抽帧是加分项：能下到视频就抽三帧拼一张；下不到也不影响她说话。
 *
 * 三条边界（AGENTS §14）：
 * 1. 只有主人递来的链接记成「他给我的」；别人发的（群里、评论区）算社会层。
 * 2. 拿不到就照实说拿不到——不许把「分享图文」补全成她想象的内容。
 * 3. 这个模块永不抛：所有失败都变成 {ok:false, why}。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { contactSheet, detectFfmpeg, imageSheet, mediaDir } from './media.js'

/** 认得的三种链接形状。顺序有意义：先具体，后笼统。 */
const PATTERNS = [
  // 短链。要排掉 `www.douyin.com/video/...` 这种「路径第一段恰好也叫 video」的长链，
  // 否则同一条链接会被两条正则各抓一次。
  /https?:\/\/(?:v|www)\.douyin\.com\/(?!video\/|note\/|discover|jingxuan|search|user\/)[A-Za-z0-9_-]{4,32}/g,
  /https?:\/\/(?:www|m)\.douyin\.com\/(?:video|note)\/\d{6,25}/g,
  /https?:\/\/(?:www\.)?iesdouyin\.com\/share\/(?:video|note)\/\d{6,25}/g,
]

/** 一屏最多看几条链接（防她一次收到一串）。 */
export const LINKS_MAX = 2

/** 下视频要带的头：douyinvod 的 CDN 不带 Referer 直接 403（真机验证过）。 */
const VIDEO_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  referer: 'https://www.douyin.com/',
}

/** 抽帧拼图最多留几张（2026-11-03，用户问「会不会占我硬盘」）。 */
export const SHEETS_KEEP = 20

/**
 * 清掉旧的拼图与残留视频。
 *
 * 视频本体不落盘超过一次抽帧的时间（`framesOf` 的 finally 里删），
 * 但拼图是「她真看过」的证据，会一直留着——所以要有个上限。
 * 只动 `media/` 下自己起的名字，别的文件一概不碰。
 */
export async function pruneMedia(dir, { keep = SHEETS_KEEP } = {}) {
  try {
    const names = await fs.readdir(dir)
    const sheets = []
    for (const name of names) {
      const full = path.join(dir, name)
      if (/^dy-sheet-.*\.png$/.test(name)) {
        const st = await fs.stat(full).catch(() => null)
        if (st) sheets.push({ full, at: st.mtimeMs })
      } else if (/^dy-.*\.mp4$/.test(name)) {
        // 抽帧中途异常退出时可能留下半个视频，直接收尸。
        await fs.rm(full, { force: true }).catch(() => {})
      }
    }
    sheets.sort((a, b) => b.at - a.at)
    for (const s of sheets.slice(Math.max(0, keep))) await fs.rm(s.full, { force: true }).catch(() => {})
    return { ok: true, kept: Math.min(sheets.length, keep), removed: Math.max(0, sheets.length - keep) }
  } catch {
    return { ok: false, why: 'media 目录读不了' }
  }
}

/** 详情接口（网页版，未签名；只读）。 */
export const DETAIL_PATH = '/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id='

/**
 * 从一段话里挑出抖音链接。
 * @param {string} text
 * @returns {Array<{url:string, id:string}>} id 为空串表示还要去解析短链
 */
export function findDouyinLinks(text) {
  const s = String(text ?? '')
  if (!s) return []
  const out = []
  const seen = new Set()
  for (const re of PATTERNS) {
    for (const m of s.matchAll(re)) {
      const url = m[0]
      const id = awemeIdFromUrl(url)
      const key = id || url
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ url, id })
      if (out.length >= LINKS_MAX) return out
    }
  }
  return out
}

/** 链接里本来就带 id 的，直接取。 */
export function awemeIdFromUrl(url) {
  const m = String(url ?? '').match(/\/(?:video|note)\/(\d{6,25})/)
  return m ? m[1] : ''
}

/**
 * 短链（v.douyin.com/xxx）走一次跳转拿真实 id。
 * 只做 HEAD/GET 的跳转跟读，不发任何写请求。
 */
export async function resolveAwemeId(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const direct = awemeIdFromUrl(url)
  if (direct) return { ok: true, id: direct }
  if (typeof fetchImpl !== 'function') return { ok: false, id: '', why: '没有可用的 fetch' }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    // redirect:'manual' 才能读到 Location，而不是被 fetch 自动跟进后吞掉。
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ctl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
    })
    const location = res?.headers?.get?.('location') ?? ''
    const fromLocation = awemeIdFromUrl(location)
    if (fromLocation) return { ok: true, id: fromLocation }
    // 有些短链直接 200 返回一张落地页，id 在正文里。
    if (res?.status === 200 && typeof res.text === 'function') {
      const body = await res.text().catch(() => '')
      const fromBody = String(body).match(/\/(?:video|note)\/(\d{6,25})/)
      if (fromBody) return { ok: true, id: fromBody[1] }
    }
    return { ok: false, id: '', why: `跳转里没看到视频 id（HTTP ${res?.status ?? '?'}）` }
  } catch (err) {
    return { ok: false, id: '', why: String(err?.name === 'AbortError' ? '解析短链超时' : err?.message ?? err).slice(0, 120) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 用她自己那条浏览器（登录态在里面）问详情。
 * @param {(p:string)=>Promise<{ok:boolean, data?:any, why?:string}>} api 由渠道适配器提供
 */
export async function fetchAweme(id, { api } = {}) {
  if (!id) return { ok: false, why: '没有 id' }
  if (typeof api !== 'function') return { ok: false, why: '这个渠道没有浏览器' }
  const r = await api(DETAIL_PATH + encodeURIComponent(id))
  if (!r?.ok) return { ok: false, why: r?.why ?? '详情没拿到' }
  const data = r.data
  const item = data?.aweme_detail ?? data?.aweme_list?.[0] ?? null
  if (!item) return { ok: false, why: '详情里没有这条视频' }
  return { ok: true, item: normalizeAweme(item) }
}

/** 只留她用得上的字段，别把整个 JSON 塞进上下文。 */
export function normalizeAweme(item = {}) {
  const stats = item.statistics ?? {}
  const video = item.video ?? {}
  const play = video.play_addr ?? {}
  // 图文作品（`share/note/…`）：没有视频流，只有一组图。三张足够她看出「这是什么」。
  const images = (Array.isArray(item.images) ? item.images : [])
    .map((im) => String((im?.url_list ?? [])[0] ?? ''))
    .filter(Boolean)
    .slice(0, 3)
  return {
    id: String(item.aweme_id ?? ''),
    kind: images.length ? 'images' : 'video',
    images,
    desc: String(item.desc || item.caption || item.item_title || '').trim(),
    author: String(item.author?.nickname ?? '').trim(),
    duration: Math.round(Number(video.duration ?? 0) / 1000),
    playUrl: String((play.url_list ?? [])[0] ?? ''),
    cover: String((video.cover?.url_list ?? [])[0] ?? ''),
    likes: Number(stats.digg_count ?? 0),
    comments: Number(stats.comment_count ?? 0),
    shares: Number(stats.share_count ?? 0),
    createdAt: Number(item.create_time ?? 0),
  }
}

/** 一句话概括，给她看的。没有的就别写。 */
export function describeAweme(a = {}) {
  const bits = []
  if (a.author) bits.push(`作者 ${a.author}`)
  if (a.duration > 0) bits.push(`${a.duration} 秒`)
  if (a.likes > 0) bits.push(`${a.likes} 赞`)
  if (a.comments > 0) bits.push(`${a.comments} 条评论`)
  const head = a.desc ? `《${a.desc.slice(0, 80)}》` : '（没写文案）'
  const kind = a.kind === 'images' ? '图文' : ''
  return `${kind ? `${kind}，` : ''}${head}${bits.length ? `，${bits.join(' · ')}` : ''}`
}

/**
 * 抽三帧拼一张图。下不到视频就返回 {ok:false}——调用方不许因此改口。
 */
export async function framesOf(aweme, { root, fetchImpl = globalThis.fetch, maxBytes = 24 * 1024 * 1024 } = {}) {
  if (aweme?.images?.length) return imagesSheet(aweme, { root, fetchImpl })
  if (!aweme?.playUrl) return { ok: false, why: '没有可下载的地址' }
  if (!root) return { ok: false, why: '没有数据目录' }
  const ff = detectFfmpeg()
  if (!ff.ok) return { ok: false, why: `本机没有可用的 ffmpeg（${ff.why}）` }
  const dir = await mediaDir(root).catch(() => path.join(root, 'media'))
  const file = path.join(dir, `dy-${aweme.id || Date.now()}.mp4`)
  const out = path.join(dir, `dy-sheet-${aweme.id || Date.now()}.png`)
  try {
    const res = await fetchImpl(aweme.playUrl, { headers: VIDEO_HEADERS })
    if (!res?.ok) return { ok: false, why: `下载失败（HTTP ${res?.status ?? '?'}）` }
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return { ok: false, why: '下载到的是空文件' }
    if (buf.length > maxBytes) return { ok: false, why: '视频太大，跳过抽帧' }
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, buf)
    const shot = await contactSheet({ bin: ff.bin, input: file, out, fromSec: 0, toSec: aweme.duration || 0, cols: 3, rows: 1 })
    if (!shot?.ok) return { ok: false, why: shot?.why ?? '抽帧失败' }
    await pruneMedia(dir).catch(() => {})
    return { ok: true, path: shot.path, shots: shot.cols * shot.rows }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 120) }
  } finally {
    // 视频本体只用来抽帧，抽完就删；拼图留着当证据。
    await fs.rm(file, { force: true }).catch(() => {})
  }
}

/**
 * 图文作品：把最多三张图拼成一张，走同一条 `read_image` 的路。
 * 图文没有视频流，`playUrl` 通常是空的——所以这条分支必须在 playUrl 之前判。
 */
async function imagesSheet(aweme, { root, fetchImpl = globalThis.fetch } = {}) {
  if (!root) return { ok: false, why: '没有数据目录' }
  const ff = detectFfmpeg()
  if (!ff.ok) return { ok: false, why: `本机没有可用的 ffmpeg（${ff.why}）` }
  const dir = await mediaDir(root).catch(() => path.join(root, 'media'))
  const files = []
  try {
    await fs.mkdir(dir, { recursive: true })
    for (let i = 0; i < aweme.images.length; i += 1) {
      const res = await fetchImpl(aweme.images[i], { headers: VIDEO_HEADERS })
      if (!res?.ok) return { ok: false, why: `第 ${i + 1} 张图没下来（HTTP ${res?.status ?? '?'}）` }
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) return { ok: false, why: '下到的是空图' }
      const f = path.join(dir, `dy-img-${aweme.id || Date.now()}-${i}.webp`)
      await fs.writeFile(f, buf)
      files.push(f)
    }
    const out = path.join(dir, `dy-sheet-${aweme.id || Date.now()}.png`)
    const shot = await imageSheet({ bin: ff.bin, inputs: files, out })
    if (!shot?.ok) return { ok: false, why: shot?.why ?? '拼图失败' }
    await pruneMedia(dir).catch(() => {})
    return { ok: true, path: shot.path, shots: files.length }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 120) }
  } finally {
    // 原图只用来拼一张，拼完就删；拼图留着当证据。
    for (const f of files) await fs.rm(f, { force: true }).catch(() => {})
  }
}

/**
 * 一条链接的全流程：解析 → 详情 → （能的话）抽帧。
 * 永不抛。
 */
export async function lookDouyin(url, { api, root, fetchImpl, withFrames = true } = {}) {
  const resolved = await resolveAwemeId(url, { fetchImpl })
  const id = resolved.id || awemeIdFromUrl(url)
  if (!id) return { ok: false, why: resolved.why || '没认出视频 id' }
  const detail = await fetchAweme(id, { api })
  if (!detail.ok) return { ok: false, id, why: detail.why }
  let frames = { ok: false, why: '没抽' }
  if (withFrames) frames = await framesOf(detail.item, { root, fetchImpl })
  return { ok: true, id, item: detail.item, frames }
}
