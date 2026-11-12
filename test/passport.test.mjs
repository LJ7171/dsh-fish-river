/**
 * passport.test.mjs —— 渠道场合（2026-11-06 B 案）
 *
 * 不再有「号主 / 默认场合」配置。场合只看：
 *   ownerId → 重要的人；closeIds → 近人；群/评论 → 公共场；其余 → 陌生人。
 * 私聊句必须先判重要的人，不能只写「这是 B 站私信里说的」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../lib/core/settings.js'
import { validateEvent } from '../lib/core/schema.js'
import {
  resolveOccasion, occasionLine, contextLinesFor, queueRank, nextQueueIndex,
  HOME_CONTEXT_LINES,
} from '../lib/channels/occasion.js'
import { renderMaterial as renderZhihu } from '../lib/platforms/zhihu/client.js'
import { renderMaterial as renderBili } from '../lib/platforms/bili/browse.js'
import { renderDouyin } from '../lib/platforms/douyin/douyinbrowse.js'

const cfg = () => normalizeConfig({ channels: { bili: { closeIds: '200' } } })

test('场合：owner=close，closeIds=close，群/评论=open，路人=open', () => {
  const c = cfg()
  const owner = resolveOccasion({ channel: 'bili', kind: 'dm', personId: 'u_100', isOwner: true, config: c })
  assert.deepEqual(owner, { channel: 'bili', kind: 'dm', isOwner: true, isClose: false, scene: 'owner-dm', bond: 'close' })

  const near = resolveOccasion({ channel: 'bili', kind: 'dm', personId: 'u_200', config: c })
  assert.equal(near.isClose, true)
  assert.equal(near.scene, 'close-dm')
  assert.equal(near.bond, 'close')

  const stranger = resolveOccasion({ channel: 'bili', kind: 'dm', personId: 'u_9', config: c })
  assert.equal(stranger.scene, 'stranger-dm')
  assert.equal(stranger.bond, 'open')

  const group = resolveOccasion({ channel: 'qq', kind: 'group', personId: 'u_100', isOwner: true, config: c })
  assert.equal(group.scene, 'group')
  assert.equal(group.bond, 'open')

  const comment = resolveOccasion({ channel: 'bili', kind: 'comment', config: c })
  assert.equal(comment.scene, 'comment')
  assert.equal(comment.bond, 'open')
})

test('私聊场景句先判重要的人，再判近人，最后才是陌生人', () => {
  assert.equal(occasionLine(resolveOccasion({ channel: 'weixin', kind: 'dm', isOwner: true })), '这是微信，只有你们俩。说话的是重要的人。')
  assert.equal(occasionLine(resolveOccasion({ channel: 'bili', kind: 'dm', isOwner: true })), '这是B站上，跟重要的人单独说话。')
  assert.equal(occasionLine(resolveOccasion({ channel: 'douyin', kind: 'dm', isOwner: true })), '这是抖音上，跟重要的人单独说话。')
  assert.equal(occasionLine(resolveOccasion({ channel: 'qq', kind: 'dm', isOwner: true })), '这是QQ上，跟重要的人单独说话。')
  assert.equal(occasionLine(resolveOccasion({ channel: 'bili', kind: 'dm', personId: 'u_200', config: cfg() })), '这是B站上，是离她近的人。')
  assert.equal(occasionLine(resolveOccasion({ channel: 'bili', kind: 'dm', personId: 'u_9', config: cfg() })), '这是B站上的陌生人私聊。')
  assert.equal(occasionLine(resolveOccasion({ channel: 'qq', kind: 'group' })), '这是QQ群里的。')
  assert.equal(occasionLine(resolveOccasion({ channel: 'bili', kind: 'comment' })), '这是B站评论里别人的话。')
  assert.equal(occasionLine(resolveOccasion({ channel: 'zhihu', kind: 'comment' })), '这是知乎上别人的评论。')
})

test('近聊多带上下文；重要的人的私聊插队，群不插', () => {
  const owner = resolveOccasion({ channel: 'bili', kind: 'dm', isOwner: true })
  const stranger = resolveOccasion({ channel: 'bili', kind: 'dm', personId: 'u_9', config: cfg() })
  assert.equal(contextLinesFor(owner, 8), HOME_CONTEXT_LINES)
  assert.equal(contextLinesFor(stranger, 8), 8)
  assert.equal(queueRank({ kind: 'dm', isOwner: true }), 1)
  assert.equal(queueRank({ kind: 'dm', isOwner: false }), 0)
  assert.equal(queueRank({ kind: 'group', isOwner: true }), 0)
  const q = [{ kind: 'dm', isOwner: false }, { kind: 'dm', isOwner: true }]
  assert.equal(nextQueueIndex(q), 1)
  assert.equal(nextQueueIndex([{ kind: 'dm' }, { kind: 'dm' }]), 0)
})

test('渠道配置不再有号主/场合；ownerId/closeIds 保留', () => {
  const c = normalizeConfig({
    channels: {
      qq: { accountOf: 'home', bond: 'close', ownerId: '123', closeIds: ' 7, 8 ' },
      bili: { accountOf: 'persona', bond: 'warm' },
    },
  })
  assert.equal(c.channels.qq.accountOf, undefined)
  assert.equal(c.channels.qq.bond, undefined)
  assert.equal(c.channels.qq.ownerId, '123')
  assert.equal(c.channels.qq.closeIds, '7, 8')
  assert.equal(c.channels.bili.accountOf, undefined)
  assert.equal(c.channels.bili.bond, undefined)
})

test('老事件带 accountOf/bond 仍能读；新事件不写 accountOf', () => {
  const old = validateEvent({ type: 'heard', text: '在吗', accountOf: 'home', bond: 'close', influence: 'constitution' }, { source: 'system' })
  assert.equal(old.accountOf, 'home')
  assert.equal(old.bond, 'close')
  const occ = resolveOccasion({ channel: 'bili', kind: 'dm', isOwner: true })
  assert.deepEqual({ bond: occ.bond }, { bond: 'close' })
})

test('素材措辞按各平台的 owner，不再用旧场合句', () => {
  const zh = renderZhihu([{ kind: 'hot', title: '热榜一' }], { zhihu: { owner: 'her' } })
  assert.match(zh, /^（这是用她自己的知乎号看到的。）/)
  const bili = renderBili([{
    video: { bvid: 'BV1', title: '一条', owner: { name: '甲' }, duration: 60, tname: 'x' },
    desc: '', tags: [], comments: [], danmaku: [], pubdate: null,
  }], { config: { bili: { owner: 'owner' } } })
  assert.match(bili, /这是用那个重要的人的B 站号看到的，不是你经历的/)
  const dy = renderDouyin([{ id: '1', title: '一条', author: '甲', like: '1' }], { browse: { douyin: { owner: 'owner' } } })
  assert.match(dy, /这是用那个重要的人的抖音号看到的，不是你经历的/)
})
