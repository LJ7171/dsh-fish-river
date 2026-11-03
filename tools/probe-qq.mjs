#!/usr/bin/env node
/**
 * 真机验 QQ 桥（OneBot 11 正向 WebSocket）。
 *
 * 用法：
 *   node tools/probe-qq.mjs --ws ws://127.0.0.1:3001
 *   node tools/probe-qq.mjs --ws ws://127.0.0.1:3001 --token 你的令牌
 *   node tools/probe-qq.mjs --ws ws://127.0.0.1:3001 --send-dm 123456789 --text 在吗
 *
 * 它做的事和插件里那条渠道完全一样（同一个 `lib/channels/qq.js`）：
 * 连上 → 打一行状态 → 把收到的消息原样打出来 → 可选地发一条私信 → 到点退出。
 *
 * 退出码：0 = 连上并正常跑完；2 = 一直没连上；3 = 参数不对。
 * 令牌只出现在 WS 的 URL 里，不会被打出来。
 */
import { create } from '../lib/channels/qq.js'

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : fallback
}

const wsUrl = arg('ws', 'ws://127.0.0.1:3001')
const token = arg('token', '')
const seconds = Math.max(3, Number(arg('seconds', '30')) || 30)
const sendDm = arg('send-dm', '')
const text = arg('text', '')
const sendGroup = arg('send-group', '')

if (token === '' && process.argv.includes('--token')) {
  console.error('--token 后面是空的。没有令牌就别传这个参数。')
  process.exit(3)
}

const adapter = create({
  config: { wsUrl, token },
  log: (level, message) => console.log(`[${level}] ${message}`),
})

const seen = []
adapter.onMessage((m) => {
  seen.push(m)
  const kind = m.kind === 'group' ? '群' : '私聊'
  console.log(`IN  ${kind} · ${m.personName || m.personId} · ${String(m.text ?? '').slice(0, 120)}`)
})

console.log(`连接 ${wsUrl}${token ? '（带令牌）' : '（无令牌）'} …`)
const started = await adapter.start()
if (!started?.ok) {
  console.error('起不来：', started?.why ?? '未知原因')
  process.exit(2)
}

// 等握手：status().connected 变成 true 就算连上，最多等 12 秒。
let status = adapter.status()
const deadline = Date.now() + 12000
while (!status.connected && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 400))
  status = adapter.status()
}

if (!status.connected) {
  console.error('12 秒内没连上。检查：桥开了吗？端口对吗？令牌对吗？')
  console.error('status:', JSON.stringify(status))
  await adapter.stop()
  process.exit(2)
}

console.log('已连上。status:', JSON.stringify(status))

if (sendDm) {
  const r = await adapter.send({ conversation: { kind: 'dm', id: sendDm, name: sendDm }, text: text || '在吗' })
  console.log('发送（私聊）:', JSON.stringify(r))
}
if (sendGroup) {
  const r = await adapter.send({ conversation: { kind: 'group', id: sendGroup, name: sendGroup }, text: text || '在吗' })
  console.log('发送（群）:', JSON.stringify(r))
}

console.log(`听 ${seconds} 秒（现在去 QQ 里给它发一条试试）…`)
await new Promise((r) => setTimeout(r, seconds * 1000))

const final = adapter.status()
console.log('结束。status:', JSON.stringify(final))
console.log(`收到 ${seen.length} 条：`)
for (const m of seen) console.log('  -', m.kind, m.personName || m.personId, '|', String(m.text ?? '').slice(0, 60))
await adapter.stop()
process.exit(0)
