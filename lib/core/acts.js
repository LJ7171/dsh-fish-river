/**
 * acts.js —— 各平台动作的纯数据表（2026-11-10）
 *
 * 只放表、格式化和解析。不引用存储，不发请求。
 * 状态页认动作只走 parseAct，不再为每个前缀写一个 if。
 * 以后加平台，在 ACTS 里加一行。
 *
 * `hand:`、`looked:` 不在这张表里。读评论页算点开，不算评论。
 * 知乎 / 贴吧的评论、回复、知乎回答都已接线（wired: true）。
 *
 * 旧行继续能读。`look:`、`watched:`、`comment:` 的 id 仍是日期后的第一段；
 * 标题或摘要放在末尾一个没有多余空格的 JSON 里，按空格取 BV 号和 rpid 的旧代码不会断。
 */

export const MAX_ITEMS = 8
export const MAX_TITLE = 40

/** @type {Array<object>} */
export const ACTS = [
  {
    key: 'bili-browse',
    prefixes: ['browse:', 'browse-more:'],
    quota: 'browse',
    tally: 'browsed',
    tallyPrefix: 'browse:',
    phase: 'browsing',
    label: '在看别人的视频',
    kind: 'browse',
    shape: 'bili-list',
    wired: true,
  },
  {
    key: 'bili-look',
    prefixes: ['look:'],
    quota: null,
    phase: 'browsing',
    label: '在点开一条',
    kind: 'browse',
    shape: 'open',
    wired: true,
  },
  {
    key: 'bili-watch',
    prefixes: ['watched:'],
    quota: 'video',
    phase: 'browsing',
    label: '在看画面',
    kind: 'browse',
    shape: 'open',
    wired: true,
  },
  {
    key: 'bili-comment',
    prefixes: ['comment:'],
    quota: 'comment',
    tally: 'comments',
    phase: 'talking',
    label: '在 B 站说了一句',
    kind: 'comment',
    shape: 'comment',
    wired: true,
  },
  {
    key: 'bili-reply',
    prefixes: ['creply:'],
    quota: 'comment',
    tally: 'comments',
    phase: 'talking',
    label: '回了一条回复',
    kind: 'comment',
    shape: 'comment',
    wired: true,
  },
  {
    key: 'dy-browse',
    prefixes: ['dy-browse:', 'dy-browse:more:'],
    quota: 'douyin',
    phase: 'browsing',
    label: '在刷抖音',
    kind: 'browse',
    shape: 'dy-list',
    wired: true,
  },
  {
    key: 'zhihu-browse',
    prefixes: ['zhihu:'],
    quota: 'zhihu-runs',
    phase: 'browsing',
    label: '在刷知乎',
    kind: 'browse',
    shape: 'zhihu-list',
    wired: true,
  },
  {
    key: 'zhihu-open',
    prefixes: ['zhihu-open:'],
    quota: null,
    phase: 'browsing',
    label: '在看知乎的一页',
    kind: 'browse',
    shape: 'open',
    wired: true,
  },
  {
    key: 'zhihu-comment',
    prefixes: ['zhihu-comment:'],
    quota: 'zhihu-comment',
    phase: 'talking',
    label: '在知乎说了一句',
    kind: 'comment',
    shape: 'comment',
    wired: true,
  },
  {
    key: 'zhihu-reply',
    prefixes: ['zhihu-reply:'],
    quota: 'zhihu-comment',
    phase: 'talking',
    label: '在知乎回了一条',
    kind: 'comment',
    shape: 'comment',
    wired: true,
  },
  {
    key: 'zhihu-answer',
    prefixes: ['zhihu-answer:'],
    quota: 'zhihu-answer',
    phase: 'talking',
    label: '在知乎写了一条回答',
    kind: 'comment',
    shape: 'comment',
    wired: true,
  },
  {
    key: 'tieba-browse',
    prefixes: ['tieba:'],
    quota: 'tieba-runs',
    phase: 'browsing',
    label: '在刷贴吧',
    kind: 'browse',
    shape: 'tieba-list',
    wired: true,
  },
  {
    key: 'tieba-thread',
    prefixes: ['tieba-thread:'],
    quota: null,
    phase: 'browsing',
    label: '在看一个帖子',
    kind: 'browse',
    shape: 'open',
    wired: true,
  },
  {
    key: 'tieba-forum',
    prefixes: ['tieba-forum:'],
    quota: null,
    phase: 'browsing',
    label: '在看一个吧',
    kind: 'browse',
    shape: 'open',
    wired: true,
  },
  {
    key: 'tieba-comment',
    prefixes: ['tieba-comment:'],
    quota: 'tieba-comment',
    phase: 'talking',
    label: '在贴吧说了一句',
    kind: 'comment',
    shape: 'comment',
    wired: true,
  },
  {
    key: 'tieba-reply',
    prefixes: ['tieba-reply:'],
    quota: 'tieba-comment',
    phase: 'talking',
    label: '在贴吧回了一条',
    kind: 'comment',
    shape: 'comment',
    wired: true,
  },
]

