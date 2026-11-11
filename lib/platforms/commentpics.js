/**
 * commentpics.js —— 她点开一条内容时，把评论里的图下载到本机
 *
 * 热榜 / 定时刷站不走这里。只有「她正在看的这一页」才下载，
 * 而且一次最多几张。下载失败就少一张，正文照旧。
 *
 * 落盘进 media/（三天 TTL）。想一直留，她自己再调 keep_image。
 */

import { saveFetchedImages } from '../core/media.js'
import { slashed } from '../core/posix.js'

/**
 * 把评论对象上的 http(s) `images` 下载到本地，写回 `pics`（正斜杠路径）。
 * @returns {Promise<string[]>} 给提示词用的那几行
 */
export async function landCommentImages(root, comments, {
  fetchImpl = null,
  referer = 'https://www.bilibili.com/',
  prefix = 'bili-cmt',
  max = 3,
} = {}) {
  const lines = []
  let left = Math.max(0, Number(max) || 0)
  for (const c of comments ?? []) {
    if (!c || typeof c !== 'object' || left <= 0) continue
    const got = []
    for (const url of c.images ?? []) {
      if (left <= 0) break
      if (!/^https?:\/\//i.test(String(url ?? ''))) continue
      const paths = await saveFetchedImages(root, [url], { fetchImpl, referer, prefix, max: 1 })
      if (!paths.length) continue
      got.push(slashed(paths[0]))
      left -= 1
    }
    if (got.length) c.pics = [...(c.pics ?? []), ...got]
    for (const p of got) lines.push(`（有图存在 ${p}，想看就用 read_image。）`)
  }
  return lines
}

export default { landCommentImages }
