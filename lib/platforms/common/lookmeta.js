/**
 * lookmeta.js —— 知乎/贴吧“刷了什么”的轻量记录。
 *
 * 句子和前缀都在 lib/core/acts.js 的动作表里，这里只转发，避免两套格式。
 * 不参与配额（次数仍看 state 文件），也不参与派生。
 */

import { formatZhihuBrowse, formatTiebaBrowse, MAX_ITEMS, MAX_TITLE } from '../../core/acts.js'

export const zhihuLookMeta = formatZhihuBrowse
export const tiebaLookMeta = formatTiebaBrowse
export { MAX_ITEMS, MAX_TITLE }

export default { zhihuLookMeta, tiebaLookMeta, MAX_ITEMS, MAX_TITLE }
