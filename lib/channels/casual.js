/**
 * casual.js —— 渠道回复发出去之前的标点轻整理
 *
 * 只做两件事：连续的同一标点收成一个（省略号收到一处省略），多出来的空白收一收。
 * 句末的 `。` / `.` 留着。问号、感叹号、小数、版本、域名、链接、代码也不改写法，
 * 只是一串相同的标点不会连着刷。
 *
 * 开关是 `config.im.casualPunctuation`，**默认开**。只有显式 `false` 才关。
 * 关了之后这一层等于不存在：发出去的字和她写的一样。
 */

/**
 * 点号后面紧跟这些，说明它是单词的一部分（小数、版本、域名、扩展名），不是一串句号。
 */
function isTokenChar(ch) {
  return ch != null && /[A-Za-z0-9_]/.test(ch)
}

/** `Mr.` `e.g.` 这种缩写里的点不是一串标点。 */
const ABBR = new Set(['mr', 'mrs', 'ms', 'dr', 'vs', 'etc', 'eg', 'ie', 'st', 'jr', 'sr'])

function wordBefore(s, i) {
  let j = i - 1
  while (j >= 0 && /[A-Za-z]/.test(s[j])) j -= 1
  return s.slice(j + 1, i)
}

/**
 * 渠道回复要不要做标点轻整理。
 * 缺这个键就是开（跟 `bubbleSplit` 相反：那个缺键是关）。
 * `getConfig` 有时给配置本身，有时套一层 `{ config }`，两种都认。
 */
export function casualPunctuationOn(config) {
  const im = config?.im ?? config?.config?.im
  return im?.casualPunctuation !== false
}

/** 这些连续出现时收成一个。句号也收，但不删掉那一个。 */
const SQUASH = new Set(['!', '！', '?', '？', '。', '，', ',', '、', '~', '～'])

function maskProtected(src) {
  const slots = []
  const put = (m) => {
    const token = `\u0000${slots.length}\u0000`
    slots.push(m)
    return token
  }
  // 先整块代码，再行内代码，最后链接。链接末尾的句号留在正文里，那是句末不是网址。
  let s = src.replace(/```[\s\S]*?```/g, put)
  s = s.replace(/`[^`\n]+`/g, put)
  s = s.replace(/https?:\/\/[^\s<>"'`]+/gi, (m) => {
    const core = m.replace(/[。．.]+$/g, '')
    if (!core || /^https?:\/?$/i.test(core)) return m
    return put(core) + m.slice(core.length)
  })
  return { s, slots }
}

function restore(s, slots) {
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)] ?? '')
}

/**
 * 连续同一标点压成一个。
 * 英文点号：一个留着；两个及以上收成一处省略号 `...`，不收成单个句号。
 * 中文省略号 `…`：两个及以上收成 `……`（一处省略），单独一个不动。
 * 小数、缩写、域名里的点不进这一串。
 */
function squashPunct(s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '.') {
      const next = s[i + 1]
      if (isTokenChar(next) || ABBR.has(wordBefore(s, i).toLowerCase())) {
        out += c
        continue
      }
      let j = i
      while (s[j] === '.') j += 1
      const run = j - i
      // 跑完才发现后面接着单词（`..2` 这种），整串原样留着。
      if (isTokenChar(s[j])) {
        out += s.slice(i, j)
      } else {
        out += run >= 2 ? '...' : '.'
      }
      i = j - 1
      continue
    }
    if (c === '…') {
      let j = i
      while (s[j] === '…') j += 1
      out += (j - i) >= 2 ? '……' : '…'
      i = j - 1
      continue
    }
    if (SQUASH.has(c)) {
      let j = i
      while (s[j] === c) j += 1
      out += c
      i = j - 1
      continue
    }
    out += c
  }
  return out
}

function tidySpace(s) {
  return s
    .replace(/[ \t\u3000]{2,}/g, ' ')
    .replace(/[ \t\u3000]+\n/g, '\n')
    .replace(/\n[ \t\u3000]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 轻整理一条即将发出的文本。
 * 句末句号留着。代码块、行内代码、链接原样保留。
 * 空串、只剩空白，返回 `''`，调用方不要把空消息发出去。
 * 单独一个句号还是一句，照发。
 *
 * @param {string} text
 * @returns {string}
 */
export function casualizePunctuation(text) {
  if (text == null) return ''
  const src = typeof text === 'string' ? text : String(text)
  if (!src.trim()) return ''
  const { s, slots } = maskProtected(src)
  return restore(tidySpace(squashPunct(s)), slots)
}
