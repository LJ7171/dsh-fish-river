/**
 * cookies.js —— cookie 串整理（零依赖，纯文本）。
 *
 * 允许从 Netscape cookies.txt 或 "a=1; b=2" 传入。只做整理，不验登录。
 */

/**
 * 把 cookie 串整理干净（允许从 Netscape cookies.txt 或 "a=1; b=2" 传入）
 */
export function normalizeCookie(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  if (s.includes('\t')) {
    const pairs = []
    for (const line of s.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue
      const p = line.split('\t')
      if (p.length >= 7 && p[5]) pairs.push(`${p[5]}=${p[6]}`)
    }
    return pairs.join('; ')
  }
  return s
}

