/**
 * 真 WebSocket 上的 QQ 桥联调（2026-11-02）。
 *
 * `test/qq-channel.test.mjs` 用的是假 WebSocket（直接调 onopen/onmessage），能覆盖逻辑，
 * 但覆盖不到握手、掩码、分片、URL 里带令牌这些真东西。这里起一个最小的 OneBot 11
 * 正向 WS 服务端（http upgrade + 手写帧），让 `lib/channels/qq.js` 真连一次。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { create } from '../lib/channels/qq.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

/** 拆客户端帧（客户端发的都带掩码）。返回 [{opcode,text}] 和剩下的半截。 */
function decodeFrames(buf) {
  const out = []
  let off = 0
  while (off + 2 <= buf.length) {
    const b1 = buf[off]
    const b2 = buf[off + 1]
    const opcode = b1 & 0x0f
    const masked = (b2 & 0x80) !== 0
    let len = b2 & 0x7f
    let p = off + 2
    if (len === 126) {
      if (p + 2 > buf.length) break
      len = buf.readUInt16BE(p)
      p += 2
    } else if (len === 127) {
      if (p + 8 > buf.length) break
      len = Number(buf.readBigUInt64BE(p))
      p += 8
    }
    const maskLen = masked ? 4 : 0
    if (p + maskLen + len > buf.length) break
    const mask = masked ? buf.subarray(p, p + 4) : null
    p += maskLen
    const payload = Buffer.from(buf.subarray(p, p + len))
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
    p += len
    out.push({ opcode, text: payload.toString('utf8') })
    off = p
  }
  return { frames: out, rest: buf.subarray(off) }
}

/** 最小 OneBot 11 服务端：握手、回 get_login_info、收 send_*、能把事件推回去。 */
async function startFakeBridge({ token = '' } = {}) {
  const got = { actions: [], url: '', pushed: 0 }
  let socket = null
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, sock) => {
    got.url = req.url
    const key = req.headers['sec-websocket-key']
    const accept = crypto.createHash('sha1').update(String(key) + GUID).digest('base64')
    sock.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'))
    socket = sock
    let buf = Buffer.alloc(0)
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const { frames, rest } = decodeFrames(buf)
      buf = rest
      for (const f of frames) {
        if (f.opcode === 8) { try { sock.end() } catch { /* ignore */ } continue }
        if (f.opcode !== 1) continue
        let msg = null
        try { msg = JSON.parse(f.text) } catch { continue }
        got.actions.push(msg)
        if (msg.action === 'get_login_info') {
          sock.write(encodeFrame(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '桥' }, echo: msg.echo })))
        } else if (String(msg.action).startsWith('send_')) {
          sock.write(encodeFrame(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: msg.echo })))
        }
      }
    })
    sock.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    got,
    url: `ws://127.0.0.1:${port}`,
    hasToken: () => String(got.url).includes(`access_token=${encodeURIComponent(token)}`),
    pushPrivate(text, userId = 123) {
      if (!socket) throw new Error('还没连上')
      got.pushed += 1
      socket.write(encodeFrame(JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: 5 + got.pushed,
        user_id: userId,
        self_id: 10001,
        sender: { user_id: userId, nickname: '小王', card: '' },
        message: [{ type: 'text', data: { text } }],
        time: Math.floor(Date.now() / 1000),
      })))
    },
    close() { try { socket?.destroy() } catch { /* ignore */ } server.close() },
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

test('真 WS：连上、握手带令牌、收到私聊、能回一条', async () => {
  const bridge = await startFakeBridge({ token: 's3cret' })
  const a = create({ config: { wsUrl: bridge.url, token: 's3cret' } })
  const got = []
  a.onMessage((m) => got.push(m))
  const started = await a.start()
  assert.equal(started.ok, true)

  for (let i = 0; i < 40 && !a.status().connected; i += 1) await wait(50)
  assert.equal(a.status().connected, true)
  assert.equal(bridge.hasToken(), true, '令牌要出现在 WS 的 URL 里')

  bridge.pushPrivate('在吗')
  for (let i = 0; i < 40 && got.length === 0; i += 1) await wait(50)
  assert.equal(got.length, 1)
  assert.equal(got[0].text, '在吗')
  assert.equal(got[0].kind, 'dm')
  assert.equal(got[0].conversationId, '123')

  const sent = await a.send({ conversation: { kind: 'dm', id: 123, name: '小王' }, text: '在的' })
  assert.equal(sent.ok, true)
  const action = bridge.got.actions.find((x) => x.action === 'send_private_msg')
  assert.ok(action, '要发出 send_private_msg')
  assert.equal(String(action.params.user_id), '123')
  assert.equal(JSON.stringify(action.params.message).includes('在的'), true)

  await a.stop()
  bridge.close()
})

test('真 WS：桥不开时 start 不抛，status 里写清楚原因', async () => {
  const a = create({ config: { wsUrl: 'ws://127.0.0.1:1', token: '' } })
  const r = await a.start()
  assert.equal(typeof r, 'object')
  const s = a.status()
  assert.equal(s.connected, false)
  assert.ok(String(s.lastError).length >= 0)
  await a.stop()
})
