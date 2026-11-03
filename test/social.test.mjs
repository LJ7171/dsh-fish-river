/**
 * social.test.mjs —— 社会层开闸（2026-11-02，合并版）
 *
 * 要守住的是四件事：
 *   ① 四条闸各自算得出来，且差一条就不算过；
 *   ② 差着的时候调用 social_open 什么都不写（不是"写了但标失败"）；
 *   ③ 开闸是事件不是配置——开完 deriveSelf 认，配置改不动；
 *   ④ 身份文档只在"可以决定"和"已经开了"两处提到外面的人，差着时一个字都不写。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  evaluateSocialGate, socialOpenAt, lastRefutedAt, daysAlive, gateBrief,
  SOCIAL_STANCE_MIN, SOCIAL_QUIET_DAYS, SOCIAL_LIVE_DAYS,
} from '../lib/socialgate.js'
import { deriveSelf, SOCIAL_OPEN_PREFIX, DAY_MS } from '../lib/derive.js'
import { appendEvent, readEvents } from '../lib/store.js'
import { registerSocialOpen } from '../lib/social.js'
import { renderSelfDoc } from '../lib/selfdoc.js'

const NOW = Date.parse('2026-11-02T00:00:00Z')
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY_MS).toISOString()

function ev(id, type, daysAgo, text, extra = {}) {
  return {
    id, ts: iso(daysAgo), day: 1, stage: 1, type, source: 'system',
    text, refs: [], verdict: null, confidence: 0.6, flags: [], ...extra,
  }
}

/** 一条判断要能成为"立场"：文本得是 never/like 类，且有背书（mentions/verified/scars）。 */
const STANCE_TEXTS = [
  '我绝不在背后说别人坏话',
  '我绝不为讨好谁改自己的说法',
  '我不假装喜欢我不喜欢的东西',
  '我绝不拿别人的软处开玩笑',
  '我绝不在累的时候答应明天的事',
  '我不想再解释自己为什么迟到',
  '我拒绝为了合群去迎合谁',
]

function stanceModel(n = SOCIAL_STANCE_MIN, stage = 4) {
  const beliefs = Array.from({ length: n }, (_, i) => ({
    id: `b${i}`,
    text: STANCE_TEXTS[i % STANCE_TEXTS.length],
    since: iso(20),
    mentions: 3,
    verified: 2,
    solid: true,
    status: 'active',
  }))
  return { stage, beliefs, scars: [] }
}

/** 活得够久的普通事件流（不含改写，稳定度交给真实 stability 去算）。 */
function longStream(days = 20) {
  const out = []
  for (let d = days; d >= 1; d -= 1) {
    out.push(ev(`u${d}a`, 'utterance', d, `第 ${d} 天我在想，有些事不能将就。`))
    out.push(ev(`u${d}b`, 'utterance', d, `第 ${d} 天我把窗帘拉开，光进来了一半。`))
  }
  return out
}

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'fish-social-'))
}

// ---- 读数 ----

test('socialOpenAt：没有就是 null，有就取最后一次', () => {
  assert.equal(socialOpenAt([]), null)
  const at = iso(3)
  const events = [
    ev('a', 'meta', 5, `${SOCIAL_OPEN_PREFIX}${iso(9)}`),
    ev('b', 'meta', 4, `${SOCIAL_OPEN_PREFIX}${at}`),
  ]
  assert.equal(socialOpenAt(events), at)
})

test('lastRefutedAt 只认 refuted，refined 不算"整条推翻"', () => {
  const events = [
    ev('a', 'revise', 9, '那句我说错了', { verdict: 'refuted' }),
    ev('b', 'revise', 4, '那句我说得不够准', { verdict: 'refined' }),
  ]
  assert.equal(lastRefutedAt(events), Date.parse(iso(9)))
})

test('daysAlive：从第一条事件算起；空流是 0', () => {
  assert.equal(daysAlive([], NOW), 0)
  assert.equal(daysAlive([ev('a', 'utterance', 20, '嗯')], NOW), 20)
})

