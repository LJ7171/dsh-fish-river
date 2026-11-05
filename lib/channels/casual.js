/**
 * casual.js —— 渠道回复发出去之前的轻量口语化
 *
 * 真人聊天句末很少打句号。这一层只做这件事：去掉作文式的句末 `。` / `.`。
 * 逗号不动，问号感叹号不动，省略号、小数、版本号、域名、链接、代码也不动。
 * 更重的改写（逗号变空格那一档）不在这里。
 *
 * 开关是 `config.im.casualPunctuation`，**默认开**。只有显式 `false` 才关。
 * 关了之后这一层等于不存在：发出去的字和后处理出现之前一样。
 */

/** 句号后面这些收尾符号还算同一句的外壳，剥句号时留着它们。 */
const CLOSER = new Set([
  '"', "'", '“', '”', '‘', '’',
  '「', '」', '『', '』', '（', '）', '(', ')',
  '[', ']', '【', '】', '《', '》', '〈', '〉',
])

/**
 * 点号后面紧跟这些，说明它是单词的一部分（小数、版本、域名、扩展名），不是句末。
 * 中文不算：`ok.然后` 里的点还是句号。
 */
function isTokenChar(ch) {
  return ch != null && /[A-Za-z0-9_]/.test(ch)
}

/** `Mr.` `e.g.` 这种缩写不是句末。只认一小串常见的，不据此改写别的词。 */
const ABBR = new Set(['mr', 'mrs', 'ms', 'dr', 'vs', 'etc', 'eg', 'ie', 'st', 'jr', 'sr'])

function wordBefore(s, i) {
  let j = i - 1
  while (j >= 0 && /[A-Za-z]/.test(s[j])) j -= 1
  return s.slice(j + 1, i)
}

/**
 * 渠道回复要不要做轻量口语化。
 * 缺这个键就是开（跟 `bubbleSplit` 相反：那个缺键是关）。
 * `getConfig` 有时给配置本身，有时套一层 `{ config }`，两种都认。
 */
export function casualPunctuationOn(config) {
  const im = config?.im ?? config?.config?.im
  return im?.casualPunctuation !== false
}

function maskProtected(src) {
  const slots = []
  const put = (m) => {
    const token = `\u0000${slots.length}\u0000`
    slots.push(m)
    return token
  }
  // 先整块代码，再行内代码，最后链接。链接末尾的句号剥回正文，那是句末不是网址。
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
 * 去掉一处句末句号，并把紧跟着的引号括号留在原地。
 * 后面同一行还有字时补一个空格，避免「你好世界」粘成一块。
 * 返回值是写进结果的片段，以及下一轮该从哪一个下标继续。
 */
function takeStop(s, i, out) {
  let j = i + 1
  let closers = ''
  while (j < s.length && CLOSER.has(s[j])) {
    closers += s[j]
    j += 1
  }
  let add = closers
  const after = s[j]
  if (after != null && !/\s/.test(after)) {
    const tail = out[out.length - 1]
    const last = add[add.length - 1]
    const boundary = last ?? tail
    if (boundary == null || !/\s/.test(boundary)) add += ' '
  }
  return { add, resume: j }
}

function stripStops(s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '。' && c !== '.') {
      out += c
      continue
    }
    const prev = s[i - 1]
    const next = s[i + 1]
    if (c === '。') {
      if (prev === '。' || next === '。') {
        out += c
        continue
      }
    } else if (prev === '.' || next === '.' || isTokenChar(next) || ABBR.has(wordBefore(s, i).toLowerCase())) {
      out += c
      continue
    }
    const taken = takeStop(s, i, out)
    out += taken.add
    i = taken.resume - 1
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

/** 剥完只剩空白，或只剩孤立句号（不是省略号），就当没有这句话。 */
function dropIfEmpty(s) {
  const t = String(s ?? '').trim()
  if (!t) return ''
  if (/^(?:\.|。|\s)+$/.test(t) && !/\.{2,}|。{2,}/.test(t)) return ''
  return t
}

/**
 * 轻量口语化一条即将发出的文本。
 * 代码块、行内代码、链接原样保留；问号感叹号、省略号、表情、@ 都不改。
 * 空串、纯句号、只剩空白，返回 `''`，调用方不要把空消息发出去。
 *
 * @param {string} text
 * @returns {string}
 */
export function casualizePunctuation(text) {
  if (text == null) return ''
  const src = typeof text === 'string' ? text : String(text)
  if (!src.trim()) return ''
  const { s, slots } = maskProtected(src)
  const stripped = tidySpace(stripStops(s))
  return dropIfEmpty(restore(stripped, slots))
}
