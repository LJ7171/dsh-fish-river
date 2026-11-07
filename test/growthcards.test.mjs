/**
 * growthcards.test.mjs —— 成长卡触发与间隔（2026-11-06）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig, dateKey } from '../lib/settings.js'
import { appendEvent, writeConfig } from '../lib/store.js'
import { readDailySpent } from '../lib/sleep.js'
import {
  blankCards, readCards, writeCards, quotaProgress, recordMilestones,
  canPush, queueCard, dayFinished, CARD_GAP_MS,
} from '../lib/growthcards.js'

async function root() { return mkdtemp(join(tmpdir(), 'fish-cards-')) }

test('间隔固定 1 小时；每日上限；同原因只排一次', async () => {
  const r = await root()
  try {
    const cfg = normalizeConfig({ daily: { events: 2 } })
    const now = 1_800_000_000_000
    let st = blankCards(now)
    assert.equal(canPush(st, cfg, now), true)
    st = queueCard(queueCard(st, 'half'), 'half')
    assert.deepEqual(st.pending, ['half'])
    st = { ...st, pushed: 2 }
    assert.equal(canPush(st, cfg, now), false, '推满就不推')
    st = { ...st, pushed: 0, lastAt: now }
    assert.equal(canPush(st, cfg, now + CARD_GAP_MS - 1), false)
    assert.equal(canPush(st, cfg, now + CARD_GAP_MS), true)
  } finally { await rm(r, { recursive: true, force: true }) }
})

test('50% / 100% 只记一次，进待推队列', async () => {
  const r = await root()
  try {
    const cfg = normalizeConfig({ daily: { events: 2 }, browse: { enabled: true, perDay: 2 }, sleep: { daily: { bili: 2, zhihu: 0, tieba: 0, douyin: 0 } } })
    await writeConfig(cfg, r)
    const dk = dateKey()
    await appendEvent({ type: 'meta', text: `browse:${dk} [{"bvid":"BV1"}]` }, { day: 1, stage: 1, source: 'system' }, r)
    const p1 = await quotaProgress(r, cfg)
    assert.equal(p1.cap, 2)
    assert.equal(p1.used, 1)
    assert.equal(p1.half, 1)
    let st = await recordMilestones(r, cfg)
    assert.deepEqual(st.pending, ['half'])
    st = await recordMilestones(r, cfg)
    assert.deepEqual(st.pending, ['half'], '同一天不重复记半程')

    await appendEvent({ type: 'meta', text: `browse:${dk} [{"bvid":"BV2"}]` }, { day: 1, stage: 1, source: 'system' }, r)
    st = await recordMilestones(r, cfg)
    assert.deepEqual(st.pending, ['half', 'all'])
    assert.equal(dayFinished(st, cfg, { cap: 2, used: 2 }), true, '上网到 100% 也算当天结束')
    assert.equal(dayFinished(st, cfg, { cap: 2, used: 1 }), false, '没满就不结束')
    assert.equal(dayFinished({ ...st, pushed: 2 }, cfg, { cap: 2, used: 1 }), true, '卡推满也算结束')
  } finally { await rm(r, { recursive: true, force: true }) }
})

test('跨零点台账重置，昨天的待推不带过来', async () => {
  const r = await root()
  try {
    const old = { ...blankCards(Date.parse('2026-11-05T12:00:00+08:00')), pushed: 1, pending: ['all'], half: true }
    await writeCards(r, old)
    const st = await readCards(r, Date.parse('2026-11-06T12:00:00+08:00'))
    assert.equal(st.pushed, 0)
    assert.deepEqual(st.pending, [])
  } finally { await rm(r, { recursive: true, force: true }) }
})

test('成长卡推送必须写 fired:，否则同一天会反复推同一张', async () => {
  const fs = await import('node:fs/promises')
  const src = await fs.readFile(new URL('../lib/scheduler.js', import.meta.url), 'utf8')
  assert.match(src, /fired:\$\{picked\.template\.id\}/)
  assert.match(src, /card:\$\{dk\} \$\{picked\.template\.id\}/)
})
