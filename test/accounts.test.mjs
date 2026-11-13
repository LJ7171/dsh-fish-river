/**
 * 出门两个号：迁移、互斥、选号、事件标记、风控不连坐、文案分得清是谁的。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  accountsFromDoc, putSlot, resolveSlot, choiceText, sameAccount, publicSlot, clearSlot,
} from '../lib/core/accounts.js'
import { saveOwner, saveBiliSlot, loadBiliAccounts, publicOwner, biliCookieFromDoc } from '../lib/core/ownerAccount.js'
import { readOwner, writeOwner, writeConfig, appendEvent, readEvents } from '../lib/core/store.js'
import { normalizeConfig } from '../lib/core/settings.js'
import { noteRisk, riskState, clearRisk } from '../lib/platforms/bili/risk.js'
import { postComment } from '../lib/platforms/bili/comment.js'
import { speakOnce } from '../lib/platforms/bili/speak.js'
import { formatBiliComment, formatBiliLook } from '../lib/core/acts.js'
import { biliLook } from '../lib/life/schedule/schedulerLook.js'
import { ownerLine, whoseAccount } from '../lib/core/ownerLabel.js'
import { scrub } from '../lib/core/log.js'
import { writeAuth, readAuth, clearAuth } from '../lib/platforms/tieba/client.js'
import { saveCookie, readAuth as readZhihu, clearAuth as clearZhihu } from '../packages/dsh-fish-river-zhihu/auth.js'

const COOKIE_A = 'SESSDATA=secret-a; bili_jct=jct-a; DedeUserID=111'
const COOKIE_B = 'SESSDATA=secret-b; bili_jct=jct-b; DedeUserID=222'

async function root() {
  return mkdtemp(join(tmpdir(), 'fish-acc-'))
}

test('旧的单条 cookie 迁进槽 a，标签跟平台 owner，槽 b 空着', () => {
  const accounts = accountsFromDoc({
    cookie: COOKIE_A,
    account: { mid: '111', name: '鱼' },
    savedAt: '2026-11-01T00:00:00.000Z',
    mid: '42',
    nickname: '重要的人',
  }, { ownerLabel: 'her' })
  assert.equal(accounts.length, 2)
  assert.equal(accounts[0].id, 'a')
  assert.equal(accounts[0].cookie, COOKIE_A)
  assert.equal(accounts[0].owner, 'her')
  assert.equal(accounts[0].allowed, true)
  assert.equal(accounts[0].account.mid, '111')
  assert.equal(accounts[1].cookie, '')
  assert.equal(accounts[1].allowed, false)
  assert.equal(accounts[1].owner, 'owner')
})

test('存一个槽不会盖掉另一个，同一个 uid 不能占两个槽', () => {
  let accounts = accountsFromDoc({}, { ownerLabel: 'her' })
  const a = putSlot(accounts, 'a', { cookie: COOKIE_A, identity: '111', account: { name: '鱼' }, owner: 'her' })
  assert.equal(a.ok, true)
  accounts = a.accounts
  const b = putSlot(accounts, 'b', { cookie: COOKIE_B, identity: '222', account: { name: '人' }, owner: 'owner' })
  assert.equal(b.ok, true)
  assert.equal(b.accounts[0].cookie, COOKIE_A)
  assert.equal(b.accounts[1].cookie, COOKIE_B)
  const clash = putSlot(b.accounts, 'b', { cookie: 'SESSDATA=secret-c; bili_jct=jct-c', identity: '111' })
  assert.equal(clash.ok, false)
  assert.equal(clash.why, 'same-uid')
  assert.equal(clash.accounts[1].cookie, COOKIE_B)
  const cleared = clearSlot(b.accounts, 'a')
  assert.equal(cleared[0].cookie, '')
  assert.equal(cleared[1].cookie, COOKIE_B)
})

test('两个号都在时不默认；只有一个就用它；文案分得清她和重要的人', () => {
  const one = accountsFromDoc({ cookie: COOKIE_A, account: { name: '鱼' } }, { ownerLabel: 'her' })
  const sole = resolveSlot(one, '')
  assert.equal(sole.ok, true)
  assert.equal(sole.slot.id, 'a')
  assert.equal(sole.slot.owner, 'her')
  const two = putSlot(putSlot(one, 'a', { cookie: COOKIE_A, identity: '111', account: { name: '鱼' }, owner: 'her' }).accounts, 'b', {
    cookie: COOKIE_B, identity: '222', account: { name: '人' }, owner: 'owner',
  }).accounts
  const choice = resolveSlot(two, '')
  assert.equal(choice.ok, false)
  assert.equal(choice.why, 'choice')
  const text = choiceText('B 站', choice.choices)
  assert.match(text, /她自己的B 站号/)
  assert.match(text, /那个重要的人的B 站号/)
  assert.match(text, /不替你选/)
  assert.doesNotMatch(text, /还剩|配额|今天.*次/)
  assert.equal(resolveSlot(two, 'b').slot.owner, 'owner')
  assert.equal(resolveSlot(two, 'her').slot.id, 'a')
  assert.equal(JSON.stringify(choice.choices.map(publicSlot)).includes('SESSDATA'), false)
  assert.match(ownerLine('B 站', 'her'), /她自己/)
  assert.match(whoseAccount('B 站', 'owner'), /重要的人/)
})

test('落盘迁移只动 cookie，手填的 mid / 昵称留着，清一个槽不动另一个', async () => {
  const dir = await root()
  try {
    await writeConfig(normalizeConfig({ bili: { owner: 'owner' } }), dir)
    await writeOwner({ mid: '42', nickname: '大号', cookie: COOKIE_A, account: { mid: '111', name: '鱼' } }, dir)
    const accounts = await loadBiliAccounts(dir)
    const ow = await readOwner(dir)
    assert.equal(ow.mid, '42')
    assert.equal(ow.nickname, '大号')
    assert.equal(ow.cookie, undefined)
    assert.equal(accounts[0].owner, 'owner')
    assert.equal(accounts[0].cookie, COOKIE_A)
    assert.equal(accounts[1].cookie, '')
    const saved = await saveBiliSlot(dir, 'b', { cookie: COOKIE_B, identity: '222', account: { mid: '222', name: '人' }, owner: 'her' })
    assert.equal(saved.ok, true)
    const again = await readOwner(dir)
    assert.equal(again.accounts[0].cookie, COOKIE_A)
    assert.equal(again.accounts[1].cookie, COOKIE_B)
    assert.equal(again.mid, '42')
    await saveOwner({ cookie: '', slot: 'b' }, dir)
    const left = await readOwner(dir)
    assert.equal(left.accounts[0].cookie, COOKIE_A)
    assert.equal(left.accounts[1].cookie, '')
    const pub = publicOwner(left)
    assert.equal(JSON.stringify(pub).includes('SESSDATA'), false)
    assert.equal(JSON.stringify(pub).includes('secret'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('同一个 uid 再存进另一个槽会被拒绝，cookie 不回显', async () => {
  const dir = await root()
  try {
    await saveOwner({ cookie: COOKIE_A, slot: 'a' }, dir)
    const r = await saveOwner({ cookie: 'SESSDATA=secret-a2; bili_jct=jct-a; DedeUserID=111', slot: 'b' }, dir)
    assert.equal(r.ok, false)
    assert.match(r.note, /另一个位置/)
    assert.equal(JSON.stringify(r).includes('SESSDATA'), false)
    const ow = await readOwner(dir)
    assert.equal(ow.accounts[0].cookie.includes('secret-a'), true)
    assert.equal(ow.accounts[1].cookie, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('一次出门只用选中的 cookie；两个号都在时不定时出门', async () => {
  const dir = await root()
  try {
    await writeConfig(normalizeConfig({
      browse: { enabled: true, perDay: 2, window: ['00:00', '23:59'], topN: 1 },
    }), dir)
    await saveBiliSlot(dir, 'a', { cookie: COOKIE_A, identity: '111', account: { mid: '111', name: '鱼' }, owner: 'her', allowed: true })
    await saveBiliSlot(dir, 'b', { cookie: COOKIE_B, identity: '222', account: { mid: '222', name: '人' }, owner: 'owner', allowed: true })
    const { loadConfig } = await import('../lib/core/settings.js')
    const { config } = await loadConfig(dir)
    const held = await biliLook(dir, { day: 1, stage: 1 }, config, '2026-11-13', {
      events: [],
      now: new Date('2026-11-13T12:00:00'),
    }, () => {})
    assert.equal(held.why, 'choice')
    assert.match(held.text, /她自己的/)
    assert.match(held.text, /重要的人/)
    assert.equal(held.acted, false)

    const seen = []
    const orig = globalThis.fetch
    globalThis.fetch = async (_url, opts) => {
      const headers = opts?.headers ?? {}
      seen.push(String(headers.cookie ?? headers.Cookie ?? ''))
      return new Response(JSON.stringify({ code: -400, message: 'no', data: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    try {
      await biliLook(dir, { day: 1, stage: 1 }, config, '2026-11-13', {
        account: 'b',
        events: [],
        now: new Date('2026-11-13T12:00:00'),
      }, () => {})
    } finally {
      globalThis.fetch = orig
    }
    assert.ok(seen.length > 0, '选了号就该发出请求')
    assert.ok(seen.every((c) => c.includes('secret-b') && !c.includes('secret-a')), seen.join('\n'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('点开和发言绑同一个号；从重要的人的号发不加 @', async () => {
  const dir = await root()
  try {
    await writeConfig(normalizeConfig({
      comment: { enabled: true, perDay: 3, atOwner: true },
      bili: { owner: 'her' },
    }), dir)
    await saveOwner({ mid: '42', nickname: '大号' }, dir)
    await saveBiliSlot(dir, 'a', { cookie: COOKIE_A, identity: '111', account: { mid: '111', name: '鱼' }, owner: 'her', allowed: true })
    await saveBiliSlot(dir, 'b', { cookie: COOKIE_B, identity: '222', account: { mid: '222', name: '人' }, owner: 'owner', allowed: true })
    const dk = '2026-11-13'
    await appendEvent({ type: 'meta', text: formatBiliLook(dk, 'BV1xx411c7mD', '一条', { slot: 'a', owner: 'her', name: '鱼' }) }, { day: 1, stage: 1, source: 'system' }, dir)
    const cookies = []
    const fake = {
      view: async () => ({ ok: true, data: { aid: 9 } }),
      replyAdd: async () => { cookies.push('sent'); return { ok: true, data: { rpid: 3 } } },
    }
    const wrong = await postComment({ root: dir, bvid: 'BV1xx411c7mD', text: '你好', account: 'b', client: fake, dateKey: dk })
    assert.equal(wrong.ok, false)
    assert.equal(cookies.length, 0)
    const said = await speakOnce({ root: dir, kind: 'comment', bvid: 'BV1xx411c7mD', text: '你好呀', account: 'b', dateKey: dk, client: fake })
    assert.equal(said.ok, false)
    const own = {
      view: async () => ({ ok: true, data: { aid: 9 } }),
      replyAdd: async (_aid, text) => { cookies.push(text); return { ok: true, data: { rpid: 4 } } },
    }
    const okHer = await speakOnce({ root: dir, kind: 'comment', bvid: 'BV1xx411c7mD', text: '在', account: 'a', dateKey: dk, client: own })
    assert.equal(okHer.ok, true)
    assert.match(okHer.said, /^@大号 /)
    const okOwner = await speakOnce({ root: dir, kind: 'comment', bvid: 'BV1xx411c7mD', text: '也在', account: 'a', dateKey: dk, client: own })
    assert.match(cookies.at(-1), /@大号/)
    await appendEvent({ type: 'meta', text: formatBiliLook(dk, 'BV1yy411c7mD', '另一条', { slot: 'b', owner: 'owner', name: '人' }) }, { day: 1, stage: 1, source: 'system' }, dir)
    const ownerSaid = await speakOnce({ root: dir, kind: 'comment', bvid: 'BV1yy411c7mD', text: '用这个号', account: 'b', dateKey: dk, client: own })
    assert.equal(ownerSaid.ok, true)
    assert.equal(ownerSaid.said.startsWith('@'), false)
    const events = (await readEvents(dir)).events.map((e) => e.text).join('\n')
    assert.equal(events.includes('SESSDATA'), false)
    assert.match(events, /"slot":"a"/)
    assert.equal(sameAccount(formatBiliComment(dk, 'BV1xx411c7mD', 1, 'x', { slot: 'a', owner: 'her', name: '鱼' }), 'b'), false)
    assert.equal(sameAccount('look:2026-11-13 BV1old', 'a'), true)
    assert.equal(sameAccount('look:2026-11-13 BV1old', 'b'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('贴吧和知乎也是两个槽：迁一个、存另一个、清一个不连坐', async () => {
  const dir = await root()
  try {
    await writeAuth(dir, { cookie: 'BDUSS=tieba-secret-a; STOKEN=s', account: { name: '鱼' }, slot: 'a', owner: 'owner' })
    const one = await readAuth(dir)
    assert.equal(one.cookie.includes('tieba-secret-a'), true)
    await writeAuth(dir, { cookie: 'BDUSS=tieba-secret-b; STOKEN=s', account: { name: '人', mid: '9' }, slot: 'b', owner: 'her' })
    const clash = await writeAuth(dir, { cookie: 'BDUSS=tieba-secret-c', account: { name: '人', mid: '9' }, slot: 'a' })
    assert.equal(clash.ok, false)
    await clearAuth(dir, 'a')
    const left = await readAuth(dir, 'b')
    assert.equal(left.cookie.includes('tieba-secret-b'), true)
    assert.equal((await readAuth(dir, 'a')), null)
    const raw = await readFile(join(dir, 'tieba.json'), 'utf8')
    assert.equal(raw.includes('tieba-secret-b'), true)

    await saveCookie(dir, { cookie: 'z_c0=zhihu-secret-a', account: { name: '知鱼', id: 'za' }, slot: 'a', owner: 'owner' })
    await saveCookie(dir, { cookie: 'z_c0=zhihu-secret-b', account: { name: '知人', id: 'zb' }, slot: 'b', owner: 'her' })
    const both = await readZhihu(dir)
    assert.equal(both.needChoice, true)
    assert.equal(JSON.stringify(both).includes('zhihu-secret'), false)
    const onlyB = await readZhihu(dir, 'b')
    assert.equal(onlyB.cookie.includes('zhihu-secret-b'), true)
    await clearZhihu(dir, 'b')
    assert.equal((await readZhihu(dir, 'a')).cookie.includes('zhihu-secret-a'), true)
    assert.equal(await readZhihu(dir, 'b'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('一个槽过期或风控，另一个槽还在', async () => {
  const dir = await root()
  try {
    await saveBiliSlot(dir, 'a', { cookie: COOKIE_A, identity: '111', account: { mid: '111', name: '鱼' }, owner: 'her' })
    await saveBiliSlot(dir, 'b', { cookie: COOKIE_B, identity: '222', account: { mid: '222', name: '人' }, owner: 'owner' })
    noteRisk(dir, -412, new Date('2026-11-13T00:00:00Z'), 'a')
    const a = riskState(dir, new Date('2026-11-13T00:05:00Z'), 'a')
    const b = riskState(dir, new Date('2026-11-13T00:05:00Z'), 'b')
    assert.equal(a.cooling, true)
    assert.equal(b.cooling, false)
    clearRisk(dir, 'a')
    assert.equal(riskState(dir, new Date(), 'b').cooling, false)
    const raw = JSON.parse(await readFile(join(dir, 'risk.json'), 'utf8'))
    assert.equal(JSON.stringify(raw).includes('SESSDATA'), false)
    assert.equal(biliCookieFromDoc(await readOwner(dir), 'b'), COOKIE_B)
    assert.equal(scrub(`cookie ${COOKIE_A}`).includes('secret-a'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
