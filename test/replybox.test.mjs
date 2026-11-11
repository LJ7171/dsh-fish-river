/**
 * replybox —— 回复先攒着，等她醒来再递（2026-11-06 A 案）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addReplies, takeReplies, readReplyBox, replyBoxPath } from '../lib/life/replybox.js'

test('回复进盒：按 rpid 去重，取走后清空，0600', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-reply-'))
  try {
    const a = await addReplies(root, [
      { rpid: 1, text: '一', user: '甲' },
      { rpid: 2, text: '二', user: '乙' },
    ], { scannedAt: '2026-11-06T10:00:00Z' })
    assert.equal(a.added, 2)
    const b = await addReplies(root, [
      { rpid: 2, text: '二', user: '乙' },
      { rpid: 3, text: '三', user: '丙' },
    ])
    assert.equal(b.added, 1, '重复 rpid 不再进盒')
    assert.equal((await readReplyBox(root)).items.length, 3)
    const mode = (await stat(replyBoxPath(root))).mode & 0o777
    assert.equal(mode, 0o600)
    const taken = await takeReplies(root)
    assert.equal(taken.length, 3)
    assert.equal((await readReplyBox(root)).items.length, 0, '递完就清空')
    assert.deepEqual(await takeReplies(root), [], '空盒再取还是空')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('盒子最多留 20 条：新的挤掉最旧的', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-reply-cap-'))
  try {
    for (let i = 1; i <= 25; i += 1) await addReplies(root, [{ rpid: i, text: String(i) }])
    const box = await readReplyBox(root)
    assert.equal(box.items.length, 20)
    assert.equal(box.items[0].rpid, 6)
    assert.equal(box.items[19].rpid, 25)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