/** 不是平台动作，但状态页要把它们当成时间锚（醒、日记、没做成的那一下）。 */
const MARKERS = [
  { key: 'wake', prefixes: ['wake:'], role: 'wake' },
  {
    key: 'diary',
    prefixes: ['diary:'],
    role: 'diary',
    phase: 'writing',
    label: '在写日记',
    kind: 'diary',
    line: '写了今天的日记',
    detail: '',
    tally: 'dairies',
  },
  {
    key: 'quiet',
    prefixes: ['quiet:'],
    role: 'quiet',
    kind: 'quiet',
    line: '醒了，但今天没有该问的事',
  },
  {
    key: 'wakefail',
    prefixes: ['wakefail:'],
    role: 'fail',
    kind: 'fail',
    line: '想醒来，但没成功',
  },
]

const INDEX = []
for (const act of ACTS) {
  for (const prefix of act.prefixes) INDEX.push({ prefix, act, marker: false })
}
for (const act of MARKERS) {
  for (const prefix of act.prefixes) INDEX.push({ prefix, act, marker: true })
}
INDEX.sort((a, b) => b.prefix.length - a.prefix.length)

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export function clipTitle(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
}

function readJson(tail) {
  const at = String(tail ?? '').search(/[\[{]/)
  if (at < 0) return null
  try {
    return JSON.parse(tail.slice(at))
  } catch {
    return null
  }
}

function headTokens(tail) {
  const raw = String(tail ?? '')
  const at = raw.search(/[\[{]/)
  const head = (at < 0 ? raw : raw.slice(0, at)).trim()
  return head ? head.split(/\s+/) : []
}

function textOf(json, key) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return ''
  return String(json[key] ?? '').replace(/\s+/g, ' ').trim()
}

function listLine(json, paint) {
  const items = Array.isArray(json) ? json : []
  return { items, ...paint(items) }
}

function payload(fields) {
  const out = {}
  if (fields?.forum) out.forum = clipTitle(fields.forum)
  if (fields?.title) out.title = clipTitle(fields.title)
  if (fields?.text) out.text = clipTitle(fields.text)
  const question = String(fields?.question ?? '').trim()
  if (/^\d{1,24}$/.test(question)) out.question = question
  // 出门用的是哪个号：只记槽、公开名字、她的还是重要的人的。不记 cookie。
  if (fields?.slot === 'a' || fields?.slot === 'b') out.slot = fields.slot
  if (fields?.owner === 'her' || fields?.owner === 'owner') out.owner = fields.owner
  if (fields?.name) out.name = clipTitle(fields.name)
  return out
}

function withJson(base, fields) {
  const body = payload(fields)
  return Object.keys(body).length ? `${base} ${JSON.stringify(body)}` : base
}

function formatRows(prefix, dk, rows) {
  const list = rows.filter(Boolean).slice(0, MAX_ITEMS)
  if (!list.length) return ''
  return `${prefix}${dk} ${JSON.stringify(list)}`
}

/** 知乎刷列表：只记标题。次数仍由 fetchZhihuMaterial 加，这里不加。 */
export function formatZhihuBrowse(dk, picks = [], account) {
  const mark = accountFields(account)
  const rows = (Array.isArray(picks) ? picks : [])
    .map((x) => clipTitle(x?.title))
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((title) => ({ title, ...mark }))
  return formatRows('zhihu:', dk, rows)
}

/** 贴吧刷推荐：吧名-标题。次数仍由 fetchTiebaMaterial 加，这里不加。 */
export function formatTiebaBrowse(dk, picks = [], account) {
  const rows = (Array.isArray(picks) ? picks : [])
    .map((x) => {
      const title = clipTitle(x?.title)
      const forum = clipTitle(x?.forum)
      if (!title) return null
      const mark = accountFields(account)
      return forum ? { forum, title, ...mark } : { title, ...mark }
    })
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
  return formatRows('tieba:', dk, rows)
}

export function formatBiliLook(dk, bvid, title, account) {
  const id = String(bvid ?? '').trim().split(/\s+/)[0] ?? ''
  if (!id) return ''
  return withJson(`look:${dk} ${id}`, { title, ...accountFields(account) })
}

export function formatBiliComment(dk, bvid, rpid, text, account) {
  const id = String(bvid ?? '').trim().split(/\s+/)[0] ?? ''
  if (!id) return ''
  return withJson(`comment:${dk} ${id} ${Number(rpid) || 0}`, { text, ...accountFields(account) })
}

export function formatBiliReply(dk, bvid, rootRpid, parentRpid, text, account) {
  const id = String(bvid ?? '').trim().split(/\s+/)[0] ?? ''
  if (!id) return ''
  return withJson(`creply:${dk} ${id} ${Number(rootRpid) || 0} ${Number(parentRpid) || 0}`, { text, ...accountFields(account) })
}

function accountFields(account) {
  if (!account || typeof account !== 'object') return {}
  const out = {}
  if (account.slot === 'a' || account.slot === 'b') out.slot = account.slot
  if (account.owner === 'her' || account.owner === 'owner') out.owner = account.owner
  if (account.name) out.name = account.name
  return out
}

/** 点进问题、回答、评论页。不加每天的次数。extra.question 记下这条回答属于哪个问题。 */
export function formatZhihuOpen(dk, id, title, extra = {}) {
  const token = String(id ?? '').trim().split(/\s+/)[0] ?? ''
  if (!token) return ''
  return withJson(`zhihu-open:${dk} ${token}`, { title, question: extra?.question, ...accountFields(extra) })
}

export function formatZhihuComment(dk, answerId, commentId, text, account) {
  const id = tokenOf(answerId)
  const cid = tokenOf(commentId) || '0'
  if (!id) return ''
  return withJson(`zhihu-comment:${dk} ${id} ${cid}`, { text, ...accountFields(account) })
}

export function formatZhihuReply(dk, answerId, rootId, parentId, text, account) {
  const id = tokenOf(answerId)
  if (!id) return ''
  return withJson(`zhihu-reply:${dk} ${id} ${tokenOf(rootId) || '0'} ${tokenOf(parentId) || '0'}`, { text, ...accountFields(account) })
}

/** 写回答单独记账，不跟评论共用配额。id 是问题号，后面是回答号。 */
export function formatZhihuAnswer(dk, questionId, answerId, text, account) {
  const id = tokenOf(questionId)
  if (!id) return ''
  return withJson(`zhihu-answer:${dk} ${id} ${tokenOf(answerId) || '0'}`, { text, ...accountFields(account) })
}

export function formatTiebaComment(dk, tid, pid, text, forum, account) {
  const id = tokenOf(tid)
  if (!id) return ''
  return withJson(`tieba-comment:${dk} ${id} ${tokenOf(pid) || '0'}`, { text, forum, ...accountFields(account) })
}

export function formatTiebaReply(dk, tid, rootPid, parentPid, text, account) {
  const id = tokenOf(tid)
  if (!id) return ''
  return withJson(`tieba-reply:${dk} ${id} ${tokenOf(rootPid) || '0'} ${tokenOf(parentPid) || '0'}`, { text, ...accountFields(account) })
}

function tokenOf(value) {
  return String(value ?? '').trim().split(/\s+/)[0] ?? ''
}

export function formatTiebaThread(dk, id, title, forum, account) {
  const token = String(id ?? '').trim().split(/\s+/)[0] ?? ''
  if (!token) return ''
  return withJson(`tieba-thread:${dk} ${token}`, { forum, title, ...accountFields(account) })
}

export function formatTiebaForum(dk, name, account) {
  const title = clipTitle(name)
  if (!title) return ''
  const mark = accountFields(account)
  if (/\s/.test(title)) return `tieba-forum:${dk} ${JSON.stringify({ title, ...mark })}`
  return `tieba-forum:${dk} ${title} ${JSON.stringify({ title, ...mark })}`
}

function describe(act, prefix, json) {
  if (act.shape === 'bili-list') {
    const { items } = listLine(json, () => ({}))
    const titles = items.slice(0, 3).map((x) => x?.title).filter(Boolean)
    const n = items.length
    const line = n
      ? `刷了 B 站 ${n} 条${titles.length ? '：' + titles.join(' / ') : ''}`
      : '去刷了 B 站，但一条也没看成'
    return { line, detail: line, tallyN: prefix === act.tallyPrefix ? n : 0 }
  }
  if (act.shape === 'zhihu-list') {
    const items = Array.isArray(json) ? json : []
    const titles = items.map((x) => x?.title).filter(Boolean)
    const line = titles.length ? `刷了知乎 ${titles.length} 条：${titles.join(' / ')}` : '刷了知乎，但没看到什么'
    return { line, detail: line, tallyN: 0 }
  }
  if (act.shape === 'tieba-list') {
    const items = Array.isArray(json) ? json : []
    const titles = items.map((x) => (x?.forum ? `${x.forum}-${x.title}` : x?.title)).filter(Boolean)
    const line = titles.length ? `刷了贴吧 ${titles.length} 条：${titles.join(' / ')}` : '刷了贴吧，但没看到什么'
    return { line, detail: line, tallyN: 0 }
  }
  if (act.shape === 'dy-list') {
    const items = Array.isArray(json) ? json : []
    const titles = items.slice(0, 3).map((x) => x?.title).filter(Boolean)
    const n = items.length
    const line = n
      ? `刷了抖音 ${n} 条${titles.length ? '：' + titles.join(' / ') : ''}`
      : '刷了抖音，但没看到什么'
    return { line, detail: line, tallyN: 0 }
  }
  if (act.shape === 'comment') {
    const summary = textOf(json, 'text')
    const line = summary ? `${act.label}：${summary}` : act.label
    return { line, detail: line, tallyN: act.tally ? 1 : 0, summary }
  }
  const title = textOf(json, 'title')
  const line = title ? `${act.label}：${title}` : act.label
  return { line, detail: line, tallyN: 0, title }
}

/**
 * 认一条 meta 正文。认不出（heard 不是 meta、fired:、sched:、hand:、looked:）返回 null。
 * @returns {object|null}
 */
export function parseAct(text) {
  const raw = String(text ?? '')
  const hit = INDEX.find((row) => raw.startsWith(row.prefix))
  if (!hit) return null
  const rest = raw.slice(hit.prefix.length)
  const sp = rest.indexOf(' ')
  const dk = (sp < 0 ? rest : rest.slice(0, sp)).trim()
  if (!DAY_RE.test(dk)) return null
  const tail = sp < 0 ? '' : rest.slice(sp + 1).trim()
  const tokens = headTokens(tail)
  const json = readJson(tail)
  if (hit.marker) {
    const act = hit.act
    return {
      key: act.key,
      id: tokens[0] ?? '',
      prefix: hit.prefix,
      dk,
      role: act.role,
      phase: act.phase ?? null,
      label: act.label ?? '',
      kind: act.kind ?? '',
      line: act.line ?? '',
      detail: act.detail ?? '',
      wired: true,
      quota: null,
      tally: act.tally ?? null,
      tallyN: act.tally ? 1 : 0,
      title: '',
      summary: '',
      rpid: 0,
      tail: tokens.join(' '),
    }
  }
  const act = hit.act
  const described = describe(act, hit.prefix, json)
  return {
    key: act.key,
    id: tokens[0] ?? '',
    prefix: hit.prefix,
    dk,
    role: 'act',
    phase: act.phase,
    label: act.label,
    kind: act.kind,
    line: described.line,
    detail: described.detail,
    wired: act.wired !== false,
    quota: act.quota ?? null,
    tally: act.tally ?? null,
    tallyN: described.tallyN,
    title: described.title ?? textOf(json, 'title'),
    summary: described.summary ?? '',
    rpid: act.shape === 'comment' ? (Number(tokens[1]) || 0) : 0,
    tail: tokens.join(' '),
  }
}

export function actByPrefix(prefix) {
  return ACTS.find((act) => act.prefixes.includes(prefix)) ?? null
}

export default {
  ACTS,
  MAX_ITEMS,
  MAX_TITLE,
  clipTitle,
  formatZhihuBrowse,
  formatTiebaBrowse,
  formatBiliLook,
  formatBiliComment,
  formatBiliReply,
  formatZhihuOpen,
  formatZhihuComment,
  formatZhihuReply,
  formatZhihuAnswer,
  formatTiebaThread,
  formatTiebaForum,
  formatTiebaComment,
  formatTiebaReply,
  parseAct,
  actByPrefix,
}
