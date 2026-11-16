/**
 * owner-label.test.mjs —— 两个槽各自的“这个号是谁的”（2026-11-16）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderMaterial } from '../packages/dsh-fish-river-zhihu/material.js'
import { saveCookie } from '../packages/dsh-fish-river-zhihu/auth.js'
import { zhihuSpeakOnce } from '../lib/platforms/zhihu/speak.js'
import { normalizeConfig } from '../lib/core/settings.js'
import { ownerLine } from '../lib/core/ownerLabel.js'
import { netSpeakBrief } from '../lib/mind/persona.js'

test('知乎历史记录按当前槽的 owner 写，不一律写成重要的人', () => {
  const items = [{ kind: 'history', title: '一条记录' }]
  const her = renderMaterial(items, { accountOwner: 'her', zhihu: { owner: 'owner' } }, { ownerLine })
  const owner = renderMaterial(items, { accountOwner: 'owner', zhihu: { owner: 'her' } }, { ownerLine })
  assert.match(her, /你最近看过的/)
  assert.doesNotMatch(her, /重要的人最近看过/)
  assert.match(owner, /重要的人最近看过的/)
})

test('知乎说话回执用所选槽的 owner，不读全局 owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-owner-'))
  try {
    await saveCookie(root, { cookie: 'z_c0=owner-label', account: { id: 'za', name: '甲' }, slot: 'a', owner: 'her' })
    const r = await zhihuSpeakOnce({
      root,
      account: 'a',
      text: '',
      config: normalizeConfig({ zhihu: { owner: 'owner' } }),
    })
    assert.match(r.note, /她自己的知乎号/)
    assert.doesNotMatch(r.note, /重要的人的知乎号/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('两个登录位置在身份文档里各写各的，不把两个都说成重要的人的号', () => {
  const text = netSpeakBrief({
    zhihuComment: true,
    zhihuAccounts: [{ id: 'a', owner: 'her' }, { id: 'b', owner: 'owner' }],
    tieba: true,
    tiebaAccounts: [{ id: 'a', owner: 'owner' }, { id: 'b', owner: 'her' }],
  })
  assert.match(text, /位置 a 是你自己的号/)
  assert.match(text, /位置 b 是重要的人的号/)
})

test('zhihu_look 列表按当前槽 owner 写，不读全局 owner', async () => {
  const { zhihuLookOnce } = await import('../packages/dsh-fish-river-zhihu/look.js')
  const r = await zhihuLookOnce({
    root: '/tmp/whatever',
    cfg: { zhihu: { enabled: true, hot: { enabled: true }, follow: { enabled: false }, history: { enabled: true }, recommend: { enabled: false } } },
    kind: 'history',
    account: 'a',
    host: { ownerLine },
    mod: {
      async readAuth() { return { cookie: 'x', id: 'a', owner: 'her', account: { name: '甲' } } },
      async fetchHistory() { return { items: [{ id: '1', title: '一条记录' }] } },
    },
  })
  assert.equal(r.ok, true)
  assert.match(r.text, /她自己的知乎号/)
  assert.match(r.text, /你最近看过的/)
  assert.doesNotMatch(r.text, /重要的人最近看过的/)
})
