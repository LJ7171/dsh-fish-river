/**
 * 主包的抖音渠道适配器：配置翻译、可选装、消息转发（2026-11-02）
 *
 * 子包本身（浏览器、CDP、protobuf 帧）不在这里测——它有自己的测试。
 * 这里只测「主包有没有把它正确接进渠道层」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from '../lib/channels/douyin.js'

function fakeInner(record) {
  return (opts) => {
    record.opts = opts
    return {
      async start() { record.started = true; return { ok: true } },
      async stop() { record.stopped = true },
      async send(m) { record.sent = m; return { ok: true } },
      onMessage(fn) { record.listener = fn; return () => {} },
      status() { return { ok: true, connected: true, since: 123, lastError: '', sent: 2, received: 3 } },
    }
  }
}

test('抖音适配器：把配置翻成子包要的形状，profile 落在数据目录里', async () => {
  const record = {}
  const a = create({
    root: 'C:/data',
    config: { channels: { douyin: { browserPath: 'C:/Edge/msedge.exe', intervalMs: 9000 } } },
    inner: fakeInner(record),
  })
  const started = await a.start()
  assert.equal(started.ok, true)
  assert.equal(record.opts.browserPath, 'C:/Edge/msedge.exe')
  assert.equal(record.opts.homeUrl, '')
  assert.equal(record.opts.intervalMs, 9000)
  assert.match(record.opts.profileDir, /douyin-profile$/)
  assert.equal(a.status().received, 3)
})

test('抖音适配器：首页地址原样带过去，没填就是空串', async () => {
  const record = {}
  const a = create({
    root: 'C:/data',
    config: { channels: { douyin: { homeUrl: '  https://www.douyin.com/?recommend=1  ' } } },
    inner: fakeInner(record),
  })
  await a.start()
  assert.equal(record.opts.homeUrl, 'https://www.douyin.com/?recommend=1')
})

test('抖音适配器：没填间隔时给 15 秒，不用子包的 6 秒默认值', async () => {
  const record = {}
  const a = create({ root: 'C:/data', config: {}, inner: fakeInner(record) })
  await a.start()
  assert.equal(record.opts.intervalMs, 15000)
})

test('抖音适配器：子包来的消息原样转发给渠道层', async () => {
  const record = {}
  const a = create({ root: 'C:/data', config: {}, inner: fakeInner(record) })
  const got = []
  a.onMessage((m) => got.push(m))
  await a.start()
  record.listener({ conversation: { id: '小满', name: '小满', kind: 'dm' }, text: '收到了吗', personId: 'u_小满' })
  assert.equal(got.length, 1)
  assert.equal(got[0].text, '收到了吗')
})

test('抖音适配器：没装子包时安静地失败，不抛异常', async () => {
  const a = create({ root: 'C:/data', config: {}, inner: () => null })
  const started = await a.start()
  assert.equal(started.ok, false)
  assert.match(String(started.why), /子包|douyin/i)
})

test('抖音适配器：send 直接交给子包，没起来时不假装成功', async () => {
  const record = {}
  const a = create({ root: 'C:/data', config: {}, inner: fakeInner(record) })
  const before = await a.send({ conversation: { id: 'x' }, text: 'hi' })
  assert.equal(before.ok, false)
  await a.start()
  const after = await a.send({ conversation: { id: 'x' }, text: 'hi' })
  assert.equal(after.ok, true)
  assert.equal(record.sent.text, 'hi')
})
