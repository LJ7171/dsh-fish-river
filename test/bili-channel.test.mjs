/**
 * bili-channel.test.mjs —— 私信渠道适配器（lib/channels/bili.js）的行为断言。
 *
 * 全部用假 fetch，不碰真网络；定时器只开不跑（intervalMs 拉长），轮询靠 `_poll()` 手动推。
 * 为什么手动推：8 秒一轮的测试既慢又抖，而且「首轮不回溯」这种断言必须能精确控制轮次。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { create, splitText } from '../lib/channels/bili.js'
import { createClient, inCooldown, resetRisk } from '../lib/bili.js'

const COOKIE = 'SESSDATA=sess; bili_jct=jct-123; DedeUserID=42; buvid3=B3'
const SELF_UID = '42'
const NOW = 1_700_000_100_000
const TS_SEC = 1_700_000_000
const SESSION_TS = 1_700_000_000_000_000

const NAV = {
  code: 0,
  data: {
    isLogin: true,
    mid: 42,
    uname: '本机账号',
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
}

/** 一个会话：last_msg.msg_seqno 是首轮建基线用的「现在最新一条」。 */
function session(talker, seq, { ts = SESSION_TS, ack = 0 } = {}) {
  return {
    talker_id: talker,
    session_type: 1,
    system_msg_type: 0,
    session_ts: ts,
    ack_seqno: ack,
    max_seqno: seq,
    last_msg: { msg_seqno: seq },
  }
}

/** 一条私信报文，字段名照 api.vc.bilibili.com 的实测返回。 */
function dm(seq, sender, { text = '', type = 1, content, msgKey, status = 0, timestamp = TS_SEC + seq } = {}) {
  const body = content ?? (type === 1 ? { content: text } : {})
  return {
    msg_key: msgKey ?? `key-${seq}`,
    msg_seqno: seq,
    sender_uid: sender,
    receiver_id: SELF_UID,
    msg_type: type,
    msg_status: status,
    timestamp,
    content: JSON.stringify(body),
  }
}

/** 假 fetch：按 URL 路由；测试通过 f.state 改「服务端现在有什么」。 */
function makeFetch() {
  const calls = []
  const state = {
    nav: NAV,
    sessions: [],
    messages: new Map(),
    send: { code: 0, data: { msg_key: 'msg-1' } },
    card: { code: 0, data: { card: { mid: 777, name: '阿岚' } } },
  }
  const reply = (body) => ({ status: 200, ok: true, text: async () => JSON.stringify(body), json: async () => body })
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    calls.push({
      url: u,
      method: String(init.method ?? 'GET'),
      body: String(init.body ?? ''),
      headers: init.headers ?? {},
    })
    if (u.includes('/x/web-interface/nav')) return reply(state.nav)
    if (u.includes('/session_svr/v1/session_svr/new_sessions')) return reply({ code: 0, data: { session_list: state.sessions } })
    if (u.includes('/svr_sync/v1/svr_sync/fetch_session_msgs')) {
      const talker = new URL(u).searchParams.get('talker_id')
      return reply({ code: 0, data: { messages: state.messages.get(String(talker)) ?? [] } })
    }
    if (u.includes('/web_im/v1/web_im/send_msg')) return reply(state.send)
    if (u.includes('/x/web-interface/card')) return reply(state.card)
    return reply({ code: -404, message: `unexpected ${u}` })
  }
  return {
    fetchImpl,
    calls,
    state,
    count: (needle) => calls.filter((c) => c.url.includes(needle)).length,
    find: (needle) => calls.find((c) => c.url.includes(needle)),
  }
}

/** 建渠道；默认注入固定 now 和很长的轮询间隔（测试不等真定时器）。 */
function channel(f, extra = {}) {
  return create({ fetchImpl: f.fetchImpl, cookie: COOKIE, now: () => NOW, intervalMs: 60_000, sendGapMs: 0, ...extra })
}

test('没 cookie：start 返回 {ok:false}，不发请求也不开定时器', async () => {
  resetRisk()
  const f = makeFetch()
  const a = create({ fetchImpl: f.fetchImpl, cookie: '', now: () => NOW })
  try {
    const r = await a.start()
    assert.equal(r.ok, false)
    assert.equal(r.why, 'no cookie')
    assert.equal(f.calls.length, 0)
    assert.equal(a._debug().hasTimer, false)
    assert.equal(a.status().connected, false)
    assert.equal(a.status().lastError, 'no cookie')
  } finally {
    await a.stop()
  }
})

