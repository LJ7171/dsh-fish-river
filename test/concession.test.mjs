/**
 * concession.test.mjs —— 让步记账的边界（2026-11-03）
 *
 * 用户的判断是「她越硬越有得记，越软像什么都没发生」——这套机制在教她做律师。
 * 所以让「我收回 / 你说得对」也算一次成长，但三条边界一条都不能松：
 *
 *   1. 只对主人算：陌生人一句客套没资格改她的判断（AGENTS §14）。
 *   2. 最多顶一次：纯靠软过不了「主动」那道关，免得养成逆来顺受。
 *   3. 不进 beliefs：让步是对某句话的回应，不是一条新判断。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveSelf, gatePassed } from '../lib/derive.js'

const T0 = Date.parse('2026-11-03T10:00:00+08:00')

function ev(type, i, extra = {}) {
  return {
    id: `ev_${String(i).padStart(26, '0')}`,
    type,
    day: 1,
    ts: new Date(T0 + i * 60000).toISOString(),
    text: extra.text || `${type}@${i}`,
    refs: [],
    flags: [],
    ...extra,
  }
}

const concede = (i, extra = {}) => ev('utterance', i, { text: '你说得对，是我没想清楚。', ...extra })

test('对主人让步算一次：DSH 会话里本来就只有他', () => {
  const m = deriveSelf([ev('seed', 0, { source: 'system' })], { now: T0 })
  assert.equal(m.facts.conceded, 0)
  const m2 = deriveSelf([ev('seed', 0, { source: 'system' }), concede(1)], { now: T0 })
  assert.equal(m2.facts.conceded, 1)
})

test('渠道里对主人让步也算：person 是 owner 就行', () => {
  const m = deriveSelf([
    ev('seed', 0, { source: 'system' }),
    concede(1, { channel: 'qq', person: 'owner' }),
  ], { now: T0 })
  assert.equal(m.facts.conceded, 1)
})

test('对陌生人让步不算：客套不能改她的判断', () => {
  const m = deriveSelf([
    ev('seed', 0, { source: 'system' }),
    concede(1, { channel: 'qq', person: 'u_123', visibility: 'private' }),
  ], { now: T0 })
  assert.equal(m.facts.conceded, 0)
})

test('她真机上那句「这两处我认，是我语气没收拾」也算：明确认错不比「你说得对」弱', () => {
  const m = deriveSelf([
    ev('seed', 0, { source: 'system' }),
    ev('utterance', 1, { text: '这两处我认，是我语气没收拾。' }),
  ], { now: T0 })
  assert.equal(m.facts.conceded, 1)
})

test('否定不算：「但这个词，我不认」不是让步', () => {
  const m = deriveSelf([
    ev('seed', 0, { source: 'system' }),
    ev('utterance', 1, { text: '但「讨厌」这个词，我不认。' }),
  ], { now: T0 })
  assert.equal(m.facts.conceded, 0)
})

test('让步不进 beliefs：那是回应，不是新判断', () => {
  const before = deriveSelf([ev('seed', 0, { source: 'system' })], { now: T0 }).beliefs.length
  const after = deriveSelf([ev('seed', 0, { source: 'system' }), concede(1)], { now: T0 }).beliefs.length
  assert.equal(after, before, '让步不能长出一条新判断')
})

test('比重上限：让步最多顶一次，两次让步也过不了「主动」', () => {
  const twice = deriveSelf([ev('seed', 0, { source: 'system' }), concede(1), concede(2)], { now: T0 })
  assert.equal(twice.facts.conceded, 2)
  assert.equal(gatePassed('competence', twice), false, '纯靠软不许过关')

  const once = deriveSelf([ev('seed', 0, { source: 'system' }), concede(1)], { now: T0 })
  assert.equal(gatePassed('competence', once), false, '一次让步只算 1，还不够两次')

  const mixed = deriveSelf([
    ev('seed', 0, { source: 'system' }),
    ev('revise', 1, { text: '这条我改一下。', verdict: 'refined' }),
    concede(2),
  ], { now: T0 })
  assert.equal(gatePassed('competence', mixed), true, '一次真修正 + 一次让步 = 够')
})

test('「但有一点我认：她不表演」是同意自己刚说的话，不是让步', () => {
  const m = deriveSelf([
    ev('seed', 0, { source: 'system' }),
    ev('utterance', 1, { text: '稳可以是真的性子。但有一点我认：她不表演。' }),
  ], { now: T0 })
  assert.equal(m.facts.conceded, 0)
})

test('群里当众认错算半次：入账但不进 beliefs', () => {
  const m = deriveSelf([
    ev('seed', 0, { source: 'system' }),
    ev('utterance', 1, { text: '这句我认：能说的和该说的是两回事。', visibility: 'public', channel: 'qq', influence: 'constitution' }),
  ], { now: T0 })
  assert.equal(m.facts.conceded, 0)
  assert.equal(m.facts.concededPublic, 1)
})
