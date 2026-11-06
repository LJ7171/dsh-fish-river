/**
 * session-fix.test.mjs —— 会话轮换 / 手动叫醒不重复段首（2026-11-06）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startScheduler } from '../lib/scheduler.js'
import { normalizeConfig } from '../lib/settings.js'
import { writeConfig } from '../lib/store.js'
import { blankState, markManual, readSleep, writeSleep } from '../lib/sleep.js'

const pad = (n) => String((n + 24) % 24).padStart(2, '0')
const now = new Date()
const start = `${pad(now.getHours() - 1)}:00`
const end = `${pad(now.getHours() + 3)}:00`

function fakeCtx(sink) {
  return {
    on: () => () => {},
    sessionController: {
      create: async () => {},
      prompt: async (req) => { sink.push(req.sessionId) },
    },
  }
}

test('home.json 轮换后，下一次唤醒用新会话，不用启动时那个', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-session-'))
  const prompts = []
  try {
    const cfg = normalizeConfig({
      sleep: { active_start: start, active_end: end },
      browse: { enabled: false }, comment: { enabled: false }, zhihu: { enabled: false }, tieba: { enabled: false },
      rules: { offers: false }, memory: { sleepEveryDays: 0 },
    })
    await writeConfig(cfg, root)
    const st = { ...blankState(cfg, Date.now()), mode: 'dice_awake', looked: false }
    await writeSleep(root, st)
    await writeFile(join(root, 'home.json'), JSON.stringify({ sessionId: 'session-new' }))
    const s = startScheduler(fakeCtx(prompts), { root, sessionId: 'session-old', log: () => {}, rnd: () => 0 })
    try {
      await s.tick()
      assert.equal(prompts.length, 1)
      assert.equal(prompts[0], 'session-new', '必须用当前的 home.json，不是启动时的会话')
    } finally { s.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('手动叫醒后 looked=true：下一分钟 tick 不再补一次段首', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-manual-look-'))
  const prompts = []
  try {
    const cfg = normalizeConfig({
      sleep: { active_start: start, active_end: end },
      browse: { enabled: false }, comment: { enabled: false }, zhihu: { enabled: false }, tieba: { enabled: false },
      rules: { offers: false }, memory: { sleepEveryDays: 0 },
    })
    await writeConfig(cfg, root)
    await writeSleep(root, { ...blankState(cfg, Date.now()), mode: 'dice_awake', looked: false })
    await markManual(root, Date.now())
    const st = await readSleep(root)
    assert.equal(st.mode, 'dice_awake')
    assert.equal(st.looked, true, '手动叫醒已经醒过一次')
    const s = startScheduler(fakeCtx(prompts), { root, sessionId: 's-main', log: () => {}, rnd: () => 0 })
    try {
      await s.tick()
      assert.equal(prompts.length, 0, '不该再发一次段首醒来')
    } finally { s.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
