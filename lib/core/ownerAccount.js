/**
 * 主人是谁：uid、昵称、B 站 cookie。
 *
 * 三件事分开的原因：
 *   - uid / 昵称是「写给谁看」的元数据，可以出现在设置界面上；
 *   - cookie 是钥匙，只能看见「有没有」，看不见内容；
 *   - 三者都存在 owner.json（0600），不进 config.json —— config 会被 /config
 *     原样回吐给观测台，钥匙混在里面等于挂在客厅墙上。
 */

import { readOwner, writeOwner, rootDir } from './store.js'
import { normalizeCookie } from './cookies.js'
import { loadConfig } from './settings.js'
import {
  accountsFromDoc,
  publicSlot,
  putSlot,
  clearSlot,
  usableSlots,
} from './accounts.js'

const COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'buvid3', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']

/** 给外面看的样子：永远不含 cookie 原文。accounts 是两个槽的公开摘要。 */
export function publicOwner(ow, { ownerLabel = 'her' } = {}) {
  const o = ow ?? {}
  const accounts = accountsFromDoc(o, { ownerLabel }).map((s) => publicSlot(s, { csrf: true }))
  const logged = accounts.filter((s) => s.hasCookie)
  const primary = logged.length === 1 ? logged[0] : (logged[0] ?? accounts[0])
  // 顶上的 account 仍是「登录的是谁」的只读摘要：只有一个号时就是它。
  // 两个号都在时，界面看 accounts，这里留第一个有 cookie 的，避免旧读法拿到空。
  const acct = logged.length === 1
    ? logged[0]
    : (o.account && !Array.isArray(o.accounts)
      ? { mid: String(o.account.mid ?? ''), name: String(o.account.name ?? '') }
      : primary)
  return {
    mid: String(o.mid ?? o.uid ?? ''),
    name: String(o.nickname ?? o.name ?? ''),
    account: {
      mid: String(acct?.mid ?? ''),
      name: String(acct?.name ?? ''),
    },
    hasCookie: logged.length > 0,
    hasCsrf: logged.some((s) => s.hasCsrf),
    savedAt: String(primary?.savedAt ?? o.savedAt ?? ''),
    accounts,
  }
}

async function ownerLabelOf(root) {
  try {
    const { config } = await loadConfig(root)
    return config?.bili?.owner === 'owner' ? 'owner' : 'her'
  } catch {
    return 'her'
  }
}

/** 读两个槽。旧的单条 cookie 会迁进槽 a，手填的 mid / 昵称留在原处。 */
export async function loadBiliAccounts(root = rootDir()) {
  const cur = (await readOwner(root)) ?? {}
  const ownerLabel = await ownerLabelOf(root)
  const accounts = accountsFromDoc(cur, { ownerLabel })
  if (!Array.isArray(cur.accounts) && (cur.cookie || cur.account)) {
    await persistBiliAccounts(root, cur, accounts)
  }
  return accounts
}

async function persistBiliAccounts(root, cur, accounts) {
  const next = { ...cur, accounts }
  // 登录 cookie 和「这份 cookie 是谁」只活在槽里。领养人两格不动。
  delete next.cookie
  delete next.savedAt
  delete next.account
  await writeOwner(next, root)
  return next
}

export async function saveBiliSlot(root, slotId, patch) {
  const cur = (await readOwner(root)) ?? {}
  const accounts = await loadBiliAccounts(root)
  const put = putSlot(accounts, slotId, patch)
  if (!put.ok) return { ok: false, why: put.why, owner: publicOwner({ ...cur, accounts }) }
  await persistBiliAccounts(root, cur, put.accounts)
  const saved = (await readOwner(root)) ?? {}
  return { ok: true, slot: put.slot, owner: publicOwner(saved) }
}

