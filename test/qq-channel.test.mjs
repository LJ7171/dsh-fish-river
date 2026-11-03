/**
 * qq-channel.test.mjs —— lib/channels/qq.js 的契约测试。
 *
 * 全程不碰真网络：WebSocket 用假实现，定时器用假时钟（否则 15s 超时、30s 退避
 * 会把一条用例拖成半分钟）。断言的对象就是 channels/README.md 里那份规范化形状。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { create } from '../lib/channels/qq.js'

const T0 = 1700000000000
const SELF = 10001

/** 假 WebSocket：记录发出去的报文，能手动 open / push / drop。 */
class FakeWS {
  static all = []

  static reset() {
    FakeWS.all = []
  }

  static get last() {
    return FakeWS.all[FakeWS.all.length - 1]
  }

  constructor(url) {
    this.url = url
    this.frames = []
    this.closed = false
    this.readyState = 0 // 0 = CONNECTING
    FakeWS.all.push(this)
  }

  send(payload) {
    this.frames.push(JSON.parse(payload))
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.onclose?.({ code: 1000 })
  }

  open() {
    this.readyState = 1
    this.onopen?.({})
  }

  /** 桥那边断线（不会走 close()，模拟网络掉线） */
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }

  push(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }

  lastFrame() {
    return this.frames[this.frames.length - 1]
  }

  find(action) {
    return this.frames.find((f) => f.action === action)
  }
}

/** 假时钟：把 setTimeout 的句柄做成可 unref 的对象，用例里手动快进。 */
function fakeClock() {
  let seq = 0
  const timers = new Map()
  return {
    setTimeout(fn, ms) {
      const id = ++seq
      timers.set(id, { fn, ms })
      return { id, unref() { return this } }
    },
    clearTimeout(handle) {
      if (handle !== null && typeof handle === 'object') timers.delete(handle.id)
    },
    /** 触发所有到期定时器（快照遍历，回调里新排的不重复触发） */
    tick(ms) {
      for (const [id, t] of [...timers]) {
        if (t.ms <= ms) {
          timers.delete(id)
          t.fn()
        }
      }
    },
    size() {
      return timers.size
    },
  }
}

function setup(extra = {}, configOverride = {}) {
  FakeWS.reset()
  const clock = fakeClock()
  const messages = []
  const logs = []
  const adapter = create({
    log: (...args) => logs.push(args.map((a) => String(a)).join(' ')),
    config: { wsUrl: 'ws://127.0.0.1:3001', token: '', ...configOverride },
    WebSocketImpl: FakeWS,
    now: () => T0,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...extra,
  })
  adapter.onMessage((m) => messages.push(m))
  return { adapter, clock, messages, logs }
}

/** 让 await 链上的微任务跑完（call 的 resolve → afterOpen 的剩余部分） */
function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

let mid = 100

function inbound(over = {}) {
  return { post_type: 'message', time: 1700000000, self_id: SELF, ...over }
}

function dm(over = {}) {
  return inbound({ message_type: 'private', message_id: ++mid, ...over })
}

function group(over = {}) {
  return inbound({ message_type: 'group', message_id: ++mid, group_id: 30003, ...over })
}

async function started(extra, configOverride) {
  const ctx = setup(extra, configOverride)
  const res = await ctx.adapter.start()
  assert.equal(res.ok, true)
  const ws = FakeWS.last
  ws.open()
  return { ...ctx, ws }
}

// ---- 连接 ----

test('create() 不碰网络；start() 之后先发 get_login_info', async () => {
  const ctx = setup()
  assert.equal(ctx.adapter.name, 'qq')
  assert.equal(FakeWS.all.length, 0, '模块加载 / create 阶段不许建连接')

  const res = await ctx.adapter.start()
  assert.equal(res.ok, true)
  assert.equal(FakeWS.all.length, 1)

  const ws = FakeWS.last
  ws.open()
  const hello = ws.find('get_login_info')
  assert.ok(hello, '连上后要问一次登录信息，确认桥那边是谁在线')
  assert.deepEqual(hello.params, {})

  ws.push({ status: 'ok', retcode: 0, data: { user_id: SELF, nickname: '大肥鱼' }, echo: hello.echo })
  await flush()

  const st = ctx.adapter.status()
  assert.equal(st.ok, true)
  assert.equal(st.connected, true)
  assert.equal(st.since, T0)
  assert.equal(st.lastError, '')
  ctx.adapter.stop()
})

// ---- 进站 ----

