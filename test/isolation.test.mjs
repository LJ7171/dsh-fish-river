/**
 * test/isolation.test.mjs —— 出门/请神的隔离带（2026-11-02，用户 m03227）
 *
 * 用户拍板：这个功能留着，但**它碰过的东西一样都不许长到她身上**。
 * 守两件事：
 *   ① 写入时盖章：台账里记过的会话，写什么都定格成 `influence:'none'`（source 是 tool 也一样）；
 *   ② 读取时消失：`deriveSelf` 与 `evaluateSocialGate` 一律当它不存在。
 *
 * 两条缺一条都不算数——只盖章不忽略，等于写了个没人看的标记；
 * 只忽略不盖章，就等于指望每个调用点都记得传对字段。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { appendEvent, readEvents } from '../lib/store.js'
import { deriveSelf } from '../lib/derive.js'
import { evaluateSocialGate } from '../lib/socialgate.js'

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'fish-isolation-'))
}

async function writeOutings(root, sessionIds) {
  await writeFile(join(root, 'outings.json'), JSON.stringify({
    version: 1,
    outings: sessionIds.map((sessionId) => ({ sessionId, at: '2026-11-02T10:00:00.000Z' })),
  }), 'utf8')
}

async function writePossessions(root, sessionIds) {
  await writeFile(join(root, 'possessions.json'), JSON.stringify({
    version: 1,
    possessions: sessionIds.map((sessionId) => ({ sessionId, at: '2026-11-02T10:00:00.000Z' })),
  }), 'utf8')
}

test('出门那条会话里写的成长事件，落盘时就被定格成 influence:none', async () => {
  const root = await tmpRoot()
  try {
    await writeOutings(root, ['s-out'])
    await appendEvent(
      { type: 'utterance', text: '我在外面说了一句', sessionId: 's-out' },
      { day: 1, stage: 1, source: 'tool' },
      root,
    )
    const { events } = await readEvents(root)
    assert.equal(events.length, 1)
    assert.equal(events[0].influence, 'none', '外面说的不进人格')
    assert.equal(events[0].text, '我在外面说了一句', '原文照写，只是不参与派生')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('请神那条会话同样被隔离；家里那条不受影响', async () => {
  const root = await tmpRoot()
  try {
    await writePossessions(root, ['s-possessed'])
    await appendEvent(
      { type: 'utterance', text: '借来的嘴说的话', sessionId: 's-possessed' },
      { day: 1, stage: 1, source: 'tool' },
      root,
    )
    await appendEvent(
      { type: 'utterance', text: '在家里说的话', sessionId: 's-home' },
      { day: 1, stage: 1, source: 'tool' },
      root,
    )
    const { events } = await readEvents(root)
    const byText = Object.fromEntries(events.map((e) => [e.text, e]))
    assert.equal(byText['借来的嘴说的话'].influence, 'none')
    assert.equal(byText['在家里说的话'].influence, undefined, '家里那条不该被盖章')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('derived 输出逐字节相同：喂一百条外面的经历，等于没喂', async () => {
  const clean = deriveSelf([])
  const dirty = deriveSelf(
    Array.from({ length: 100 }, (_, i) => ({
      id: `e${i}`,
      type: 'utterance',
      text: `外面第 ${i} 句：我不想再讨好人 ${i}`,
      at: new Date(Date.UTC(2026, 9, 1, i % 24)).toISOString(),
      influence: 'none',
      sessionId: 's-out',
    })),
  )
  assert.equal(JSON.stringify(dirty), JSON.stringify(clean), '隔离带必须是一堵实心墙')
})

test('没被盖章的事件照常长：对照组证明上面那条不是因为「什么都没算」', async () => {
  const base = deriveSelf([])
  const withGrowth = deriveSelf([{
    id: 'g1',
    type: 'utterance',
    text: '我不想再讨好人',
    at: new Date(Date.UTC(2026, 9, 1, 9)).toISOString(),
  }])
  assert.notEqual(JSON.stringify(withGrowth), JSON.stringify(base), '普通事件必须能改派生结果')
})

test('外面那一趟写的「开闸」不算数：隔离带比闸门更早生效', async () => {
  const root = await tmpRoot()
  try {
    await writeOutings(root, ['s-out'])
    await appendEvent(
      { type: 'meta', text: 'social-open:2026-11-01T00:00:00.000Z', sessionId: 's-out' },
      { day: 1, stage: 1, source: 'system' },
      root,
    )
    const { events } = await readEvents(root)
    assert.equal(events[0].influence, 'none')
    const gate = evaluateSocialGate({ model: deriveSelf(events), events })
    assert.equal(gate.open, false, '在外面按的那颗按钮不改变她')
    assert.equal(gate.at, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
