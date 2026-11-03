/**
 * gate.test.mjs —— 该不该叫醒她（2026-11-02：主人私聊不受冷却限制）
 *
 * 冷却的唯一目的是防刷屏。群里几十条要压住，主人自己在私信里连说三句不该被压。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { canReply, REPLY_COOLDOWN_MS } from '../lib/channels/gate.js'

const cfg = { channels: { qq: { enabled: true, replyInGroup: true, groups: ['999'] } } }
const base = { channel: 'qq', stage: 3, config: cfg, now: 10_000_000 }

test('gate：主人私聊连说两句，第二句不压', () => {
  const r = canReply({ ...base, kind: 'dm', conversationId: '10086', isOwner: true, lastReplyAt: base.now - 1000 })
  assert.equal(r.ok, true)
  assert.equal(r.why, '')
})

test('gate：主人私聊在群里，冷却照样有效', () => {
  const r = canReply({
    ...base,
    kind: 'group',
    conversationId: '999',
    isOwner: true,
    mentioned: true,
    lastReplyAt: base.now - 1000,
  })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'cooldown')
})

test('gate：陌生人的私聊仍然受冷却限制', () => {
  const r = canReply({
    ...base,
    kind: 'dm',
    conversationId: '20000',
    isOwner: false,
    lastReplyAt: base.now - (REPLY_COOLDOWN_MS - 1),
  })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'cooldown')
})

test('gate：冷却时间过去之后就放行', () => {
  const r = canReply({
    ...base,
    kind: 'dm',
    conversationId: '20000',
    isOwner: false,
    lastReplyAt: base.now - REPLY_COOLDOWN_MS,
  })
  assert.equal(r.ok, true)
})

test('gate：群里没 @ 她就不开口，@ 了才说话', () => {
  const cfg = { channels: { qq: { enabled: true, replyInGroup: true, groups: ['138273988'] } } }
  const notMentioned = canReply({ channel: 'qq', kind: 'group', conversationId: '138273988', isOwner: true, stage: 3, config: cfg })
  assert.equal(notMentioned.ok, false)
  assert.equal(notMentioned.why, 'group-not-mentioned')
  const mentioned = canReply({ channel: 'qq', kind: 'group', conversationId: '138273988', isOwner: true, stage: 3, config: cfg, mentioned: true })
  assert.equal(mentioned.ok, true)
})

test('gate：mentionOnly 关掉之后群里又回到「每句都接」', () => {
  const cfg = { channels: { qq: { enabled: true, replyInGroup: true, groups: ['138273988'], mentionOnly: false } } }
  const r = canReply({ channel: 'qq', kind: 'group', conversationId: '138273988', isOwner: true, stage: 3, config: cfg })
  assert.equal(r.ok, true)
})

test('gate：私聊不受 @ 规则影响', () => {
  const cfg = { channels: { qq: { enabled: true, ownerId: '1' } } }
  const r = canReply({ channel: 'qq', kind: 'dm', conversationId: '1', isOwner: true, stage: 1, config: cfg })
  assert.equal(r.ok, true)
})