test('私聊消息规范化：personId 前缀 / personName / text', async () => {
  const { adapter, messages, ws } = await started()
  ws.push(
    dm({
      message_id: 501,
      user_id: 20002,
      sender: { nickname: '阿明' },
      message: [{ type: 'text', data: { text: '  你好呀  ' } }],
      raw_message: '  你好呀  ',
    }),
  )

  assert.equal(messages.length, 1)
  const m = messages[0]
  assert.equal(m.channelId, 'qq')
  assert.equal(m.kind, 'dm')
  assert.equal(m.conversationId, '20002')
  assert.equal(m.conversationName, '阿明')
  assert.equal(m.personId, 'u_20002')
  assert.equal(m.personName, '阿明')
  assert.equal(m.text, '你好呀')
  assert.deepEqual(m.images, [])
  assert.equal(m.at, 1700000000 * 1000)
  assert.equal(m.raw.message_id, 501)
  adapter.stop()
})

test('群里 @ 她会被洗掉；只有图片时 text 为空但消息仍然上报', async () => {
  const { adapter, messages, ws } = await started()

  ws.push(
    group({
      message_id: 601,
      user_id: 20002,
      sender: { card: '群里的阿明', nickname: '阿明' },
      message: [
        { type: 'at', data: { qq: String(SELF), name: '大肥鱼' } },
        { type: 'text', data: { text: ' 在吗' } },
      ],
    }),
  )
  assert.equal(messages.length, 1)
  assert.equal(messages[0].text, '在吗')
  assert.equal(messages[0].kind, 'group')
  assert.equal(messages[0].conversationId, '30003')
  assert.equal(messages[0].conversationName, '群里的阿明')
  assert.equal(messages[0].personName, '群里的阿明')

  ws.push(
    group({
      message_id: 602,
      user_id: 20003,
      message: [{ type: 'image', data: { url: 'https://example.com/a.png' } }],
    }),
  )
  const pic = messages[1]
  assert.equal(pic.text, '', '只发图时 text 是空串，不许编一句话出来')
  assert.deepEqual(pic.images, ['https://example.com/a.png'])
  adapter.stop()
})

test('post_format=string（CQ 码）也认：@ 她去掉，图片能捞出来', async () => {
  const { adapter, messages, ws } = await started()
  ws.push(
    group({
      message_id: 603,
      user_id: 20002,
      sender: { nickname: '阿明' },
      message: '[CQ:at,qq=10001] 你看 [CQ:image,url=https://example.com/b.png]',
    }),
  )
  assert.equal(messages.length, 1)
  assert.equal(messages[0].text, '你看')
  assert.deepEqual(messages[0].images, ['https://example.com/b.png'])
  adapter.stop()
})

test('@ 她被记成 mentionedSelf，且不进正文（群聊只认被点名的）', async () => {
  const { adapter, messages, ws } = await started()
  ws.push(group({ message_id: 605, user_id: 20002, message: [{ type: 'text', data: { text: '在吗' } }] }))
  ws.push(group({ message_id: 606, user_id: 20002, message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 在吗' } }] }))
  assert.equal(messages.length, 2)
  assert.equal(messages[0].mentionedSelf, false, '没点名的消息不许说被点了名')
  assert.equal(messages[1].mentionedSelf, true)
  assert.equal(messages[1].text, '在吗', '@ 她的段不进正文')
  adapter.stop()
})

test('CQ 码里的 @ 她同样记成 mentionedSelf', async () => {
  const { adapter, messages, ws } = await started()
  ws.push(group({ message_id: 607, user_id: 20002, message: '[CQ:at,qq=10001] 在吗' }))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].mentionedSelf, true)
  assert.equal(messages[0].text, '在吗')
  adapter.stop()
})

test('图片最多收 4 张', async () => {
  const { adapter, messages, ws } = await started()
  const segs = Array.from({ length: 6 }, (_, i) => ({ type: 'image', data: { url: `https://example.com/${i}.png` } }))
  ws.push(group({ message_id: 604, user_id: 20002, message: segs }))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].images.length, 4)
  adapter.stop()
})

// ---- 出站 ----

