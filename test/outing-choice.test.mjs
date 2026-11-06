/**
 * outing-choice.test.mjs —— 掷骰只问、她自己选（2026-11-06）
 *
 * 三件事：
 *   1. 叫醒语按来源分（掷骰/手动醒着 = 出去逛逛；睡醒/段首/手动在睡 = 醒一醒）；
 *   2. choose_outing 只在醒来回合可用；空选不调执行器、不占次数；
 *   3. 作息掷骰叫醒时不再预抓素材（没有 browse 事件），抓不抓由她选。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WAKE_TRIGGER, OUTING_TRIGGER, wakeTriggerFor } from '../lib/wakeconst.js'
import { registerChooseOuting, setOutingExecutor, resetOutingForTests } from '../lib/outingChoice.js'
import { setWakeTurn, resetWakeTurnForTests } from '../lib/wakeTurn.js'
import { startScheduler, wakeNow } from '../lib/scheduler.js'
import { normalizeConfig } from '../lib/settings.js'
import { writeConfig, readEvents } from '../lib/store.js'
import { writeSleep, readSleep, blankState } from '../lib/sleep.js'

const pad = (n) => String((n + 24) % 24).padStart(2, '0')
const now = new Date()
const start = `${pad(now.getHours() - 1)}:00`
const end = `${pad(now.getHours() + 3)}:00`

test('叫醒语：掷骰/手动醒着用「出去逛逛」，睡醒/段首用「醒一醒」', () => {
  assert.equal(OUTING_TRIGGER, '（出去逛逛）')
  assert.equal(wakeTriggerFor({ ledger: 'roll' }), OUTING_TRIGGER)
  assert.equal(wakeTriggerFor({ ledger: 'segment' }), WAKE_TRIGGER)
  assert.equal(wakeTriggerFor({ manual: true, asleep: false }), OUTING_TRIGGER)
  assert.equal(wakeTriggerFor({ manual: true, asleep: true }), WAKE_TRIGGER)
  assert.equal(wakeTriggerFor({ manual: true, asleep: null }), WAKE_TRIGGER, '第一次还没有台账：先醒一醒')
  assert.equal(wakeTriggerFor({}), WAKE_TRIGGER)
})

test('choose_outing：空选不调执行器；选了才把路交给执行器', async () => {
  const ctx = { tools: { register: (s) => s } }
  const tool = registerChooseOuting(ctx, { root: '/tmp/nope' })
  assert.equal(tool.name, 'choose_outing')
  assert.deepEqual(tool.parameters.properties.channels.items.enum, ['bili', 'zhihu', 'tieba', 'reply'])
  assert.doesNotMatch(tool.description, /配额|阶段/)

  const calls = []
  setOutingExecutor(async (args) => { calls.push(args); return { ok: true, text: '看到了什么', note: '' } })
  try {
    resetWakeTurnForTests()
    const off = await tool.execute({ channels: ['bili'] }, { sessionId: 's' })
    assert.equal(off.ok, false)
    assert.match(off.note, /不是你自己醒着/)
    assert.equal(calls.length, 0)

    setWakeTurn({ sessionId: 's', dk: '2026-11-06', segmentId: 3 })
    const none = await tool.execute({ channels: [] }, { sessionId: 's' })
    assert.equal(none.ok, false)
    assert.match(none.note, /不逛/)
    assert.equal(calls.length, 0, '空选不该发任何请求')

    const bad = await tool.execute({ channels: ['news'] }, { sessionId: 's' })
    assert.equal(bad.ok, false)
    assert.equal(calls.length, 0, '不认识的路过滤掉后也是空选')

    const r = await tool.execute({ channels: ['bili', 'zhihu', 'bili'] }, { sessionId: 's' })
    assert.equal(r.ok, true)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].channels, ['bili', 'zhihu'], '去重保序')
    assert.equal(calls[0].wakeTurn.segmentId, 3)
  } finally {
    resetOutingForTests()
    resetWakeTurnForTests()
  }
})

test('掷骰叫醒不预抓：只发唤醒语，素材等她选', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-outing-'))
  const prompts = []
  const ctx = {
    on: () => () => {},
    sessionController: {
      create: async () => {},
      prompt: async (req) => { prompts.push(req) },
    },
  }
  try {
    const cfg = normalizeConfig({
      sleep: { active_start: start, active_end: end, nap_min_h: 3, nap_max_h: 3 },
      browse: { enabled: true },
      comment: { enabled: false },
      zhihu: { enabled: false },
      tieba: { enabled: false },
      rules: { offers: false },
      memory: { sleepEveryDays: 0 },
    })
    await writeConfig(cfg, root)
    const st = {
      ...blankState(cfg, Date.now()),
      mode: 'dice_awake',
      looked: true,
      segmentId: 1,
      acts: { bili: 0, douyin: 0, zhihu: 0, tieba: 0, reply: 0 },
      blocked: { bili: 0, douyin: 0, zhihu: 0, tieba: 0, reply: 0 },
      nextRollAt: { bili: 0, douyin: 0, zhihu: 0, tieba: 0, reply: 0 },
    }
    await writeSleep(root, st)
    const s = startScheduler(ctx, { root, sessionId: 's-main', log: () => {}, rnd: () => 0 })
    try {
      await s.tick()
      assert.equal(prompts.length, 1, '应当叫醒一次')
      assert.equal(prompts[0].content[0].text, OUTING_TRIGGER)
      const { events } = await readEvents(root)
      assert.equal(events.filter((e) => e.type === 'meta' && String(e.text).startsWith('browse:')).length, 0, '没选之前不该抓 B 站')
      const after = await readSleep(root)
      assert.equal(after.acts.bili, 0, '没选不占次数')
    } finally {
      s.dispose()
    }
  } finally {
    resetWakeTurnForTests()
    await rm(root, { recursive: true, force: true })
  }
})

test('手动叫醒也只问不抓：叫醒后等她选，不先抓素材', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-manual-'))
  const prompts = []
  const ctx = {
    on: () => () => {},
    sessionController: {
      create: async () => {},
      prompt: async (req) => { prompts.push(req) },
    },
  }
  try {
    await writeConfig(normalizeConfig({
      sleep: { active_start: start, active_end: end },
      browse: { enabled: true },
      comment: { enabled: false },
      zhihu: { enabled: false },
      tieba: { enabled: false },
      rules: { offers: false },
      memory: { sleepEveryDays: 0 },
    }), root)
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].content[0].text, WAKE_TRIGGER, '还没有台账：先醒一醒')
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'meta' && String(e.text).startsWith('browse:')).length, 0, '手动叫醒也不该先抓')
    const st = await readSleep(root)
    assert.equal(st.mode, 'dice_awake')
    assert.equal(st.acts.bili, 0, '她没选就不占次数')
  } finally {
    resetWakeTurnForTests()
    await rm(root, { recursive: true, force: true })
  }
})
