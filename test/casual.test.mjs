/**
 * casual.test.mjs —— 渠道回复的标点轻整理
 *
 * 句末句号留着。连续的同一标点收成一个，空白收一收。
 * 小数、版本、链接、问号感叹号、省略号、代码的写法不动。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { casualizePunctuation, casualPunctuationOn } from '../lib/channels/casual.js'
import { splitBubbles } from '../lib/channels/router.js'

test('句末句号留着，问号感叹号和逗号也留着', () => {
  assert.equal(casualizePunctuation('在。'), '在。')
  assert.equal(casualizePunctuation('在。今天有点忙。'), '在。今天有点忙。')
  assert.equal(casualizePunctuation('嗯，我在。'), '嗯，我在。')
  assert.equal(casualizePunctuation('真的？'), '真的？')
  assert.equal(casualizePunctuation('好！'), '好！')
  assert.equal(casualizePunctuation('好！真的？'), '好！真的？')
  assert.equal(casualizePunctuation('「好。」'), '「好。」')
})

test('连续同一标点收成一个，省略号收到一处', () => {
  assert.equal(casualizePunctuation('好！！！'), '好！')
  assert.equal(casualizePunctuation('真的？？？'), '真的？')
  assert.equal(casualizePunctuation('好。。。'), '好。')
  assert.equal(casualizePunctuation('等下...'), '等下...')
  assert.equal(casualizePunctuation('等下....'), '等下...')
  assert.equal(casualizePunctuation('等下…'), '等下…')
  assert.equal(casualizePunctuation('等下……'), '等下……')
  assert.equal(casualizePunctuation('等下………'), '等下……')
  assert.equal(casualizePunctuation('等下…再看。'), '等下…再看。')
})

test('英文句末句号留着，小数、版本、域名、缩写里的点也留着', () => {
  assert.equal(casualizePunctuation('I am here.'), 'I am here.')
  assert.equal(casualizePunctuation('I am here. Really.'), 'I am here. Really.')
  assert.equal(casualizePunctuation('圆周率是 3.14。'), '圆周率是 3.14。')
  assert.equal(casualizePunctuation('版本 v1.2 已经出了。'), '版本 v1.2 已经出了。')
  assert.equal(casualizePunctuation('版本 v1.2.3.'), '版本 v1.2.3.')
  assert.equal(casualizePunctuation('去 example.com 看。'), '去 example.com 看。')
  assert.equal(casualizePunctuation('去 example.com.'), '去 example.com.')
  assert.equal(casualizePunctuation('Mr. Smith is here.'), 'Mr. Smith is here.')
  assert.equal(casualizePunctuation('Wait?'), 'Wait?')
  assert.equal(casualizePunctuation('Hey!'), 'Hey!')
  assert.equal(casualizePunctuation('Hey!!!'), 'Hey!')
})

test('表情、@、链接不改，链接后面的句号留在正文', () => {
  assert.equal(casualizePunctuation('好。😂 @你。'), '好。😂 @你。')
  assert.equal(
    casualizePunctuation('看 https://example.com/a?x=1.2 就行。'),
    '看 https://example.com/a?x=1.2 就行。',
  )
  assert.equal(
    casualizePunctuation('看 https://example.com/a.b/c.'),
    '看 https://example.com/a.b/c.',
  )
})

test('代码块和行内代码里的点不动', () => {
  assert.equal(casualizePunctuation('看 `a.b` 和 3.14。'), '看 `a.b` 和 3.14。')
  const fence = '```\nconst x = 1.\n```'
  assert.equal(casualizePunctuation(fence), fence)
  assert.equal(casualizePunctuation('先看。\n```\nok.\n```\n再说。'), '先看。\n```\nok.\n```\n再说。')
  assert.equal(casualizePunctuation('先看！！\n```\nok!!!\n```'), '先看！\n```\nok!!!\n```')
})

test('连续空白收一收，换行留着', () => {
  assert.equal(casualizePunctuation('嗯。   好。'), '嗯。 好。')
  assert.equal(casualizePunctuation('嗯。\n\n好。'), '嗯。\n\n好。')
  assert.equal(casualizePunctuation('嗯。\n\n\n\n好。'), '嗯。\n\n好。')
})

test('空串和纯空白不发，单独句号还在', () => {
  assert.equal(casualizePunctuation(''), '')
  assert.equal(casualizePunctuation('   '), '')
  assert.equal(casualizePunctuation(null), '')
  assert.equal(casualizePunctuation('。'), '。')
  assert.equal(casualizePunctuation('.'), '.')
  assert.equal(casualizePunctuation('  。  '), '。')
  assert.equal(casualizePunctuation('...'), '...')
  assert.equal(casualizePunctuation('？'), '？')
  assert.equal(casualizePunctuation('!'), '!')
})

test('分段之后每一段各自整理，切点仍按原来的句号', () => {
  const src = '在。\n\n刚看到你消息。今天有点忙。'
  const parts = splitBubbles(src)
  assert.deepEqual(parts, ['在。', '刚看到你消息。', '今天有点忙。'])
  assert.deepEqual(parts.map((p) => casualizePunctuation(p)), ['在。', '刚看到你消息。', '今天有点忙。'])
  assert.equal(casualizePunctuation('在。刚看到。'), '在。刚看到。')
  assert.equal(casualizePunctuation('在！！刚看到。。'), '在！刚看到。')
})

test('开关缺键是开，只有显式 false 才关', () => {
  assert.equal(casualPunctuationOn({}), true)
  assert.equal(casualPunctuationOn({ im: {} }), true)
  assert.equal(casualPunctuationOn({ im: { bubbleSplit: true } }), true)
  assert.equal(casualPunctuationOn({ config: { im: { casualPunctuation: true } } }), true)
  assert.equal(casualPunctuationOn({ im: { casualPunctuation: false } }), false)
  assert.equal(casualPunctuationOn({ im: { casualPunctuation: 'false' } }), true, '字符串不算关掉')
})
