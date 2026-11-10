/**
 * 读评论暂停（2026-11-06 用户定）
 *
 * 所有平台的「读评论」设置都先撤掉，功能之后统一挪到社会层。
 * 数据（已经产生的 voice 事件）不动；这里只断言：不再抓评论、不再写新 voice。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../lib/settings.js'
import { fetchZhihuMaterial } from '../lib/zhihu.js'
import { zhihuLookOnce } from '../lib/zhihuLook.js'

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'fish-zh-voice-'))
}

test('配置里不再有 voices；旧的 true 被忽略，评论占位字段在', () => {
  const cfg = normalizeConfig({ zhihu: { enabled: true, voices: true } })
  assert.equal(cfg.zhihu.voices, undefined)
  assert.equal(cfg.zhihu.owner, 'owner', '默认用重要的人的号看')
  assert.deepEqual(cfg.zhihu.comment, { enabled: false, perDay: 1, replyPerDay: 1 })
})

test('刷知乎不再拉评论区：即使旧配置写着 voices:true', async () => {
  const root = await tempRoot()
  try {
    let commentCalls = 0
    const mod = {
      async readAuth() { return { cookie: 'z_c0=x' } },
      async fetchHot() { return { ok: true, items: [{ id: 'hot:1', title: '热榜标题', url: 'https://www.zhihu.com/question/42' }] } },
      async fetchFollow() { return { ok: true, items: [] } },
      async fetchHistory() { return { ok: true, items: [] } },
      async fetchRecommend() { return { ok: true, items: [] } },
      async fetchComments() { commentCalls += 1; return { ok: true, comments: [{ text: '别人的评论', likes: 99 }] } },
    }
    const cfg = normalizeConfig({ zhihu: { enabled: true, voices: true } })
    const r = await fetchZhihuMaterial({ root, cfg, mod, now: new Date('2026-11-06T10:00:00'), fetchImpl: async () => ({ ok: true }) })
    assert.equal(r.ok, true)
    assert.equal(commentCalls, 0, '不再抓评论')
    const { readFile } = await import('node:fs/promises')
    await assert.rejects(readFile(join(root, 'events.jsonl'), 'utf8'), '不写 voice 事件')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('她自己点开评论仍然能看，但不再自动收成 voice', async () => {
  const root = await tempRoot()
  try {
    const mod = {
      async readAuth() { return { cookie: 'z_c0=x' } },
      async fetchComments() {
        return { ok: true, total: 1, comments: [{ author: '甲', text: '这条评论挺长的一句话', likes: 80 }] }
      },
    }
    const cfg = normalizeConfig({ zhihu: { enabled: true, voices: true } })
    const r = await zhihuLookOnce({ root, cfg, kind: 'comments', id: 'https://www.zhihu.com/answer/2', mod })
    assert.equal(r.ok, true)
    assert.match(r.text, /这条评论挺长的一句话/)
    const { readFile } = await import('node:fs/promises')
    const lines = (await readFile(join(root, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(lines.some((e) => e.type === 'voice'), false, '显式点开也不写 voice')
    assert.ok(lines.some((e) => String(e.text ?? '').startsWith('zhihu-open:')), '看评论页记的是点开')
    assert.equal(lines.some((e) => String(e.text ?? '').startsWith('zhihu-comment:')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
