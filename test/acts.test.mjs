/**
 * acts.test.mjs —— 动作表：旧行还能拆，知乎和贴吧的说话已经接线。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTS,
  actByPrefix,
  formatBiliComment,
  formatBiliLook,
  formatBiliReply,
  formatTiebaForum,
  formatTiebaThread,
  formatZhihuOpen,
  parseAct,
} from '../lib/core/acts.js'

test('旧 look / comment 仍能拆出 id；带 JSON 时有标题或摘要', () => {
  const look = parseAct('look:2026-11-07 BV1xx411c7mD')
  assert.equal(look.id, 'BV1xx411c7mD')
  assert.equal(look.title, '')

  const look2 = parseAct('look:2026-11-07 BV1xx411c7mD {"title":"一条标题"}')
  assert.equal(look2.id, 'BV1xx411c7mD')
  assert.equal(look2.title, '一条标题')
  assert.equal(look2.label, '在点开一条')
  assert.equal(look2.quota, null)

  const comment = parseAct('comment:2026-11-07 BV1xx411c7mD 88')
  assert.equal(comment.id, 'BV1xx411c7mD')
  assert.equal(comment.rpid, 88)
  assert.equal(comment.summary, '')

  const comment2 = parseAct('comment:2026-11-07 BV1xx411c7mD 88 {"text":"说完了"}')
  assert.equal(comment2.id, 'BV1xx411c7mD')
  assert.equal(comment2.rpid, 88)
  assert.equal(comment2.summary, '说完了')
})

test('摘要里的空格不挡 id；JSON 本身没有多余空格', () => {
  const line = formatBiliComment('2026-11-07', 'BV1xx411c7mD', 88, '今天 还行\n呀')
  assert.equal(line, 'comment:2026-11-07 BV1xx411c7mD 88 {"text":"今天 还行 呀"}')
  const act = parseAct(line)
  assert.equal(act.id, 'BV1xx411c7mD')
  assert.equal(act.rpid, 88)
  assert.equal(act.summary, '今天 还行 呀')

  const reply = formatBiliReply('2026-11-07', 'BV1xx411c7mD', 10, 11, '回一句')
  assert.equal(reply, 'creply:2026-11-07 BV1xx411c7mD 10 11 {"text":"回一句"}')
  assert.equal(parseAct(reply).id, 'BV1xx411c7mD')
})

test('标题截到 40 字', () => {
  const line = formatBiliLook('2026-11-07', 'BV1xx411c7mD', '字'.repeat(50))
  assert.equal(parseAct(line).title.length, 40)
  assert.match(line, /^look:2026-11-07 BV1xx411c7mD \{"title":/)
})

test('点开不加配额；知乎和贴吧评论只在表里', () => {
  for (const prefix of ['look:', 'zhihu-open:', 'tieba-thread:', 'tieba-forum:']) {
    const row = actByPrefix(prefix)
    assert.ok(row, prefix)
    assert.equal(row.quota, null, prefix)
    assert.equal(row.wired, true, prefix)
  }
  for (const prefix of ['zhihu-comment:', 'zhihu-reply:', 'zhihu-answer:', 'tieba-comment:', 'tieba-reply:']) {
    const row = actByPrefix(prefix)
    assert.ok(row, prefix)
    assert.equal(row.wired, true, prefix)
    assert.equal(row.phase, 'talking', prefix)
  }
  assert.equal(ACTS.some((act) => act.prefixes.includes('hand:')), false)
  assert.equal(ACTS.some((act) => act.prefixes.includes('looked:')), false)
  assert.equal(parseAct('hand:2026-11-07 BV1xx411c7mD'), null)
  assert.equal(parseAct('looked:BV1xx411c7mD'), null)
  assert.equal(parseAct('fired:test_first'), null)
  assert.equal(parseAct('sched:2026-11-07 2026-11-07T00:00:00.000Z'), null)
  assert.equal(parseAct('wake:2026-11-07 nightly')?.role, 'wake')
})

test('点开的前缀各归各的', () => {
  assert.match(formatZhihuOpen('2026-11-07', '123', '一个问题'), /^zhihu-open:2026-11-07 123 /)
  assert.match(formatTiebaThread('2026-11-07', '999', '一个帖子', 'meme吧'), /^tieba-thread:2026-11-07 999 /)
  assert.match(formatTiebaForum('2026-11-07', 'meme吧'), /^tieba-forum:2026-11-07 meme吧 /)
  assert.equal(parseAct(formatZhihuOpen('2026-11-07', '123', '一个问题')).label, '在看知乎的一页')
  assert.equal(parseAct(formatTiebaThread('2026-11-07', '999', '一个帖子', 'meme吧')).label, '在看一个帖子')
  assert.equal(parseAct('dy-browse:2026-11-07 [{"id":"1","title":"一条"}]').label, '在刷抖音')
})

test('后续分片不算进每天刷几次', () => {
  assert.equal(parseAct('browse:2026-11-07 [{"title":"a"},{"title":"b"}]').tallyN, 2)
  assert.equal(parseAct('browse-more:2026-11-07 [{"title":"c"}]').tallyN, 0)
  assert.equal(parseAct('look:2026-11-07 BV1').tallyN, 0)
})
