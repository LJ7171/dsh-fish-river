/**
 * maintenance.test.mjs —— 换档/恢复期间 store 写入口必须被冻结。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beginMaintenance, endMaintenance, resetMaintenanceForTests } from '../lib/maintenance.js'
import { appendEvent, writeAtomic, readEvents } from '../lib/store.js'

test('维护中 writeAtomic / appendEvent 被拒，结束后恢复', async () => {
  resetMaintenanceForTests()
  const root = await mkdtemp(join(tmpdir(), 'fish-maint-'))
  try {
    beginMaintenance()
    try {
      await assert.rejects(writeAtomic(join(root, 'x.json'), '{}'), /换档|维护/)
      await assert.rejects(
        appendEvent({ type: 'meta', text: 'x' }, { day: 1, stage: 1, source: 'system' }, root),
        /换档|维护/,
      )
      assert.equal((await readEvents(root)).events.length, 0)
    } finally {
      endMaintenance()
    }
    await writeAtomic(join(root, 'x.json'), '{"ok":true}')
    assert.equal(JSON.parse(await readFile(join(root, 'x.json'), 'utf8')).ok, true)
    await appendEvent({ type: 'meta', text: 'after' }, { day: 1, stage: 1, source: 'system' }, root)
    assert.equal((await readEvents(root)).events.length, 1)
  } finally {
    resetMaintenanceForTests()
    await rm(root, { recursive: true, force: true })
  }
})