test('没传 opts.cookie：从 owner.json 读；owner 也没有才算 no cookie', async () => {
  resetRisk()
  const f = makeFetch()
  let asked = 0
  const a = create({
    fetchImpl: f.fetchImpl,
    now: () => NOW,
    intervalMs: 60_000,
    readOwnerImpl: async () => { asked++; return { cookie: COOKIE } },
  })
  try {
    assert.deepEqual(await a.start(), { ok: true })
    assert.equal(asked, 1)
  } finally {
    await a.stop()
  }

  const b = create({ fetchImpl: f.fetchImpl, now: () => NOW, readOwnerImpl: async () => null })
  try {
    const r = await b.start()
    assert.equal(r.ok, false)
    assert.equal(r.why, 'no cookie')
  } finally {
    await b.stop()
  }
})

test('cookie 有效：nav 记下 selfUid；首轮只建基线，不回溯历史', async () => {
  resetRisk()
  const f = makeFetch()
  f.state.messages.set('777', [dm(10, 777, { text: '几天前说过的话' })])
  f.state.sessions = [session(777, 10)]
  const got = []
  const a = channel(f)
  a.onMessage((m) => got.push(m))
  try {
    assert.deepEqual(await a.start(), { ok: true })
    assert.equal(f.count('/x/web-interface/nav'), 1)
    // cookie 必须带进 nav —— 不带就是匿名请求，登录态根本验不出来
    assert.match(f.find('/x/web-interface/nav').headers.cookie, /SESSDATA=sess/)
    assert.equal(a._debug().selfUid, SELF_UID)
    assert.equal(a._debug().hasTimer, true)
    assert.equal(a._debug().baselined, true)
    // 首轮那条只是基线：一条都不许上报
    assert.deepEqual(got, [])
    assert.equal(a.status().received, 0)
  } finally {
    await a.stop()
  }
})

test('cookie 失效：nav 回 -101，start 返回 {ok:false}，不开定时器', async () => {
  resetRisk()
  const f = makeFetch()
  f.state.nav = { code: -101, message: '账号未登录' }
  const a = channel(f)
  try {
    const r = await a.start()
    assert.equal(r.ok, false)
    assert.match(r.why, /-101/)
    assert.equal(a._debug().hasTimer, false)
    assert.equal(a.status().connected, false)
    assert.equal(f.count('/session_svr/v1/session_svr/new_sessions'), 0)
  } finally {
    await a.stop()
  }
})

test('轮询上报别人发来的新私信，字段符合契约', async () => {
  resetRisk()
  const f = makeFetch()
  f.state.messages.set('777', [dm(10, 777, { text: '旧消息' })])
  f.state.sessions = [session(777, 10)]
  const got = []
  const a = channel(f)
  a.onMessage((m) => got.push(m))
  try {
    await a.start()
    f.state.messages.get('777').push(dm(11, 777, { text: '你好呀' }))
    f.state.sessions = [session(777, 11, { ts: SESSION_TS + 11 })]
    await a._poll()

    assert.equal(got.length, 1)
    const m = got[0]
    assert.equal(m.channelId, 'bili')
    assert.equal(m.kind, 'dm')
    assert.equal(m.conversationId, '777')
    assert.equal(m.personId, 'u_777')
    assert.equal(m.personName, '阿岚')
    assert.equal(m.text, '你好呀')
    assert.deepEqual(m.images, [])
    assert.equal(m.at, (TS_SEC + 11) * 1000)
    assert.ok(m.raw)
    assert.equal(a.status().received, 1)
  } finally {
    await a.stop()
  }
})

test('自己发的私信不上报，游标照样前进（不会下一轮翻出来）', async () => {
  resetRisk()
  const f = makeFetch()
  f.state.messages.set('777', [dm(10, 777, { text: '旧消息' })])
  f.state.sessions = [session(777, 10)]
  const got = []
  const a = channel(f)
  a.onMessage((m) => got.push(m))
  try {
    await a.start()
    f.state.messages.get('777').push(dm(11, SELF_UID, { text: '我自己回的' }))
    f.state.sessions = [session(777, 11, { ts: SESSION_TS + 11 })]
    await a._poll()
    assert.deepEqual(got, [])
    assert.equal(a._debug().cursors.get('777'), 11)
    // 再来一轮：同一条不会被翻出来重报
    await a._poll()
    assert.deepEqual(got, [])
  } finally {
    await a.stop()
  }
})

test('同一个 msg_key 重复出现只上报一次', async () => {
  resetRisk()
  const f = makeFetch()
  f.state.messages.set('777', [dm(10, 777, { text: '旧消息' })])
  f.state.sessions = [session(777, 10)]
  const got = []
  const a = channel(f)
  a.onMessage((m) => got.push(m))
  try {
    await a.start()
    // 假服务端把同一条消息返回了两遍（seqno 递进、msg_key 一样）
    f.state.messages.get('777').push(
      dm(11, 777, { text: '第一次', msgKey: 'dup-key' }),
      dm(12, 777, { text: '重复', msgKey: 'dup-key' }),
    )
    f.state.sessions = [session(777, 12, { ts: SESSION_TS + 12 })]
    await a._poll()
    assert.equal(got.length, 1)
    assert.equal(got[0].text, '第一次')
  } finally {
    await a.stop()
  }
})

