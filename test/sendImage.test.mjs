/**
 * sendImage.test.mjs —— 她主动发图（`send_image`）。
 *
 * 不联网、不发微信：sender 是假的，「当前在跟谁说话」用 channelTurn 手动摆。
 * 重点验：没有渠道轮时拒绝、路径与格式校验、够不着的地方不发、失败原样透出。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerSendImage, sendImageOnce } from '../lib/talk/sendImage.js'
import { setChannelTurn, clearChannelTurn, setChannelSender, resetChannelTurnForTests, currentChannelTurn } from '../lib/channels/channelTurn.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fish-sendimg-'))
  const media = join(root, 'media')
  await mkdir(media, { recursive: true })
  const pic = join(media, 'shot.png')
  await writeFile(pic, PNG)
  const txt = join(media, 'note.txt')
  await writeFile(txt, 'not an image')
  return { root, pic, txt }
}

test('没有渠道轮时不发（她在家跟自己说话）', async () => {
  resetChannelTurnForTests()
  const root = await mkdtemp(join(tmpdir(), 'fish-sendimg-'))
  try {
    const r = await sendImageOnce({ root, path: join(root, 'x.png') })
    assert.equal(r.ok, false)
    assert.match(r.note, /没有在跟谁说话/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('有渠道轮时：把真实路径交给 sender，成功就 ok', async () => {
  resetChannelTurnForTests()
  const { root, pic } = await setup()
  try {
    setChannelTurn({ channel: 'weixin', kind: 'dm', conversationId: 'wxid_a' })
    const calls = []
    setChannelSender(async (args) => { calls.push(args); return { ok: true } })
    const r = await sendImageOnce({ root, herDir: root, path: pic, caption: '你看' })
    assert.equal(r.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, pic)
    assert.equal(calls[0].caption, '你看')
  } finally {
    resetChannelTurnForTests()
    await rm(root, { recursive: true, force: true })
  }
})

test('过期的那一轮不算：5 分钟后工具就该说没有在跟谁说话', async () => {
  resetChannelTurnForTests()
  const { root, pic } = await setup()
  try {
    setChannelTurn({ channel: 'weixin', kind: 'dm', conversationId: 'wxid_a' })
    setChannelSender(async () => ({ ok: true }))
    const later = Date.now() + 6 * 60_000
    const r = await sendImageOnce({ root, path: pic, now: later })
    assert.equal(r.ok, false)
    assert.match(r.note, /没有在跟谁说话/)
    assert.equal(currentChannelTurn(later), null)
  } finally {
    resetChannelTurnForTests()
    await rm(root, { recursive: true, force: true })
  }
})

test('不在她够得着的地方 / 不是图片 / 不是文件 都拒绝', async () => {
  resetChannelTurnForTests()
  const { root, txt } = await setup()
  const outside = await mkdtemp(join(tmpdir(), 'fish-outside-'))
  try {
    setChannelTurn({ channel: 'weixin', kind: 'dm', conversationId: 'wxid_a' })
    setChannelSender(async () => ({ ok: true }))

    const far = join(outside, 'x.png')
    await writeFile(far, PNG)
    const a = await sendImageOnce({ root, path: far })
    assert.equal(a.ok, false)
    assert.match(a.note, /够得着/)

    const b = await sendImageOnce({ root, path: txt })
    assert.equal(b.ok, false)
    assert.match(b.note, /不是一张图片/)

    const c = await sendImageOnce({ root, path: join(root, 'nope.png') })
    assert.equal(c.ok, false)
    assert.match(c.note, /找不到/)

    const d = await sendImageOnce({ root, path: 'https://example.com/a.png' })
    assert.equal(d.ok, false)
    assert.match(d.note, /本机/)
  } finally {
    resetChannelTurnForTests()
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('sender 失败时把原因透出（比如这个渠道还不支持发图）', async () => {
  resetChannelTurnForTests()
  const { root, pic } = await setup()
  try {
    setChannelTurn({ channel: 'qq', kind: 'dm', conversationId: '42' })
    setChannelSender(async () => ({ ok: false, why: '这个渠道还发不了图' }))
    const r = await sendImageOnce({ root, path: pic })
    assert.equal(r.ok, false)
    assert.match(r.note, /发不了图/)
  } finally {
    resetChannelTurnForTests()
    await rm(root, { recursive: true, force: true })
  }
})

test('工具注册：名字与参数是合法 JSON Schema', () => {
  const ctx = { tools: { register: (t) => t } }
  const tool = registerSendImage(ctx, { root: '/tmp/x' })
  assert.equal(tool.name, 'send_image')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['path'])
  assert.ok(tool.parameters.properties.caption)
})
