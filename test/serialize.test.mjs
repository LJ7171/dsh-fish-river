/**
 * serialize.test.mjs —— 同一文件上的读-改-写不能交错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { withSerial, resetSerialForTests } from '../lib/serialize.js'

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

test('withSerial：同一个 key 串行，不会读到前一个之前的快照', async () => {
  resetSerialForTests()
  const order = []
  const one = withSerial('same', async () => {
    order.push('a-start')
    await tick(10)
    order.push('a-end')
    return 'a'
  })
  const two = withSerial('same', async () => {
    order.push('b-start')
    await tick(1)
    order.push('b-end')
    return 'b'
  })
  assert.deepEqual(await Promise.all([one, two]), ['a', 'b'])
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'])
})

test('withSerial：前一个失败不会卡住后一个', async () => {
  resetSerialForTests()
  const a = withSerial('fail', async () => { throw new Error('boom') })
  const b = withSerial('fail', async () => 'ok')
  await assert.rejects(a, /boom/)
  assert.equal(await b, 'ok')
})