// ---- 四条闸 ----

test('阶段不到就不算过', () => {
  const gate = evaluateSocialGate({ model: { stage: 2 }, events: [], now: NOW })
  assert.equal(gate.ok, false)
  const g = gate.gates.find((x) => x.id === 'stage')
  assert.equal(g.ok, false)
  assert.match(g.why, /第 2 阶段/)
})

test('立场不够就不算过；够 6 条才算', () => {
  const few = evaluateSocialGate({ model: stanceModel(3), events: longStream(), now: NOW })
  assert.equal(few.gates.find((x) => x.id === 'stance').ok, false)
  const six = evaluateSocialGate({ model: stanceModel(6), events: longStream(), now: NOW })
  assert.equal(six.gates.find((x) => x.id === 'stance').ok, true)
  assert.match(six.gates.find((x) => x.id === 'stance').why, /6 条/)
})

test(`30 天内整条推翻过自己 → 稳这一条不过`, () => {
  const events = [...longStream(), ev('r', 'revise', 5, '那句是错的', { verdict: 'refuted' })]
  const gate = evaluateSocialGate({ model: stanceModel(), events, now: NOW })
  const g = gate.gates.find((x) => x.id === 'quiet')
  assert.equal(g.ok, false)
  assert.match(g.why, /再等一等/)
})

test(`40 天前推翻过 → 已经稳了`, () => {
  const events = [...longStream(50), ev('r', 'revise', 40, '那句是错的', { verdict: 'refuted' })]
  const gate = evaluateSocialGate({ model: stanceModel(), events, now: NOW })
  assert.equal(gate.gates.find((x) => x.id === 'quiet').ok, true)
})

test(`活不够 ${SOCIAL_LIVE_DAYS} 天 → 这一条不过`, () => {
  const events = [ev('a', 'utterance', 2, '刚来。'), ev('b', 'utterance', 1, '还在。')]
  const gate = evaluateSocialGate({ model: stanceModel(), events, now: NOW })
  const g = gate.gates.find((x) => x.id === 'live')
  assert.equal(g.ok, false)
  assert.match(g.why, /才活了 2 天/)
})

test('开过之后 ok 恒真，why 说明已经开过', () => {
  const events = [ev('o', 'meta', 1, `${SOCIAL_OPEN_PREFIX}${iso(1)}`)]
  const gate = evaluateSocialGate({ model: { stage: 1 }, events, now: NOW })
  assert.equal(gate.open, true)
  assert.equal(gate.ok, true)
  assert.match(gate.why, /开过了/)
})

test('gateBrief：没开时只说她听得到的话，不出现字段名', () => {
  const gate = evaluateSocialGate({ model: { stage: 1 }, events: [], now: NOW })
  const line = gateBrief(gate)
  assert.match(line, /还差/)
  for (const bad of ['stage', 'stance', 'quiet', 'live', 'social-open']) {
    assert.equal(line.includes(bad), false)
  }
})

// ---- 工具：愿不愿意由她定，能不能开由事件流定 ----

function fakeCtx() {
  const tools = []
  return {
    tools: { register: (spec) => { tools.push(spec); return spec } },
    toolsList: tools,
  }
}

test('闸门差着的时候调用 social_open：一个事件都不写', async () => {
  const root = await tmpRoot()
  const ctx = fakeCtx()
  registerSocialOpen(ctx, {
    root,
    evaluate: () => ({ ok: false, open: false, at: null, why: '只 3 条站得住的立场，要 6 条' }),
  })
  const spec = ctx.toolsList[0]
  const out = await spec.execute({})
  assert.equal(out.ok, false)
  assert.match(out.note, /6 条/)
  const { events } = await readEvents(root)
  assert.equal(events.length, 0)
})

