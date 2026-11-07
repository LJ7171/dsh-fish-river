/**
 * lookmeta.test.mjs —— 知乎/贴吧“刷了什么”的轻量记录（2026-11-07）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { zhihuLookMeta, tiebaLookMeta, MAX_ITEMS, MAX_TITLE } from '../lib/lookmeta.js'

test('知乎：只记标题，去换行、截断、最多 8 条', () => {
  const picks = Array.from({ length: 10 }, (_, i) => ({ title: `标题${i}\n第二行` }))
  const text = zhihuLookMeta('2026-11-07', picks)
  assert.match(text, /^zhihu:2026-11-07 \[/)
  const rows = JSON.parse(text.slice('zhihu:2026-11-07 '.length))
  assert.equal(rows.length, MAX_ITEMS)
  assert.equal(rows[0].title, '标题0 第二行')
  assert.ok(rows[0].title.length <= MAX_TITLE)
  assert.equal(JSON.stringify(rows).includes('正文'), false)
})

test('贴吧：吧名-标题，不记 id', () => {
  const text = tiebaLookMeta('2026-11-07', [
    { id: '123', forum: 'meme吧', title: '我有好多meme无人分享' },
    { id: '456', title: '没有吧名' },
  ])
  const rows = JSON.parse(text.slice('tieba:2026-11-07 '.length))
  assert.deepEqual(rows, [
    { forum: 'meme吧', title: '我有好多meme无人分享' },
    { title: '没有吧名' },
  ])
  assert.equal(JSON.stringify(rows).includes('123'), false)
})
