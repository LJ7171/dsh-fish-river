/**
 * pace.test.mjs —— 进站静默窗和纯确认
 *
 * 静默窗按场合给毫秒，显式 0 关掉。
 * 确认只认整段：短名单、单独表情、单独句号或省略号。
 * 问句、点名、新内容不算。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import {
  HOME_CLOSE_SILENCE_MS,
  ackPhrasesOf,
  ackSilenceOn,
  isAckOnly,
  isAckSegment,
  mergeHeld,
  sessionKey,
  silenceMsFor,
} from '../lib/channels/pace.js'
import { resolveOccasion } from '../lib/channels/passport.js'

const ownerClose = resolveOccasion({
  channel: 'qq',
  kind: 'dm',
  personId: 'u_1',
  isOwner: true,
  config: { channels: { qq: { ownerId: '1' } } },
})

const homeClose = resolveOccasion({
  channel: 'weixin',
  kind: 'dm',
  personId: 'u_w',
  isOwner: false,
  config: { channels: { weixin: { closeIds: 'w' } } },
})

const outingGroup = resolveOccasion({
  channel: 'qq',
  kind: 'group',
  personId: 'u_5',
  isOwner: false,
  config: {},
})

const outingDm = resolveOccasion({
  channel: 'qq',
  kind: 'dm',
  personId: 'u_9',
  isOwner: false,
  config: {},
})

test('静默窗：重要的人和近人的私聊约 2 秒，群和陌生人不等', () => {
  assert.equal(silenceMsFor(ownerClose, {}), HOME_CLOSE_SILENCE_MS)
  assert.equal(silenceMsFor(homeClose, {}), HOME_CLOSE_SILENCE_MS)
  assert.equal(homeClose.scene, 'close-dm')
  assert.equal(homeClose.bond, 'close')
  assert.equal(silenceMsFor(outingGroup, {}), 0)
  assert.equal(silenceMsFor(outingDm, {}), 0)
  assert.equal(outingGroup.scene, 'group')
  assert.equal(outingDm.scene, 'stranger-dm')
})

test('静默窗：显式毫秒盖过场合，0 是关，缺键才按场合', () => {
  assert.equal(silenceMsFor(ownerClose, { im: { inboundSilenceMs: 0 } }), 0)
  assert.equal(silenceMsFor(outingGroup, { im: { inboundSilenceMs: 1500 } }), 1500)
  assert.equal(silenceMsFor(ownerClose, { im: { inboundSilenceMs: null } }), HOME_CLOSE_SILENCE_MS)
  assert.equal(silenceMsFor(ownerClose, { im: {} }), HOME_CLOSE_SILENCE_MS)
  assert.equal(silenceMsFor(ownerClose, { config: { im: { inboundSilenceMs: 0 } } }), 0)
  assert.equal(silenceMsFor(ownerClose, { im: { inboundSilenceMs: 999999 } }), 60000)
})

test('确认：短名单、单独表情、单独句号和省略号算；问句和新内容不算', () => {
  for (const s of ['嗯', '嗯嗯', '好', '好的', 'ok', 'OK', '收到', '行', '可以', '哈哈', '好的。', '嗯！']) {
    assert.equal(isAckOnly(s), true, s)
  }
  assert.equal(isAckOnly('。'), true)
  assert.equal(isAckOnly('…'), true)
  assert.equal(isAckOnly('...'), true)
  assert.equal(isAckOnly('……'), true)
  assert.equal(isAckOnly('😂'), true)
  assert.equal(isAckOnly('  好的  '), true)

  assert.equal(isAckOnly('好的，明天三点见'), false)
  assert.equal(isAckOnly('嗯？'), false)
  assert.equal(isAckOnly('在吗'), false)
  assert.equal(isAckOnly('@鱼 嗯'), false)
  assert.equal(isAckOnly('收到，改成三点'), false)
  assert.equal(isAckOnly('帮我看一下'), false)
  assert.equal(isAckOnly('😂😂'), false, '两个表情不是单独一个')
  assert.equal(isAckOnly('哈哈哈哈哈哈'), false, '比名单更长的笑声不算')
  assert.equal(isAckOnly('？'), false, '问号是问句')
  assert.equal(isAckOnly(''), false)
})

test('确认：整段每一行都是确认才停；有一行新内容就照常', () => {
  assert.equal(isAckSegment('嗯\n好的'), true)
  assert.equal(isAckSegment('嗯\n明天三点见'), false)
  assert.equal(isAckSegment('收到'), true)
})

test('确认：短名单可换；空名单只剩表情和单独标点', () => {
  assert.equal(isAckOnly('嗯', ['收到']), false)
  assert.equal(isAckOnly('收到', ['收到']), true)
  assert.equal(isAckOnly('。', []), true)
  assert.equal(isAckOnly('😂', []), true)
  assert.equal(isAckOnly('嗯', []), false)
  assert.equal(ackSilenceOn({}), true)
  assert.equal(ackSilenceOn({ im: { ackSilence: false } }), false)
  assert.ok(ackPhrasesOf({}).includes('收到'))
  assert.deepEqual(ackPhrasesOf({ im: { ackPhrases: [] } }), [])
})

test('攒段：同一会话并成一条，点名和图片留着', () => {
  const a = { channel: 'qq', kind: 'dm', conversationId: '1', personId: 'u_1', text: '第一句', images: [] }
  const b = { channel: 'qq', kind: 'dm', conversationId: '1', personId: 'u_1', text: '第二句', images: ['/a.png'], mentionedSelf: true }
  assert.equal(sessionKey(a), sessionKey(b))
  assert.notEqual(sessionKey(a), sessionKey({ ...a, personId: 'u_2' }))
  const merged = mergeHeld([a, b])
  assert.equal(merged.text, '第一句\n第二句')
  assert.deepEqual(merged.images, ['/a.png'])
  assert.equal(merged.mentionedSelf, true)
  assert.equal(isAckSegment(merged.text), false)
})

test('静默窗不进刷站和看画面', async () => {
  const browse = await fs.readFile(new URL('../lib/platforms/bili/browse.js', import.meta.url), 'utf8')
  const look = await fs.readFile(new URL('../lib/platforms/bili/look.js', import.meta.url), 'utf8')
  const douyin = await fs.readFile(new URL('../lib/platforms/douyin/douyinbrowse.js', import.meta.url), 'utf8')
  for (const src of [browse, look, douyin]) {
    assert.doesNotMatch(src, /silenceMsFor|isAckSegment|inboundSilenceMs/)
  }
})