test('四条都过了：写一条 meta，deriveSelf 立刻认，且只能开一次', async () => {
  const root = await tmpRoot()
  const ctx = fakeCtx()
  registerSocialOpen(ctx, { root, evaluate: () => ({ ok: true, open: false, at: null, why: '四条都过了' }) })
  const spec = ctx.toolsList[0]

  const out = await spec.execute({})
  assert.equal(out.ok, true)
  assert.ok(out.at)

  const { events } = await readEvents(root)
  const meta = events.find((e) => String(e.text ?? '').startsWith(SOCIAL_OPEN_PREFIX))
  assert.ok(meta, '必须留下一条 social-open 的 meta')
  assert.equal(deriveSelf(events).influence.socialOpen, true)

  // 第二次：幂等，不写第二条
  const again = fakeCtx()
  registerSocialOpen(again, { root, evaluate: () => ({ ok: true, open: true, at: out.at, why: '' }) })
  const second = await again.toolsList[0].execute({})
  assert.equal(second.ok, false)
  assert.match(second.note, /已经开过/)
  const after = await readEvents(root)
  assert.equal(
    after.events.filter((e) => String(e.text ?? '').startsWith(SOCIAL_OPEN_PREFIX)).length,
    1,
  )
})

test('开闸之后社会层才进派生：没开时 social 事件不进 influence.social', async () => {
  const guest = (i) => ev(`g${i}`, 'utterance', 1, `群里第 ${i} 个人说，这样说话太冲了。`, {
    origin: 'guest', influence: 'social', visibility: 'public', channel: 'qq',
  })
  const events = [guest(1), guest(2)]
  const before = deriveSelf(events)
  assert.equal(before.influence.socialOpen, false)
  assert.equal(before.influence.social.count, 0)

  events.push(ev('o', 'meta', 1, `${SOCIAL_OPEN_PREFIX}${iso(1)}`))
  const after = deriveSelf(events)
  assert.equal(after.influence.socialOpen, true)
  assert.ok(after.influence.social.count >= 2)
})

// ---- 身份文档 ----

test('身份文档：差着时一个字不提，可以决定时出现「外面的人」，开了之后说法变了', () => {
  const model = { ...deriveSelf([]), stage: 1 }
  const closed = renderSelfDoc(model, {})
  assert.equal(closed.includes('## 外面的人'), false)

  const offer = renderSelfDoc(model, { social: 'offer' })
  assert.match(offer, /## 外面的人/)
  assert.match(offer, /social_open/)
  assert.match(offer, /不是他替我开的/)

  const open = renderSelfDoc(model, { social: 'open' })
  assert.match(open, /## 外面的人/)
  assert.match(open, /不能收回/)
  assert.equal(open.includes('social_open'), false, '已经开了就不该再劝她调用')
})

test('开闸后她学到的东西真的进了身份文档；没开闸时同样的字一个都不出现', () => {
  const base = { ...deriveSelf([]), stage: 4 }
  const learned = {
    ...base,
    influence: {
      socialOpen: true,
      social: {
        count: 1,
        kept: 1,
        truncated: 0,
        beliefs: [{ id: 'e1', text: '群里有人第一次说话要先打招呼', since: '2026-11-01', channel: 'qq', person: 'u_9' }],
        people: [],
        channels: ['qq'],
      },
    },
  }
  const open = renderSelfDoc(learned, { social: 'open' })
  assert.match(open, /在外面学到的/)
  assert.match(open, /先打招呼/)

  const offer = renderSelfDoc(learned, { social: 'offer' })
  assert.equal(offer.includes('先打招呼'), false, '还没开闸就不该把这层带进身份')
})

test('写事件时不需要她先读过身份文档：meta 的 source 必须是 system', async () => {
  const root = await tmpRoot()
  const { events } = await (async () => {
    await appendEvent(
      { type: 'meta', text: `${SOCIAL_OPEN_PREFIX}${iso(0)}` },
      { day: 1, stage: 1, source: 'system' },
      root,
    )
    return readEvents(root)
  })()
  assert.equal(events.length, 1)
  assert.equal(events[0].source, 'system')
})