test('纯图片私信：images 收 url，text 是空串；昵称查不到就空串', async () => {
  resetRisk()
  const f = makeFetch()
  f.state.card = { code: -404, message: '风控' }
  f.state.messages.set('777', [dm(10, 777, { text: '旧消息' })])
  f.state.sessions = [session(777, 10)]
  const got = []
  const a = channel(f)
  a.onMessage((m) => got.push(m))
  try {
    await a.start()
    f.state.messages.get('777').push(dm(11, 777, {
      type: 2,
      content: { url: 'https://i0.hdslb.com/bfs/new_dyn/x.png', width: 100, height: 100 },
    }))
    f.state.sessions = [session(777, 11, { ts: SESSION_TS + 11 })]
    await a._poll()
    assert.equal(got.length, 1)
    assert.equal(got[0].text, '')
    assert.deepEqual(got[0].images, ['https://i0.hdslb.com/bfs/new_dyn/x.png'])
    assert.equal(got[0].personName, '')
  } finally {
    await a.stop()
  }
})

test('send 带 csrf / wbi 签名 / dev_id，成功返回 id', async () => {
  resetRisk()
  const f = makeFetch()
  const a = channel(f)
  try {
    await a.start()
    const r = await a.send({ conversation: { kind: 'dm', id: '777', name: '阿岚' }, text: '在吗' })
    assert.equal(r.ok, true)
    assert.equal(r.id, 'msg-1')

    const call = f.find('/web_im/v1/web_im/send_msg')
    assert.ok(call, '应该发了 send_msg')
    const q = new URL(call.url).searchParams
    assert.equal(q.get('w_sender_uid'), SELF_UID)
    assert.equal(q.get('w_receiver_id'), '777')
    assert.ok(q.get('w_rid'), 'start 拿到了 wbi 密钥，请求必须签名')
    const body = new URLSearchParams(call.body)
    assert.equal(body.get('csrf'), 'jct-123')
    assert.equal(body.get('csrf_token'), 'jct-123')
    assert.equal(body.get('msg[receiver_id]'), '777')
    assert.equal(body.get('msg[msg_type]'), '1')
    assert.ok(body.get('msg[dev_id]'))
    assert.equal(JSON.parse(body.get('msg[content]')).content, '在吗')
    assert.equal(a.status().sent, 1)
    // status 会被观测台整个序列化：凭据一个字都不能漏
    const dumped = JSON.stringify(a.status())
    assert.equal(dumped.includes('SESSDATA'), false)
    assert.equal(dumped.includes('jct-123'), false)
  } finally {
    await a.stop()
  }
})

test('风控冷却中 send 直接返回 cooldown，不发请求', async () => {
  resetRisk()
  const f = makeFetch()
  // 借 lib/bili.js 的写接口记一次 -412：RISK 是模块级共享的，私信也要吃这份冷却。
  const client = createClient({
    cookie: COOKIE,
    fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ code: -412, message: '请求被拦截' }) }),
    now: () => NOW,
    minIntervalMs: 1,
    jitterMs: 0,
  })
  const posted = await client.replyAdd(1, '触发一次写风控')
  assert.equal(posted.ok, false)
  assert.equal(inCooldown('write', NOW), true)

  const a = channel(f)
  try {
    const r = await a.send({ conversation: '777', text: '在吗' })
    assert.equal(r.ok, false)
    assert.match(r.why, /^cooldown \d+s$/)
    assert.equal(f.count('/web_im/v1/web_im/send_msg'), 0)
  } finally {
    resetRisk()
    await a.stop()
  }
})

test('超长文本按 500 字切段逐段发', async () => {
  resetRisk()
  const f = makeFetch()
  const a = channel(f)
  const text = '字'.repeat(1200)
  try {
    await a.start()
    const r = await a.send({ conversation: '777', text })
    assert.equal(r.ok, true)
    const calls = f.calls.filter((c) => c.url.includes('/web_im/v1/web_im/send_msg'))
    assert.equal(calls.length, 3)
    const parts = calls.map((c) => JSON.parse(new URLSearchParams(c.body).get('msg[content]')).content)
    assert.deepEqual(parts.map((p) => Array.from(p).length), [500, 500, 200])
    assert.equal(parts.join(''), text)
    assert.equal(a.status().sent, 3)
  } finally {
    await a.stop()
  }
})

test('splitText 按码点切，不会劈开 emoji', () => {
  assert.deepEqual(splitText('😀'.repeat(3), 2), ['😀😀', '😀'])
})
