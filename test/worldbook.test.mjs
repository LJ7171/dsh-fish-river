/**
 * worldbook.test.mjs —— 「她知道的事」这一层
 *
 * 要守住的是一句话：**事实可以给，人格不能给。**
 * 所以这里测的几乎全是边界：不建文件、不进事件流、不超上限、认不出的条目丢掉。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  createWorldbook,
  importLorebook,
  matchEntries,
  knowledgeBlock,
  WORLDBOOK_FILE,
  MATCH_MAX,
} from '../lib/worldbook.js'
import { buildPrompt } from '../lib/channels/router.js'
import { renderSelfDoc, writeSelfDoc, KNOWLEDGE_SHOWN } from '../lib/selfdoc.js'
import { deriveSelf } from '../lib/derive.js'

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'fish-wb-'))
}

const lorebook = {
  entries: {
    0: { key: ['临江', '临江市'], content: '临江是座沿江的小城，冬天很冷。', disable: false },
    1: { key: ['公司'], content: '她在一家做地图的小公司上班，三楼。' },
    2: { key: [], content: '没有关键词，应该被丢掉。' },
    3: { key: ['猫'], content: '' , disable: false },
  },
}

test('导入：认 SillyTavern 的 entries 对象，也认数组；没关键词/没正文的丢掉并报数', () => {
  const a = importLorebook(lorebook)
  assert.equal(a.ok, true)
  assert.equal(a.entries.length, 2)
  assert.equal(a.skipped, 2)
  assert.deepEqual(a.entries[0].keys, ['临江', '临江市'])

  const b = importLorebook([{ key: ['学校'], content: '她在临江三中读过书。' }])
  assert.equal(b.entries.length, 1)
  assert.equal(b.entries[0].keys[0], '学校')

  const c = importLorebook({ nope: 1 })
  assert.equal(c.ok, false)
  assert.ok(c.why)
})

test('导入：disable:true 的条目留着但标成不启用', () => {
  const r = importLorebook({ entries: [{ key: ['旧设定'], content: '已经不成立了。', disable: true }] })
  assert.equal(r.entries.length, 1)
  assert.equal(r.entries[0].enabled, false)
})

test('匹配：长关键词优先、超上限截断、不启用的不参与', () => {
  const entries = [
    { id: 'a', keys: ['学校'], text: '学校很大。', enabled: true, at: 1 },
    { id: 'b', keys: ['临江三中'], text: '临江三中是她念书的地方。', enabled: true, at: 2 },
    { id: 'c', keys: ['秘密'], text: '这条不该被取到。', enabled: false, at: 3 },
  ]
  const hit = matchEntries(entries, '你还记得临江三中吗')
  assert.equal(hit.length, 1)
  assert.equal(hit[0].id, 'b')

  const many = Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, keys: ['临江'], text: `第${i}条`, enabled: true, at: i }))
  assert.equal(matchEntries(many, '临江').length, MATCH_MAX)
  assert.equal(matchEntries(entries, '').length, 0)
})

test('匹配：总字数有上限，长的截断并加省略号', () => {
  const entries = [{ id: 'a', keys: ['长'], text: '字'.repeat(5000), enabled: true, at: 1 }]
  const hit = matchEntries(entries, '很长的一段话', { chars: 20 })
  assert.equal(hit.length, 1)
  assert.ok(hit[0].text.length <= 20)
  assert.ok(hit[0].text.endsWith('…'))
})

test('存储：没导入过不建文件；导入后是 0600，读完能拿回同样的条目', async () => {
  const root = await tmpRoot()
  const wb = createWorldbook(root)
  assert.deepEqual(await wb.list(), [])
  await assert.rejects(fs.stat(path.join(root, WORLDBOOK_FILE)))

  await wb.replace(importLorebook(lorebook).entries)
  const st = await fs.stat(path.join(root, WORLDBOOK_FILE))
  // Windows 上 mode 位不可靠，只在类 POSIX 上断言
  if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600)

  const list = await createWorldbook(root).list()
  assert.equal(list.length, 2)

  const stats = await wb.stats()
  assert.equal(stats.count, 2)
  assert.equal(stats.enabled, 2)
  assert.ok(stats.chars > 0)

  await wb.add([{ key: ['新'], content: '后来加的一条。' }])
  assert.equal((await wb.stats()).count, 3)
  const all = await wb.list()
  await wb.remove(all[0].id)
  assert.equal((await wb.stats()).count, 2)

  await wb.clear()
  assert.equal((await wb.stats()).count, 0)
  await fs.rm(root, { recursive: true, force: true })
})

test('提示词：有命中才加「你知道的事」，没有就一个字不加', () => {
  assert.equal(knowledgeBlock([]), '')
  const block = knowledgeBlock([{ text: '临江是座沿江的小城。' }])
  assert.match(block, /你知道的事/)
  assert.match(block, /临江是座沿江的小城/)
  // 是事实，不是要求
  assert.doesNotMatch(block, /你是一个/)

  const msg = { channel: 'qq', kind: 'group', conversationId: '1', conversationName: '群', personName: 'Lily', text: '在吗' }
  assert.doesNotMatch(buildPrompt(msg, [], {}), /你知道的事/)
  assert.match(buildPrompt(msg, [], { knowledge: [{ text: '临江是座沿江的小城。' }] }), /你知道的事/)
})

test('身份文档也带上她知道的事：他在的时候，她也知道这些', async () => {
  const root = await tmpRoot()
  await createWorldbook(root).add([{ key: ['临江'], content: '住在临江路 12 号。' }])
  await writeSelfDoc(root, {})

  const doc = await fs.readFile(path.join(root, 'home', '她的身份.md'), 'utf8')
  assert.match(doc, /## 我知道的事/)
  assert.match(doc, /临江路 12 号/)
  // 还是事实，不是人设
  assert.doesNotMatch(doc, /你是一个温柔的人/)

  await fs.rm(root, { recursive: true, force: true })
})

test('没导入过世界书时，身份文档里连标题都不出现', () => {
  const doc = renderSelfDoc({ ...deriveSelf([]), stage: 1 }, {})
  assert.equal(doc.includes('## 我知道的事'), false)
  assert.equal(KNOWLEDGE_SHOWN, 24)
})
