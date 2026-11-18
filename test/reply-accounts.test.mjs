/**
 * reply-accounts.test.mjs —— 扫回复的「是哪个号」「谁回的」（2026-11-18）
 *
 * 规则：
 *   - 根必须带 slot（没有就不扫）；
 *   - 同号（发根的那个号）回的：不递；
 *   - 她自己的号（her 角色，含另一个 her 号）回的：不递（避免回声）；
 *   - 主人的号（owner 角色）回的：递，递的时候标「那个重要的人」；
 *   - 其他账号：陌生人。
 * 另守：知乎「回主楼」那条路不能用另一个号回自己的顶层评论。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dateKey, normalizeConfig } from '../lib/core/settings.js'
import { appendEvent, writeConfig, writeOwner } from '../lib/core/store.js'
import { writeSleep } from '../lib/life/schedule/sleep.js'
import { formatBiliComment, formatTiebaComment, formatZhihuComment } from '../lib/core/acts.js'
import { scanReplies as scanBiliReplies } from '../lib/platforms/bili/comment.js'
import { scanReplies as scanZhihuReplies } from '../lib/platforms/zhihu/comment.js'
import { postReply as postZhihuReply } from '../packages/dsh-fish-river-zhihu/comment.js'
import { scanReplies as scanTiebaReplies } from '../lib/platforms/tieba/comment.js'

const HER = { slot: 'a', owner: 'her', name: '戴菲钰' }
const OWNER = { slot: 'b', owner: 'owner', name: '独自享受' }

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-reply-accounts-'))
  try {
    await writeConfig(normalizeConfig({
      comment: { enabled: true },
      social: { waiveSpeak: true },
      zhihu: { enabled: true, comment: { enabled: true, replyPerDay: 2 } },
      tieba: { comment: { enabled: true } },
      browse: { enabled: false, images: { enabled: false } },
    }), root)
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

async function meta(root, text) {
  await appendEvent({ type: 'meta', text }, { day: 0, stage: 1, source: 'system' }, root)
}

function zhihuAccounts() {
  return [
    { id: 'a', owner: 'her', allowed: true, cookie: 'ca', account: { id: 'ua', name: '戴菲钰' } },
    { id: 'b', owner: 'owner', allowed: true, cookie: 'cb', account: { id: 'ub', name: '独自享受' } },
  ]
}

test('知乎：根是她的号——同号跳过、主人的号标「那个重要的人」、陌生人不标；没 slot 的根不扫', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await meta(root, formatZhihuComment(dk, 'ans1', 'rootA', '我说过', HER))
    await meta(root, formatZhihuComment(dk, 'ans1', 'rootNoSlot', '老根没标'))
    const api = {
      async readAccounts() { return zhihuAccounts() },
      async fetchChildComments({ id }) {
        if (id === 'rootNoSlot') {
          return { ok: true, comments: [{ id: 'no-slot-child', authorId: 'us', author: '路人', text: '不该扫到' }] }
        }
        return {
          ok: true,
          comments: [
            { id: 'same', authorId: 'ua', author: '戴菲钰', text: '我自己又补一句' },
            { id: 'from-owner', authorId: 'ub', author: '独自享受', text: '我回你了' },
            { id: 'stranger', authorId: 'us', author: '路人', text: '路过' },
          ],
        }
      },
    }
    const out = await scanZhihuReplies({ root, api, cookie: 'ca', selfId: 'ua', slot: 'a', owner: 'her', name: '戴菲钰' })
    assert.deepEqual(out.map((x) => x.rpid), ['from-owner', 'stranger'], '同号不递；主人和陌生人留着')
    const owner = out.find((x) => x.rpid === 'from-owner')
    const stranger = out.find((x) => x.rpid === 'stranger')
    assert.equal(owner.authorRole, 'owner')
    assert.equal(owner.authorName, '独自享受')
    assert.equal(owner.rootSlot, 'a')
    assert.equal(owner.rootRole, 'her')
    assert.equal(stranger.authorRole, 'stranger')
  })
})

test('知乎：根是主人的号——主人自己再补不递，她自己的号回也不递，只剩陌生人', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await meta(root, formatZhihuComment(dk, 'ans1', 'rootB', '主人发的', OWNER))
    const api = {
      async readAccounts() { return zhihuAccounts() },
      async fetchChildComments() {
        return {
          ok: true,
          comments: [
            { id: 'owner-same', authorId: 'ub', author: '独自享受', text: '主人补一句' },
            { id: 'her-cross', authorId: 'ua', author: '戴菲钰', text: '她自己的号回' },
            { id: 'stranger', authorId: 'us', author: '路人', text: '路过' },
          ],
        }
      },
    }
    const out = await scanZhihuReplies({ root, api, cookie: 'cb', selfId: 'ub', slot: 'b' })
    assert.deepEqual(out.map((x) => x.rpid), ['stranger'])
    assert.equal(out[0].authorRole, 'stranger')
  })
})

test('知乎：回自己的顶层评论时，选了另一个号当场拒掉（堵「回主楼」的口子）', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await writeSleep(root, { mode: 'dice_awake', looked: true, lastActivityAt: Date.now() })
    await meta(root, formatZhihuComment(dk, 'ans1', 'rootA', '我说过', HER))
    const api = {
      async readAccounts() { return zhihuAccounts() },
      async createComment() { throw new Error('不该走到发出去') },
    }
    const out = await postZhihuReply({
      root, api, cookie: 'cb', slot: 'b', selfId: 'ub',
      answerId: 'ans1', parentId: 'rootA', text: '用另一个号回', dateKey: dk,
    })
    assert.equal(out.ok, false)
    assert.match(out.why, /另一个号/)
  })
})

test('B 站：同号不递、主人的号标「那个重要的人」、陌生人不标；没 slot 的根不扫', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await writeOwner({ mid: 100 }, root)
    await meta(root, formatBiliComment(dk, 'BV1', 111, '我说过', { slot: 'a', owner: 'her', name: '鲸鲸71号' }))
    await meta(root, `comment:${dk} BV2 222 {"text":"老根没标"}`)
    const accounts = [
      { id: 'a', owner: 'her', allowed: true, cookie: 'ca', account: { mid: 100, name: '鲸鲸71号' } },
      { id: 'b', owner: 'owner', allowed: true, cookie: 'cb', account: { mid: 200, name: '放空心绪' } },
    ]
    const client = {
      async view() { return { ok: true, data: { aid: 9 } } },
      async subReplies(aid, rootRpid) {
        if (rootRpid === 222) return { ok: true, data: [{ rpid: 999, mid: 999, user: '路人', text: '不该扫到' }] }
        return {
          ok: true,
          data: [
            { rpid: 1, mid: 100, user: '鲸鲸71号', text: '同号补一句' },
            { rpid: 2, mid: 200, user: '放空心绪', text: '主人回你' },
            { rpid: 3, mid: 999, user: '路人', text: '路过' },
          ],
        }
      },
    }
    const out = await scanBiliReplies({ root, client, accounts, slot: 'a', dateKey: dk })
    assert.deepEqual(out.map((x) => x.rpid), [2, 3])
    assert.equal(out.find((x) => x.rpid === 2).authorRole, 'owner')
    assert.equal(out.find((x) => x.rpid === 3).authorRole, 'stranger')
  })
})

test('贴吧：同号不递、主人的号标「那个重要的人」、陌生人不标；没 slot 的根不扫', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await meta(root, formatTiebaComment(dk, 'tid1', 'pid1', '我说过', '吧', { slot: 'a', owner: 'her', name: '戴菲钰' }))
    await meta(root, `tieba-comment:${dk} tid2 pid2 {"text":"老根没标"}`)
    const accounts = [
      { id: 'a', owner: 'her', allowed: true, cookie: 'ca', account: { mid: 'ua', name: '戴菲钰' } },
      { id: 'b', owner: 'owner', allowed: true, cookie: 'cb', account: { mid: 'ub', name: '独自享受' } },
    ]
    const api = {
      async floor({ pid }) {
        if (pid === 'pid2') return { ok: true, replies: [{ id: 'no-slot', authorId: 'us', author: '路人', text: '不该扫到', time: 1 }] }
        return {
          ok: true,
          replies: [
            { id: 'same', authorId: 'ua', author: '戴菲钰', text: '同号补充', time: 2 },
            { id: 'owner', authorId: 'ub', author: '独自享受', text: '主人回你', time: 3 },
            { id: 'stranger', authorId: 'us', author: '路人', text: '路过', time: 4 },
          ],
        }
      },
    }
    const out = await scanTiebaReplies({ root, api, accounts, cookie: 'ca', slot: 'a' })
    assert.deepEqual(out.map((x) => x.rpid), ['owner', 'stranger'])
    assert.equal(out.find((x) => x.rpid === 'owner').authorRole, 'owner')
    assert.equal(out.find((x) => x.rpid === 'stranger').authorRole, 'stranger')
  })
})
