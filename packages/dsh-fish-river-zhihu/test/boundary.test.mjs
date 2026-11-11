/**
 * 子包自己的边界：不引用主包，出口不再落后于 api.js，知乎规则在包里。
 * 宿主接线（作息、社会层、事件流）仍由 test/ 里的用例守。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as pkg from '../index.js'
import { normalizeZhihu, ZHIHU_COPY, ZHIHU_DEFAULTS } from '../config.js'
import { parseTarget } from '../look.js'
import { opensToday, commentCountToday } from '../comment.js'
import { renderQuestions } from '../material.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

test('子包源码不 import 主包 lib', async () => {
  const names = (await readdir(root)).filter((name) => name.endsWith('.js'))
  assert.ok(names.includes('comment.js'))
  for (const name of names) {
    const text = await readFile(join(root, name), 'utf8')
    assert.doesNotMatch(text, /from\s+['"][^'"]*\/lib\//, name)
    assert.doesNotMatch(text, /from\s+['"]\.\.\/\.\.\/lib\//, name)
    assert.doesNotMatch(text, /require\(\s*['"][^'"]*lib\//, name)
  }
})

test('出口含邀请、推荐、发布控制和领域入口', () => {
  for (const name of [
    'fetchQuestionInvites', 'fetchQuestionRecommend', 'answerPublishControl', 'resetZhihuWriteRisk',
    'normalizeZhihu', 'fetchZhihuMaterial', 'zhihuLookOnce', 'registerZhihuLook',
    'postComment', 'postReply', 'postAnswer', 'scanIfAwake', 'registerZhihuSpeak', 'bindHost',
  ]) {
    assert.equal(typeof pkg[name], 'function', name)
  }
})

test('normalizeZhihu：默认关、夹紧、旧 voices 丢掉', () => {
  const fresh = normalizeZhihu({})
  assert.equal(fresh.enabled, false)
  assert.equal(fresh.owner, 'owner')
  assert.equal(fresh.hot.topN, ZHIHU_DEFAULTS.hot.topN)
  assert.equal(fresh.history.enabled, true)
  assert.deepEqual(fresh.answer, { enabled: false, perDay: 1 })
  const tight = normalizeZhihu({
    enabled: true,
    perDay: 99,
    voices: true,
    hot: { topN: 99 },
    follow: { topN: 0 },
    comment: { enabled: true, perDay: 9, replyPerDay: 40 },
    answer: { enabled: true, perDay: 3 },
    accountOf: 'home',
  })
  assert.equal(tight.perDay, 8)
  assert.equal(tight.hot.topN, 20)
  assert.equal(tight.follow.topN, 1)
  assert.equal(tight.voices, undefined)
  assert.equal(tight.accountOf, undefined)
  assert.equal(tight.comment.perDay, 5)
  assert.equal(tight.comment.replyPerDay, 10)
  assert.equal(tight.answer.perDay, 1)
  assert.equal(tight.owner, 'her', '没写 owner 时，老的 accountOf=home 迁成她自己的号')
  assert.equal(normalizeZhihu({ owner: 'owner', accountOf: 'home' }).owner, 'owner')
})

test('点开前缀和问题素材仍是原来的句子', () => {
  const events = [{ type: 'meta', text: 'zhihu-open:2026-11-11 42 {"question":"7"}' }]
  assert.deepEqual(opensToday(events, '2026-11-11'), [{ id: '42', question: '7' }])
  assert.equal(commentCountToday(events, '2026-11-11'), 0)
  assert.deepEqual(parseTarget('https://www.zhihu.com/question/1/answer/2'), { questionId: '1', answerId: '2' })
  const text = renderQuestions([{ id: 'q1', title: '为什么', source: 'invite' }])
  assert.match(text, /为什么（问题 q1，邀请）/)
  assert.match(text, /zhihu_look/)
})

test('设置页文案和子包导出一致（表单仍画在 client.js）', async () => {
  const client = await readFile(join(root, '..', '..', 'lib', 'client.js'), 'utf8')
  for (const value of Object.values(ZHIHU_COPY)) {
    assert.equal(client.includes(value), true, value.slice(0, 24))
  }
})