/** 只清这一槽。另一槽的 cookie 留着。 */
export async function clearBiliSlot(root, slotId) {
  const cur = (await readOwner(root)) ?? {}
  const accounts = await loadBiliAccounts(root)
  const next = clearSlot(accounts, slotId)
  await persistBiliAccounts(root, cur, next)
  return { ok: true, owner: publicOwner((await readOwner(root)) ?? {}) }
}

/** 过期只作废这一槽，不连坐另一个号。 */
export async function expireBiliSlot(root, slotId) {
  return clearBiliSlot(root, slotId)
}

/** 非出门路径（私信、自检）用的 cookie：旧文件顶上的，或恰好一个槽，或槽 a。 */
export function biliCookieFromDoc(doc, slotId) {
  if (slotId === 'a' || slotId === 'b') {
    const accounts = accountsFromDoc(doc, { ownerLabel: 'her' })
    return accounts.find((s) => s.id === slotId)?.cookie || ''
  }
  if (!Array.isArray(doc?.accounts) && doc?.cookie) return String(doc.cookie)
  const accounts = accountsFromDoc(doc, { ownerLabel: 'her' })
  const usable = usableSlots(accounts)
  if (usable.length === 1) return usable[0].cookie
  const a = accounts.find((s) => s.id === 'a' && s.cookie)
  return a?.cookie || ''
}

export function dedeUserId(cookie) {
  const m = /(?:^|;\s*)DedeUserID=([^;]+)/.exec(String(cookie ?? ''))
  return m ? decodeURIComponent(m[1]).trim() : ''
}

/**
 * 记下「这份 cookie 登的是哪个账号」。
 * 只写 account，**绝不碰 mid / nickname**——那两格是领养人，用户手填的。
 * @param {{mid?:number|string, uname?:string, name?:string}} me client.me() 的返回
 */
export async function saveAccount(me, root = rootDir(), slotId = 'a') {
  const cur = (await readOwner(root)) ?? {}
  const accounts = await loadBiliAccounts(root)
  const id = slotId === 'b' ? 'b' : 'a'
  const ident = String(me?.mid ?? '').trim()
  const put = putSlot(accounts, id, {
    account: { mid: ident, name: String(me?.uname ?? me?.name ?? '') },
    identity: ident,
    savedAt: accounts.find((s) => s.id === id)?.savedAt || new Date().toISOString(),
  })
  if (!put.ok) return publicOwner({ ...cur, accounts })
  await persistBiliAccounts(root, (await readOwner(root)) ?? cur, put.accounts)
  return publicOwner((await readOwner(root)) ?? {})
}

/**
 * 从一坨粘贴内容里抠出 cookie 字符串。
 * 允许三种来源：纯 `a=1; b=2`、浏览器 DevTools 的 `Cookie:` 头、整段 Netscape cookies.txt。
 * 认出哪些键恰好可用：只看 B 站需要的几个，别把整段浏览器 cookies 存进来。
 */
export function parseCookieInput(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { cookie: '', missing: ['SESSDATA'] }
  const pairs = []
  const seen = new Set()
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    // Netscape 格式：domain \t flag \t path \t secure \t expiry \t name \t value
    const tab = t.split('\t')
    if (tab.length >= 7) {
      const name = tab[5].trim()
      const value = tab[6].trim()
      if (name && !seen.has(name)) { seen.add(name); pairs.push([name, value]) }
      continue
    }
    const body = t.replace(/^cookie\s*:\s*/i, '')
    for (const part of body.split(';')) {
      const i = part.indexOf('=')
      if (i <= 0) continue
      const name = part.slice(0, i).trim()
      const value = part.slice(i + 1).trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      pairs.push([name, value])
    }
  }
  const kept = pairs.filter(([n]) => COOKIE_NAMES.includes(n))
  const cookie = kept.map(([n, v]) => `${n}=${v}`).join('; ')
  const missing = COOKIE_NAMES.filter((n) => ['SESSDATA', 'bili_jct'].includes(n) && !seen.has(n))
  return { cookie: normalizeCookie(cookie), missing }
}

