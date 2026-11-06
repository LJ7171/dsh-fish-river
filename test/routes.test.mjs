/**
 * routes.test.mjs —— 段首醒必须真的把“能出门的路”递给她（2026-11-06 回归）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startScheduler } from '../lib/scheduler.js'
import { normalizeConfig } from '../lib/settings.js'
import { writeConfig } from '../lib/store.js'
import { blankState, writeSleep } from '../lib/sleep.js'
import { getWakeSection, clearWakeSection } from '../lib/identity.js'

const pad = (n) => String((n + 24) % 24).padStart(2, '0')
const now = new Date()
const start = `${pad(now.getHours() - 1)}:00`
const end = `${pad(now.getHours() + 3)}:00`

test('段首醒：有配额就要递出门邀请，不能说“没什么特别要做的”', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-routes-'))
  const prompts = []
  try {
    const cfg = normalizeConfig({
      sleep: { active_start: start, active_end: end, daily: { bili: 2, douyin: 0, zhihu: 0, tieba: 0 } },
      browse: { enabled: true, perDay: 2 },
      comment: { enabled: false }, zhihu: { enabled: false }, tieba: { enabled: false },
      rules: { offers: false }, memory: { sleepEveryDays: 0 },
    })
    await writeConfig(cfg, root)
    await writeSleep(root, { ...blankState(cfg, Date.now()), mode: 'dice_awake', looked: false })
    const ctx = {
      on: () => () => {},
      sessionController: {
        create: async () => {},
        prompt: async (req) => { prompts.push(String(getWakeSection() ?? '')) },
      },
    }
    const s = startScheduler(ctx, { root, sessionId: 's-main', log: () => {}, rnd: () => 0 })
    try {
      await s.tick()
      assert.equal(prompts.length, 1)
      assert.match(prompts[0], /想出门逛逛吗/)
      assert.match(prompts[0], /B 站/)
      assert.doesNotMatch(prompts[0], /没什么特别要做的/)
    } finally { s.dispose() }
  } finally { clearWakeSection(); await rm(root, { recursive: true, force: true }) }
})
