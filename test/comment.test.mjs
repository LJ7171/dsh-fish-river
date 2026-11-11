/**
 * comment.test.mjs —— 评论记账末尾的摘要不能打断按空格取号。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  commentCountToday,
  herComments,
  herCommentsRecent,
  replyCountToday,
  targetsToday,
} from '../lib/platforms/comment.js'
import { formatBiliComment, formatBiliLook, formatBiliReply } from '../lib/core/acts.js'

const DK = '2026-11-07'

function meta(text) {
  return { type: 'meta', text }
}

test('旧 comment 行和新的摘要行都能数出 bvid 与 rpid', () => {
  const fresh = formatBiliComment(DK, 'BV1new', 42, '今天 还行')
  const events = [
    meta(`comment:${DK} BV1old 7`),
    meta(fresh),
    meta(formatBiliReply(DK, 'BV1new', 42, 9, '回 一句')),
  ]
  assert.equal(commentCountToday(events, DK), 2)
  assert.equal(replyCountToday(events, DK), 1)
  assert.deepEqual(herComments(events, DK), [
    { bvid: 'BV1old', rpid: 7 },
    { bvid: 'BV1new', rpid: 42 },
  ])
  assert.deepEqual(herCommentsRecent(events, 7, new Date(2026, 10, 7, 12).getTime()), [
    { bvid: 'BV1new', rpid: 42, dk: DK },
    { bvid: 'BV1old', rpid: 7, dk: DK },
  ])
})

test('look 行末尾的标题 JSON 不挡今天看过的 BV 号', () => {
  const events = [meta(formatBiliLook(DK, 'BV1look', '一条 标题'))]
  assert.deepEqual(targetsToday(events, DK).map((x) => x.bvid), ['BV1look'])
})