/**
 * 存一次。只改传进来的字段，其余保留。
 * 传 `cookie: ''` 是「清除」，不是「没传」。
 */
export async function saveOwner(patch = {}, root = rootDir()) {
  const cur = (await readOwner(root)) ?? {}
  const next = { ...cur }
  if (patch.mid !== undefined) next.mid = String(patch.mid).trim()
  if (patch.nickname !== undefined) next.nickname = String(patch.nickname).trim()
  const slotId = patch.slot === 'b' ? 'b' : (patch.slot === 'a' || patch.cookie !== undefined ? 'a' : '')
  if (patch.cookie !== undefined || patch.owner !== undefined || patch.allowed !== undefined) {
    // 先把领养人两格落下，再动槽。cookie 认不出也不能把这两格丢掉。
    if (patch.mid !== undefined || patch.nickname !== undefined) await writeOwner(next, root)
    const accounts = await loadBiliAccounts(root)
    const id = slotId === 'b' ? 'b' : 'a'
    if (patch.cookie !== undefined) {
      const c = String(patch.cookie).trim()
      if (!c) {
        const cleared = clearSlot(accounts, id)
        await persistBiliAccounts(root, (await readOwner(root)) ?? next, cleared)
        const saved = (await readOwner(root)) ?? {}
        return { ok: true, note: '清掉了。', owner: publicOwner(saved) }
      }
      const parsed = parseCookieInput(c)
      if (!parsed.cookie) {
        await writeOwner({ ...(await readOwner(root) ?? next), mid: next.mid, nickname: next.nickname }, root)
        const saved = (await readOwner(root)) ?? next
        return { ok: false, note: 'cookie 里没认出 B 站的键，只存下了上面两格。', owner: publicOwner(saved) }
      }
      const ident = dedeUserId(parsed.cookie)
      const put = putSlot(await loadBiliAccounts(root), id, {
        cookie: parsed.cookie,
        savedAt: new Date().toISOString(),
        ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
        ...(patch.allowed !== undefined ? { allowed: patch.allowed === true } : {}),
        ...(ident ? { identity: ident, account: { mid: ident, name: accounts.find((s) => s.id === id)?.account?.name || '' } } : {}),
      })
      if (!put.ok) {
        return { ok: false, note: '这个号已经登在另一个位置了。', owner: publicOwner((await readOwner(root)) ?? next) }
      }
      await persistBiliAccounts(root, (await readOwner(root)) ?? next, put.accounts)
      const saved = (await readOwner(root)) ?? {}
      const miss = parsed.missing
      return { ok: true, note: miss.length ? `存下了，但少了 ${miss.join(' / ')}。` : '存下了。', owner: publicOwner(saved), missing: miss }
    }
    const put = putSlot(accounts, id, {
      ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
      ...(patch.allowed !== undefined ? { allowed: patch.allowed === true } : {}),
    })
    if (!put.ok) return { ok: false, note: '这个号已经登在另一个位置了。', owner: publicOwner((await readOwner(root)) ?? next) }
    await persistBiliAccounts(root, (await readOwner(root)) ?? next, put.accounts)
    return { ok: true, note: '存下了。', owner: publicOwner((await readOwner(root)) ?? {}) }
  }
  await writeOwner(next, root)
  return { ok: true, note: '存下了。', owner: publicOwner((await readOwner(root)) ?? next) }
}

/**
 * 艾特前缀：评论发出去时加在最前面。
 * 只有同时满足「开了艾特」「有昵称」才加 —— 没昵称的 @ 只是一串没人认领的字符。
 */
export function mentionPrefix(ow, cfg) {
  const on = cfg?.comment?.atOwner !== false
  const name = String(ow?.nickname ?? ow?.name ?? '').trim()
  if (!on || !name) return ''
  // B 站昵称里带空格时 @ 会断掉，换成下划线是站内常见写法
  return `@${name.replace(/\s+/g, '_')} `
}
