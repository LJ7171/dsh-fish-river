/**
 * privacy.test.mjs —— 私聊可见性（AGENTS §9）在 owner 侧的唯一口径。
 *
 * 2026-11-08：`guard.visibleTo` 之前生产代码零调用；现在 /events /status
 * /reports /channels 统一走这里。只脱敏正文，不删记录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PRIVATE_REDACTED,
  ownerIdSets,
  isOwnerEvent,
  redactEvents,
  redactBeliefsForOwner,
  redactThreads,
} from '../lib/privacy.js'

const config = { channels: { qq: { ownerId: '10086' }, weixin: { ownerId: 'u_wxid_a' } } }
const sets = ownerIdSets(config)

test('ownerIdSets：裸 id 与 u_ 前缀都收，空渠道不产生条目', () => {
  assert.deepEqual([...sets.get('qq')].sort(), ['10086', 'u_10086'].sort())
  assert.deepEqual([...sets.get('weixin')].sort(), ['u_wxid_a', 'wxid_a'].sort())
  assert.equal(sets.has('bili'), false)
})

test('isOwnerEvent：公开/主人私聊可见；陌生人私聊不可见', () => {
  assert.equal(isOwnerEvent({ visibility: 'public', origin: 'guest' }, sets), true)
  assert.equal(isOwnerEvent({ visibility: 'private', origin: 'owner', person: 'u_999', channel: 'qq' }, sets), true)
  assert.equal(isOwnerEvent({ visibility: 'private', origin: 'guest', person: 'u_999', channel: 'qq' }, sets), false)
  assert.equal(isOwnerEvent({ visibility: 'private', person: 'u_10086', channel: 'qq' }, sets), true, '老事件没有 origin 时按 person 认')
})

test('redactEvents：只换别人的私聊正文，不改原对象、不碰非私聊', () => {
  const events = [
    { id: 'a', type: 'heard', visibility: 'private', origin: 'owner', channel: 'qq', person: 'u_10086', text: '主人说的' },
    { id: 'b', type: 'heard', visibility: 'private', origin: 'guest', channel: 'qq', person: 'u_999', text: '陌生人说的' },
    { id: 'c', type: 'utterance', visibility: 'private', origin: 'self', channel: 'qq', person: 'u_999', text: '她回陌生人的' },
    { id: 'd', type: 'utterance', visibility: 'private', origin: 'self', channel: 'qq', person: 'u_10086', text: '她回主人的' },
    { id: 'e', type: 'utterance', visibility: 'public', origin: 'self', channel: 'qq', person: 'u_999', text: '群里说的' },
    { id: 'f', type: 'meta', text: 'wake:2026-11-08 x' },
  ]
  const view = redactEvents(events, config)
  assert.equal(view.find((e) => e.id === 'a').text, '主人说的')
  assert.equal(view.find((e) => e.id === 'b').text, PRIVATE_REDACTED)
  assert.equal(view.find((e) => e.id === 'b').redacted, true)
  assert.equal(view.find((e) => e.id === 'c').text, PRIVATE_REDACTED)
  assert.equal(view.find((e) => e.id === 'd').text, '她回主人的')
  assert.equal(view.find((e) => e.id === 'e').text, '群里说的')
  assert.equal(view.find((e) => e.id === 'f').text, 'wake:2026-11-08 x')
  assert.equal(events[1].text, '陌生人说的', 'helper 不能改原数组里的对象')
})

test('redactBeliefsForOwner：按来源事件 id 决定要不要遮', () => {
  const events = [
    { id: 'b1', visibility: 'private', origin: 'guest', channel: 'qq', person: 'u_999' },
    { id: 'b2', visibility: 'private', origin: 'owner', channel: 'qq', person: 'u_10086' },
  ]
  const out = redactBeliefsForOwner([
    { id: 'b1', text: '从陌生人那里学到的' },
    { id: 'b2', text: '跟主人学的' },
    { id: 'b3', text: '找不到来源' },
  ], events, config)
  assert.equal(out[0].text, PRIVATE_REDACTED)
  assert.equal(out[0].redacted, true)
  assert.equal(out[1].text, '跟主人学的')
  assert.equal(out[2].text, '找不到来源')
})

test('redactThreads：群可见，私聊只有主人那个会话可见', () => {
  const out = redactThreads([
    { key: 'qq:group:111', channel: 'qq', kind: 'group', conversationId: '111', preview: '群里最后一句' },
    { key: 'qq:dm:10086', channel: 'qq', kind: 'dm', conversationId: '10086', preview: '主人私聊' },
    { key: 'qq:dm:999', channel: 'qq', kind: 'dm', conversationId: '999', preview: '陌生人的私聊' },
  ], config)
  assert.equal(out[0].preview, '群里最后一句')
  assert.equal(out[1].preview, '主人私聊')
  assert.equal(out[2].preview, PRIVATE_REDACTED)
  assert.equal(out[2].redacted, true)
})
