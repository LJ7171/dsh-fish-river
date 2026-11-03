/**
 * memory.test.mjs —— 三层记忆里「关系层 / 流水层 / 可见性」的守门测试
 *
 * 这一组不是功能演示，是**边界**：
 *   - 印象可以被覆盖，但不会被一次打招呼擦掉；
 *   - 流水会淘汰，但不会把事件流里的东西带走；
 *   - 别人的私聊，他本人也读不到；
 *   - 她复述别人的私事，出门前能被认出来。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createPeople, IMPRESSION_MAX, NOTES_MAX, PEOPLE_MAX } from '../lib/people.js'
import { createJournal, JOURNAL_KEEP, threadKey } from '../lib/journal.js'
import { visibleTo, filterForAudience } from '../lib/guard.js'
import { buildIndex, looksLikePrivateLeak, shingles } from '../lib/leakcheck.js'

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'fish-mem-'))
}

test('people：印象可覆盖，但没有新看法时不会被擦掉', async () => {
  const root = await tmpRoot()
  const people = createPeople(root)
  await people.upsert('u_1', { name: 'Lily', impression: '话少，但讲理', channel: 'qq' })
  // 只打个招呼、没给印象：印象必须留着
  await people.upsert('u_1', { name: 'Lily', channel: 'qq' })
  let p = await people.get('u_1')
  assert.equal(p.impression, '话少，但讲理')
  assert.equal(p.count, 2)
  // 明确给空串：这才是「把印象清掉」
  await people.upsert('u_1', { impression: '' })
  p = await people.get('u_1')
  assert.equal(p.impression, '')
  await fs.rm(root, { recursive: true, force: true })
})

test('people：超长印象被截断，备注有上限，渠道去重', async () => {
  const root = await tmpRoot()
  const people = createPeople(root)
  const long = '啊'.repeat(IMPRESSION_MAX + 50)
  for (let i = 0; i < NOTES_MAX + 4; i++) await people.upsert('u_2', { note: `第${i}条`, channel: i % 2 ? 'qq' : 'bili' })
  await people.upsert('u_2', { impression: long, channel: 'bili' })
  const p = await people.get('u_2')
  assert.equal(p.impression.length, IMPRESSION_MAX)
  assert.equal(p.notes.length, NOTES_MAX)
  // 第一次见是在 B 站（i=0），之后才是 QQ；渠道按首次出现排序
  assert.deepEqual(p.channels, ['bili', 'qq'])
  await fs.rm(root, { recursive: true, force: true })
})

test('people：跨实例落盘（重建之后还在）', async () => {
  const root = await tmpRoot()
  const a = createPeople(root)
  await a.upsert('u_3', { name: '阿泽', impression: '爱发长语音' })
  const b = createPeople(root) // 新实例，不共享内存
  const p = await b.get('u_3')
  assert.equal(p.name, '阿泽')
  assert.equal(p.impression, '爱发长语音')
  await fs.rm(root, { recursive: true, force: true })
})

test('people：人太多时按最后见面时间淘汰', async () => {
  const root = await tmpRoot()
  const people = createPeople(root)
  for (let i = 0; i < PEOPLE_MAX + 5; i++) await people.upsert(`u_${i}`, { now: 1_000 + i })
  const list = await people.list({ limit: PEOPLE_MAX + 100 })
  assert.equal(list.length, PEOPLE_MAX)
  // 最早的那几个没了，最新的还在
  assert.equal(await people.get('u_0'), null)
  assert.ok(await people.get(`u_${PEOPLE_MAX + 4}`))
  await fs.rm(root, { recursive: true, force: true })
})

test('people：rebuild 只补计数与时间，不改印象', async () => {
  const root = await tmpRoot()
  const people = createPeople(root)
  await people.upsert('u_9', { impression: '她自己觉得的' })
  const res = await people.rebuild([
    { person: 'u_9', channel: 'qq', ts: 100 },
    { person: 'u_9', channel: 'bili', ts: 300 },
    { person: 'u_8', channel: 'qq', ts: 200 },
  ])
  assert.equal(res.people, 2)
  const p = await people.get('u_9')
  assert.equal(p.impression, '她自己觉得的')
  assert.equal(p.count, 2)
  assert.equal(p.first, 100)
  assert.equal(p.last, 300)
  await fs.rm(root, { recursive: true, force: true })
})

test('journal：滚动保留最近 N 句，最旧的被淘汰', async () => {
  const root = await tmpRoot()
  const j = createJournal(root)
  for (let i = 0; i < JOURNAL_KEEP + 7; i++) {
    await j.append({ channel: 'qq', kind: 'group', conversationId: 'g1', role: i % 2 ? 'her' : 'me', text: `第${i}句` })
  }
  const lines = await j.recent({ channel: 'qq', kind: 'group', conversationId: 'g1' })
  assert.equal(lines.length, JOURNAL_KEEP)
  assert.equal(lines.at(-1).text, `第${JOURNAL_KEEP + 6}句`)
  assert.equal(lines[0].text, `第7句`)
  await fs.rm(root, { recursive: true, force: true })
})

test('journal：同一个 id 在不同渠道是两个线程', async () => {
  const root = await tmpRoot()
  const j = createJournal(root)
  await j.append({ channel: 'qq', conversationId: '42', text: 'QQ 上说的' })
  await j.append({ channel: 'bili', conversationId: '42', text: 'B 站上说的' })
  const qq = await j.recent({ channel: 'qq', conversationId: '42' })
  const bili = await j.recent({ channel: 'bili', conversationId: '42' })
  assert.deepEqual(qq.map((l) => l.text), ['QQ 上说的'])
  assert.deepEqual(bili.map((l) => l.text), ['B 站上说的'])
  assert.notEqual(threadKey({ channel: 'qq', conversationId: '42' }), threadKey({ channel: 'bili', conversationId: '42' }))
  await fs.rm(root, { recursive: true, force: true })
})

test('可见性：老事件（没有字段）只在他面前可用', () => {
  const old = { type: 'utterance', text: '以前说过的话' }
  assert.equal(visibleTo(old, { person: 'owner' }), true)
  assert.equal(visibleTo(old, { person: 'u_1' }), false)
})

test('可见性：别人的私聊，他本人也读不到', () => {
  const secret = { type: 'utterance', text: '我老公要出差', visibility: 'private', person: 'u_1' }
  assert.equal(visibleTo(secret, { person: 'u_1' }), true)
  assert.equal(visibleTo(secret, { person: 'owner' }), false)
  assert.equal(visibleTo(secret, { person: 'u_2' }), false)
})

test('可见性：公开的谁都能用；filterForAudience 保持原顺序', () => {
  const evs = [
    { id: 'a', visibility: 'public', text: 'A' },
    { id: 'b', visibility: 'private', person: 'u_1', text: 'B' },
    { id: 'c', visibility: 'owner', text: 'C' },
    { id: 'd', visibility: 'private', person: 'u_2', text: 'D' },
  ]
  assert.deepEqual(filterForAudience(evs, { person: 'u_1' }).map((e) => e.id), ['a', 'b'])
  assert.deepEqual(filterForAudience(evs, { person: 'owner' }).map((e) => e.id), ['a', 'c'])
  assert.deepEqual(filterForAudience(evs, { person: 'u_3' }).map((e) => e.id), ['a'])
})

test('leakcheck：她复述别人的私事，会被认出来', () => {
  const events = [
    { visibility: 'private', person: 'u_1', text: '我老公下个月要去深圳出差两个星期' },
    { visibility: 'private', person: 'u_2', text: '我最近在准备考研，压力很大' },
  ]
  const index = buildIndex(events)
  assert.ok(index.size > 0)
  const bad = looksLikePrivateLeak('你还记得吗，她老公下个月要去深圳出差两个星期', index, { person: 'u_2' })
  assert.equal(bad.hit, true)
  assert.equal(bad.from, 'u_1')
  // 说给当事人听：不算泄露
  const ok = looksLikePrivateLeak('你老公下个月要去深圳出差两个星期，你一个人行吗', index, { person: 'u_1' })
  assert.equal(ok.hit, false)
})

test('leakcheck：同一个人在另一个平台说的话，不算外泄', () => {
  // 2026-11-02：主人在 B 站是 u_10001、在抖音是昵称；两串 id 不相等，
  // 只按字符串比会把她跟主人复述主人自己说过的话拦掉（真机踩过）。
  const index = buildIndex([{ visibility: 'private', person: '10001', text: '我下周要去深圳出差两个星期，家里那只猫麻烦你喂一下' }])
  const blocked = looksLikePrivateLeak('我下周要去深圳出差两个星期，家里那只猫麻烦你喂一下', index, { person: 'u_小满' })
  assert.equal(blocked.hit, true)
  const allowed = looksLikePrivateLeak('我下周要去深圳出差两个星期，家里那只猫麻烦你喂一下', index, { person: 'u_小满', sameAs: ['10001'] })
  assert.equal(allowed.hit, false)
})

test('leakcheck：配置里的裸 id 与事件里的 u_ 前缀算同一个人', () => {
  // 2026-11-03 真机：主人在 QQ 群里复述自己私聊里说过的话，被当成「外泄别人的私事」拦掉
  // （日志 `拦下一条出门的话（leak）`）。原因是设置里填的是 `10002`，
  // 事件里的 person 是 `u_10002`，同一个人的两种写法对不上。
  const text = '消息测试 QQ 群渠道，三个地方都通了'
  const index = buildIndex([{ visibility: 'private', person: 'u_10002', text: `${text}，顺便把猫喂了` }])
  const blocked = looksLikePrivateLeak(text, index, { person: 'u_999' })
  assert.equal(blocked.hit, true, '不知道是同一个人时，仍然要拦')
  const allowed = looksLikePrivateLeak(text, index, { person: 'u_999', sameAs: ['10002'] })
  assert.equal(allowed.hit, false, '裸 id 与 u_ 前缀必须认成同一个人')
  // 反过来也成立：sameAs 里写带前缀的，event 里是裸的
  const index2 = buildIndex([{ visibility: 'private', person: '10002', text: `${text}，顺便把猫喂了` }])
  assert.equal(looksLikePrivateLeak(text, index2, { person: 'u_1', sameAs: ['u_10002'] }).hit, false)
})

test('leakcheck：公开内容与短句不会误伤', () => {
  const index = buildIndex([{ visibility: 'public', person: 'u_1', text: '我老公下个月要去深圳出差两个星期' }])
  assert.equal(index.size, 0, 'owner/公开事件不该进私聊索引')
  const hit = looksLikePrivateLeak('今天天气不错', buildIndex([{ visibility: 'private', person: 'u_1', text: '我老公下个月要去深圳出差两个星期' }]), {
    person: 'u_2',
  })
  assert.equal(hit.hit, false)
})

test('leakcheck：shingles 归一化掉空白与标点', () => {
  const a = shingles('我 老公，下个月要出差')
  const b = shingles('我老公下个月要出差')
  assert.deepEqual([...a].sort(), [...b].sort())
})
