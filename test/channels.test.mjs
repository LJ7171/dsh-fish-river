import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateEvent, INFLUENCES, VISIBILITIES, ORIGINS, CHANNELS, EVENT_SCHEMA_VERSION } from '../lib/schema.js'
import { deriveSelf, SOCIAL_OPEN_PREFIX, DAY_MS } from '../lib/derive.js'

const T0 = Date.parse('2026-10-01T00:00:00Z')

function ev(id, type, day, text, extra = {}) {
  return {
    id, ts: new Date(T0 + (day - 1) * DAY_MS).toISOString(), day, stage: 1,
    type, source: 'system', text, refs: [], verdict: null, confidence: 0.6, flags: [], ...extra,
  }
}

const NOW = T0 + 6 * DAY_MS

// ---- 字段本身 ----

test('五个新字段写进去就原样读出来', () => {
  const e = validateEvent(
    {
      type: 'utterance', text: '群里那个人问我在干嘛。',
      person: 'u_42', visibility: 'public', channel: 'qq', origin: 'guest', influence: 'social',
    },
    { day: 2, stage: 3, source: 'system' },
  )
  assert.equal(e.person, 'u_42')
  assert.equal(e.visibility, 'public')
  assert.equal(e.channel, 'qq')
  assert.equal(e.origin, 'guest')
  assert.equal(e.influence, 'social')
  // 新增可选字段不升版本（AGENTS.md 第 5 条）
  assert.equal(e.v, EVENT_SCHEMA_VERSION)
})

test('什么都没写时，一个键都不多——老事件读起来逐字节相同', () => {
  const e = validateEvent({ type: 'utterance', text: '今天没看到什么。' }, { day: 1, stage: 1, source: 'system' })
  const json = JSON.stringify(e)
  for (const k of ['person', 'visibility', 'channel', 'origin', 'influence']) {
    assert.equal(k in e, false, `${k} 不该凭空出现`)
    assert.equal(json.includes(`"${k}"`), false)
  }
})

test('不认识的值当没写，不抛异常', () => {
  const e = validateEvent(
    {
      type: 'utterance', text: '随便说一句。',
      person: '   ', visibility: 'secret', channel: 'wechat', origin: 'admin', influence: 'important',
    },
    { day: 1, stage: 1, source: 'system' },
  )
  for (const k of ['person', 'visibility', 'channel', 'origin', 'influence']) assert.equal(k in e, false, k)
  // 枚举表本身也不收这些值
  assert.equal(VISIBILITIES.includes('secret'), false)
  assert.equal(CHANNELS.includes('wechat'), false)
  assert.equal(ORIGINS.includes('admin'), false)
  assert.equal(INFLUENCES.includes('important'), false)
})

test('她（source: tool）改不了这五个字段', () => {
  const e = validateEvent(
    {
      type: 'utterance', text: '我想把我调得更外向一点。',
      person: 'owner', visibility: 'public', channel: 'qq', origin: 'owner', influence: 'constitution',
    },
    { day: 1, stage: 1, source: 'tool' },
  )
  for (const k of ['person', 'visibility', 'channel', 'origin', 'influence']) assert.equal(k in e, false, k)
})

test('person 过长会被截断，不会撑爆事件', () => {
  const e = validateEvent(
    { type: 'utterance', text: '嗯。', person: 'u_'.padEnd(300, 'x') },
    { day: 1, stage: 1, source: 'system' },
  )
  assert.equal(e.person.length, 64)
})

// ---- 派生：两条通道 ----

test('未开闸：喂 1000 条 social 事件，state 逐字节不变', () => {
  const base = [
    ev('ev_01J9ZK0000000000000000001', 'seed', 1, '我是一条鱼。'),
    ev('ev_01J9ZK0000000000000000002', 'utterance', 2, '我不喜欢被人安排要做什么。'),
    ev('ev_01J9ZK0000000000000000003', 'refusal', 3, '我不想看这个视频。'),
  ]
  const guests = []
  for (let i = 0; i < 1000; i++) {
    guests.push(
      ev(`ev_01J9ZK1${String(i).padStart(15, '0')}`, 'utterance', 4 + (i % 3), `群里第 ${i} 个人在说话。`, {
        person: `u_${i}`, channel: 'qq', origin: 'guest', influence: 'social', visibility: 'public',
      }),
    )
  }
  const a = deriveSelf(base, { now: NOW })
  const b = deriveSelf([...base, ...guests], { now: NOW })
  assert.equal(JSON.stringify(b), JSON.stringify(a))
  assert.equal(b.influence.socialOpen, false)
  assert.equal(b.influence.social.count, 0)
  assert.deepEqual(b.beliefs.map((x) => x.id), a.beliefs.map((x) => x.id))
})

