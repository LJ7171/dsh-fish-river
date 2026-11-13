/**
 * accounts.js —— 出门平台的两个登录槽。
 *
 * B 站 / 知乎 / 贴吧各最多两个号，凭据仍写在各自原来的 0600 文件里。
 * 这里只放纯函数：迁移、公开摘要、同号互斥、出门时选哪一个。
 * 不读盘、不写盘、不把 cookie 放进返回给界面的对象。
 *
 * 一个槽：cookie、owner（her | owner）、公开身份、savedAt、allowed。
 * allowed 关着，或者没 cookie，就不能被选去出门。
 */

export const SLOT_IDS = Object.freeze(['a', 'b'])

export function normalizeOwner(value, fallback = 'owner') {
  if (value === 'her' || value === 'owner') return value
  return fallback === 'her' ? 'her' : 'owner'
}

export function emptySlot(id, owner = 'owner') {
  return {
    id: id === 'b' ? 'b' : 'a',
    cookie: '',
    owner: normalizeOwner(owner),
    allowed: false,
    account: { mid: '', name: '' },
    savedAt: '',
  }
}

function identityOf(slot) {
  return String(slot?.account?.mid ?? '').trim()
}

function copyAccount(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    mid: String(src.mid ?? src.id ?? '').trim(),
    name: String(src.name ?? src.uname ?? '').trim(),
  }
}

function normalizeSlot(raw, id, fallbackOwner) {
  const cookie = String(raw?.cookie ?? '').trim()
  const owner = normalizeOwner(raw?.owner, fallbackOwner)
  // 没写 allowed：有 cookie 就默认可出门（迁过来的那一个号不该突然不能用）。
  // 写了 false 就关着。没有 cookie 的槽不能被选。
  const allowed = cookie ? raw?.allowed !== false : false
  return {
    id,
    cookie,
    owner,
    allowed,
    account: copyAccount(raw?.account),
    savedAt: String(raw?.savedAt ?? ''),
  }
}

/**
 * 把一份凭据文档收成恰好两个槽。
 * 还没有 accounts 时，顶上的 cookie / account 进槽 a，标签用调用方传来的平台 owner。
 * 槽 b 空着。不改传入的对象。
 */
export function accountsFromDoc(doc, { ownerLabel = 'owner' } = {}) {
  const label = normalizeOwner(ownerLabel)
  const other = label === 'her' ? 'owner' : 'her'
  if (Array.isArray(doc?.accounts)) {
    const byId = new Map()
    for (const raw of doc.accounts) {
      const id = raw?.id === 'b' ? 'b' : 'a'
      if (byId.has(id)) continue
      byId.set(id, normalizeSlot(raw, id, id === 'a' ? label : other))
    }
    return SLOT_IDS.map((id) => byId.get(id) ?? emptySlot(id, id === 'a' ? label : other))
  }
  const legacy = doc && typeof doc === 'object' ? doc : {}
  const cookie = String(legacy.cookie ?? '').trim()
  const slot = normalizeSlot({
    id: 'a',
    cookie,
    owner: label,
    allowed: Boolean(cookie),
    account: legacy.account,
    savedAt: legacy.savedAt || legacy.account?.savedAt || '',
  }, 'a', label)
  return [slot, emptySlot('b', other)]
}

/** 给界面和接口的槽。没有 cookie 字段。 */
export function publicSlot(slot, { csrf = false } = {}) {
  const cookie = String(slot?.cookie ?? '')
  const out = {
    id: slot?.id === 'b' ? 'b' : 'a',
    owner: slot?.owner === 'her' ? 'her' : 'owner',
    allowed: Boolean(slot?.allowed) && Boolean(cookie),
    hasCookie: Boolean(cookie),
    name: String(slot?.account?.name ?? ''),
    mid: String(slot?.account?.mid ?? ''),
    savedAt: String(slot?.savedAt ?? ''),
  }
  if (csrf) out.hasCsrf = /(?:^|;\s*)bili_jct=/.test(cookie)
  return out
}

export function usableSlots(accounts) {
  return (accounts ?? []).filter((s) => s?.cookie && s.allowed)
}

/** 另一个槽已经占了同一个 uid/mid 时返回那个槽，否则 null。 */
export function conflictingSlot(accounts, slotId, identity) {
  const id = String(identity ?? '').trim()
  if (!id) return null
  return (accounts ?? []).find((s) => s.id !== slotId && identityOf(s) === id) ?? null
}

/**
 * 写一个槽。identity 和现有槽撞了就不改。
 * 清 cookie（传空串）只动这一槽。
 */
export function putSlot(accounts, slotId, patch = {}) {
  const id = slotId === 'b' ? 'b' : 'a'
  const list = SLOT_IDS.map((x) => {
    const found = (accounts ?? []).find((s) => s.id === x)
    return found ? { ...found, account: { ...found.account } } : emptySlot(x)
  })
  const cur = list.find((s) => s.id === id)
  const next = {
    ...cur,
    id,
    owner: patch.owner !== undefined ? normalizeOwner(patch.owner, cur.owner) : cur.owner,
    savedAt: patch.savedAt !== undefined ? String(patch.savedAt ?? '') : cur.savedAt,
    account: patch.account ? { ...cur.account, ...copyAccount(patch.account) } : { ...cur.account },
  }
  if (patch.cookie !== undefined) next.cookie = String(patch.cookie ?? '').trim()
  if (!next.cookie) {
    next.allowed = false
    if (patch.cookie === '') {
      next.account = { mid: '', name: '' }
      next.savedAt = ''
    }
  } else if (patch.allowed !== undefined) {
    next.allowed = patch.allowed === true
  } else if (patch.cookie !== undefined) {
    next.allowed = true
  }
  const ident = patch.identity !== undefined ? String(patch.identity ?? '').trim() : identityOf(next)
  if (ident) next.account = { ...next.account, mid: ident }
  if (next.cookie && conflictingSlot(list, id, identityOf(next))) {
    return { ok: false, why: 'same-uid', accounts: list }
  }
  const accountsNext = list.map((s) => (s.id === id ? next : s))
  return { ok: true, accounts: accountsNext, slot: next }
}