test('send()：私聊发 send_private_msg，群聊发 send_group_msg，按 echo 对上响应', async () => {
  const { adapter, ws } = await started()

  const p1 = adapter.send({ conversation: { kind: 'dm', id: '20002', name: '阿明' }, text: '在的' })
  const f1 = ws.lastFrame()
  assert.equal(f1.action, 'send_private_msg')
  assert.equal(f1.params.user_id, 20002)
  assert.equal(f1.params.message[0].data.text, '在的')
  ws.push({ status: 'ok', retcode: 0, data: { message_id: 777 }, echo: f1.echo })
  assert.deepEqual(await p1, { ok: true, id: '777' })

  const p2 = adapter.send({ conversation: { kind: 'group', id: '30003', name: '群' }, text: '大家好' })
  const f2 = ws.lastFrame()
  assert.equal(f2.action, 'send_group_msg')
  assert.equal(f2.params.group_id, 30003)
  ws.push({ status: 'ok', retcode: 0, data: { message_id: 778 }, echo: f2.echo })
  assert.deepEqual(await p2, { ok: true, id: '778' })

  // 桥回失败（被禁言之类）：resolve 成 {ok:false}，不是 reject
  const p3 = adapter.send({ conversation: { kind: 'dm', id: '20002' }, text: '再说一句' })
  const f3 = ws.lastFrame()
  ws.push({ status: 'failed', retcode: 1200, wording: '不允许发送', echo: f3.echo })
  const r3 = await p3
  assert.equal(r3.ok, false)
  assert.equal(r3.why, '不允许发送')
  assert.equal(r3.retcode, 1200)

  assert.equal(adapter.status().sent, 2)
  adapter.stop()
})

test('超长文本按 1500 字切段，依次发', async () => {
  const { adapter, ws } = await started()
  const p = adapter.send({ conversation: { kind: 'dm', id: '20002' }, text: 'a'.repeat(1600) })

  const f1 = ws.lastFrame()
  assert.equal(f1.action, 'send_private_msg')
  assert.equal(f1.params.message[0].data.text.length, 1500)
  ws.push({ status: 'ok', retcode: 0, data: { message_id: 801 }, echo: f1.echo })
  await flush()

  const f2 = ws.lastFrame()
  assert.notEqual(f2.echo, f1.echo)
  assert.equal(f2.params.message[0].data.text.length, 100)
  ws.push({ status: 'ok', retcode: 0, data: { message_id: 802 }, echo: f2.echo })

  assert.deepEqual(await p, { ok: true, id: '802' })
  adapter.stop()
})

test('没连上时 send() 返回 {ok:false}，不抛异常', async () => {
  const { adapter } = setup()
  const res = await adapter.send({ conversation: { kind: 'dm', id: '20002' }, text: '嗨' })
  assert.equal(res.ok, false)
  assert.equal(res.why, 'offline')
  assert.equal(adapter.status().connected, false)
})

test('send() 15 秒没回音返回 {ok:false, why:"timeout"}', async () => {
  const { adapter, clock, ws } = await started()
  const p = adapter.send({ conversation: { kind: 'dm', id: '20002' }, text: '在吗' })
  assert.ok(ws.find('send_private_msg'), '报文已经出去了')

  clock.tick(15_000)
  const res = await p
  assert.equal(res.ok, false)
  assert.equal(res.why, 'timeout')
  adapter.stop()
})

// ---- 重连 ----

test('断线后按阶梯自动重连；stop() 之后不再重连', async () => {
  const { adapter, clock, ws } = await started()
  assert.equal(adapter.status().connected, true)

  ws.drop(1006)
  assert.equal(FakeWS.all.length, 1, '断线当下不该立刻新建连接，要等退避')
  assert.equal(adapter.status().connected, false)
  assert.equal(adapter.status().ok, false)

  clock.tick(1000) // 第一档
  assert.equal(FakeWS.all.length, 2)
  assert.equal(FakeWS.all[1].url, ws.url, '新连接用同一个地址（含 token）')

  FakeWS.last.open()
  assert.equal(adapter.status().connected, true)

  adapter.stop()
  clock.tick(30_000)
  assert.equal(FakeWS.all.length, 2, 'stop() 之后连定时器都不该再留')
  assert.equal(clock.size(), 0)
})

test('重复的 message_id 只上报一次；自己发的消息不算别人说的', async () => {
  const { adapter, messages, ws } = await started()

  const ev = dm({ message_id: 701, user_id: 20002, message: [{ type: 'text', data: { text: '只该看见一次' } }] })
  ws.push(ev)
  ws.push(ev) // 重连补齐时的重复
  assert.equal(messages.length, 1)

  ws.push(dm({ message_id: 702, user_id: SELF, message: [{ type: 'text', data: { text: '我自己' } }] }))
  assert.equal(messages.length, 1)
  assert.equal(adapter.status().received, 1)
  adapter.stop()
})

// ---- 凭据 ----

test('token 拼进 wsUrl，但不许出现在 status() 和日志里', async () => {
  const TOKEN = 'tok-9f3c2b7a-secret-value'
  const { adapter, logs } = await started({}, { token: TOKEN })

  const url = FakeWS.last.url
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get('access_token'), TOKEN)

  const st = JSON.stringify(adapter.status())
  assert.equal(st.includes(TOKEN), false)
  assert.equal(Object.keys(adapter.status()).some((k) => /token/i.test(k)), false, 'status 里连键名都不该有')
  assert.equal(logs.join('\n').includes(TOKEN), false)
  adapter.stop()
})
