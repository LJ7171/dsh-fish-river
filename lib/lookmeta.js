/**
 * lookmeta.js —— 把一次出门看到的标题记成一条轻量 meta（2026-11-07）
 *
 * 只给状态页看“她刷了什么”：标题截短、去换行，不带正文、不带 id。
 * 不参与配额（知乎/贴吧次数仍看 state 文件），也不参与派生。
 */

export const MAX_ITEMS = 8
export const MAX_TITLE = 40

function titleOf(x) {
  return String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
}

/** 知乎：只记标题。 */
export function zhihuLookMeta(dk, picks = []) {
  const rows = (Array.isArray(picks) ? picks : [])
    .map((x) => titleOf(x?.title))
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((title) => ({ title }))
  return rows.length ? `zhihu:${dk} ${JSON.stringify(rows)}` : ''
}

/** 贴吧：吧名-标题。 */
export function tiebaLookMeta(dk, picks = []) {
  const rows = (Array.isArray(picks) ? picks : [])
    .map((x) => {
      const title = titleOf(x?.title)
      const forum = titleOf(x?.forum)
      if (!title) return null
      return forum ? { forum, title } : { title }
    })
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
  return rows.length ? `tieba:${dk} ${JSON.stringify(rows)}` : ''
}

export default { zhihuLookMeta, tiebaLookMeta, MAX_ITEMS, MAX_TITLE }
