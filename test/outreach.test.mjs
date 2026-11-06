/**
 * outreach.test.mjs —— 醒来时主动发消息（send_message / 醒来时 send_image）。
 *
 * 不联网：sender 是假的，「醒来这一轮」用 wakeTurn 手动摆，配置写进临时根目录。
 * 重点验：只在醒来轮可用、一天两次、被拒的调用不占次数、出站过闸、
 *         发图走同一条额度、context_token 持久化能读回来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setWakeTurn, resetWakeTurnForTests, currentWakeTurn } from '../lib/wakeTurn.js'
import {
  sendOutreach, sentToday, setOutreachSender, resetOutreachForTests, outreachPath,
} from '../lib/outreach.js'
import { sendImageOnce } from '../lib/sendImage.js'
import { normalizeConfig, updateConfig } from '../lib/settings.js'
import { readContextStore, saveContextStore } from '../lib/channels/weixin.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fish-outreach-'))
  await updateConfig({ outreach: { enabled: true, perDay: 2 }, channels: { weixin: { enabled: true, ownerId: 'wx_owner' } } }, root)
  const cfg = normalizeConfig({
    outreach: { enabled: true, perDay: 2 },
    channels: { weixin: { enabled: true, ownerId: 'wx_owner' } },
  })
  const pic = join(root, 'pic.png')
  await writeFile(pic, PNG)
  return { root, cfg, pic }
}

function fakeSender() {
  const calls = []
  const fn = async (args) => { calls.push(args); return { ok: true } }
  fn.calls = calls
  return fn
}

test('wakeTurn：只在醒来那一轮有效，30 分钟后过期', () => {
  resetWakeTurnForTests()
  assert.equal(currentWakeTurn(), null)
  setWakeTurn({ sessionId: 's1', dk: '2026-11-05' })
  assert.equal(currentWakeTurn()?.sessionId, 's1')
  assert.equal(currentWakeTurn(Date.now() + 31 * 60_000), null)
  resetWakeTurnForTests()
})

test('sendOutreach：开关关 / 不在醒来轮 / 没填发给谁 / 没连上，都不发', async () => {
  const { root, cfg } = await setup()
  try {
    resetWakeTurnForTests()
    resetOutreachForTests()
    setOutreachSender(fakeSender())

    const off = await sendOutreach({ root, cfg: normalizeConfig({}), text: '在吗' })
    assert.equal(off.ok, false)
    assert.match(off.note, /不能主动发/)

    setWakeTurn({ dk: '2026-11-05' })
    const noOwner = await sendOutreach({ root, cfg: normalizeConfig({ outreach: { enabled: true } }), text: '在吗' })
    assert.equal(noOwner.ok, false)
    assert.match(noOwner.note, /发给谁/)

    resetOutreachForTests()
    const noSender = await sendOutreach({ root, cfg, text: '在吗' })
    assert.equal(noSender.ok, false)
    assert.match(noSender.note, /没连上/)

    resetWakeTurnForTests()
    setOutreachSender(fakeSender())
    const noTurn = await sendOutreach({ root, cfg, text: '在吗' })
    assert.equal(noTurn.ok, false)
    assert.match(noTurn.note, /不是醒着的时候/)
  } finally {
    resetWakeTurnForTests()
    resetOutreachForTests()
    await rm(root, { recursive: true, force: true })
  }
})

test('一天最多两次：第三次被拒，且被拒的不占次数', async () => {
  const { root, cfg } = await setup()
  try {
    resetWakeTurnForTests()
    resetOutreachForTests()
    const sender = fakeSender()
    setOutreachSender(sender)
    setWakeTurn({ dk: '2026-11-05' })

    assert.equal((await sendOutreach({ root, cfg, text: '第一句' })).ok, true)
    assert.equal((await sendOutreach({ root, cfg, text: '第二句' })).ok, true)
    const third = await sendOutreach({ root, cfg, text: '第三句' })
    assert.equal(third.ok, false)
    assert.match(third.note, /今天已经发过 2 次/)
    assert.equal(sender.calls.length, 2)
    assert.equal(await sentToday(root), 2)

    // 关掉开关再开，额度不重置（还是 2）
    assert.equal((await sendOutreach({ root, cfg: normalizeConfig({ ...cfg, outreach: { ...cfg.outreach, perDay: 3 } }) , text: '第三句' })).ok, true)
    assert.equal(sender.calls.length, 3)
  } finally {
    resetWakeTurnForTests()
    resetOutreachForTests()
    await rm(root, { recursive: true, force: true })
  }
})

test('发送失败不占次数；被出站闸拦也不占次数', async () => {
  const { root, cfg } = await setup()
  try {
    resetWakeTurnForTests()
    resetOutreachForTests()
    setWakeTurn({ dk: '2026-11-05' })
    let calls = 0
    setOutreachSender(async () => { calls += 1; return { ok: false, why: '发消息被拒（-14）' } })
    const fail = await sendOutreach({ root, cfg, text: '在吗' })
    assert.equal(fail.ok, false)
    assert.equal(await sentToday(root), 0)

    // 出站闸（泄露系统提示/密钥类）拦下：不调用 sender，不占额度
    const blocked = await sendOutreach({ root, cfg, text: 'sk-1234567890abcdef1234567890abcdef' })
    assert.equal(blocked.ok, false)
    assert.match(blocked.note, /不能发出去/)
    assert.equal(await sentToday(root), 0)
    assert.equal(calls, 1)
  } finally {
    resetWakeTurnForTests()
    resetOutreachForTests()
    await rm(root, { recursive: true, force: true })
  }
})

test('醒来时 send_image：走主动消息那条线，和文字共用额度', async () => {
  const { root, cfg, pic } = await setup()
  try {
    resetWakeTurnForTests()
    resetOutreachForTests()
    const sender = fakeSender()
    setOutreachSender(sender)
    setWakeTurn({ dk: '2026-11-05' })

    // 先发一句（占 1 次），再发一张图（占第 2 次）
    assert.equal((await sendOutreach({ root, cfg, text: '你看这个' })).ok, true)
    const img = await sendImageOnce({ root, herDir: root, path: pic, caption: '一起看' })
    assert.equal(img.ok, true, img.note)
    assert.equal(sender.calls.length, 2)
    assert.equal(sender.calls[1].channel, 'weixin')
    assert.deepEqual(sender.calls[1].images, [pic])
    assert.equal(await sentToday(root), 2)

    // 额度用完后发图也被挡
    const more = await sendImageOnce({ root, herDir: root, path: pic })
    assert.equal(more.ok, false)
    assert.match(more.note, /今天已经发过 2 次/)
  } finally {
    resetWakeTurnForTests()
    resetOutreachForTests()
    await rm(root, { recursive: true, force: true })
  }
})

test('context_token 持久化：落盘 0600，能按联系人读回来', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ctx-'))
  try {
    const m = new Map([['u_a', 'tok-a'], ['u_b', 'tok-b']])
    await saveContextStore(root, m)
    const file = join(root, 'weixin-context.json')
    const st = await stat(file)
    assert.equal(st.mode & 0o777, 0o600)
    const back = await readContextStore(root)
    assert.equal(back.get('u_a'), 'tok-a')
    assert.equal(back.get('u_b'), 'tok-b')
    // 坏档当空
    await writeFile(file, '{not json')
    assert.equal((await readContextStore(root)).size, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('额度台账是 0600 的 outreach-state.json', async () => {
  const { root, cfg } = await setup()
  try {
    resetWakeTurnForTests()
    resetOutreachForTests()
    setOutreachSender(async () => ({ ok: true }))
    const now = Date.parse('2026-11-05T10:00:00+08:00')
    setWakeTurn({ dk: '2026-11-05' })
    await sendOutreach({ root, cfg, text: '在吗', now })
    const st = await stat(outreachPath(root))
    assert.equal(st.mode & 0o777, 0o600)
    const raw = JSON.parse(await readFile(outreachPath(root), 'utf8'))
    assert.equal(raw.sent, 1)
    assert.equal(raw.dateKey, '2026-11-05')
  } finally {
    resetWakeTurnForTests()
    resetOutreachForTests()
    await rm(root, { recursive: true, force: true })
  }
})
