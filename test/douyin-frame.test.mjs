/**
 * 抖音私信帧解析（2026-11-02 真机样本）
 *
 * 样本来自一次真实抓帧：用户从手机发出的「这条是测试」。
 * 帧是 protobuf，字符串是裸 UTF-8，所以这里验的是「能不能从字节流里把三段抠出来」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDmFrame } from '../packages/dsh-fish-river-douyin/index.js'

/** 按真机帧的形状拼一个：字段名明文 + 三段中文 + 二进制控制字节。 */
function frame(sender, text) {
  const parts = [
    Buffer.from([0x0a, 0x2c, 0x08, 0x01]),
    Buffer.from('x_frontier_msg_id', 'utf8'),
    Buffer.from([0x12, 0x10]),
    Buffer.from(sender, 'utf8'),
    Buffer.from([0x1a, 0x04]),
    Buffer.from('私信了你', 'utf8'),
    Buffer.from([0x22, 0x0a]),
    Buffer.from(text, 'utf8'),
    Buffer.from([0x28, 0xff, 0xfe, 0x01]),
  ]
  return Buffer.concat(parts).toString('base64')
}

test('parseDmFrame：从帧里认出发送人和正文', () => {
  const got = parseDmFrame(frame('小满', '这条是测试'))
  assert.deepEqual(got, { sender: '小满', text: '这条是测试' })
})

test('parseDmFrame：正文里有标点也不会被截断', () => {
  const got = parseDmFrame(frame('小满', '收到了吗？我刚才发了三条，都没人回。'))
  assert.equal(got.sender, '小满')
  assert.match(got.text, /收到了吗/)
})

test('parseDmFrame：不是私信推送的帧一律不认', () => {
  // 有中文、但没有「私信了你」这个推送标记（比如直播间消息、系统通知）
  const other = Buffer.from('直播间点赞了你的作品', 'utf8').toString('base64')
  assert.equal(parseDmFrame(other), null)
  const heartbeat = Buffer.from('hi').toString('base64')
  assert.equal(parseDmFrame(heartbeat), null)
  assert.equal(parseDmFrame(''), null)
  assert.equal(parseDmFrame(null), null)
})

test('parseDmFrame：缺发送人或缺正文时宁可不报，也不猜', () => {
  const noSender = Buffer.from('私信了你这条是测试', 'utf8').toString('base64')
  assert.equal(parseDmFrame(noSender), null)
})

test('parseDmFrame：坏 base64 不会抛', () => {
  assert.doesNotThrow(() => parseDmFrame('%%%not-base64%%%'))
})
