/**
 * douyin-browse.test.mjs —— 刷抖音（2026-11-02，用户 m03490）
 *
 * 和 B 站一个地位：她自己去看，看到的东西进素材，她自己说什么才进事件流。
 * 这里只测主包这一侧：拉取、去重、渲染、记账、失败时不打扰她。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DY_PREFIX,
  douyinCountToday,
  douyinSeenIds,
  renderDouyin,
  recordDouyinBrowse,
  gatherDouyin,
  loadDouyin,
} from '../lib/douyinbrowse.js'
import { appendEvent, readEvents } from '../lib/store.js'

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'fish-dy-'))
}

const items = [
  { id: '111', title: '把西瓜切开的方法', author: '厨房小张', like: '1.2万', href: 'https://www.douyin.com/video/111' },
  { id: '222', title: '凌晨四点的菜市场', author: '街角', like: '860', href: 'https://www.douyin.com/video/222' },
]

test('renderDouyin：写成平台上有什么，不替她下结论', () => {
  const t = renderDouyin(items)
  assert.match(t, /抖音/)
  assert.match(t, /把西瓜切开的方法/)
  assert.match(t, /@厨房小张/)
  assert.match(t, /1\.2万 赞/)
  assert.doesNotMatch(t, /你应该|值得看/)
  assert.equal(renderDouyin([]), '')
})

test('记账：配额按天算，别的日期不算', async () => {
  const root = await tmpRoot()
  await recordDouyinBrowse(root, '2026-11-02', items, { day: 1, stage: 1 })
  const { events } = await readEvents(root)
  assert.equal(douyinCountToday(events, '2026-11-02'), 1)
  assert.equal(douyinCountToday(events, '2026-11-03'), 0)
  const seen = douyinSeenIds(events)
  assert.ok(seen.ids.has('111'))
  assert.ok(seen.ids.has('222'))
  await fs.rm(root, { recursive: true, force: true })
})

test('gatherDouyin：拉一批、拼素材、记账；第二天不再推同一条', async () => {
  const root = await tmpRoot()
  const feed = async () => ({ ok: true, items })
  const r = await gatherDouyin({ root, dk: '2026-11-02', model: { day: 1, stage: 1 }, cfg: {}, feed })
  assert.equal(r.ok, true)
  assert.equal(r.picks.length, 2)
  assert.match(r.text, /凌晨四点的菜市场/)

  const { events } = await readEvents(root)
  const again = await gatherDouyin({ root, dk: '2026-11-02', model: { day: 1, stage: 1 }, cfg: {}, feed, events })
  assert.equal(again.ok, false)
  assert.match(again.note, /都看过了/)
  await fs.rm(root, { recursive: true, force: true })
})

test('gatherDouyin：平台不给 / 拉取失败，都不打扰她', async () => {
  const root = await tmpRoot()
  const noItems = await gatherDouyin({ root, dk: '2026-11-02', model: {}, cfg: {}, feed: async () => ({ ok: true, items: [] }) })
  assert.equal(noItems.ok, false)
  const failed = await gatherDouyin({ root, dk: '2026-11-02', model: {}, cfg: {}, feed: async () => ({ ok: false, why: '没找到 Edge 或 Chrome' }) })
  assert.equal(failed.ok, false)
  assert.match(failed.note, /Edge/)
  const threw = await gatherDouyin({ root, dk: '2026-11-02', model: {}, cfg: {}, feed: async () => { throw new Error('boom') } })
  assert.equal(threw.ok, false)
  assert.match(threw.note, /boom/)
  await fs.rm(root, { recursive: true, force: true })
})

test('loadDouyin：没装子包就整条路消失，不抛', async () => {
  assert.equal(await loadDouyin(async () => { throw new Error('ERR_MODULE_NOT_FOUND') }), null)
  assert.equal(await loadDouyin(async () => ({ browseFeed: () => {} })).then((m) => typeof m.browseFeed), 'function')
})

test('记账分片：条目多的时候写多条 meta，前缀只有第一条是 dy-browse:', async () => {
  const root = await tmpRoot()
  const many = Array.from({ length: 12 }, (_, i) => ({ id: String(1000 + i), title: '标题'.repeat(20), author: 'a', like: '1', href: 'h' }))
  await recordDouyinBrowse(root, '2026-11-02', many, { day: 1, stage: 1 })
  const { events } = await readEvents(root)
  const lines = events.filter((e) => String(e.text ?? '').startsWith(DY_PREFIX))
  assert.ok(lines.length >= 1)
  assert.equal(douyinCountToday(events, '2026-11-02'), 1, '分片再多也只算刷了一次')
  await fs.rm(root, { recursive: true, force: true })
})
