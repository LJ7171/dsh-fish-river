/**
 * zhihu-question-sources.test.mjs —— 问题来源、回答发布、评论参数（2026-11-11）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { fetchQuestionInvites, fetchQuestionRecommend, createAnswer, createComment } from '../packages/dsh-fish-river-zhihu/api.js'

function fakeFetch(handler) {
  return async (url, opts = {}) => handler(String(url), opts)
}

test('邀请回答：只取问题，跳过已回答/关闭，保留来源', async () => {
  let seenUrl = ''
  const fetchImpl = fakeFetch((url) => {
    seenUrl = url
    return {
    status: 200,
    text: async () => JSON.stringify({ data: [
      { target: { id: 'q1', title: '邀请一', type: 'question', url: 'https://api.zhihu.com/questions/q1' } },
      { target: { id: 'q2', title: '已经答过', type: 'question', has_answer: true } },
      { target: { id: 'q3', title: '关闭了', type: 'question', status: { is_close: true } } },
    ] }),
  }
  })
  const r = await fetchQuestionInvites({ cookie: 'c', fetchImpl })
  assert.equal(r.ok, true)
  assert.deepEqual(r.items.map((x) => x.id), ['q1'])
  assert.equal(r.items[0].source, 'invite')
  assert.equal(r.items[0].url, 'https://www.zhihu.com/question/q1')
  assert.match(seenUrl, /timeline\/entry\/invite/)
})

test('作者推荐：跳过草稿，只留问题', async () => {
  const fetchImpl = fakeFetch(() => ({
    status: 200,
    text: async () => JSON.stringify({ data: [
      { question: { id: 'q9', title: '推荐一', type: 'question' } },
      { is_in_draft: true, question: { id: 'q10', title: '草稿' } },
    ] }),
  }))
  const r = await fetchQuestionRecommend({ cookie: 'c', fetchImpl })
  assert.deepEqual(r.items.map((x) => x.id), ['q9'])
  assert.equal(r.items[0].source, 'recommend')
})

test('写回答：先 GET 控制，再 POST content/publish，正文是 HTML', async () => {
  const calls = []
  const fetchImpl = fakeFetch((url, opts) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
    if (url.includes('/content/publish/control/v2')) {
      return { status: 200, text: async () => JSON.stringify({ code: 0, data: {} }) }
    }
    return { status: 200, text: async () => JSON.stringify({ code: 0, data: { result: JSON.stringify({ publish: { id: 'ans1' } }) } }) }
  })
  const r = await createAnswer({ cookie: '_xsrf=abc; z_c0=1', questionId: 'q1', content: '你好\n\n世界', fetchImpl })
  assert.equal(r.ok, true, r.why)
  assert.equal(r.id, 'ans1')
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /content\/publish\/control\/v2/)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[1].url, 'https://www.zhihu.com/api/v4/content/publish')
  assert.equal(calls[1].method, 'POST')
  assert.equal(calls[1].body.action, 'answer')
  assert.equal(calls[1].body.data.extra_info.question_id, 'q1')
  assert.match(calls[1].body.data.hybrid.html, /<p>你好<\/p><p>世界<\/p>/)
  assert.equal(calls[1].body.data.hybrid.textLength, 6)
})

test('评论主楼 reply_comment_id=0；回复带 reply_root_comment_id', async () => {
  const bodies = []
  const fetchImpl = fakeFetch((url, opts) => {
    bodies.push(JSON.parse(opts.body))
    return { status: 200, text: async () => JSON.stringify({ id: 'c1' }) }
  })
  await createComment({ cookie: '_xsrf=abc; z_c0=1', id: 'ans1', content: '一句', fetchImpl })
  assert.equal(bodies[0].reply_comment_id, '0')
  assert.match(bodies[0].content, /<p>一句<\/p>/)
  await createComment({ cookie: '_xsrf=abc; z_c0=1', id: 'ans1', content: '回', replyCommentId: 'child', replyRootCommentId: 'root', fetchImpl })
  assert.equal(bodies[1].reply_comment_id, 'child')
  assert.equal(bodies[1].reply_root_comment_id, 'root')
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchZhihuMaterial } from '../lib/platforms/zhihu.js'
import { normalizeConfig, DEFAULTS } from '../lib/core/settings.js'
import { ZHIHU_DEFAULTS } from '../packages/dsh-fish-river-zhihu/config.js'

test('刷知乎：开着回答才抓邀请/推荐，并把首页问题一起递给她', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-zq-'))
  try {
    const calls = []
    const mod = {
      readAuth: async () => ({ cookie: 'c' }),
      fetchHot: async () => ({ ok: true, items: [] }),
      fetchFollow: async () => ({ ok: true, items: [] }),
      fetchHistory: async () => ({ ok: true, items: [] }),
      fetchRecommend: async () => ({ ok: true, items: [{ id: 'rec:qhome', kind: 'question', title: '首页问题', url: 'https://www.zhihu.com/question/qhome' }] }),
      fetchQuestionInvites: async () => { calls.push('invite'); return { ok: true, items: [{ id: 'qinv', title: '邀请问题', source: 'invite' }] } },
      fetchQuestionRecommend: async () => { calls.push('recommend'); return { ok: true, items: [{ id: 'qrec', title: '推荐问题', source: 'recommend' }] } },
    }
    const on = normalizeConfig({ zhihu: { enabled: true, answer: { enabled: true } } })
    const r = await fetchZhihuMaterial({ root, cfg: on, mod, now: new Date('2026-11-11T10:00:00+08:00') })
    assert.equal(r.ok, true)
    assert.match(r.text, /## 可以回答的问题/)
    assert.match(r.text, /邀请问题（问题 qinv，邀请）/)
    assert.match(r.text, /推荐问题（问题 qrec，推荐）/)
    assert.match(r.text, /首页问题（问题 qhome，首页）/)
    assert.deepEqual(calls.sort(), ['invite', 'recommend'])

    calls.length = 0
    const off = normalizeConfig({ zhihu: { enabled: true, answer: { enabled: false } } })
    const r2 = await fetchZhihuMaterial({ root, cfg: off, mod, now: new Date('2026-11-11T11:00:00+08:00') })
    assert.equal(calls.length, 0, '回答关着就不抓问题源')
    assert.doesNotMatch(r2.text, /可以回答的问题/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('素材全关、只开回答：仍然抓问题源', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-zq-only-'))
  try {
    const calls = []
    const mod = {
      readAuth: async () => ({ cookie: 'c' }),
      fetchHot: async () => ({ ok: true, items: [] }),
      fetchFollow: async () => ({ ok: true, items: [] }),
      fetchHistory: async () => ({ ok: true, items: [] }),
      fetchRecommend: async () => ({ ok: true, items: [] }),
      fetchQuestionInvites: async () => { calls.push('invite'); return { ok: true, items: [{ id: 'qonly', title: '只回答也不该漏', source: 'invite' }] } },
      fetchQuestionRecommend: async () => { calls.push('recommend'); return { ok: true, items: [] } },
    }
    const cfg = normalizeConfig({
      zhihu: {
        enabled: true, hot: { enabled: false }, follow: { enabled: false }, recommend: { enabled: false }, history: { enabled: false },
        answer: { enabled: true, perDay: 1 },
      },
    })
    const r = await fetchZhihuMaterial({ root, cfg, mod, now: new Date('2026-11-11T10:00:00+08:00') })
    assert.match(r.text, /只回答也不该漏/)
    assert.deepEqual(calls.sort(), ['invite', 'recommend'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('问题候选当天只递一次；回答额度为 0 不抓', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-zq-dedupe-'))
  try {
    let calls = 0
    const mod = {
      readAuth: async () => ({ cookie: 'c' }),
      fetchHot: async () => ({ ok: true, items: [] }),
      fetchFollow: async () => ({ ok: true, items: [] }),
      fetchHistory: async () => ({ ok: true, items: [] }),
      fetchRecommend: async () => ({ ok: true, items: [] }),
      fetchQuestionInvites: async () => { calls += 1; return { ok: true, items: [{ id: 'qdup', title: '同一个问题', source: 'invite' }] } },
      fetchQuestionRecommend: async () => ({ ok: true, items: [] }),
    }
    const cfg = normalizeConfig({ zhihu: { enabled: true, answer: { enabled: true, perDay: 1 } } })
    const now = new Date('2026-11-11T10:00:00+08:00')
    const a = await fetchZhihuMaterial({ root, cfg, mod, now })
    assert.match(a.text, /同一个问题/)
    const b = await fetchZhihuMaterial({ root, cfg, mod, now: new Date('2026-11-11T11:00:00+08:00') })
    assert.doesNotMatch(b.text, /同一个问题/)
    assert.equal(calls, 2)

    const zero = normalizeConfig({ zhihu: { enabled: true, answer: { enabled: true, perDay: 0 } } })
    calls = 0
    await fetchZhihuMaterial({ root, cfg: zero, mod, now: new Date('2026-11-11T12:00:00+08:00') })
    assert.equal(calls, 0, '每天 0 条就不抓')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('主包 DEFAULTS.zhihu 和子包 ZHIHU_DEFAULTS 不漂移', () => {
  assert.deepEqual(DEFAULTS.zhihu, ZHIHU_DEFAULTS)
})
