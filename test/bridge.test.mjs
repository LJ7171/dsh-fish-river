import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { parseWsUrl, detectBridge, startBridge, probeTcp, DEFAULT_WS } from '../lib/bridge.js'

function listen() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => sock.end())
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

test('parseWsUrl：合法地址 / 默认端口 / 非法', () => {
  assert.deepEqual(parseWsUrl('ws://127.0.0.1:3001'), { host: '127.0.0.1', port: 3001, secure: false })
  assert.deepEqual(parseWsUrl('wss://example.com'), { host: 'example.com', port: 443, secure: true })
  assert.equal(parseWsUrl('http://x'), null)
  assert.equal(parseWsUrl('nonsense'), null)
  assert.equal(parseWsUrl(''), null)
})

test('detectBridge：桥起着时 listening=true', async () => {
  const { srv, port } = await listen()
  try {
    const st = await detectBridge({ wsUrl: `ws://127.0.0.1:${port}`, bridgePath: '' })
    assert.equal(st.ok, true)
    assert.equal(st.listening, true)
    assert.equal(st.port, port)
    assert.match(st.note, /通了/)
  } finally {
    srv.close()
  }
})

test('detectBridge：桥没起时给一句人话，不抛', async () => {
  const { srv, port } = await listen()
  await new Promise((r) => srv.close(r))
  const st = await detectBridge({ wsUrl: `ws://127.0.0.1:${port}`, bridgePath: '', timeoutMs: 800 })
  assert.equal(st.ok, false)
  assert.equal(st.listening, false)
  assert.match(st.note, /连不上/)
})

test('detectBridge：地址写错时不探端口', async () => {
  const st = await detectBridge({ wsUrl: 'http://127.0.0.1:3001' })
  assert.equal(st.ok, false)
  assert.equal(st.port, null)
  assert.match(st.note, /不是合法/)
})

test('detectBridge：路径存在与否不影响通不通，但会报出来', async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'bridge-'))
  const exe = join(dir, 'bridge.exe')
  fs.writeFileSync(exe, 'x')
  const st = await detectBridge({ wsUrl: DEFAULT_WS, bridgePath: exe, timeoutMs: 500 })
  assert.equal(st.pathExists, true)
  const st2 = await detectBridge({ wsUrl: DEFAULT_WS, bridgePath: join(dir, 'nope.exe'), timeoutMs: 500 })
  assert.equal(st2.pathExists, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('startBridge：没填路径 / 路径不存在都只回一句话', async () => {
  const a = await startBridge('')
  assert.equal(a.ok, false)
  assert.match(a.note, /还没填/)
  const b = await startBridge(join(os.tmpdir(), 'definitely-not-here.exe'))
  assert.equal(b.ok, false)
  assert.match(b.note, /不存在/)
})

test('probeTcp 仍然可用（observe 里 re-export）', async () => {
  const { srv, port } = await listen()
  try {
    const r = await probeTcp('127.0.0.1', port, 1000)
    assert.equal(r.ok, true)
  } finally {
    srv.close()
  }
})
