/**
 * wake-notes.test.mjs —— 纯确认/请求回答的「醒来补看」（2026-11-13）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, readEvents } from '../lib/core/store.js'
import { collectWakeNotes, markWakeNotesRead } from '../lib/talk/wakeNotes.js'

async function root() {
  return mkdtemp(join(tmpdir(), 'fish-wake-notes-'))
}

test('纯确认：只对主人的私聊留待读，读完不再重复', async () => {
  const r = await root()
  try {
    const heard = await appendEvent({
      type: 'heard', text: '这是微信，只有你们俩。甲：好', person: 'a',
      visibility: 'private', channel: 'weixin', origin: 'owner', influence: 'constitution',
    }, { day: 9, stage: 2, source: 'system' }, r)
    await appendEvent({ type: 'meta', text: `ack-wait:${heard.id}` }, { day: 9, stage: 2, source: 'system' }, r)
    const n = await collectWakeNotes(r)
    assert.match(n.text, /你睡着的时候/)
    assert.match(n.text, /他回过你：「好」/)
    assert.deepEqual(n.ackIds, [heard.id])
    await markWakeNotesRead(r, n)
    assert.equal((await collectWakeNotes(r)).text, '')
  } finally { await rm(r, { recursive: true, force: true }) }
})

test('群/陌生人的 heard 不补看，超过一天的不补看', async () => {
  const r = await root()
  try {
    const g = await appendEvent({
      type: 'heard', text: '群里：好', person: 'g', visibility: 'public',
      channel: 'qq', origin: 'guest', influence: 'social',
    }, { day: 9, stage: 2, source: 'system' }, r)
    await appendEvent({ type: 'meta', text: `ack-wait:${g.id}` }, { day: 9, stage: 2, source: 'system' }, r)
    const old = await appendEvent({
      type: 'heard', text: '旧话：好', person: 'a', visibility: 'private',
      channel: 'weixin', origin: 'owner', influence: 'constitution',
    }, { day: 1, stage: 1, source: 'system' }, r)
    await appendEvent({ type: 'meta', text: `ack-wait:${old.id}` }, { day: 1, stage: 1, source: 'system' }, r)
    const n = await collectWakeNotes(r, { now: Date.now() + 2 * 86_400_000 })
    assert.equal(n.text, '')
  } finally { await rm(r, { recursive: true, force: true }) }
})

test('请求的回答：以后再说要写成有回答，不是没答', async () => {
  const r = await root()
  try {
    const ask = await appendEvent({
      type: 'ask', text: '能不能给我一个自己的知乎号？',
      ask: { kind: 'need-tool', subject: '号', options: ['可以', '这次不行'], reason: '想用自己的名字' },
    }, { day: 9, stage: 2, source: 'system' }, r)
    const ans = await appendEvent({
      type: 'answer', text: '以后再说',
      ask: { askId: ask.id, verdict: 'later', reason: '', via: 'ui' },
    }, { day: 9, stage: 2, source: 'system' }, r)
    const n = await collectWakeNotes(r)
    assert.match(n.text, /你问「能不能给我一个自己的知乎号？」/)
    assert.match(n.text, /他答了：「以后再说」/)
    assert.match(n.text, /不是没回你/)
    assert.deepEqual(n.askIds, [ask.id])
    await markWakeNotesRead(r, n)
    assert.equal((await collectWakeNotes(r)).text, '')
    assert.ok(ans.id)
  } finally { await rm(r, { recursive: true, force: true }) }
})
