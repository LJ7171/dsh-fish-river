/**
 * 抖音渠道（子包）测试：用假 CDP 传输层，不启动任何浏览器。
 *
 * 2026-11-02 改版后的契约：
 *   · 收消息走 `Network.webSocketFrameReceived`（protobuf 帧里的裸 UTF-8）；
 *   · 发消息走真实鼠标事件（点会话 → 点输入框 → insertText → 回车）；
 *   · DOM 只剩两件事：刷新会话列表、定位要点的元素。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  create,
  parseDmFrame,
  splitText,
  normalizeMessage,
  browserCandidates,
} from '../packages/dsh-fish-river-douyin/index.js'

function fakeTransport(state = {}) {
  const seen = { clicked: [], typed: [], entered: 0, events: new Set() }
  if (state.panelOpen === undefined) state.panelOpen = true
  const hasPanel = () => state.panelOpen !== false
  const states = () => (hasPanel() ? (state.convos ?? []) : [])
  const t = {
    state,
    seen,
    async launch() { return state.launch ?? { ok: true } },
    async navigate(url) { state.navigated = url; return { ok: true } },
    async bringToFront() { seen.fronted = true; return { ok: true } },
    async evaluate(expr) {
      // 2026-11-02 真机改版后，发送前要先「量盒子」：面板关着时节点还在，只是 0×0。
      if (expr.includes('usable')) {
        const n = states().length
        return { ok: true, value: JSON.stringify(n ? { ok: true, x: 10, y: 10 } : { ok: false, why: 'no-item' }) }
      }
      if (expr.includes('getBoundingClientRect')) {
        const n = states().length
        if (expr.includes('contenteditable')) return { ok: true, value: 'true' }
        return { ok: true, value: n > 0 ? 'true' : 'false' }
      }
      if (expr.includes('convos')) {
        return { ok: true, value: JSON.stringify({ ok: true, convos: states() }) }
      }
      if (expr.includes('im-dialog')) {
        return { ok: true, value: JSON.stringify({ ok: true, lines: state.lines ?? [] }) }
      }
      return { ok: true, value: JSON.stringify({ ok: true }) }
    },
    async enableNetwork() { state.network = true; return { ok: true } },
    onEvent(fn) { seen.events.add(fn); return () => seen.events.delete(fn) },
    async clickSelector(sel) {
      seen.clicked.push(sel)
      if (String(sel).includes('im-entry')) state.panelOpen = !hasPanel()
      return { ok: true }
    },
    async clickNth(sel, i) { seen.clicked.push(`${sel}#${i}`); return { ok: true } },
    async clickPoint(x, y) { seen.clicked.push(`point:${x},${y}`); return { ok: true } },
    async typeText(text) { seen.typed.push(text); return { ok: true } },
    async pressEnter() { seen.entered += 1; return { ok: true } },
    async close() { state.closed = true },
  }
  t.emitFrame = (payloadData) => {
    for (const fn of seen.events) fn('Network.webSocketFrameReceived', { response: { payloadData } })
  }
  return t
}

const frameOf = (sender, text) => Buffer.concat([
  Buffer.from('x_frontier_msg_id', 'utf8'),
  Buffer.from(sender, 'utf8'),
  Buffer.from('私信了你', 'utf8'),
  Buffer.from(text, 'utf8'),
]).toString('base64')

test('没有浏览器时 start 返回 ok:false，而不是抛异常', async () => {
  const t = fakeTransport({ launch: { ok: false, why: '没找到 Edge 或 Chrome' } })
  const a = create({ transport: t })
  const r = await a.start()
  assert.equal(r.ok, false)
  assert.match(r.why, /Edge|Chrome/)
  assert.equal(a.status().connected, false)
})

test('start 后打开私信面板，首轮只建基线、不发消息', async () => {
  let got = 0
  const t = fakeTransport({ convos: [{ id: '小王', name: '小王', preview: '在吗' }] })
  const a = create({ transport: t, intervalMs: 999999, bootWaitMs: 0, openWaitMs: 1 })
  a.onMessage(() => { got += 1 })
  const r = await a.start()
  assert.equal(r.ok, true)
  assert.equal(t.state.navigated, 'https://www.douyin.com/jingxuan')
  assert.equal(t.state.network, true, '必须开网络事件，否则收不到帧')
  assert.equal(got, 0)
  await a.stop()
})

test('落哪一页听配置的：填了推荐频道就去推荐频道', async () => {
  const t = fakeTransport()
  const a = create({ transport: t, homeUrl: 'www.douyin.com/?recommend=1', bootWaitMs: 0 })
  await a.start()
  assert.equal(t.state.navigated, 'https://www.douyin.com/?recommend=1')
  await a.stop()
})

test('帧来了：解出谁说了什么，归一成形如 u_昵称 的人', async () => {
  const t = fakeTransport({ convos: [{ id: '小满', name: '小满' }] })
  const a = create({ transport: t, intervalMs: 999999, bootWaitMs: 0 })
  const got = []
  a.onMessage((m) => got.push(m))
  await a.start()
  t.emitFrame(frameOf('小满', '收到了吗'))
  assert.equal(got.length, 1)
  assert.equal(got[0].text, '收到了吗')
  assert.equal(got[0].conversationName, '小满')
  assert.equal(got[0].personId, 'u_小满')
  await a.stop()
})

test('不是私信的心跳帧不会变成消息', async () => {
  const t = fakeTransport({ convos: [] })
  const a = create({ transport: t, intervalMs: 999999, bootWaitMs: 0 })
  const got = []
  a.onMessage((m) => got.push(m))
  await a.start()
  t.emitFrame(Buffer.from('hi').toString('base64'))
  assert.equal(got.length, 0)
  await a.stop()
})

test('send：点会话 → 点输入框 → 打字 → 回车', async () => {
  const t = fakeTransport({ convos: [{ id: '小满', name: '小满' }] })
  const a = create({ transport: t, intervalMs: 999999, bootWaitMs: 0, openWaitMs: 1 })
  await a.start()
  const r = await a.send({ conversation: { id: '小满', name: '小满' }, text: '在的' })
  assert.equal(r.ok, true)
  assert.deepEqual(t.seen.typed, ['在的'])
  assert.equal(t.seen.entered, 1)
  assert.ok(t.seen.clicked.some((s) => s.includes('contenteditable')), '要先点输入框拿到焦点')
  await a.stop()
})

test('send：面板被收起来时先点开再发，别把话丢掉', async () => {
  // 2026-11-02 真机：页面把私信面板收起来之后，节点还在但盒子是 0×0，
  // 旧代码当成「找不到会话」，一条已经生成好的话就没了。
  const t = fakeTransport({ convos: [{ id: '小满', name: '小满' }] })
  const a = create({ transport: t, intervalMs: 999999, bootWaitMs: 0, openWaitMs: 1 })
  await a.start()
  t.state.panelOpen = false // 发之前，页面把面板收起来了
  const r = await a.send({ conversation: { id: '小满', name: '小满' }, text: '在的' })
  assert.equal(r.ok, true)
  assert.deepEqual(t.seen.typed, ['在的'])
  assert.ok(t.seen.clicked.some((s) => String(s).includes('im-entry')), '要先把面板点开')
  await a.stop()
})

test('send：长文本按 900 字切段，逐段发', async () => {
  const t = fakeTransport({ convos: [{ id: '小满', name: '小满' }] })
  const a = create({ transport: t, intervalMs: 999999, bootWaitMs: 0, openWaitMs: 1 })
  await a.start()
  await a.send({ conversation: { id: '小满' }, text: 'あ'.repeat(1900) })
  assert.equal(t.seen.typed.length, 3)
  assert.equal(t.seen.entered, 3)
  await a.stop()
})

test('send：没连上时直接说 not-connected', async () => {
  const a = create({ transport: fakeTransport({}) })
  const r = await a.send({ conversation: { id: 'x' }, text: 'hi' })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'not-connected')
})

test('status 只有七个字段，且不含 cookie / 令牌', async () => {
  const t = fakeTransport({ convos: [] })
  const a = create({ transport: t, intervalMs: 999999, bootWaitMs: 0 })
  await a.start()
  const s = a.status()
  assert.deepEqual(Object.keys(s).sort(), ['connected', 'lastError', 'ok', 'queued', 'received', 'sent', 'since'])
  await a.stop()
})

test('parseDmFrame：sender 在标记前、正文在标记后', () => {
  assert.deepEqual(parseDmFrame(frameOf('小满', '这条是测试')), { sender: '小满', text: '这条是测试' })
})

test('splitText / normalizeMessage / browserCandidates 还是老契约', () => {
  assert.equal(splitText('a'.repeat(1000), 900).length, 2)
  const m = normalizeMessage({ text: 'hi', at: 1 }, { conversation: { id: 'c1', name: '小王', kind: 'dm' } })
  assert.equal(m.personId, 'u_c1')
  assert.ok(browserCandidates('win32').some((p) => /msedge\.exe$/.test(p)))
})
