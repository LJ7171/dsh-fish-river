/**
 * zhihu.test.mjs —— 知乎素材源（子包 api/auth + 主包 lib/zhihu.js）。
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
  zhihuTick, takePendingMaterial, renderMaterial, inZhihuWindow,
} from '../lib/zhihu.js'
import { registerZhihuLook, zhihuLookOnce, parseTarget } from '../lib/zhihuLook.js'
import { fetchQuestion, fetchAnswer, fetchComments, htmlToText, extractImages } from '../packages/dsh-fish-river-zhihu/api.js'
import { saveImages } from '../lib/zhihuLook.js'
import { normalizeConfig } from '../lib/settings.js'

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

/* ---------------------------- 配置 ---------------------------- */

test('默认配置：关着、白天 08:00–20:00、推荐单独 8 次', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.zhihu.enabled, false)
  assert.equal(cfg.zhihu.perDay, 4)
  assert.deepEqual(cfg.zhihu.window, ['08:00', '20:00'])
  assert.equal(cfg.zhihu.hot.topN, 8)
  assert.equal(cfg.zhihu.follow.topN, 8)
  // 2026-11-04：浏览历史改成默认开（他要求的），措辞仍是「他看的」
  assert.equal(cfg.zhihu.history.enabled, true)
  assert.equal(cfg.zhihu.recommend.enabled, true)
  assert.equal(cfg.zhihu.recommend.perDay, 8)
})

test('配置夹紧：次数与条数超范围会被拉回', () => {
  const cfg = normalizeConfig({ zhihu: { enabled: true, perDay: 99, hot: { topN: 99 }, follow: { topN: 0 } } })
  assert.equal(cfg.zhihu.perDay, 8)
  assert.equal(cfg.zhihu.hot.topN, 20)
  assert.equal(cfg.zhihu.follow.topN, 1)
})


/* ---------------------------- 定时翻 + 攒素材 ---------------------------- */

function tickMod({ hot = [], rec = [] } = {}) {
  return {
    async readAuth() { return { cookie: 'z_c0=x' } },
    async fetchHot() { return { ok: true, items: hot } },
    async fetchFollow() { return { ok: true, items: [] } },
    async fetchHistory() { return { ok: true, items: [] } },
    async fetchRecommend() { return { ok: true, items: rec } },
  }
}

test('zhihuTick：窗口外一次都不翻（默认 08:00–20:00）', async () => {
  const root = await tempRoot()
  try {
    const mod = tickMod({ hot: [{ id: 'hot:1', title: '一' }] })
    const cfg = normalizeConfig({ zhihu: { enabled: true } })
    const night = new Date('2026-11-04T21:30:00')
    assert.equal(inZhihuWindow(cfg, night), false)
    const r = await zhihuTick({ root, cfg, now: night, rnd: () => 0, mod })
    assert.equal(r.ran, false)
    assert.equal(r.why, 'out-of-window')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('zhihuTick：同一分钟只掷一次骰子；命中就把新的攒进 pending', async () => {
  const root = await tempRoot()
  try {
    const mod = tickMod({ hot: [{ id: 'hot:1', title: '热榜一' }], rec: [{ id: 'rec:1', title: '推荐一' }] })
    const cfg = normalizeConfig({ zhihu: { enabled: true } })
    const now = new Date('2026-11-04T10:15:00')
    const a = await zhihuTick({ root, cfg, now, rnd: () => 0, mod })
    assert.equal(a.ran, true)
    assert.ok(a.items >= 2)
    const st = await readState(root)
    assert.equal(st.runs, 1)
    assert.equal(st.recRuns, 1)
    assert.ok(st.pending.length >= 2)

    // 同一分钟再来一次：lastMinute 挡住，不重复翻
    const b = await zhihuTick({ root, cfg, now, rnd: () => 0, mod })
    assert.equal(b.ran, false)
    assert.equal(b.why, 'same-minute')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('zhihuTick：骰子没中就不发请求（概率纪律）', async () => {
  const root = await tempRoot()
  try {
    let calls = 0
    const mod = {
      async readAuth() { return { cookie: 'z_c0=x' } },
      async fetchHot() { calls += 1; return { ok: true, items: [] } },
      async fetchFollow() { return { ok: true, items: [] } },
      async fetchHistory() { return { ok: true, items: [] } },
      async fetchRecommend() { calls += 1; return { ok: true, items: [] } },
    }
    const cfg = normalizeConfig({ zhihu: { enabled: true } })
    const r = await zhihuTick({ root, cfg, now: new Date('2026-11-04T10:15:00'), rnd: () => 0.999, mod })
    assert.equal(r.ran, false)
    assert.equal(calls, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('takePendingMaterial：拼成素材并清空 pending（seen 留着）', async () => {
  const root = await tempRoot()
  try {
    await writeState(root, {
      dateKey: '2026-11-04', runs: 1, recRuns: 1,
      seen: { 'hot:1': Date.now(), 'rec:1': Date.now(), 'hist:1': Date.now() },
      pending: [
        { kind: 'hot', id: 'hot:1', title: '热榜一', heat: '百万' },
        { kind: 'recommend', id: 'rec:1', title: '推荐一', author: '某人' },
        { kind: 'history', id: 'hist:1', title: '他看过的题' },
      ],
    })
    const r = await takePendingMaterial(root)
    assert.match(r.text, /热榜一/)
    assert.match(r.text, /首页推给你的/)
    assert.match(r.text, /重要的人最近看过的/)
    assert.match(r.text, /这是重要的人知乎账号上刷到的/)
    assert.doesNotMatch(r.text, /主人/)
    assert.match(r.text, /不是她经历的|不是你经历的/)
    const st = await readState(root)
    assert.equal(st.pending.length, 0)
    assert.ok(st.seen['hot:1'], 'seen 要留着，避免同一批再递一次')
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
    assert.equal(st.mode & 0o777, 0o600)
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
