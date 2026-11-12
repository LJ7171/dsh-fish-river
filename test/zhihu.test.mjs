/**
 * zhihu.test.mjs —— 知乎素材源（子包 api/auth + 主包 lib/platforms/zhihu.js）。
 *
 * 全程不联网：fetch 是假的，子包模块也可以整块注入。
 * 重点验三件事：
 *   - 解析稳（热榜 / 关注动态两种形状）；
 *   - 同一批内容只递一次（快照去重），配额按天归零；
 *   - 素材**不写事件流**（events.jsonl 不该被创建）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fetchHot, fetchFollow } from '../packages/dsh-fish-river-zhihu/api.js'
import {
  gatherZhihu, loadZhihu, readState, writeState, runsToday, statePath,
  fetchZhihuMaterial, renderMaterial,
} from '../lib/platforms/zhihu/zhihu.js'
import { registerZhihuLook, zhihuLookOnce, parseTarget } from '../lib/platforms/zhihu/zhihuLook.js'
import { fetchQuestion, fetchAnswer, fetchComments, htmlToText, extractImages } from '../packages/dsh-fish-river-zhihu/api.js'
import { saveImages } from '../lib/platforms/zhihu/zhihuLook.js'
import { dateKey, normalizeConfig } from '../lib/core/settings.js'
import { lookBeforeWake } from '../lib/life/schedule/scheduler.js'
import { readEvents } from '../lib/core/store.js'

function fakeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
    headers: { getSetCookie: () => [] },
  }
}

async function tempRoot() {
  return await mkdtemp(join(tmpdir(), 'fish-zhihu-'))
}

/* ---------------------------- 子包：解析 ---------------------------- */

test('fetchHot：解析标题 / 热度 / 链接，空的丢掉', async () => {
  const payload = {
    data: [
      { card_id: 'Q_1', target: { title: '第一条热榜', link: { url: 'https://www.zhihu.com/question/1' } }, detail_text: '800 万热度' },
      { card_id: 'Q_2', target: { title: '' } },
      { card_id: 'Q_3', target: { title: '第三条', question: { title: '问题标题' } } },
    ],
  }
  const r = await fetchHot({ cookie: 'z_c0=x', limit: 8, fetchImpl: async () => fakeResponse(payload) })
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 2)
  assert.equal(r.items[0].title, '第一条热榜')
  assert.equal(r.items[0].heat, '800 万热度')
  assert.match(r.items[0].id, /^hot:/)
})

test('fetchHot：不是 JSON / 状态码不对 → ok:false，不抛', async () => {
  const r1 = await fetchHot({ cookie: '', fetchImpl: async () => fakeResponse('<html>403</html>', 403) })
  assert.equal(r1.ok, false)
  const r2 = await fetchHot({ cookie: '', fetchImpl: async () => { throw new Error('net down') } })
  assert.equal(r2.ok, false)
  assert.match(r2.why, /net down/)
})

test('fetchFollow：解析关注动态（作者 + 标题 + 类型），空标题跳过', async () => {
  const payload = {
    data: [
      { id: 'm1', source: { actor: { name: '灵剑' }, target: { type: 'answer', title: '女子早餐摔骨折怎么算工伤' } } },
      { id: 'm2', source: { actor: { name: '随机比特' }, target: { type: 'article', title: '斯坦福重测五十项论文' } } },
      { id: 'm3', source: { actor: { name: '某人' }, target: { type: 'pin', title: '' } } },
    ],
  }
  const r = await fetchFollow({ cookie: 'z_c0=x', limit: 8, fetchImpl: async () => fakeResponse(payload) })
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 2)
  assert.deepEqual(r.items.map((x) => x.author), ['灵剑', '随机比特'])
  assert.equal(r.items[0].kind, 'answer')
})

/* ---------------------------- 主包：去重与素材 ---------------------------- */

function fakeMod({ hot = [], follow = [], cookie = 'z_c0=x' } = {}) {
  const calls = { hot: 0, follow: 0 }
  return {
    calls,
    async readAuth() { return cookie ? { cookie, account: { name: '独自享受' } } : null },
    async fetchHot() { calls.hot += 1; return { ok: true, items: hot } },
    async fetchFollow() { calls.follow += 1; return { ok: true, items: follow } },
  }
}

