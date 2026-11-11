import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerSpeak } from '../lib/platforms/speak.js'
import { updateConfig } from '../lib/core/settings.js'
import { appendEvent } from '../lib/core/store.js'

function grab(ctx) {
  let spec = null
  ctx.tools.register = (s) => { spec = s }
  return () => spec
}

test('评论区是社会层：没开闸时她说了也不算，而且听不到「权限」两个字', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-speak-gate-'))
  try {
    await updateConfig({ comment: { enabled: true } }, root)
    const ctx = { tools: {} }
    const get = grab(ctx)
    registerSpeak(ctx, { root, tenant: null })
    const tool = get()
    assert.ok(tool, '工具要注册上')
    const out = await tool.execute({ text: '你说得对' }, {})
    assert.equal(out.ok, false)
    assert.equal(out.said, '')
    assert.doesNotMatch(out.note, /权限/)
    assert.match(out.note, /还没到/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('开闸之后这条闸就不再拦她（走到真正的发帖那一步才失败，因为没登录）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-speak-gate2-'))
  try {
    await updateConfig({ comment: { enabled: true } }, root)
    await appendEvent({ type: 'meta', text: 'social-open:2026-11-02T00:00:00.000Z' }, { day: 1, stage: 4, source: 'system' }, root)
    const ctx = { tools: {} }
    const get = grab(ctx)
    registerSpeak(ctx, { root, tenant: null })
    const out = await get().execute({ text: '你说得对' }, {})
    assert.equal(out.ok, false)
    assert.doesNotMatch(out.note, /还没到/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
