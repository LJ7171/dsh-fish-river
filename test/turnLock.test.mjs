/**
 * turnLock.test.mjs —— 同一会话一轮只许一个。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { acquireTurn, resetTurnLocksForTests } from '../lib/talk/turnLock.js'

test('acquireTurn：同一会话拿不到就超时返回 null；释放后下一位能拿到', async () => {
  resetTurnLocksForTests()
  const first = await acquireTurn('session-a')
  assert.equal(typeof first, 'function')
  const second = await acquireTurn('session-a', { timeoutMs: 20 })
  assert.equal(second, null, '第一位没放之前，第二位应超时')
  first()
  const third = await acquireTurn('session-a', { timeoutMs: 100 })
  assert.equal(typeof third, 'function', '释放后应该能拿到')
  third()
})

test('acquireTurn：不同会话互不阻塞', async () => {
  resetTurnLocksForTests()
  const a = await acquireTurn('session-a')
  const b = await acquireTurn('session-b', { timeoutMs: 50 })
  assert.equal(typeof a, 'function')
  assert.equal(typeof b, 'function')
  a()
  b()
})

test('acquireTurn：release 幂等', async () => {
  resetTurnLocksForTests()
  const r = await acquireTurn('session-c')
  r()
  r()
  const again = await acquireTurn('session-c', { timeoutMs: 100 })
  assert.equal(typeof again, 'function')
  again()
})
