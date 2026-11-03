/**
 * dylink.test.mjs —— 一条抖音链接变成「她看过的东西」
 *
 * 这里只测不联网的部分：认链接、拼短链跳转、把详情压成几句话。
 * 真机能不能打开，是另一回事——所以失败路径也必须有断言：
 * **拿不到就说拿不到，不许编。**
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  awemeIdFromUrl,
  describeAweme,
  fetchAweme,
  findDouyinLinks,
  normalizeAweme,
  resolveAwemeId,
} from '../lib/dylink.js'

const DETAIL = {
  aweme_detail: {
    aweme_id: '7698383770206099046',
    desc: '原声版来了 🧊美式真的很生气',
    author: { nickname: '小满' },
    create_time: 1793600000,
    video: {
      duration: 18400,
      play_addr: { url_list: ['https://v3-web.douyinvod.com/x.mp4'] },
      cover: { url_list: ['https://p3-sign.douyinpic.com/c.jpg'] },
    },
    statistics: { digg_count: 12345, comment_count: 678, share_count: 90 },
  },
}

test('认得出三种链接，短链留空 id 等解析', () => {
  const text = '你看这个 https://v.douyin.com/iRkQ2xYz/ 还有 https://www.douyin.com/video/7698383770206099046'
  const links = findDouyinLinks(text)
  assert.equal(links.length, 2)
  assert.equal(links[0].id, '')
  assert.equal(links[1].id, '7698383770206099046')
})

test('笔记链接也认，普通网址不认', () => {
  assert.equal(findDouyinLinks('https://www.douyin.com/note/7698383770206099046').length, 1)
  assert.equal(findDouyinLinks('https://www.bilibili.com/video/BV1xx411c7mD').length, 0)
  assert.equal(findDouyinLinks('').length, 0)
})

test('一条消息里最多看两条，重复的只算一次', () => {
  const same = 'https://www.douyin.com/video/7698383770206099046'
  assert.equal(findDouyinLinks(`${same} ${same}`).length, 1)
  const many = [
    'https://www.douyin.com/video/111111111111111111',
    'https://www.douyin.com/video/222222222222222222',
    'https://www.douyin.com/video/333333333333333333',
  ].join(' ')
  assert.equal(findDouyinLinks(many).length, 2)
})

test('awemeIdFromUrl 只从 /video/ 和 /note/ 里取', () => {
  assert.equal(awemeIdFromUrl('https://www.douyin.com/video/7698383770206099046'), '7698383770206099046')
  assert.equal(awemeIdFromUrl('https://v.douyin.com/iRkQ2xYz/'), '')
})

test('短链跟一次跳转，从 Location 里拿到 id', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.redirect, 'manual')
    return { status: 302, headers: { get: (k) => (k === 'location' ? 'https://www.iesdouyin.com/share/video/7698383770206099046/?a=1' : '') } }
  }
  const r = await resolveAwemeId('https://v.douyin.com/iRkQ2xYz/', { fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.id, '7698383770206099046')
})

test('短链返回落地页时，从正文里抠 id', async () => {
  const fetchImpl = async () => ({
    status: 200,
    headers: { get: () => '' },
    text: async () => '<script>window.x="/video/7698383770206099046"</script>',
  })
  const r = await resolveAwemeId('https://v.douyin.com/iRkQ2xYz/', { fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.id, '7698383770206099046')
})

test('跳不开就说跳不开，不抛', async () => {
  const fetchImpl = async () => ({ status: 403, headers: { get: () => '' } })
  const r = await resolveAwemeId('https://v.douyin.com/iRkQ2xYz/', { fetchImpl })
  assert.equal(r.ok, false)
  assert.match(r.why, /没看到视频 id/)
})

test('超时也返回失败，不卡住', async () => {
  const fetchImpl = async () => {
    const e = new Error('aborted')
    e.name = 'AbortError'
    throw e
  }
  const r = await resolveAwemeId('https://v.douyin.com/iRkQ2xYz/', { fetchImpl })
  assert.equal(r.ok, false)
  assert.match(r.why, /超时/)
})

test('详情压成她要看的几个字段', () => {
  const a = normalizeAweme(DETAIL.aweme_detail)
  assert.equal(a.id, '7698383770206099046')
  assert.equal(a.author, '小满')
  assert.equal(a.duration, 18)
  assert.equal(a.likes, 12345)
  assert.equal(a.playUrl, 'https://v3-web.douyinvod.com/x.mp4')
})

test('一句话概括带上作者和数字，没文案就说没文案', () => {
  const line = describeAweme(normalizeAweme(DETAIL.aweme_detail))
  assert.match(line, /原声版来了/)
  assert.match(line, /作者 小满/)
  assert.match(line, /18 秒/)
  assert.match(line, /12345 赞/)
  assert.match(describeAweme({ desc: '' }), /没写文案/)
})

test('没有浏览器就没有详情——这是「拿不到」，不是「没这条视频」', async () => {
  const r = await fetchAweme('7698383770206099046', {})
  assert.equal(r.ok, false)
  assert.match(r.why, /没有浏览器/)
})

test('详情里没有视频时不假装有', async () => {
  const api = async () => ({ ok: true, data: { aweme_detail: null } })
  const r = await fetchAweme('1', { api })
  assert.equal(r.ok, false)
  assert.match(r.why, /没有这条视频/)
})

test('抽帧拼图有上限：留最新的 20 张，残留视频顺手清掉', async () => {
  const { mkdtemp, writeFile, readdir, utimes } = await import('node:fs/promises')
  const os = await import('node:os')
  const pathMod = await import('node:path')
  const { pruneMedia } = await import('../lib/dylink.js')
  const dir = await mkdtemp(pathMod.join(os.tmpdir(), 'dyprune-'))
  for (let i = 0; i < 25; i++) {
    const f = pathMod.join(dir, `dy-sheet-${i}.png`)
    await writeFile(f, 'x')
    const t = new Date(Date.now() + i * 1000)
    await utimes(f, t, t)
  }
  await writeFile(pathMod.join(dir, 'dy-orphan.mp4'), 'x')
  await writeFile(pathMod.join(dir, 'keep-me.txt'), 'x')

  const r = await pruneMedia(dir)
  assert.equal(r.ok, true)
  assert.equal(r.kept, 20)
  assert.equal(r.removed, 5)
  const left = (await readdir(dir)).filter((n) => n.startsWith('dy-sheet-'))
  assert.equal(left.length, 20)
  assert.ok(!left.includes('dy-sheet-0.png'), '最旧的那张该被清掉')
  assert.ok(left.includes('dy-sheet-24.png'), '最新的要留着')
  const all = await readdir(dir)
  assert.ok(!all.includes('dy-orphan.mp4'), '残留视频要收尸')
  assert.ok(all.includes('keep-me.txt'), '别人的文件一个字不许动')
})

test('下视频要带 Referer：抖音 CDN 不带就是 403', async () => {
  const os = await import('node:os')
  const { framesOf } = await import('../lib/dylink.js')
  let seen = null
  const fetchImpl = async (url, opts) => { seen = opts?.headers ?? {}; return { ok: false, status: 403 } }
  const r = await framesOf({ id: '1', playUrl: 'https://v26-web.douyinvod.com/x.mp4', duration: 10 }, { root: os.tmpdir(), fetchImpl })
  assert.equal(r.ok, false)
  assert.match(String(r.why), /403/)
  assert.equal(seen?.referer, 'https://www.douyin.com/')
  assert.match(String(seen?.['user-agent']), /Mozilla/)
})

test('图文作品：没有视频流也能拼一张（三张图）', () => {
  const a = normalizeAweme({ aweme_id: '7703868127586578105', desc: '', images: [{ url_list: ['https://p3/a.webp'] }, { url_list: ['https://p3/b.webp'] }, { url_list: ['https://p3/c.webp'] }], statistics: { digg_count: 1251, comment_count: 519 }, author: { nickname: '请叫我豪门' } })
  assert.equal(a.kind, 'images')
  assert.equal(a.images.length, 3)
  const line = describeAweme(a)
  assert.match(line, /图文/)
  assert.match(line, /请叫我豪门/)
})

test('图文作品的图多于三张时只取前三（上下文别被撑爆）', () => {
  const a = normalizeAweme({ aweme_id: '1', images: Array.from({ length: 9 }, (_, i) => ({ url_list: [`https://p3/${i}.webp`] })) })
  assert.equal(a.images.length, 3)
})
