/**
 * reply-delivery.test.mjs —— 别人回了她，她醒着就立刻递（2026-11-18）
 *
 * 四条：醒着立投 / 睡着留盒 / 忙时不硬插 / 递过就算看过；
 * 加回复间隔的边界与调度器的扫描窗口。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dateKey, normalizeConfig } from '../lib/core/settings.js'
import { writeConfig } from '../lib/core/store.js'
import { sleepPath, writeSleep } from '../lib/life/schedule/sleep.js'
import { addReplies, readReplyBox } from '../lib/life/replybox.js'
import { getWakeSection, setWakeSection } from '../lib/mind/identity.js'
import { seenReplies } from '../lib/platforms/bili/comment.js'
import {
  REPLY_TRIGGER, deliverAwakeReplyBatch, resetReplyDeliveryForTests,
} from '../lib/life/replyDelivery.js'
import {
  getPacing, replyGapMs, resetPacingForTests, setPacing, waitReplyGap,
} from '../lib/core/pacing.js'

const cfg = normalizeConfig({
  comment: { enabled: true, scanEveryMin: 30 },
  browse: { enabled: false, images: { enabled: false } },
})

function fakeCtx() {
  const listeners = []
  const prompts = []
  return {
    prompts,
    ctx: {
      on: (name, fn) => {
        const row = { name, fn }
        listeners.push(row)
        return () => {
          const i = listeners.indexOf(row)
          if (i >= 0) listeners.splice(i, 1)
        }
      },
      sessionController: {
        create: async () => {},
        prompt: async (req) => { prompts.push(req) },
      },
    },
    emit(type, sessionId) {
      for (const row of [...listeners]) row.fn({ header: { id: sessionId } }, { type })
    },
  }
}

function awakeState(now) {
  return {
    mode: 'dice_awake',
    since: now,
    lastActivityAt: now,
    wakeDueAt: 0,
    wokeInside: true,
    looked: true,
    segmentId: 1,
    acts: {},
    blocked: {},
    nextRollAt: {},
  }
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-reply-go-'))
  try {
    await writeConfig(cfg, root)
    setWakeSection('')
    resetReplyDeliveryForTests()
    return await fn(root)
  } finally {
    setWakeSection('')
    resetReplyDeliveryForTests()
    await rm(root, { recursive: true, force: true })
  }
}

test('她醒着：立刻开一轮递过去，盒子清空、写已递标记、不写 wake、不动作息', async () => {
  await withRoot(async (root) => {
    const now = Date.now()
    await writeSleep(root, awakeState(now))
    const sleepBefore = await readFile(sleepPath(root), 'utf8')
    await addReplies(root, [{ rpid: 2001, bvid: 'BV1', user: '路人', text: '这句说得对' }])
    const { ctx, prompts, emit } = fakeCtx()

    const r = await deliverAwakeReplyBatch(ctx, root, { config: cfg, now, sessionId: 's-test', log: () => {} })
    assert.equal(r.ok, true)
    assert.equal(r.pushed, 1)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].content[0].text, REPLY_TRIGGER)
    assert.match(prompts[0].requestId, /^nudge-reply-/)
    assert.match(getWakeSection(), /这句说得对/)
    assert.equal((await readReplyBox(root)).items.length, 0, '递出去就清空')

    const { readEvents } = await import('../lib/core/store.js')
    const { events } = await readEvents(root)
    assert.equal(seenReplies(events).has(2001), true, '递过就算看过')
    assert.equal(events.some((e) => String(e.text ?? '').startsWith('wake:')), false, '立投不算一次醒来')
    assert.equal(events.some((e) => String(e.text ?? '').startsWith(`cseen:${dateKey()} 2001`)), true)
    assert.equal(await readFile(sleepPath(root), 'utf8'), sleepBefore, '立投不写作息台账')

    emit('turn/end', 's-test')
    assert.equal(getWakeSection(), '', 'turn/end 之后处境要摘掉')
  })
})

test('她睡着：盒子原样留着，不开轮', async () => {
  await withRoot(async (root) => {
    const now = Date.now()
    await writeSleep(root, { mode: 'asleep', lastActivityAt: now, wakeDueAt: now + 3_600_000, looked: true })
    await addReplies(root, [{ rpid: 2002, bvid: 'BV1', user: '路人', text: '睡醒再看' }])
    const { ctx, prompts } = fakeCtx()
    const r = await deliverAwakeReplyBatch(ctx, root, { config: cfg, now, sessionId: 's-test', log: () => {} })
    assert.equal(r.ok, false)
    assert.equal(r.why, 'asleep')
    assert.equal(prompts.length, 0)
    assert.equal((await readReplyBox(root)).items.length, 1, '睡着的回复不能丢')
  })
})

test('她正在说一轮：不硬插，留到下一拍', async () => {
  await withRoot(async (root) => {
    const now = Date.now()
    await writeSleep(root, awakeState(now))
    await addReplies(root, [{ rpid: 2003, bvid: 'BV1', user: '路人', text: '等一下再递' }])
    const { ctx, prompts } = fakeCtx()
    const r = await deliverAwakeReplyBatch(ctx, root, { config: cfg, now, sessionId: 's-test', log: () => {}, isBusy: () => true })
    assert.equal(r.why, 'busy')
    assert.equal(prompts.length, 0)
    assert.equal((await readReplyBox(root)).items.length, 1)
  })
})

test('段首还没醒：让给段首唤醒，不在它前面插一轮', async () => {
  await withRoot(async (root) => {
    const now = Date.now()
    await writeSleep(root, { ...awakeState(now), looked: false })
    await addReplies(root, [{ rpid: 2004, bvid: 'BV1', user: '路人', text: '段首' }])
    const { ctx, prompts } = fakeCtx()
    const r = await deliverAwakeReplyBatch(ctx, root, { config: cfg, now, sessionId: 's-test', log: () => {} })
    assert.equal(r.why, 'segment-start')
    assert.equal(prompts.length, 0)
    assert.equal((await readReplyBox(root)).items.length, 1)
  })
})

test('一批 5 分钟内只立投一次；递失败放回盒子', async () => {
  await withRoot(async (root) => {
    const now = Date.now()
    await writeSleep(root, awakeState(now))
    await addReplies(root, [{ rpid: 2005, bvid: 'BV1', user: '路人', text: '第一批' }])
    const { ctx } = fakeCtx()
    const r1 = await deliverAwakeReplyBatch(ctx, root, { config: cfg, now, sessionId: 's-test', log: () => {} })
    assert.equal(r1.ok, true)

    await addReplies(root, [{ rpid: 2006, bvid: 'BV1', user: '路人', text: '马上又来一条' }])
    const r2 = await deliverAwakeReplyBatch(ctx, root, { config: cfg, now: now + 60_000, sessionId: 's-test', log: () => {} })
    assert.equal(r2.why, 'throttled')
    assert.equal((await readReplyBox(root)).items.length, 1, '节流期内留盒')
  })

  await withRoot(async (root) => {
    const now = Date.now()
    await writeSleep(root, awakeState(now))
    await addReplies(root, [{ rpid: 2007, bvid: 'BV1', user: '路人', text: '这次会失败' }])
    const ctx = {
      on: () => () => {},
      sessionController: {
        create: async () => {},
        prompt: async () => { throw new Error('宿主拒绝') },
      },
    }
    const r = await deliverAwakeReplyBatch(ctx, root, { config: cfg, now, sessionId: 's-test', log: () => {} })
    assert.equal(r.ok, false)
    const box = await readReplyBox(root)
    assert.equal(box.items.length, 1, '递不出去就放回盒子')
    assert.equal(box.items[0].rpid, 2007)
    const { readEvents } = await import('../lib/core/store.js')
    const { events } = await readEvents(root)
    assert.equal(seenReplies(events).has(2007), false, '没递出去不能标记已递')
  })
})

test('回复间隔：模块默认不延迟；配置 30 秒时落在 21–30 秒、且跨平台共用一份', async () => {
  resetPacingForTests()
  assert.equal(getPacing().maxReplyGapSec, 0, '没接配置时不要凭空等 30 秒')

  const t0 = Date.now()
  await waitReplyGap(() => t0)
  setPacing({ maxReplyGapSec: 30 })
  const gap = replyGapMs(t0)
  assert.ok(gap >= 21_000 && gap <= 30_000, `实际间隔 ${gap} 应落在 21–30 秒`)

  setPacing({ maxReplyGapSec: 0 })
  assert.equal(replyGapMs(t0), 0, '0 = 不限制')

  assert.equal(normalizeConfig({ bili: { maxReplyGapSec: 45 } }).bili.maxReplyGapSec, 45)
  assert.equal(normalizeConfig({ bili: { maxReplyGapSec: 9999 } }).bili.maxReplyGapSec, 3600)
  assert.equal(normalizeConfig({ bili: { maxReplyGapSec: -1 } }).bili.maxReplyGapSec, 0)
  resetPacingForTests()
})

test('waitReplyGap：两条回复之间真的会等，不是只算了个数', async () => {
  resetPacingForTests()
  try {
    // 0.05 秒 × 0.7~1.0 = 35~50ms；第一次写不等，第二次必须等。
    setPacing({ maxReplyGapSec: 0.05 })
    const t0 = Date.now()
    await waitReplyGap()
    await waitReplyGap()
    assert.ok(Date.now() - t0 >= 30, '第二条回复要等够间隔')
  } finally {
    resetPacingForTests()
  }
})

test('扫回复：三平台按作息窗口扫（睡着也扫），不再走 scanIfAwake', async () => {
  const src = await readFile(new URL('../lib/life/schedule/scheduler.js', import.meta.url), 'utf8')
  assert.match(src, /if \(!inActiveWindow\(config, new Date\(now\)\)\) return/)
  assert.match(src, /scanZhihuReplies\(\{ root \}\)/)
  assert.match(src, /scanTiebaReplies\(\{ root \}\)/)
  assert.equal(src.includes('scanZhihuIfAwake'), false)
  assert.equal(src.includes('scanTiebaIfAwake'), false)
})