/**
 * 写一个槽，并自动把同一个 uid 从旧槽移走。
 * 用户 2026-11-13 确认：扫码扫到已经在另一个槽的号时，不拒绝，直接移到目标槽。
 */
export function putSlotMoving(accounts, slotId, patch = {}) {
  const id = slotId === 'b' ? 'b' : 'a'
  const ident = String(patch.identity ?? patch.account?.mid ?? patch.account?.id ?? '').trim()
  const other = ident ? conflictingSlot(accounts, id, ident) : null
  const base = other ? clearSlot(accounts, other.id) : accounts
  return putSlot(base, id, patch)
}

export function clearSlot(accounts, slotId) {
  return putSlot(accounts, slotId, { cookie: '' }).accounts
}

function matchRequested(accounts, requested) {
  const want = String(requested ?? '').trim()
  if (!want) return null
  const byId = accounts.find((s) => s.id === want)
  if (byId) return byId
  if (want === 'her' || want === 'owner') {
    const hits = usableSlots(accounts).filter((s) => s.owner === want)
    return hits.length === 1 ? hits[0] : null
  }
  const byName = usableSlots(accounts).filter((s) => s.account?.name && s.account.name === want)
  return byName.length === 1 ? byName[0] : null
}

/**
 * 出门用哪一个号。
 * 指定了就只用那一个（空的、没允许的都不算）。
 * 没指定：恰好一个可用就用它；两个就让她选，不默认。
 */
export function resolveSlot(accounts, requested) {
  const want = String(requested ?? '').trim()
  if (want) {
    const hit = matchRequested(accounts, want)
    if (!hit || !hit.cookie || !hit.allowed) return { ok: false, why: 'unavailable' }
    return { ok: true, slot: hit }
  }
  const usable = usableSlots(accounts)
  if (usable.length === 1) return { ok: true, slot: usable[0], sole: true }
  if (usable.length === 0) return { ok: false, why: 'none' }
  return { ok: false, why: 'choice', choices: usable.map((s) => publicSlot(s)) }
}

/** 醒来时告诉她这两个号分别是谁的。不提次数。 */
export function choiceText(platform, choices) {
  const name = String(platform ?? '').trim() || '这里'
  const lines = [`${name}有两个可以出门的号。这次先不替你选。`]
  for (const s of choices ?? []) {
    const who = s.owner === 'her' ? `她自己的${name}号` : `那个重要的人的${name}号`
    const shown = s.name ? `${who}（${s.name}）` : who
    lines.push(`- ${s.id}：${shown}`)
  }
  lines.push('想用哪个，account 里写 a 或 b。')
  return lines.join('\n')
}

/** 写进事件的公开标记。没有 cookie。 */
export function stampOf(slot) {
  if (!slot) return {}
  const out = {}
  if (slot.id === 'a' || slot.id === 'b') out.slot = slot.id
  const owner = slot.owner === 'her' || slot.owner === 'owner' ? slot.owner : ''
  if (owner) out.owner = owner
  const name = String(slot.account?.name ?? slot.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
  if (name) out.name = name
  return out
}

export function readStamp(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const slot = json.slot === 'b' ? 'b' : (json.slot === 'a' ? 'a' : '')
  if (!slot) return null
  return {
    slot,
    owner: json.owner === 'her' ? 'her' : (json.owner === 'owner' ? 'owner' : ''),
    name: String(json.name ?? ''),
  }
}

/** 从一条 meta 正文里读槽。列表行看第一条带 slot 的；没有就是当时那一个登录。 */
export function stampFromText(text) {
  const raw = String(text ?? '')
  const at = raw.search(/[\[{]/)
  if (at < 0) return null
  try {
    const json = JSON.parse(raw.slice(at))
    if (Array.isArray(json)) {
      for (const item of json) {
        const hit = readStamp(item)
        if (hit) return hit
      }
      return null
    }
    return readStamp(json)
  } catch {
    return null
  }
}

/**
 * 点开和发言是不是同一个号。
 * 老事件没有槽：算当时那一个登录，只对槽 a 成立（迁过来的那一个）。
 * 两边都没有槽（更早的单号路径）也算同一件事。
 */
export function sameAccount(eventText, slotId) {
  const stamped = stampFromText(eventText)
  const want = slotId === 'b' ? 'b' : (slotId === 'a' ? 'a' : '')
  if (!stamped?.slot && !want) return true
  if (!stamped?.slot) return want === 'a' || want === ''
  if (!want) return stamped.slot === 'a'
  return stamped.slot === want
}

export default {
  SLOT_IDS,
  normalizeOwner,
  emptySlot,
  accountsFromDoc,
  publicSlot,
  usableSlots,
  conflictingSlot,
  putSlot,
  clearSlot,
  resolveSlot,
  choiceText,
  stampOf,
  readStamp,
  stampFromText,
  sameAccount,
}
