/**
 * sleep.test.mjs —— 作息状态机
 *
 * 窗外微信只回话；窗内静默满 10 分钟才可掷骰；睡满若落在窗外就等到 7:00；
 * 每路 d=2 之后停；各路计数分开；睡眠时扫回复 no-op；关掉则旧时段照旧。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../lib/core/settings.js'
import { writeConfig } from '../lib/core/store.js'
import { startScheduler } from '../lib/life/scheduler.js'
import { postComment, scanIfAwake } from '../lib/platforms/comment.js'
import {
  advance, armRoll, blankState, diceOpen, dueRolls, markAct, markBlocked, rollSegment,
  inActiveWindow, nextActiveStart, noteWeixin, readDailySpent, readSleep, sleepEnabled, writeSleep,
} from '../lib/life/sleep.js'
import { appendEvent } from '../lib/core/store.js'
import { dateKey } from '../lib/core/settings.js'
import { writeState as writeZhihuState } from '../lib/platforms/zhihu.js'

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
const cfg = normalizeConfig({
  sleep: {
    enabled: true,
    active_start: '07:00',
    active_end: '23:00',
    idle_to_sleep_min: 90,
    nap_min_h: 3,
    nap_max_h: 5,
    browse_interval_min_m: 30,
    browse_interval_max_m: 30,
    browse_max_per_wake: 2,
    weixin_session_idle_min: 10,
  },
  browse: { enabled: true, perDay: 2, douyin: { enabled: true, perDay: 1 } },
  zhihu: { enabled: true },
  comment: { enabled: true, window: ['00:00', '23:59'] },
})

function asleepAt(t) {
  return {
    mode: 'asleep',
    since: t,
    lastActivityAt: t,
    weixinSilentSince: 0,
    sessionSince: 0,
    sleptAt: 0,
    napHours: 0,
    wakeDueAt: t + 6 * 3_600_000,
    wokeInside: false,
    looked: true,
    segmentId: 0,
    acts: { bili: 0, douyin: 0, zhihu: 0, reply: 0 },
    blocked: { bili: 0, douyin: 0, zhihu: 0, reply: 0 },
    nextRollAt: { bili: 0, douyin: 0, zhihu: 0, reply: 0 },
  }
}

test('默认开着作息，时刻和间隔夹在界限里', () => {
  const c = normalizeConfig({})
  assert.equal('enabled' in c.sleep, false, '作息固定生效，没有开关')
  assert.equal(c.sleep.active_start, '07:00')
  assert.equal(c.sleep.active_end, '23:00')
  assert.equal(c.sleep.idle_to_sleep_min, 90)
  assert.equal(c.sleep.nap_min_h, 3)
  assert.equal(c.sleep.nap_max_h, 5)
  assert.equal(c.sleep.browse_max_per_wake, 2)
  assert.equal(c.sleep.weixin_session_idle_min, 10)
  assert.equal(c.memory.sleepEveryDays, 7, '回头想仍在 memory，不跟作息混名')
  const tight = normalizeConfig({
    sleep: { nap_min_h: 6, nap_max_h: 2, browse_interval_min_m: 40, browse_interval_max_m: 10, active_start: '99:00' },
  })
  assert.equal(tight.sleep.nap_min_h, 6)
  assert.equal(tight.sleep.nap_max_h, 6)
  assert.equal(tight.sleep.browse_interval_max_m, 40)
  assert.equal(tight.sleep.active_start, '07:00')
  assert.equal(inActiveWindow(c, new Date(2026, 10, 5, 7, 0)), true)
  assert.equal(inActiveWindow(c, new Date(2026, 10, 5, 22, 59)), true)
  assert.equal(inActiveWindow(c, new Date(2026, 10, 5, 23, 0)), false)
  assert.equal(inActiveWindow(c, new Date(2026, 10, 5, 3, 0)), false)
})

test('每天配额：上网四项迁到 sleep.daily，评论两项留在 comment', () => {
  const migrated = normalizeConfig({ browse: { perDay: 3, douyin: { perDay: 2 } }, zhihu: { perDay: 6, recommend: { perDay: 9 } }, comment: { perDay: 4, replyPerDay: 5 } })
  assert.deepEqual(migrated.sleep.daily, { bili: 3, douyin: 2, zhihu: 6, tieba: 2 })
  assert.equal(migrated.comment.perDay, 4, '评论配额仍在 comment')
  assert.equal(migrated.comment.replyPerDay, 5)
  const explicit = normalizeConfig({ sleep: { daily: { bili: 1 } }, browse: { perDay: 3 } })
  assert.equal(explicit.sleep.daily.bili, 1, '新配置优先')
  assert.equal(explicit.sleep.daily.zhihu, 4, '缺的项回默认')
  // 旧 sleep.daily.comment/reply 只做一次迁移
  const legacy = normalizeConfig({ sleep: { daily: { comment: 3, reply: 4 } } })
  assert.equal(legacy.comment.perDay, 3)
  assert.equal(legacy.comment.replyPerDay, 4)
})

test('窗外微信只开会话苏醒，静默够了再睡，不掷骰', () => {
  const t = at(2026, 11, 5, 3, 0)
  const first = advance(asleepAt(t), cfg, t, { weixin: true })
  assert.equal(first.state.mode, 'session_awake')
  assert.equal(first.enteredDice, false)
  const mid = advance(first.state, cfg, t + 9 * 60_000)
  assert.equal(mid.state.mode, 'session_awake')
  assert.equal(mid.reason, 'session-outside')
  const done = advance(first.state, cfg, t + 10 * 60_000)
  assert.equal(done.state.mode, 'asleep')
  assert.equal(done.reason, 'session-done-outside')
  assert.equal(done.enteredDice, false)
  assert.deepEqual(dueRolls(done.state, cfg, t + 10 * 60_000), [])
})

test('窗内微信静默满 10 分钟才升级成可掷骰，中途又来消息就清零', () => {
  const t = at(2026, 11, 5, 10, 0)
  const woke = advance(asleepAt(t + 5 * 3_600_000), cfg, t, { weixin: true })
  assert.equal(woke.state.mode, 'session_awake')
  const early = advance(woke.state, cfg, t + 9 * 60_000)
  assert.equal(early.state.mode, 'session_awake', '差一分钟还不能逛')
  assert.deepEqual(dueRolls(early.state, cfg, t + 9 * 60_000), [])
  const again = advance(early.state, cfg, t + 9 * 60_000, { weixin: true })
  assert.equal(again.state.mode, 'session_awake')
  const still = advance(again.state, cfg, t + 18 * 60_000)
  assert.equal(still.state.mode, 'session_awake', '第二句把静默计时清掉了')
  const up = advance(again.state, cfg, t + 9 * 60_000 + 10 * 60_000)
  assert.equal(up.reason, 'session-upgrade')
  assert.equal(up.state.mode, 'dice_awake')
  assert.equal(up.state.looked, false)
})

test('睡满落在窗外就等到 7:00 再醒', () => {
  const t = at(2026, 11, 5, 22, 0)
  const dice = {
    ...asleepAt(t),
    mode: 'dice_awake',
    wokeInside: true,
    looked: true,
    lastActivityAt: t - 90 * 60_000,
    since: t - 2 * 3_600_000,
  }
  const slept = advance(dice, cfg, t, { rng: () => 1 })
  assert.equal(slept.reason, 'idle')
  assert.equal(slept.state.mode, 'asleep')
  assert.equal(slept.state.napHours, 5)
  const due = new Date(slept.state.wakeDueAt)
  assert.equal(due.getHours(), 7)
  assert.equal(due.getMinutes(), 0)
  assert.equal(due.getDate(), 6, '22:00 再睡 5 小时落在次日凌晨，醒在次日 7:00')
  const before = advance(slept.state, cfg, at(2026, 11, 6, 6, 59))
  assert.equal(before.state.mode, 'asleep')
  const morning = advance(slept.state, cfg, at(2026, 11, 6, 7, 0))
  assert.equal(morning.reason, 'nap-done')
  assert.equal(morning.state.mode, 'dice_awake')
  assert.equal(nextActiveStart(cfg, new Date(at(2026, 11, 6, 3, 0))), at(2026, 11, 6, 7, 0))
})

test('23:00 还醒着就结束掷骰并入睡', () => {
  const t = at(2026, 11, 5, 22, 50)
  const dice = {
    ...asleepAt(t),
    mode: 'dice_awake',
    wokeInside: true,
    looked: true,
    lastActivityAt: t,
    since: at(2026, 11, 5, 20, 0),
  }
  const end = advance(dice, cfg, at(2026, 11, 5, 23, 0))
  assert.equal(end.reason, 'window-end')
  assert.equal(end.state.mode, 'asleep')
  assert.deepEqual(dueRolls(end.state, cfg, at(2026, 11, 5, 23, 0)), [])
})

test('每路「真的上网」2 次后停掷；渠道互不占用', () => {
  const t = at(2026, 11, 5, 12, 0)
  let s = {
    ...blankState(cfg, t),
    mode: 'dice_awake',
    looked: false,
    wokeInside: true,
  }
  // 段首掷骰：只是允许去，不算一次上网
  const rolled = rollSegment(s, cfg, t, () => 0)
  s = rolled.state
  assert.deepEqual(s.acts, { bili: 0, douyin: 0, zhihu: 0, tieba: 0 }, '段首不再预扣')
  assert.equal(s.looked, true)
  assert.deepEqual(rolled.hits.sort(), ['bili', 'douyin', 'zhihu'])
  assert.deepEqual(dueRolls(s, cfg, t + 29 * 60_000), [])
  const due = dueRolls(s, cfg, t + 30 * 60_000)
  assert.ok(due.includes('bili') && due.includes('zhihu') && due.includes('douyin'))

  // 真的刷了两次 B 站 → 停；知乎不受影响
  s = markAct(s, 'bili', t + 30 * 60_000)
  s = markAct(s, 'bili', t + 31 * 60_000)
  assert.equal(s.acts.bili, 2)
  assert.equal(s.acts.zhihu, 0)
  const later = dueRolls(s, cfg, t + 60 * 60_000)
  assert.equal(later.includes('bili'), false)
  assert.equal(later.includes('zhihu'), true)

  // 被挡的那一路：本段不再掷，但不算次数
  s = markBlocked(s, 'zhihu')
  assert.equal(s.acts.zhihu, 0)
  assert.equal(dueRolls({ ...s, nextRollAt: { ...s.nextRollAt, zhihu: 0 } }, cfg, t + 60 * 60_000).includes('zhihu'), false)

  // 全部满 2 → 没有可掷的
  const full = { ...s, acts: { bili: 2, douyin: 2, zhihu: 2, reply: 2 } }
  assert.deepEqual(dueRolls(full, cfg, t + 120 * 60_000), [])
})

test('睡满醒来不会下一分钟又睡（lastActivityAt 跟着醒来走）', () => {
  const t0 = at(2026, 11, 5, 7, 1)
  const s = {
    ...asleepAt(t0),
    lastActivityAt: at(2026, 11, 5, 5, 0),
    wakeDueAt: t0 - 1000,
  }
  const woke = advance(s, cfg, t0, { rng: () => 0.5 })
  assert.equal(woke.reason, 'nap-done')
  assert.equal(woke.state.mode, 'dice_awake')
  assert.equal(woke.state.lastActivityAt, t0, '醒来这一刻就是最近活动，不该沿用睡前的')
  const next = advance(woke.state, cfg, t0 + 60_000, { rng: () => 0.5 })
  assert.equal(next.state.mode, 'dice_awake', '下一分钟不该被判定为 90 分钟没动')
})

test('窗外不掷骰：手动叫醒在 23:30，00:05 也不该冒出一路', () => {
  const t = at(2026, 11, 5, 23, 30)
  let s = advance(asleepAt(t), cfg, t, { manual: true, rng: () => 0 }).state
  assert.equal(s.mode, 'dice_awake')
  assert.equal(s.wokeInside, false)
  s = rollSegment(s, cfg, t, () => 0).state
  const later = at(2026, 11, 6, 0, 5)
  assert.deepEqual(dueRolls(s, cfg, later), [])
})

test('睡眠时扫回复和发评论都 no-op；可掷骰才放行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-sleep-scan-'))
  try {
    await writeConfig(cfg, root)
    const asleep = asleepAt(Date.now())
    await writeSleep(root, asleep)
    let calls = 0
    const client = { view() { calls += 1; return { ok: true, data: { aid: 1 } } }, subReplies() { calls += 1; return { ok: true, data: [] } }, replyAdd() { calls += 1; return { ok: true, data: { rpid: 1 } } } }
    const scan = await scanIfAwake({ root, config: cfg, client, events: [], sleepState: asleep })
    assert.equal(scan.ok, false)
    assert.equal(scan.why, 'asleep')
    assert.equal(calls, 0)
    const said = await postComment({ root, client, bvid: 'BV1', text: '醒着才说', dateKey: '2026-11-05' })
    assert.equal(said.ok, false)
    assert.match(said.why, /在睡/)
    assert.equal(calls, 0)
    const dice = { ...asleep, mode: 'dice_awake', looked: true }
    const open = await scanIfAwake({ root, config: cfg, client, events: [], sleepState: dice })
    assert.equal(open.ok, true)
    assert.equal(open.why, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('作息固定生效：没有开关；台账还没建立前不接管', () => {
  assert.equal(sleepEnabled({}), true, '固定 true')
  const st = blankState(cfg, at(2026, 11, 5, 10, 0))
  assert.equal(diceOpen(cfg, st).governed, true)
  assert.equal(diceOpen(cfg, null).governed, false, '还没有台账时按老时段走，避免第一次启动被掐')
  assert.equal(normalizeConfig({ sleep: { enabled: false } }).sleep.enabled, undefined)
})

test('活跃窗外调度器不主动叫醒', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-sleep-tick-'))
  const prompts = []
  const ctx = {
    on: () => () => {},
    sessionController: {
      create: async () => {},
      prompt: async (req) => { prompts.push(req) },
    },
  }
  try {
    const now = new Date()
    const h = (now.getHours() + 3) % 24
    const start = `${String(h).padStart(2, '0')}:00`
    const end = `${String((h + 1) % 24).padStart(2, '0')}:10`
    await writeConfig(normalizeConfig({
      sleep: { enabled: true, active_start: start, active_end: end },
      browse: { enabled: false },
      comment: { enabled: false },
      rules: { offers: false },
      memory: { sleepEveryDays: 0 },
    }), root)
    const s = startScheduler(ctx, { root, sessionId: 's-main', log: () => {} })
    try {
      await s.tick()
      assert.equal(prompts.length, 0)
      const st = await readSleep(root)
      assert.equal(st.mode, 'asleep')
      const raw = await readFile(join(root, 'sleep-state.json'))
      assert.ok(raw.length > 10)
    } finally {
      s.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('每天已用：B 站/抖音数事件流，知乎数当天 runs，分片和隔天不算', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-spent-'))
  const dk = dateKey()
  const head = { day: 1, stage: 1, source: 'system' }
  try {
    await appendEvent({ type: 'meta', text: `browse:${dk} []` }, head, root)
    await appendEvent({ type: 'meta', text: `browse-more:${dk} []` }, head, root)
    await appendEvent({ type: 'meta', text: `dy-browse:${dk} []` }, head, root)
    await appendEvent({ type: 'meta', text: `dy-browse:${dk} [{"id":"a"}]` }, head, root)
    await appendEvent({ type: 'meta', text: 'browse:2000-01-01 []' }, head, root)
    await writeZhihuState(root, { dateKey: dk, runs: 3, seen: {} })
    assert.deepEqual(await readDailySpent(root, dk), { bili: 1, douyin: 2, zhihu: 3, tieba: 0 })
    await writeZhihuState(root, { dateKey: '2000-01-01', runs: 9, seen: {} })
    assert.equal((await readDailySpent(root, dk)).zhihu, 0, '隔天的知乎次数不算今天')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('作息页每天配额旁边写出当天已用', async () => {
  const cl = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(cl, /已用 \$\{n\} \/ 配额 \$\{capText\}/)
  assert.match(cl, /extra: usedLine\(quotaUsed, 'bili', qBili\)/)
  assert.match(cl, /extra: usedLine\(quotaUsed, 'douyin', qDouyin\)/)
  assert.match(cl, /extra: usedLine\(quotaUsed, 'zhihu', qZhihu\)/)
  assert.match(cl, /extra: usedLine\(quotaUsed, 'tieba', qTieba\)/)
  const obs = await readFile(new URL('../lib/ui/observe.js', import.meta.url), 'utf8')
  assert.match(obs, /dailyUsed = await readDailySpent\(root\)/)
})

test('全局出门：开着的平台共用一个 nextRollAt，不再各自计时', () => {
  const cfg = normalizeConfig({ browse: { enabled: true }, zhihu: { enabled: true }, tieba: { enabled: true } })
  const t = at(2026, 11, 7, 9, 0)
  const s = rollSegment(blankState(cfg, t), cfg, t, () => 0.5).state
  const times = ['bili', 'zhihu', 'tieba'].map((ch) => s.nextRollAt[ch])
  assert.equal(new Set(times).size, 1, '三路必须同一时间')
  assert.ok(times[0] > t)
  assert.equal(dueRolls(s, cfg, times[0] - 1).length, 0)
  const due = dueRolls(s, cfg, times[0])
  assert.deepEqual(due.sort(), ['bili', 'tieba', 'zhihu'])
})

test('writeSleep：旧快照不会把刚被消息叫醒的状态盖回 asleep', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-sleep-race-'))
  const t0 = at(2026, 11, 8, 12)
  try {
    await writeConfig(cfg, root)
    const stale = { ...blankState(cfg, t0), mode: 'asleep', lastActivityAt: t0, wakeDueAt: t0 + 3_600_000 }
    await writeSleep(root, stale)
    await noteWeixin(root, t0 + 1000)
    const mid = await readSleep(root)
    assert.equal(mid.mode, 'session_awake')
    await writeSleep(root, stale)
    const after = await readSleep(root)
    assert.equal(after.lastActivityAt, t0 + 1000, '更晚的活动时间不能被旧快照回退')
    assert.notEqual(after.mode, 'asleep', '期间刚醒过，旧快照不能让她睡回去')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
