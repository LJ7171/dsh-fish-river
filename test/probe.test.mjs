import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { probeTcp } from '../lib/observe.js'

function listen() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => sock.end())
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

test('probeTcp：有人听就通', async () => {
  const { srv, port } = await listen()
  try {
    const r = await probeTcp('127.0.0.1', port, 1500)
    assert.equal(r.ok, true)
  } finally {
    srv.close()
  }
})

test('probeTcp：没人听就报错，不抛', async () => {
  const { srv, port } = await listen()
  await new Promise((r) => srv.close(r))
  const r = await probeTcp('127.0.0.1', port, 800)
  assert.equal(r.ok, false)
  assert.ok(typeof r.why === 'string' && r.why.length > 0)
})
