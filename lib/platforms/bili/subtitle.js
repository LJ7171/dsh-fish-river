/**
 * subtitle.js —— 把一条 B 站视频的字幕变成她能读的几行字
 *
 * 为什么单独一层：抽帧（video.js）解决「画面里是什么」，字幕解决「里面在说什么」。
 * 后者不用下载音视频、不用转写模型——B 站本身就有 CC / AI 字幕轨
 * （`lib/platforms/bili.js` 的 `subtitle()`），拉下来就是带时间轴的文本。
 *
 * 三条边界：
 *   - **不落盘**：字幕只在这一次调用里过一手；`watched:` 事件仍然只记标题。
 *   - **不整篇灌**：按时间轴等距抽样 + 字数上限，最多几十行。整部片的字幕
 *     塞进上下文会把她的判断挤没，也会把 token 烧光。
 *   - **过 guard**：字幕是外人写的东西，和评论、弹幕同一条规矩——
 *     试图重塑她的行直接丢，不递给她。
 */

import { sanitizeForeign, looksLikeRewriting } from '../../core/guard.js'

/** 字幕轨通常能拉几百上千行；这个上限是「够她听懂这一段」而不是「全文」。 */
export const SUBTITLE_MAX_LINES = 60
export const SUBTITLE_MAX_CHARS = 1400

function errorText(error) {
  return String(error?.message ?? error).slice(0, 200)
}

/** 秒 → mm:ss（超过一小时就 h:mm:ss，免得「85:12」这种读不出来）。 */
export function formatStamp(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(r).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * 从一整条字幕轨里挑几行。
 *
 * 等距抽而不是取前 N 行：前 N 行只覆盖开头几十秒，等于只知道视频怎么开场。
 * 抽样保留「开头—中间—结尾」的大致轮廓，和抽帧同一套想法。
 *
 * @param {{t:number,text:string}[]} lines
 * @param {{maxLines?:number,maxChars?:number}} [opts]
 * @returns {{ok:boolean, lines:{t:number,text:string}[], text:string, total:number, dropped:number, why:string}}
 */
export function pickSubtitleLines(lines, opts = {}) {
  const maxLines = Math.max(1, Number(opts.maxLines ?? SUBTITLE_MAX_LINES))
  const maxChars = Math.max(80, Number(opts.maxChars ?? SUBTITLE_MAX_CHARS))
  const all = (Array.isArray(lines) ? lines : [])
    .map((l) => ({ t: Number(l?.t) || 0, text: String(l?.text ?? '').trim() }))
    // 空行不要；想改她的话也不要（和评论/弹幕同一条防注入规矩）。
    .filter((l) => l.text && !looksLikeRewriting(l.text).hit)
  const total = all.length
  if (!total) return { ok: false, lines: [], text: '', total: 0, dropped: 0, why: '这条没有可用的字幕' }

  const step = Math.max(1, Math.ceil(total / maxLines))
  const picked = []
  let chars = 0
  for (let i = 0; i < total && picked.length < maxLines; i += step) {
    const line = `[${formatStamp(all[i].t)}] ${all[i].text}`
    if (picked.length && chars + line.length + 1 > maxChars) break
    picked.push(line)
    chars += line.length + 1
  }
  // 整块再过一次 sanitizeForeign：伪造系统指令的行会被换成一句中性的说明。
  const text = sanitizeForeign(picked.join('\n')).text
  const kept = picked.map((s) => {
    const m = /^\[([0-9:]+)\] (.*)$/.exec(s)
    return { t: m ? m[1] : '', text: m ? m[2] : s }
  })
  return { ok: true, lines: kept, text, total, dropped: total - kept.length, why: '' }
}

/**
 * 拉一条视频的字幕并挑好。
 *
 * 失败不抛：没有字幕轨 / 没登录 / 视频没 CC 都是正常情况，
 * 调用方照常给画面，只是少了这一节。
 *
 * @returns {Promise<{ok:boolean, lines:{t:string,text:string}[], text:string, total:number, dropped:number, why:string}>}
 */
export async function subtitleFor({ client, bvid, cid, maxLines, maxChars } = {}) {
  if (!client || typeof client.subtitle !== 'function') {
    return { ok: false, lines: [], text: '', total: 0, dropped: 0, why: '这个客户端没有字幕接口' }
  }
  if (!bvid || !cid) return { ok: false, lines: [], text: '', total: 0, dropped: 0, why: '缺 bvid 或 cid' }
  try {
    const r = await client.subtitle(bvid, cid)
    if (!r?.ok || !Array.isArray(r.data) || !r.data.length) {
      return { ok: false, lines: [], text: '', total: 0, dropped: 0, why: r?.message || '这条没有字幕' }
    }
    return pickSubtitleLines(r.data, { maxLines, maxChars })
  } catch (error) {
    return { ok: false, lines: [], text: '', total: 0, dropped: 0, why: errorText(error) }
  }
}

export default { formatStamp, pickSubtitleLines, subtitleFor, SUBTITLE_MAX_LINES, SUBTITLE_MAX_CHARS }
