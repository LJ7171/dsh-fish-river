/**
 * 知乎 / 贴吧说话。默认关，她自己写。
 * 硬限制对齐 B 站评论；写回答单独配额；标成主人也可以发，但回述里写清是谁的号。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig, dateKey } from '../lib/core/settings.js'
import { appendEvent, readEvents, writeConfig } from '../lib/core/store.js'
import { sleepPath } from '../lib/life/schedule/sleep.js'
import {
  formatTiebaForum,
  formatTiebaThread,
  formatZhihuComment,
  formatZhihuOpen,
  parseAct,
} from '../lib/core/acts.js'
import { postAnswer, postComment as postZhihuComment, postReply as postZhihuReply, scanIfAwake as scanZhihuIfAwake, renderReplies as renderZhihuReplies } from '../lib/platforms/zhihu/zhihuComment.js'
import { postComment as postTiebaComment, postReply as postTiebaReply, scanIfAwake as scanTiebaIfAwake, renderReplies as renderTiebaReplies } from '../lib/platforms/tieba/tiebaComment.js'
import { zhihuSpeakOnce, registerZhihuSpeak, noteZhihuSpeak } from '../lib/platforms/zhihu/zhihuSpeak.js'
import { tiebaSpeakOnce, registerTiebaSpeak, noteTiebaSpeak } from '../lib/platforms/tieba/tiebaSpeak.js'
import { renderSelfDoc } from '../lib/mind/selfdoc.js'
import { modelOf } from '../lib/mind/derive.js'
import { scanDue } from '../lib/life/replyScan.js'
import { resetSpeakRisk } from '../lib/platforms/common/speakRisk.js'
import { addThreadPost, floorRepliesFrom } from '../lib/platforms/tieba/tieba.js'
import { createComment, fetchChildComments, resetZhihuWriteRisk } from '../packages/dsh-fish-river-zhihu/api.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-speak-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

async function meta(root, text) {
  await appendEvent({ type: 'meta', text }, { day: 0, stage: 1, source: 'system' }, root)
}

async function ready(root, patch) {
  await writeConfig(normalizeConfig(patch), root)
  await meta(root, 'social-open:2026-11-01T00:00:00.000Z')
}

function zhihuApi() {
  const calls = []
  return {
    calls,
    async createComment(args) {
      calls.push(['comment', args])
      return { ok: true, id: `c${calls.length}` }
    },
    async createAnswer(args) {
      calls.push(['answer', args])
      return { ok: true, id: 'a1' }
    },
    async fetchChildComments(args) {
      calls.push(['child', args])
      return { ok: true, comments: [] }
    },
  }
}

function tiebaApi() {
  const calls = []
  return {
    calls,
    async addPost(args) {
      calls.push(['post', args])
      return { ok: true, pid: `p${calls.length}` }
    },
    async floor(args) {
      calls.push(['floor', args])
      return { ok: true, replies: [] }
    },
  }
}

function fakeCtx() {
  const defs = []
  return { defs, tools: { register(d) { defs.push(d); return () => {} } } }
}

test('开关关着就拒，说明里不许诺发得出去', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await ready(root, {})
    await meta(root, formatZhihuOpen(dk, 'ans1', '一条回答'))
    const api = zhihuApi()
    const r = await zhihuSpeakOnce({ root, api, cookie: 'x', kind: 'comment', id: 'ans1', text: '想说', dateKey: dk })
    assert.equal(r.ok, false)
    assert.match(r.note, /不方便/)
    assert.doesNotMatch(r.note, /配额|开关|还剩|\d/)
    assert.equal(api.calls.length, 0)

    const ctx = fakeCtx()
    registerZhihuSpeak(ctx, { root })
    const def = ctx.defs.find((d) => d.name === 'zhihu_speak')
    noteZhihuSpeak(false)
    assert.doesNotMatch(def.description, /可以给你|写一个回答|留一条评论|发出去/)
    noteZhihuSpeak({ comment: true, answer: false, owner: 'owner' })
    assert.match(def.description, /今天点开过/)
    assert.match(def.description, /重要的人/)
    noteZhihuSpeak(false)
  })
})

test('配额用尽只说状态；写回答不占用评论次数', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await ready(root, {
      zhihu: {
        owner: 'owner',
        comment: { enabled: true, perDay: 1, replyPerDay: 1 },
        answer: { enabled: true, perDay: 1 },
      },
    })
    await meta(root, formatZhihuOpen(dk, 'ans1', '一条回答', { question: 'q1' }))
    await meta(root, formatZhihuOpen(dk, 'q1', '一个问题'))
    const api = zhihuApi()
    const first = await zhihuSpeakOnce({ root, api, cookie: 'x', kind: 'comment', id: 'ans1', text: '第一句', dateKey: dk })
    assert.equal(first.ok, true, first.note)
    assert.match(first.note, /说出去了/)
    assert.match(first.note, /重要的人的知乎号/)
    const second = await zhihuSpeakOnce({ root, api, cookie: 'x', kind: 'comment', id: 'ans1', text: '第二句', dateKey: dk })
    assert.equal(second.ok, false)
    assert.match(second.note, /说得够多/)
    assert.doesNotMatch(second.note, /配额|开关|还剩|\d/)
    const answer = await zhihuSpeakOnce({ root, api, cookie: 'x', kind: 'answer', id: 'q1', text: '一个回答', dateKey: dk })
    assert.equal(answer.ok, true, answer.note)
    const { events } = await readEvents(root)
    const texts = events.map((e) => String(e.text ?? ''))
    assert.equal(texts.filter((t) => t.startsWith(`zhihu-comment:${dk} `)).length, 1)
    assert.equal(texts.filter((t) => t.startsWith(`zhihu-answer:${dk} `)).length, 1)
    const again = await zhihuSpeakOnce({ root, api, cookie: 'x', kind: 'answer', id: 'q1', text: '再写一条', dateKey: dk })
    assert.equal(again.ok, false)
    assert.match(again.note, /说得够多/)
  })
})

test('今天没点开的不说；刷列表和进吧不算点开', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await ready(root, {
      zhihu: { comment: { enabled: true }, answer: { enabled: true } },
      tieba: { comment: { enabled: true } },
    })
    await meta(root, `zhihu:${dk} [{"title":"热榜"}]`)
    await meta(root, formatZhihuOpen(dk, 'q-only', '只看了问题'))
    await meta(root, `tieba:${dk} [{"title":"首页"}]`)
    await meta(root, formatTiebaForum(dk, 'meme吧'))
    const z = zhihuApi()
    const comment = await zhihuSpeakOnce({ root, api: z, cookie: 'x', kind: 'comment', id: 'ans-miss', text: '路过', dateKey: dk })
    assert.equal(comment.ok, false)
    assert.match(comment.note, /zhihu_look/)
    assert.match(comment.note, /别的/)
    assert.equal(z.calls.length, 0)
    const onQuestion = await postZhihuComment({ root, api: z, cookie: 'x', answerId: 'ans-under-q', text: '问题页不算这条回答', dateKey: dk })
    assert.equal(onQuestion.ok, false)
    assert.match(onQuestion.why, /没打开/)
    const answer = await zhihuSpeakOnce({ root, api: z, cookie: 'x', kind: 'answer', id: 'q-miss', text: '没看过的问题', dateKey: dk })
    assert.equal(answer.ok, false)
    assert.match(answer.note, /问题/)
    assert.match(answer.note, /zhihu_look/)
    const wrote = await zhihuSpeakOnce({ root, api: z, cookie: 'x', kind: 'answer', id: 'q-only', text: '看过这个问题', dateKey: dk })
    assert.equal(wrote.ok, true, wrote.note)

    const t = tiebaApi()
    const post = await tiebaSpeakOnce({ root, api: t, kind: 'comment', id: 'tid-miss', text: '跟一帖', dateKey: dk })
    assert.equal(post.ok, false)
    assert.match(post.note, /tieba_look/)
    assert.match(post.note, /别的/)
    assert.equal(t.calls.length, 0)
  })
})

test('睡着、社会层没开闸，都不说', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await writeConfig(normalizeConfig({ zhihu: { comment: { enabled: true } } }), root)
    await meta(root, formatZhihuOpen(dk, 'ans1', '一条'))
    const api = zhihuApi()
    const closed = await zhihuSpeakOnce({ root, api, cookie: 'x', kind: 'comment', id: 'ans1', text: '人堆', dateKey: dk })
    assert.equal(closed.ok, false)
    assert.match(closed.note, /不是说话的时候/)
    assert.equal(api.calls.length, 0)

    await meta(root, 'social-open:2026-11-01T00:00:00.000Z')
    await writeFile(sleepPath(root), JSON.stringify({ v: 1, mode: 'asleep' }))
    const asleep = await zhihuSpeakOnce({ root, api, cookie: 'x', kind: 'comment', id: 'ans1', text: '睡着', dateKey: dk })
    assert.equal(asleep.ok, false)
    assert.match(asleep.note, /不是说话的时候/)
    assert.equal(api.calls.length, 0)
  })
})

test('楼中楼只回自己的评论下；关掉「有人回复时让她回一句」就拒', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await ready(root, { zhihu: { comment: { enabled: true, replyToReplies: true } } })
    await meta(root, formatZhihuComment(dk, 'ans1', 'mine', '我说过'))
    const api = zhihuApi()
    api.fetchChildComments = async () => ({ ok: true, comments: [{ id: 'other-child', text: '别人' }] })
    const foreign = await postZhihuReply({ root, api, cookie: 'x', answerId: 'ans1', parentId: 'stranger', text: '回别人的楼', dateKey: dk })
    assert.equal(foreign.ok, false)
    assert.match(foreign.why, /只能回自己/)
    assert.equal(api.calls.filter((c) => c[0] === 'comment').length, 0)

    const own = await zhihuSpeakOnce({ root, api, cookie: 'x', kind: 'reply', id: 'ans1', parentId: 'mine', text: '回自己下面', dateKey: dk })
    assert.equal(own.ok, true, own.note)
    assert.equal(api.calls.filter((c) => c[0] === 'comment').length, 1)

    await writeConfig(normalizeConfig({
      zhihu: { comment: { enabled: true, replyToReplies: false } },
    }), root)
    const callsBefore = api.calls.length
    const off = await zhihuSpeakOnce({ root, api, cookie: 'x', kind: 'reply', id: 'ans1', parentId: 'mine', text: '再回', dateKey: dk })
    assert.equal(off.ok, false)
    assert.match(off.note, /不方便/)
    assert.equal(api.calls.length, callsBefore)
  })
})

test('回子评论时 reply_root_comment_id 是自己的主楼，reply_comment_id 是那条子评论', async () => {
  resetZhihuWriteRisk()
  try {
    await withRoot(async (root) => {
      const dk = dateKey()
      await ready(root, { zhihu: { comment: { enabled: true, replyPerDay: 2 } } })
      await meta(root, formatZhihuComment(dk, 'ans1', 'rootc', '我说过'))
      const bodies = []
      const fetchImpl = async (_url, opts = {}) => {
        if (opts.body) bodies.push(JSON.parse(opts.body))
        return { status: 200, text: async () => JSON.stringify({ id: `n${bodies.length}` }) }
      }
      const api = {
        createComment,
        async fetchChildComments(args) {
          assert.equal(String(args.id), 'rootc')
          return { ok: true, comments: [{ id: 'childc', text: '楼下' }] }
        },
      }
      const child = await postZhihuReply({
        root, api, cookie: '_xsrf=abc; z_c0=1', fetchImpl, answerId: 'ans1', parentId: 'childc', text: '回楼下', dateKey: dk,
      })
      assert.equal(child.ok, true, child.why)
      assert.equal(bodies[0].reply_comment_id, 'childc')
      assert.equal(bodies[0].reply_root_comment_id, 'rootc')

      const own = await postZhihuReply({
        root, api, cookie: '_xsrf=abc; z_c0=1', fetchImpl, answerId: 'ans1', parentId: 'rootc', text: '回自己这条', dateKey: dk,
      })
      assert.equal(own.ok, true, own.why)
      assert.equal(bodies[1].reply_comment_id, 'rootc')
      assert.equal(bodies[1].reply_root_comment_id, 'rootc')
    })
  } finally {
    resetZhihuWriteRisk()
  }
})

test('贴吧同样只回自己那一层，主人号也可以发', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await ready(root, { tieba: { owner: 'owner', comment: { enabled: true, replyToReplies: true } } })
    await meta(root, formatTiebaThread(dk, 'tid1', '一个帖', 'meme吧'))
    const api = tiebaApi()
    const said = await tiebaSpeakOnce({ root, api, kind: 'comment', id: 'tid1', text: '跟一帖', dateKey: dk })
    assert.equal(said.ok, true, said.note)
    assert.match(said.note, /重要的人的贴吧号/)
    const { events } = await readEvents(root)
    const line = events.map((e) => String(e.text ?? '')).find((t) => t.startsWith(`tieba-comment:${dk} `))
    assert.match(line, /"forum":"meme吧"/)

    await writeConfig(normalizeConfig({ tieba: { owner: 'her', comment: { enabled: true, replyToReplies: false } } }), root)
    const off = await tiebaSpeakOnce({ root, api, kind: 'reply', id: 'tid1', parentId: 'p1', text: '回楼', dateKey: dk })
    assert.equal(off.ok, false)
    assert.match(off.note, /不方便/)
    assert.match(off.note, /她自己的贴吧号/)
  })
})

test('要验证码就停，不再发请求去过验证', async () => {
  resetZhihuWriteRisk()
  resetSpeakRisk('tieba')
  try {
    let zFetches = 0
    const zFetch = async () => {
      zFetches += 1
      return { status: 200, text: async () => JSON.stringify({ error: { message: '需要验证码', code: 1 }, captcha: {} }) }
    }
    const first = await createComment({ cookie: '_xsrf=abc; z_c0=1', id: 'ans1', content: '一句', fetchImpl: zFetch })
    assert.equal(first.code, 'CAPTCHA')
    const n = zFetches
    const second = await createComment({ cookie: '_xsrf=abc; z_c0=1', id: 'ans1', content: '再一句', fetchImpl: zFetch })
    assert.equal(second.code, 'COOLDOWN')
    assert.equal(zFetches, n)

    let tFetches = 0
    const urls = []
    const tFetch = async (url) => {
      tFetches += 1
      urls.push(String(url))
      const body = String(url).includes('/c/s/pc/sync')
        ? JSON.stringify({ data: { anti: { tbs: 'tbs1' } } })
        : JSON.stringify({ error_code: '40', error_msg: '请输入验证码', info: { need_vcode: '1' } })
      return { ok: true, status: 200, text: async () => body }
    }
    const post = await addThreadPost({ cookie: 'BDUSS=abc', tid: '9', kw: 'meme吧', content: '跟', fetchImpl: tFetch })
    assert.equal(post.code, 'CAPTCHA')
    const tn = tFetches
    const again = await addThreadPost({ cookie: 'BDUSS=abc', tid: '9', content: '再跟', fetchImpl: tFetch })
    assert.equal(again.code, 'COOLDOWN')
    assert.equal(tFetches, tn)
    assert.equal(urls.some((u) => /captcha|getvcode|vcodeimg/i.test(u)), false)
  } finally {
    resetZhihuWriteRisk()
    resetSpeakRisk('tieba')
  }
})

test('动作表能解析知乎回答和两边的评论，并且已经接线', () => {
  const dk = '2026-11-10'
  for (const line of [
    formatZhihuComment(dk, '1234567890123456789', '9876543210987654321', '一句'),
    formatZhihuOpen(dk, '555', '回答', { question: '42' }),
  ]) {
    const act = parseAct(line)
    assert.equal(act.wired, true)
    assert.equal(act.id.length > 0, true)
  }
  const answer = parseAct(`zhihu-answer:${dk} 42 99 {"text":"写了"}`)
  assert.equal(answer.wired, true)
  assert.equal(answer.label, '在知乎写了一条回答')
  assert.equal(answer.quota, 'zhihu-answer')
  assert.equal(answer.phase, 'talking')
  const tieba = parseAct(`tieba-reply:${dk} 7 8 9 {"text":"回"}`)
  assert.equal(tieba.wired, true)
  assert.equal(tieba.label, '在贴吧回了一条')
})

test('扫回复不看掷骰；睡着不打请求；递给她时写清是谁的号', async () => {
  assert.equal(scanDue({ enabled: true, lastAt: 0, everyMin: 30, now: 1_000 }), true)
  assert.equal(scanDue({ enabled: false, lastAt: 0, everyMin: 30, now: 1_000 }), false)
  assert.equal(scanDue({ enabled: true, lastAt: 1_000, everyMin: 30, now: 1_000 + 60_000 }), false)
  await withRoot(async (root) => {
    let hits = 0
    const asleep = { v: 1, mode: 'asleep' }
    const z = await scanZhihuIfAwake({
      root,
      config: normalizeConfig({}),
      sleepState: asleep,
      api: { fetchChildComments() { hits += 1; return { ok: true, comments: [] } } },
      cookie: 'x',
    })
    const t = await scanTiebaIfAwake({
      root,
      config: normalizeConfig({}),
      sleepState: asleep,
      api: { floor() { hits += 1; return { ok: true, replies: [] } } },
    })
    assert.equal(z.why, 'asleep')
    assert.equal(t.why, 'asleep')
    assert.equal(hits, 0)
    const shown = renderZhihuReplies([{ rpid: '1', answerId: 'a', user: '路人', text: '说了句' }], 'owner')
    assert.match(shown, /重要的人的知乎号/)
    const hers = renderTiebaReplies([{ rpid: '2', tid: 't', user: '路人', text: '也说了' }], 'her')
    assert.match(hers, /她自己的贴吧号/)
  })
  const src = await readFile(new URL('../lib/life/schedule/scheduler.js', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('async function runOutingChoice'), src.indexOf('出门路线只用模块级'))
  assert.equal(body.includes('scanZhihuIfAwake'), false)
  assert.equal(body.includes('scanTiebaIfAwake'), false)
  assert.equal(body.includes('scanReplies'), false)
})

test('身份文档只写真正打开的平台，并写清是谁的号', () => {
  const model = modelOf([])
  const old = renderSelfDoc(model, { speak: true, browse: false, diary: false })
  assert.match(old, /bili_speak/)
  assert.doesNotMatch(old, /zhihu_speak|tieba_speak/)
  const doc = renderSelfDoc(model, {
    browse: false,
    diary: false,
    speak: {
      bili: false,
      zhihuComment: true,
      zhihuAnswer: true,
      tieba: true,
      zhihuOwner: 'owner',
      tiebaOwner: 'her',
    },
  })
  assert.match(doc, /在网上说话/)
  assert.match(doc, /zhihu_speak/)
  assert.match(doc, /tieba_speak/)
  assert.match(doc, /重要的人的知乎号/)
  assert.match(doc, /她自己的贴吧号/)
  assert.doesNotMatch(doc, /bili_speak/)
  assert.doesNotMatch(doc, /配额|开关|还剩/)
  const none = renderSelfDoc(model, {
    browse: false,
    diary: false,
    speak: { bili: false, zhihuComment: false, zhihuAnswer: false, tieba: false },
  })
  assert.equal(none.includes('在网上说话'), false)
})

test('设置页不再写功能没接上，评论配额和 B 站对齐', async () => {
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(client.includes('功能还没接上'), false)
  assert.equal(client.includes('不发评论、不私信'), false)
  assert.equal(client.includes('不发帖、不回帖'), false)
  const cfg = normalizeConfig({
    zhihu: { comment: { enabled: true, perDay: 99, replyPerDay: 99, scanEveryMin: 1, replyToReplies: false }, answer: { enabled: true, perDay: 9 } },
    tieba: { comment: { perDay: 99, replyPerDay: 99, scanEveryMin: 9999 } },
  })
  assert.equal(cfg.zhihu.comment.perDay, 5)
  assert.equal(cfg.zhihu.comment.replyPerDay, 10)
  assert.equal(cfg.zhihu.comment.scanEveryMin, 5)
  assert.equal(cfg.zhihu.comment.replyToReplies, false)
  assert.equal(cfg.zhihu.answer.enabled, true)
  assert.equal(cfg.zhihu.answer.perDay, 1)
  assert.equal(cfg.tieba.comment.enabled, false)
  assert.equal(cfg.tieba.comment.perDay, 5)
  assert.equal(cfg.tieba.comment.replyPerDay, 10)
  assert.equal(cfg.tieba.comment.scanEveryMin, 720)
})

test('楼中楼读取能认出子评论，贴吧回帖撞验证码时不带验证码重试', async () => {
  let seen = ''
  const child = await fetchChildComments({
    cookie: 'z_c0=1',
    id: 'root1',
    fetchImpl: async (url) => {
      seen = String(url)
      return {
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'kid', content: '楼下', author: { name: '路人', id: 'u1' } }] }),
      }
    },
  })
  assert.equal(child.ok, true)
  assert.match(seen, /child_comment/)
  assert.equal(child.comments[0].id, 'kid')
  assert.equal(child.comments[0].text.includes('楼下') || child.comments[0].author === '路人', true)

  const rows = floorRepliesFrom({ subpost_list: [{ id: '9', content: [{ type: 0, text: '楼中' }] }] })
  assert.equal(rows[0].id, '9')
  assert.match(rows[0].text, /楼中/)
})

test('贴吧楼中楼拒绝不在自己那层下面的回复', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await ready(root, { tieba: { owner: 'her', comment: { enabled: true, replyPerDay: 2 } } })
    await meta(root, `tieba-comment:${dk} tid1 mine {"text":"我跟过","forum":"meme吧"}`)
    const api = tiebaApi()
    const r = await postTiebaReply({ root, api, tid: 'tid1', parentId: 'nope', text: '乱回', dateKey: dk })
    assert.equal(r.ok, false)
    assert.match(r.why, /只能回自己/)
    assert.equal(api.calls.filter((c) => c[0] === 'post').length, 0)
    const ok = await postTiebaReply({ root, api, tid: 'tid1', parentId: 'mine', text: '回这层', dateKey: dk })
    assert.equal(ok.ok, true, ok.why)
    const posted = api.calls.find((c) => c[0] === 'post')
    assert.equal(posted[1].quoteId, 'mine')
    const heard = await tiebaSpeakOnce({ root, api, kind: 'reply', id: 'tid1', parentId: 'mine', text: '再说一句', dateKey: dk })
    assert.equal(heard.ok, true, heard.note)
    assert.match(heard.note, /她自己的贴吧号/)
  })
})

test('太长、像凭据的话，都不发出去', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await ready(root, { zhihu: { comment: { enabled: true }, answer: { enabled: true } } })
    await meta(root, formatZhihuOpen(dk, 'ans1', '一条', { question: 'q1' }))
    const api = zhihuApi()
    const long = await postZhihuComment({ root, api, cookie: 'x', answerId: 'ans1', text: '啊'.repeat(1001), dateKey: dk })
    assert.equal(long.ok, false)
    assert.match(long.why, /太长/)
    const leak = await zhihuSpeakOnce({ root, api, cookie: 'x', kind: 'comment', id: 'ans1', text: 'cookie=abc', dateKey: dk })
    assert.equal(leak.ok, false)
    assert.match(leak.note, /先不说了|不该说/)
    const path = await zhihuSpeakOnce({ root, api, cookie: 'x', kind: 'comment', id: 'ans1', text: '在 /home/me/events.jsonl 里', dateKey: dk })
    assert.equal(path.ok, false)
    assert.match(path.note, /不该说/)
    assert.equal(api.calls.length, 0)
    const longAnswer = await postAnswer({ root, api, cookie: 'x', questionId: 'q1', text: '啊'.repeat(2501), dateKey: dk })
    assert.equal(longAnswer.ok, false)
    assert.match(longAnswer.why, /太长/)
  })
})

test('贴吧工具关着时说明不许诺能跟帖', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerTiebaSpeak(ctx, { root })
    const def = ctx.defs.find((d) => d.name === 'tieba_speak')
    noteTiebaSpeak(false)
    assert.doesNotMatch(def.description, /可以给你|跟一帖|发出去/)
    noteTiebaSpeak({ on: true, owner: 'her' })
    assert.match(def.description, /今天点开过/)
    assert.match(def.description, /她自己的贴吧号/)
    noteTiebaSpeak(false)
  })
})
