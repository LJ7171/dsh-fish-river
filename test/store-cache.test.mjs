/**
 * store-cache.test.mjs —— 事件流缓存只做快照，不能变成第二份真相。
 *
 * 2026-11-08：readEvents 按 stat 缓存全量解析结果。这里守三条：
 * 返回数组是浅拷贝（调用方 push 不污染缓存）；appendEvent 之后立即可见；
 * 外部进程改写（stat 变了）下一次读必须重读。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, appendFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, paths, readEvents } from '../lib/store.js'

const ctx = { day: 1, stage: 1, source: 'system' }

test('readEvents 缓存：appendEvent 之后立即可见，返回数组可安全修改', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-cache-'))
  try {
    await appendEvent({ type: 'meta', text: 'a' }, ctx, root)
    const first = await readEvents(root)
    assert.equal(first.events.length, 1)
    first.events.push({ id: 'fake' })
    const second = await readEvents(root)
    assert.equal(second.events.length, 1, '调用方改返回数组不能污染缓存')
    await appendEvent({ type: 'meta', text: 'b' }, ctx, root)
    const third = await readEvents(root)
    assert.equal(third.events.length, 2, 'appendEvent 要同步推进缓存')
    assert.equal(third.events[1].text, 'b')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readEvents 缓存：外部追加/删文件会让 stat 失效并重读', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-cache2-'))
  try {
    await appendEvent({ type: 'meta', text: 'one' }, ctx, root)
    assert.equal((await readEvents(root)).events.length, 1)
    const line = JSON.stringify({ id: 'ev_external_1', type: 'meta', text: 'external' }) + '\n'
    await appendFile(paths(root).events, line, 'utf8')
    const after = await readEvents(root)
    assert.equal(after.events.length, 2, '外部追加必须被看见')
    assert.equal(after.events[1].text, 'external')
    await unlink(paths(root).events)
    assert.equal((await readEvents(root)).events.length, 0, '文件没了就是空，不是旧缓存')
    await appendEvent({ type: 'meta', text: 'again' }, ctx, root)
    assert.equal((await readEvents(root)).events.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readEvents 缓存：两个家互不串', async () => {
  const a = await mkdtemp(join(tmpdir(), 'fish-cache-a-'))
  const b = await mkdtemp(join(tmpdir(), 'fish-cache-b-'))
  try {
    await appendEvent({ type: 'meta', text: 'A' }, ctx, a)
    await appendEvent({ type: 'meta', text: 'B1' }, ctx, b)
    await appendEvent({ type: 'meta', text: 'B2' }, ctx, b)
    assert.equal((await readEvents(a)).events.length, 1)
    assert.equal((await readEvents(b)).events.length, 2)
    assert.equal((await readEvents(a)).events[0].text, 'A')
  } finally {
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
  }
})