test('gatherZhihu：第一次全给，第二次同样的内容不再给', async () => {
  const root = await tempRoot()
  try {
    const mod = fakeMod({
      hot: [{ id: 'hot:1', title: '热榜一', heat: '百万' }],
      follow: [{ id: 'feed:1', author: '灵剑', title: '回答一' }],
    })
    const cfg = normalizeConfig({ zhihu: { enabled: true } })
    const a = await gatherZhihu({ root, cfg, mod })
    assert.equal(a.ok, true)
    assert.match(a.text, /热榜一/)
    assert.match(a.text, /灵剑：回答一/)
    assert.equal(a.picks.length, 2)

    const b = await gatherZhihu({ root, cfg, mod })
    assert.equal(b.ok, false)
    assert.match(b.note, /都看过了/)

    // 来了一条新的：只给新的
    mod.fetchHot = async () => ({ ok: true, items: [
      { id: 'hot:1', title: '热榜一', heat: '百万' },
      { id: 'hot:2', title: '热榜二', heat: '十万' },
    ] })
    const c = await gatherZhihu({ root, cfg, mod })
    assert.equal(c.ok, true)
    assert.match(c.text, /热榜二/)
    assert.doesNotMatch(c.text, /热榜一/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('gatherZhihu：没登录 / 关着 / 没装子包 都只降级，不抛', async () => {
  const root = await tempRoot()
  try {
    const cfg = normalizeConfig({ zhihu: { enabled: true } })
    const noLogin = await gatherZhihu({ root, cfg, mod: fakeMod({ cookie: '' }) })
    assert.equal(noLogin.ok, false)
    assert.equal(noLogin.why, 'login-required')

    const off = await gatherZhihu({ root, cfg: normalizeConfig({}), mod: fakeMod() })
    assert.equal(off.why, 'disabled')

    // 不传 mod 时走真实子包：仓库里就有一份，所以这里是「没登录」而不是「没装」。
    // 「没装」那条由 loadZhihu 的用例守。
    const real = await gatherZhihu({ root, cfg })
    assert.equal(real.ok, false)
    assert.equal(real.why, 'login-required')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('gatherZhihu：不写事件流，只写 zhihu-state.json（0600）', async () => {
  const root = await tempRoot()
  try {
    const mod = fakeMod({ hot: [{ id: 'hot:9', title: '一条' }] })
    const cfg = normalizeConfig({ zhihu: { enabled: true } })
    await gatherZhihu({ root, cfg, mod })
    const files = await readdir(root)
    assert.equal(files.includes('events.jsonl'), false, '素材不该进她的记忆')
    assert.equal(files.includes('zhihu-state.json'), true)
    const st = JSON.parse(await readFile(statePath(root), 'utf8'))
    // gatherZhihu 只负责「一次性拉一份素材」，次数由 zhihuTick 记——
    // 所以这里不检查 runs，只检查「这条例被记住了」和「没写事件流」。
    assert.ok(st.seen['hot:9'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('配额按天归零：昨天的 runs 不算今天', async () => {
  const st = { dateKey: '2026-11-03', runs: 3, seen: {} }
  assert.equal(runsToday(st, '2026-11-04'), 0)
  assert.equal(runsToday({ dateKey: '2026-11-04', runs: 3 }, '2026-11-04'), 3)
})

test('readState：文件坏了就当第一次（不拦住一次唤醒）', async () => {
  const root = await tempRoot()
  try {
    const st = await readState(root)
    assert.equal(st.runs, 0)
    await writeState(root, { dateKey: '2026-11-04', runs: 1, seen: {} })
    const st2 = await readState(root)
    assert.equal(st2.runs, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('loadZhihu：没装就返回 null', async () => {
  const mod = await loadZhihu(async () => { const e = new Error('nope'); e.code = 'ERR_MODULE_NOT_FOUND'; throw e })
  assert.equal(mod, null)
})

test('loadZhihu：装了的话领域入口在子包上，不在主包里重写', async () => {
  const mod = await loadZhihu()
  assert.equal(typeof mod.fetchQuestionInvites, 'function')
  assert.equal(typeof mod.answerPublishControl, 'function')
  assert.equal(typeof mod.normalizeZhihu, 'function')
  assert.equal(typeof mod.registerZhihuLook, 'function')
  assert.equal(typeof mod.registerZhihuSpeak, 'function')
  assert.equal(typeof mod.postAnswer, 'function')
  assert.equal(typeof mod.bindHost, 'function')
})

/* ---------------------------- 配置 ---------------------------- */

test('默认配置：关着、配额按「次」进作息、推荐只是逛的内容之一', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.zhihu.enabled, false)
  assert.equal(cfg.sleep.daily.zhihu, 4, '每天刷几次现在由作息配额管')
  assert.equal(cfg.sleep.daily.recommend, undefined, '推荐不再单独占一次配额')
  assert.equal(cfg.zhihu.window, undefined, '白天时段已删除（作息接管）')
  assert.equal(cfg.zhihu.hot.topN, 8)
  assert.equal(cfg.zhihu.follow.topN, 8)
  // 2026-11-04：浏览历史改成默认开（他要求的），措辞仍是「他看的」
  assert.equal(cfg.zhihu.history.enabled, true)
  assert.equal(cfg.zhihu.recommend.enabled, true, '推荐仍是「一次逛什么」里的一项')
  assert.equal(cfg.zhihu.voices, undefined, '读评论设置已撤（功能之后统一到社会层）')
  assert.deepEqual(cfg.zhihu.comment, {
    enabled: false, perDay: 1, replyPerDay: 1, replyToReplies: true, scanEveryMin: 30, lastScanAt: '',
  })
  assert.deepEqual(cfg.zhihu.answer, { enabled: false, perDay: 1 })
})

test('配置夹紧：次数与条数超范围会被拉回', () => {
  const cfg = normalizeConfig({ zhihu: { enabled: true, perDay: 99, hot: { topN: 99 }, follow: { topN: 0 } } })
  assert.equal(cfg.zhihu.perDay, 8)
  assert.equal(cfg.zhihu.hot.topN, 20)
  assert.equal(cfg.zhihu.follow.topN, 1)
})


/* ---------------------------- 现场抓一次（和刷 B 站同一种动作） ---------------------------- */

function fetchMod({ hot = [], follow = [], rec = [], hist = [] } = {}) {
  const calls = { hot: 0, follow: 0, recommend: 0, history: 0, comments: 0 }
  return {
    calls,
    async readAuth() { return { cookie: 'z_c0=x' } },
    async fetchHot() { calls.hot += 1; return { ok: true, items: hot } },
    async fetchFollow() { calls.follow += 1; return { ok: true, items: follow } },
    async fetchRecommend() { calls.recommend += 1; return { ok: true, items: rec } },
    async fetchHistory() { calls.history += 1; return { ok: true, items: hist } },
    async fetchComments() { calls.comments += 1; return { ok: true, comments: [{ text: '这条评论挺长的一句话', likes: 99 }] } },
  }
}

test('现场抓一次：勾选哪几路就抓哪几路，素材当次返回、runs +1', async () => {
  const root = await tempRoot()
  try {
    const mod = fetchMod({ hot: [{ id: 'hot:1', title: '热榜一' }], rec: [{ id: 'rec:1', title: '推荐一' }] })
    const cfg = normalizeConfig({ zhihu: { enabled: true } })
    const r = await fetchZhihuMaterial({ root, cfg, mod, now: new Date('2026-11-04T10:15:00'), fetchImpl: async () => ({ ok: true }) })
    assert.equal(r.ok, true)
    assert.match(r.text, /热榜一/)
    assert.match(r.text, /推荐一/)
    assert.equal(mod.calls.hot, 1)
    assert.equal(mod.calls.recommend, 1)
    assert.equal(mod.calls.follow, 1)
    assert.equal(mod.calls.history, 1)
    const st = await readState(root)
    assert.equal(st.runs, 1, '抓一次算一次上网')
    assert.ok(st.seen['hot:1'])

    // 同样的内容再抓：没有新 id，不重复给
    const again = await fetchZhihuMaterial({ root, cfg, mod, now: new Date('2026-11-04T10:16:00'), fetchImpl: async () => ({ ok: true }) })
    assert.equal(again.ok, false)
    assert.equal(again.acted, true, '请求确实发了')
    assert.equal((await readState(root)).runs, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('配额用完：直接 blocked，一次请求都不发', async () => {
  const root = await tempRoot()
  try {
    const mod = fetchMod({ hot: [{ id: 'hot:9', title: '九' }] })
    const cfg = normalizeConfig({ zhihu: { enabled: true } })
    await writeState(root, { dateKey: '2026-11-04', runs: 4, seen: {} })
    const r = await fetchZhihuMaterial({ root, cfg, mod, now: new Date('2026-11-04T10:15:00') })
    assert.equal(r.ok, false)
    assert.equal(r.blocked, true)
    assert.equal(r.why, 'quota')
    assert.equal(mod.calls.hot + mod.calls.follow + mod.calls.recommend + mod.calls.history, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('没登录 / 关着 / 全不勾：都只降级，不抛', async () => {
  const root = await tempRoot()
  try {
    const mod = fetchMod({})
    const noAuth = { ...mod, readAuth: async () => null }
    const r1 = await fetchZhihuMaterial({ root, cfg: normalizeConfig({ zhihu: { enabled: true } }), mod: noAuth })
    assert.equal(r1.ok, false)
    assert.equal(r1.why, 'login-required')

    const r2 = await fetchZhihuMaterial({ root, cfg: normalizeConfig({}), mod })
    assert.equal(r2.ok, false)
    assert.equal(r2.why, 'disabled')

    const none = normalizeConfig({ zhihu: { enabled: true, hot: { enabled: false }, follow: { enabled: false }, recommend: { enabled: false }, history: { enabled: false } } })
    const r3 = await fetchZhihuMaterial({ root, cfg: none, mod })
    assert.equal(r3.ok, false)
    assert.equal(r3.why, 'nothing-selected')
    assert.equal(mod.calls.hot, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('读评论暂停：配置写 voices:true 也不再拉评论、不写 voice', async () => {
  const root = await tempRoot()
  try {
    const mod = fetchMod({ hot: [{ id: 'hot:5', title: '带评论的题', url: 'https://www.zhihu.com/question/123' }] })
    const cfg = normalizeConfig({ zhihu: { enabled: true, voices: true } })
    const r = await fetchZhihuMaterial({ root, cfg, mod, now: new Date('2026-11-04T10:15:00'), fetchImpl: async () => ({ ok: true }) })
    assert.equal(r.ok, true)
    assert.equal(mod.calls.comments, 0)
    const { events } = await (await import('../lib/core/store.js')).readEvents(root)
    assert.equal(events.filter((e) => e.type === 'voice' && e.channel === 'zhihu').length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('renderMaterial：没有素材就返回空串', () => {
  assert.equal(renderMaterial([]), '')
})

test('zhihu_look 工具：注册成功，参数是合法 JSON Schema；关着时只说看不了', async () => {
  const ctx = { tools: { register: (t) => t } }
  const tool = registerZhihuLook(ctx, { root: '/tmp/x' })
  assert.equal(tool.name, 'zhihu_look')
  assert.equal(tool.parameters.type, 'object')
  assert.ok(tool.parameters.properties.kind.enum.includes('history'))
  const off = await zhihuLookOnce({ root: '/tmp/x', cfg: normalizeConfig({}), kind: 'hot' })
  assert.equal(off.ok, false)
  assert.match(off.note, /看不了/)
})


/* ---------------------------- 点进去：问题 / 回答 / 评论 ---------------------------- */

test('parseTarget：链接与裸 id 都能认', () => {
  assert.deepEqual(parseTarget('https://www.zhihu.com/question/36867384/answer/2101466029390151931'), {
    questionId: '36867384', answerId: '2101466029390151931',
  })
  assert.deepEqual(parseTarget('https://zhuanlan.zhihu.com/p/2091558033625179773'), { articleId: '2091558033625179773' })
  assert.deepEqual(parseTarget('123456'), { raw: '123456' })
  assert.deepEqual(parseTarget(''), {})
})

test('htmlToText：去标签、留段落', () => {
  const t = htmlToText('<p>第一段</p><p>第二段 &amp; 更多<br>换行</p>')
  assert.match(t, /第一段/)
  assert.match(t, /第二段 & 更多/)
  assert.doesNotMatch(t, /<p>/)
})

test('fetchQuestion：标题来自回答里的 question，正文转纯文本', async () => {
  const body = {
    paging: { totals: 2016 },
    data: [{
      id: 111,
      voteup_count: 1904,
      comment_count: 222,
      author: { name: '谭少' },
      question: { id: 36867384, title: '哪些游戏玩物不丧志' },
      content: '<p>刺客信条</p><p>我从来没去过威尼斯</p>',
    }],
  }
  const r = await fetchQuestion({ cookie: 'x', id: '36867384', limit: 1, fetchImpl: async () => fakeResponse(body) })
  assert.equal(r.ok, true)
  assert.equal(r.question.title, '哪些游戏玩物不丧志')
  assert.equal(r.question.answerCount, 2016)
  assert.match(r.answers[0].text, /威尼斯/)
  assert.doesNotMatch(r.answers[0].text, /<p>/)
})

test('fetchAnswer：正文截断、带作者与赞同数', async () => {
  const body = {
    id: 2101466029390151931,
    voteup_count: 9,
    comment_count: 2,
    author: { name: 'Asher' },
    question: { id: 36867384, title: '哪些游戏玩物不丧志' },
    content: `<p>${'长'.repeat(2000)}</p>`,
  }
  const r = await fetchAnswer({ cookie: 'x', id: '2101466029390151931', maxChars: 300, fetchImpl: async () => fakeResponse(body) })
  assert.equal(r.ok, true)
  assert.equal(r.answer.author, 'Asher')
  assert.ok(r.answer.text.length <= 320, `应截断，实际 ${r.answer.text.length}`)
  assert.match(r.answer.text, /……$/)
})

test('fetchComments：answer/article/question 三种 target 的路径都对', async () => {
  const body = { paging: { totals: 7 }, data: [{ id: 1, like_count: 3, author: { name: '一条江' }, content: '<p>不错</p>', child_comment_count: 2 }] }
  const seen = []
  const fake = async (url) => { seen.push(String(url)); return fakeResponse(body) }
  for (const target of ['answer', 'article', 'question']) {
    const r = await fetchComments({ cookie: 'x', target, id: '42', limit: 3, fetchImpl: fake })
    assert.equal(r.ok, true)
    assert.equal(r.comments[0].author, '一条江')
    assert.equal(r.comments[0].likes, 3)
  }
  assert.match(seen[0], /comment_v5\/answers\/42\/root_comment/)
  assert.match(seen[1], /comment_v5\/articles\/42\/root_comment/)
  assert.match(seen[2], /comment_v5\/questions\/42\/root_comment/)
  const bad = await fetchComments({ cookie: 'x', target: 'dm', id: '42' })
  assert.equal(bad.ok, false)
})

function detailMod() {
  return {
    async readAuth() { return { cookie: 'z_c0=x' } },
    async fetchHot() { return { ok: true, items: [] } },
    async fetchRecommend() { return { ok: true, items: [] } },
    async fetchFollow() { return { ok: true, items: [] } },
    async fetchHistory() { return { ok: true, items: [] } },
    async fetchQuestion() {
      return { ok: true, question: { id: '36867384', title: '哪些游戏玩物不丧志', answerCount: 2016 }, answers: [{ id: '1', author: '谭少', votes: 1904, comments: 222, text: '刺客信条', url: 'https://www.zhihu.com/answer/1' }] }
    },
    async fetchAnswer() {
      return { ok: true, answer: { id: '2101466029390151931', question: { title: '哪些游戏玩物不丧志' }, author: 'Asher', votes: 9, comments: 2, text: '正文', url: 'https://www.zhihu.com/answer/2101466029390151931' } }
    },
    async fetchComments() {
      return { ok: true, total: 2, comments: [{ id: 'c1', author: '谢钊', likes: 0, text: '[赞同]', replies: 0 }] }
    },
  }
}

test('zhihuLookOnce：question / answer / comments 三种都能点进去', async () => {
  const root = await tempRoot()
  try {
    const cfg = normalizeConfig({ zhihu: { enabled: true } })
    const mod = detailMod()
    const q = await zhihuLookOnce({ root, cfg, kind: 'question', id: '36867384', mod })
    assert.equal(q.ok, true)
    assert.match(q.text, /问题：哪些游戏玩物不丧志/)
    assert.match(q.text, /谭少/)

    const a = await zhihuLookOnce({ root, cfg, kind: 'answer', id: 'https://www.zhihu.com/question/36867384/answer/2101466029390151931', mod })
    assert.equal(a.ok, true)
    assert.match(a.text, /Asher/)
    assert.match(a.text, /正文/)

    const c = await zhihuLookOnce({ root, cfg, kind: 'comments', id: 'https://www.zhihu.com/question/36867384/answer/2101466029390151931', topN: 3, mod })
    assert.equal(c.ok, true)
    assert.match(c.text, /评论/)
    assert.match(c.text, /谢钊/)

    const dirty = await zhihuLookOnce({ root, cfg, kind: 'answer', id: '', mod })
    assert.equal(dirty.ok, false)
    assert.match(dirty.note, /回答号|链接/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('再拉热榜记 zhihu:，点进去记 zhihu-open:，都不加 runs', async () => {
  const root = await tempRoot()
  try {
    const cfg = normalizeConfig({ zhihu: { enabled: true } })
    const mod = {
      ...detailMod(),
      async readAuth() { return { cookie: 'z' } },
      async fetchHot() { return { ok: true, items: [{ id: 'h1', title: '热榜标题' }] } },
    }
    const hot = await zhihuLookOnce({ root, cfg, kind: 'hot', mod })
    assert.equal(hot.ok, true, hot.note)
    const q = await zhihuLookOnce({ root, cfg, kind: 'question', id: '36867384', mod })
    assert.equal(q.ok, true, q.note)
    const { events } = await readEvents(root)
    const texts = events.map((e) => String(e.text ?? ''))
    const dk = dateKey()
    assert.ok(texts.some((t) => t.startsWith(`zhihu:${dk} `)), texts.join('\n'))
    assert.ok(texts.some((t) => t.startsWith(`zhihu-open:${dk} `)), texts.join('\n'))
    assert.equal(texts.some((t) => t.startsWith('zhihu-comment:')), false)
    assert.equal(runsToday(await readState(root), dk), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('zhihu_look 的参数里包含 question / answer / comments', () => {
  const ctx = { tools: { register: (t) => t } }
  const tool = registerZhihuLook(ctx, { root: '/tmp/x' })
  for (const k of ['question', 'answer', 'comments']) assert.ok(tool.parameters.properties.kind.enum.includes(k))
  assert.ok(tool.parameters.properties.id)
  assert.deepEqual(tool.parameters.properties.target.enum, ['answer', 'article', 'question'])
})


/* ---------------------------- 知乎图片：落盘给 read_image ---------------------------- */

test('extractImages：只认 http(s)，跳过 data: 占位图，去重', () => {
  const html = `
    <p>x</p>
    <img src="https://pic1.zhimg.com/a_720w.jpg" data-original="https://pic1.zhimg.com/a_r.jpg">
    <img src="data:image/svg+xml;utf8,<svg/>">
    <img src="//picx.zhimg.com/b.jpg">
    <img src="https://pic1.zhimg.com/a_720w.jpg">
  `
  const got = extractImages(html, 3)
  assert.deepEqual(got, ['https://pic1.zhimg.com/a_r.jpg', 'https://picx.zhimg.com/b.jpg'])
})

test('saveImages：下载成功的落盘（0600），data: 与坏图跳过', async () => {
  const root = await tempRoot()
  try {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const fetchImpl = async (url) => {
      if (String(url).includes('bad')) return { ok: false, status: 500, arrayBuffer: async () => Buffer.alloc(0) }
      return { ok: true, status: 200, arrayBuffer: async () => jpeg }
    }
    const paths = await saveImages({ root, urls: ['https://pic1.zhimg.com/ok.jpg', 'https://pic1.zhimg.com/bad.jpg'], tag: 'a-1', fetchImpl })
    assert.equal(paths.length, 1)
    assert.match(paths[0], /zhihu-media\/a-1-0\.jpg$/)
    const st = await stat(paths[0])
    if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('zhihuLookOnce：回答里的图会下载，并把路径写进结果', async () => {
  const root = await tempRoot()
  try {
    const cfg = normalizeConfig({ zhihu: { enabled: true } })
    const mod = detailMod()
    mod.fetchAnswer = async () => ({
      ok: true,
      answer: {
        id: '2101466029390151931',
        question: { title: '哪些游戏玩物不丧志' },
        author: 'Asher',
        votes: 9,
        comments: 2,
        text: '正文',
        images: ['https://pic1.zhimg.com/ok.jpg'],
        url: 'https://www.zhihu.com/answer/2101466029390151931',
      },
    })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => jpeg })
    const r = await zhihuLookOnce({ root, cfg, kind: 'answer', id: '2101466029390151931', mod, fetchImpl })
    assert.equal(r.ok, true)
    assert.match(r.text, /read_image/)
    assert.match(r.text, /zhihu-media\/a-2101466029390151931-0\.jpg/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('zhihuLookOnce：看图关掉不落盘；max 截断张数', async () => {
  const root = await tempRoot()
  try {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => jpeg })
    const mod = detailMod()
    mod.fetchAnswer = async () => ({
      ok: true,
      answer: {
        id: '1',
        question: { title: '题' },
        author: '甲',
        votes: 1,
        comments: 0,
        text: '正文',
        images: [
          'https://pic1.zhimg.com/a.jpg',
          'https://pic1.zhimg.com/b.jpg',
          'https://pic1.zhimg.com/c.jpg',
        ],
        url: 'https://www.zhihu.com/answer/1',
      },
    })
    const off = await zhihuLookOnce({
      root,
      cfg: normalizeConfig({ zhihu: { enabled: true, images: { enabled: false } } }),
      kind: 'answer',
      id: '1',
      mod,
      fetchImpl,
    })
    assert.equal(off.ok, true)
    assert.match(off.text, /正文/)
    assert.doesNotMatch(off.text, /read_image|zhihu-media/)

    const capped = await zhihuLookOnce({
      root,
      cfg: normalizeConfig({ zhihu: { enabled: true, images: { enabled: true, max: 2 } } }),
      kind: 'answer',
      id: '1',
      mod,
      fetchImpl,
    })
    assert.equal(capped.ok, true)
    const hits = capped.text.match(/zhihu-media[/\\]a-1-\d+\.jpg/g) || []
    assert.equal(hits.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('出门抓知乎写 zhihu:，不写 tieba:（前缀不能串）', async () => {
  const root = await tempRoot()
  try {
    const cfg = normalizeConfig({ zhihu: { enabled: true } })
    const mod = fetchMod({ hot: [{ id: 'hot:1', title: '热榜一' }] })
    const out = await lookBeforeWake(
      root,
      { day: 1, stage: 1 },
      cfg,
      '2026-11-04',
      { channels: ['zhihu'], zhihuMod: mod, zhihuFetch: async () => ({ ok: true }), now: new Date('2026-11-04T10:15:00') },
      () => {},
    )
    assert.equal(out.acted.zhihu, true)
    const { events } = await readEvents(root)
    const metas = events.filter((e) => e.type === 'meta').map((e) => String(e.text ?? ''))
    assert.ok(metas.some((t) => t.startsWith('zhihu:')), `应写 zhihu:，实际 ${metas.join(' | ')}`)
    assert.equal(metas.some((t) => t.startsWith('tieba:')), false, '知乎不能写成 tieba:')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
