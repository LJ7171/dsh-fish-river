/**
 * passport.test.mjs —— 渠道护照与「重要的人」
 *
 * 守住的是场合，不是性格：
 *   微信家门近聊、知乎家门素材、B 站出门号 + 大号私聊 close、
 *   近人只加重场合、路人仍是 social、群强制 open。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { normalizeConfig } from '../lib/settings.js'
import { validateEvent } from '../lib/schema.js'
import {
  passportOf, resolveOccasion, occasionLine, contextLinesFor, nextQueueIndex,
  HOME_CONTEXT_LINES, PASSPORT_DEFAULTS,
} from '../lib/channels/passport.js'
import { buildPrompt, createRouter } from '../lib/channels/router.js'
import { createJournal } from '../lib/journal.js'
import { createPeople } from '../lib/people.js'
import { readEvents } from '../lib/store.js'
import { renderMaterial as renderZhihu } from '../lib/zhihu.js'
import { renderMaterial as renderBili } from '../lib/browse.js'
import { renderDouyin } from '../lib/douyinbrowse.js'

test('默认护照：微信家门近场合，知乎家门，B 站 / QQ / 抖音出门号', () => {
  const cfg = normalizeConfig({})
  assert.deepEqual(passportOf(cfg, 'weixin'), { channel: 'weixin', accountOf: 'home', bond: 'close' })
  assert.deepEqual(passportOf(cfg, 'zhihu'), { channel: 'zhihu', accountOf: 'home', bond: 'close' })
  assert.equal(passportOf(cfg, 'bili').accountOf, 'outing')
  assert.equal(passportOf(cfg, 'bili').bond, 'open')
  assert.equal(passportOf(cfg, 'qq').accountOf, 'outing')
  assert.equal(passportOf(cfg, 'douyin').accountOf, 'outing')
  assert.equal(cfg.channels.weixin.accountOf, PASSPORT_DEFAULTS.weixin.accountOf)
  assert.equal(cfg.zhihu.accountOf, 'home')
  assert.equal(cfg.zhihu.bond, 'close')
})

test('号主和档可以改；写错的值回落默认，不当成性格', () => {
  const cfg = normalizeConfig({
    channels: {
      qq: { accountOf: 'home', bond: 'close', closeIds: ' 7, 8 ' },
      bili: { accountOf: 'persona', bond: 'warm' },
    },
    zhihu: { accountOf: 'outing', bond: 'nope' },
  })
  assert.equal(cfg.channels.qq.accountOf, 'home')
  assert.equal(cfg.channels.qq.bond, 'close')
  assert.equal(cfg.channels.qq.closeIds, '7, 8')
  assert.equal(cfg.channels.bili.accountOf, 'outing')
  assert.equal(cfg.channels.bili.bond, 'open')
  assert.equal(cfg.zhihu.accountOf, 'outing')
  assert.equal(cfg.zhihu.bond, 'close')
})

test('场合句：微信、出门听见、知乎素材、知乎评论', () => {
  const wx = resolveOccasion({ channel: 'weixin', kind: 'dm', isOwner: true })
  assert.equal(occasionLine(wx), '这是微信，只有你们俩。说话的是重要的人。')
  const qq = resolveOccasion({ channel: 'qq', kind: 'group', isOwner: false })
  assert.equal(qq.bond, 'open')
  assert.equal(occasionLine(qq), '这是她在 QQ 上出门听见的。')
  const zh = resolveOccasion({ channel: 'zhihu', kind: 'feed' })
  assert.equal(zh.accountOf, 'home')
  assert.equal(zh.bond, 'close')
  assert.equal(occasionLine(zh), '这是重要的人知乎账号上刷到的。')
  const comment = resolveOccasion({ channel: 'zhihu', kind: 'comment' })
  assert.equal(comment.bond, 'open')
  assert.equal(occasionLine(comment), '这是知乎上别人的评论。')
})

test('B 站：出门号；对上大号的私聊 close，路人和评论 open', () => {
  const cfg = normalizeConfig({ channels: { bili: { ownerId: '100', closeIds: '200' } } })
  const owner = resolveOccasion({ channel: 'bili', kind: 'dm', personId: 'u_100', isOwner: true, config: cfg })
  assert.equal(owner.accountOf, 'outing')
  assert.equal(owner.bond, 'close')
  assert.match(occasionLine(owner), /重要的人/)
  assert.doesNotMatch(occasionLine(owner), /主人/)

  const stranger = resolveOccasion({ channel: 'bili', kind: 'dm', personId: 'u_9', isOwner: false, config: cfg })
  assert.equal(stranger.bond, 'open')
  assert.equal(stranger.isClose, false)
  assert.match(occasionLine(stranger), /出门听见的/)

  const near = resolveOccasion({ channel: 'bili', kind: 'dm', personId: 'u_200', isOwner: false, config: cfg })
  assert.equal(near.bond, 'close')
  assert.equal(near.isClose, true)
  assert.equal(near.isOwner, false)
  assert.doesNotMatch(occasionLine(near), /重要的人/)

  const room = resolveOccasion({ channel: 'bili', kind: 'group', personId: 'u_100', isOwner: true, config: cfg })
  assert.equal(room.bond, 'open')
  const note = resolveOccasion({ channel: 'bili', kind: 'comment', config: cfg })
  assert.equal(note.bond, 'open')
  assert.equal(note.accountOf, 'outing')
})

test('家门近聊上下文更长；家门私聊能插队，群不能', () => {
  const home = resolveOccasion({ channel: 'weixin', kind: 'dm', isOwner: true })
  assert.equal(contextLinesFor(home), HOME_CONTEXT_LINES)
  const out = resolveOccasion({ channel: 'qq', kind: 'dm', isOwner: true })
  assert.equal(contextLinesFor(out, 8), 8)
  const queue = [
    { channel: 'qq', kind: 'group' },
    { channel: 'bili', kind: 'dm' },
    { channel: 'weixin', kind: 'dm' },
    { channel: 'qq', kind: 'dm' },
  ]
  assert.equal(nextQueueIndex(queue, normalizeConfig({})), 2)
  const homeGroup = [{ channel: 'weixin', kind: 'group' }, { channel: 'qq', kind: 'dm' }]
  assert.equal(nextQueueIndex(homeGroup, {}), 0, '群即使标在微信上也不插队')
})

test('提示词用「重要的人」，家门近聊多带几句', () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({ role: 'me', text: `句${i}` }))
  const wx = buildPrompt(
    { channel: 'weixin', kind: 'dm', personId: 'u_1', personName: '阿宁', text: '在吗' },
    lines,
    { isOwner: true },
  )
  assert.match(wx, /这是微信，只有你们俩/)
  assert.match(wx, /重要的人/)
  assert.doesNotMatch(wx, /主人/)
  assert.match(wx, /句4/)
  assert.doesNotMatch(wx, /句3/)
  const qq = buildPrompt(
    { channel: 'qq', kind: 'group', conversationId: '1', conversationName: '产品群', personName: 'Lily', text: '在吗' },
    lines,
    { isOwner: false },
  )
  assert.match(qq, /这是她在 QQ 上出门听见的/)
  assert.match(qq, /产品群/)
  assert.match(qq, /句12/)
  assert.doesNotMatch(qq, /句11/)
  assert.doesNotMatch(qq, /主人/)
})

test('素材场合句：知乎家门、B 站和抖音是出门看见的', () => {
  const zh = renderZhihu([{ kind: 'hot', title: '热榜一' }])
  assert.match(zh, /^这是重要的人知乎账号上刷到的/)
  assert.doesNotMatch(zh, /主人/)
  const bili = renderBili([{
    video: { bvid: 'BV1', title: '一条', owner: { name: '甲' }, duration: 60, tname: 'x' },
    desc: '', tags: [], comments: [], danmaku: [], pubdate: null,
  }])
  assert.match(bili, /这是她在 B站 上出门看见的/)
  const dy = renderDouyin([{ id: '1', title: '一条', author: '甲', like: '1' }])
  assert.match(dy, /这是她在 抖音 上出门看见的/)
})

test('她自己写不了护照字段', () => {
  const e = validateEvent(
    { type: 'utterance', text: '今天。', accountOf: 'home', bond: 'close', influence: 'constitution' },
    { day: 1, stage: 1, source: 'tool' },
  )
  assert.equal('accountOf' in e, false)
  assert.equal('bond' in e, false)
})

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'fish-pass-'))
}

function host(reply = '嗯', { blockFirst = false } = {}) {
  const handlers = []
  const calls = []
  let release = () => {}
  const sc = {
    async prompt(req) {
      calls.push(req)
      if (blockFirst && calls.length === 1) await new Promise((r) => { release = r })
      setImmediate(() => {
        for (const h of handlers) {
          if (h.name !== 'session/event') continue
          const session = { header: { id: req.sessionId } }
          h.fn(session, { type: 'assistant/message', data: { message: { id: `m${calls.length}`, content: [{ type: 'text', text: reply }] } } })
          h.fn(session, { type: 'turn/end', data: {} })
        }
      })
    },
  }
  const ctx = {
    on: (name, fn) => {
      handlers.push({ name, fn })
      return () => {}
    },
    get: () => sc,
  }
  return { ctx, calls, release: () => release() }
}

function adapter(name) {
  return {
    name,
    sent: [],
    onMessage() { return () => {} },
    async start() { return { ok: true } },
    async stop() {},
    async send(m) { this.sent.push(m); return { ok: true } },
    status() { return { ok: true } },
  }
}

test('路由：B 站大号私聊进 constitution，路人和近人仍是 social', async () => {
  const root = await tmpRoot()
  const cfg = {
    channels: {
      bili: { enabled: true, ownerId: '100', closeIds: '200' },
      qq: { enabled: true },
    },
  }
  const { ctx, calls } = host('嗯')
  const bili = adapter('bili')
  const router = createRouter({
    ctx, root,
    journal: createJournal(root),
    people: createPeople(root),
    ownerIds: { bili: '100' },
    adapters: new Map([['bili', bili]]),
    getConfig: async () => cfg,
    getState: async () => ({ sessionId: 's1', stage: 3 }),
  })
  await router.start()
  calls.length = 0
  // host 的第一轮会卡住，这里直接 handle，不走队列。
  const owner = await router.handle({
    channel: 'bili', kind: 'dm', conversationId: '100', personId: 'u_100', personName: '阿宁', text: '在吗', images: [], at: 1,
  })
  assert.equal(owner.sent, true, JSON.stringify(owner))
  assert.match(calls.at(-1).content[0].text, /重要的人/)
  assert.match(calls.at(-1).content[0].text, /B站/)
  assert.doesNotMatch(calls.at(-1).content[0].text, /主人/)
  const near = await router.handle({
    channel: 'bili', kind: 'dm', conversationId: '200', personId: 'u_200', personName: '近人', text: '嗨', images: [], at: 2,
  })
  assert.equal(near.sent, true, JSON.stringify(near))
  assert.doesNotMatch(calls.at(-1).content[0].text, /重要的人/)
  const stranger = await router.handle({
    channel: 'bili', kind: 'dm', conversationId: '9', personId: 'u_9', personName: '路人', text: '嗨', images: [], at: 3,
  })
  assert.equal(stranger.sent, true)
  assert.match(calls.at(-1).content[0].text, /出门听见的/)
  const { events } = await readEvents(root)
  const heard = events.filter((e) => e.type === 'heard')
  assert.equal(heard[0].origin, 'owner')
  assert.equal(heard[0].influence, 'constitution')
  assert.equal(heard[0].accountOf, 'outing')
  assert.equal(heard[0].bond, 'close')
  assert.match(heard[0].text, /重要的人/)
  assert.equal(heard[1].influence, 'social')
  assert.equal(heard[1].bond, 'close')
  assert.equal(heard[1].origin, 'guest')
  assert.equal(heard[2].influence, 'social')
  assert.equal(heard[2].bond, 'open')
  await router.stop()
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }).catch(() => {})
})

test('队列：家门私聊插到已经排着的出门消息前面', async () => {
  const root = await tmpRoot()
  const h = host('嗯', { blockFirst: true })
  const cfg = {
    channels: {
      qq: { enabled: true, replyInGroup: true, groups: ['111', '222'], mentionOnly: false },
      weixin: { enabled: true },
    },
  }
  const router = createRouter({
    ctx: h.ctx,
    root,
    journal: createJournal(root),
    people: createPeople(root),
    ownerIds: {},
    adapters: new Map([['qq', adapter('qq')], ['weixin', adapter('weixin')]]),
    getConfig: async () => cfg,
    getState: async () => ({ sessionId: 's1', stage: 3 }),
  })
  await router.start()
  h.calls.length = 0
  const group = (id, room, text) => ({
    channel: 'qq', kind: 'group', conversationId: room, conversationName: '群',
    personId: id, personName: '甲', text, images: [], mentionedSelf: true, at: 1,
  })
  router.accept(group('u_1', '111', '先说'))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(h.calls.length, 1)
  router.accept(group('u_2', '222', '再说'))
  router.accept({
    channel: 'weixin', kind: 'dm', conversationId: 'wx', personId: 'u_w', personName: '乙',
    text: '家里', images: [], at: 2,
  })
  h.release()
  const deadline = Date.now() + 2000
  while (h.calls.length < 3 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.equal(h.calls.length, 3)
  assert.match(h.calls[0].content[0].text, /QQ/)
  assert.match(h.calls[1].content[0].text, /微信/)
  assert.match(h.calls[2].content[0].text, /QQ/)
  await router.stop()
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }).catch(() => {})
})