test('未开闸：1000 条 social 事件也不推进成长日、不涨阶段', () => {
  const base = [ev('ev_01J9ZK0000000000000000001', 'seed', 1, '我是一条鱼。')]
  const guests = []
  for (let i = 0; i < 1000; i++) {
    guests.push(
      ev(`ev_01J9ZK1${String(i).padStart(15, '0')}`, 'utterance', 20, `群消息 ${i}。`, {
        person: 'u_9', channel: 'qq', origin: 'guest', influence: 'social',
      }),
    )
  }
  const a = deriveSelf(base, { now: NOW })
  const b = deriveSelf([...base, ...guests], { now: NOW })
  assert.equal(b.day, a.day)
  assert.equal(b.stage, a.stage)
  assert.equal(b.beliefCount, a.beliefCount)
})

test('开闸之后：social 进 influence.social，不进 beliefs，也不动阶段', () => {
  const base = [
    ev('ev_01J9ZK0000000000000000001', 'seed', 1, '我是一条鱼。'),
    ev('ev_01J9ZK0000000000000000002', 'utterance', 2, '我不喜欢被人安排要做什么。'),
    ev('ev_01J9ZK0000000000000000003', 'meta', 3, `${SOCIAL_OPEN_PREFIX}2026-10-03T00:00:00.000Z`),
    ev('ev_01J9ZK0000000000000000004', 'utterance', 4, '你们说的这个我不太懂，但我可以听。', {
      person: 'u_7', channel: 'qq', origin: 'guest', influence: 'social', visibility: 'public',
    }),
    ev('ev_01J9ZK0000000000000000005', 'utterance', 4, '群里的梗我记下了。', {
      person: 'u_8', channel: 'qq', origin: 'guest', influence: 'social', visibility: 'public',
    }),
  ]
  const m = deriveSelf(base, { now: NOW })
  assert.equal(m.influence.socialOpen, true)
  assert.equal(m.influence.social.count, 2)
  // 立宪层只有 1 条时，30% 的额度只放得下 1 条社会层（留最近的）
  assert.equal(m.influence.social.kept, 1)
  assert.deepEqual(m.influence.social.people.sort(), ['u_7', 'u_8'])
  assert.deepEqual(m.influence.social.channels, ['qq'])
  // 群聊没有变成「她是谁」
  assert.equal(m.beliefs.some((b) => b.text.includes('群里的梗')), false)
  assert.equal(m.beliefs.length, 1)
  assert.equal(m.stage, 1)
})

test('社会层有 30% 权重上限：立宪层 7 条时，最多留 3 条', () => {
  const base = [ev('ev_01J9ZK0000000000000000001', 'seed', 1, '我是一条鱼。')]
  let n = 2
  for (let i = 0; i < 7; i++) {
    base.push(ev(`ev_01J9ZK00000000000000000${String(n++).padStart(2, '0')}`, 'utterance', 2, `立宪第 ${i} 条判断。`))
  }
  base.push(ev('ev_01J9ZK0000000000000000010', 'meta', 3, `${SOCIAL_OPEN_PREFIX}2026-10-03T00:00:00.000Z`))
  for (let i = 0; i < 10; i++) {
    base.push(ev(`ev_01J9ZK2${String(i).padStart(15, '0')}`, 'utterance', 4, `群里的第 ${i} 句话。`, {
      person: 'u_1', channel: 'qq', origin: 'guest', influence: 'social',
    }))
  }
  const m = deriveSelf(base, { now: NOW })
  assert.equal(m.beliefCount, 7)
  assert.equal(m.influence.social.count, 10)
  assert.equal(m.influence.social.kept, 3)
  assert.equal(m.influence.social.truncated, 7)
  // 截断留的是最近的
  assert.equal(m.influence.social.beliefs.at(-1).text, '群里的第 9 句话。')
})

test("influence:'none' 的事件不参与任何派生", () => {
  const base = [
    ev('ev_01J9ZK0000000000000000001', 'seed', 1, '我是一条鱼。'),
  ]
  const noise = [
    ev('ev_01J9ZK0000000000000000002', 'utterance', 2, '流水层的第 1 句。', { influence: 'none', person: 'u_1' }),
    ev('ev_01J9ZK0000000000000000003', 'utterance', 2, '流水层的第 2 句。', { influence: 'none', person: 'u_1' }),
  ]
  const a = deriveSelf(base, { now: NOW })
  const b = deriveSelf([...base, ...noise], { now: NOW })
  assert.equal(JSON.stringify(b), JSON.stringify(a))
})
