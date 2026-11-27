/**
 * tieba.test.mjs —— 贴吧只读素材：签名、解析、配额、扫码不回显 cookie。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dateKey, normalizeConfig } from '../lib/core/settings.js'
import { appendEvent, readEvents } from '../lib/core/store.js'
import { formatTiebaComment, formatTiebaThread } from '../lib/core/acts.js'
import { postComment, postReply } from '../lib/platforms/tieba/comment.js'
import { resetSpeakRisk } from '../lib/platforms/common/writeRisk.js'
import {
  SIGN_SECRET, addThreadPost, bdussFromBody, cookieFromSetCookie, parseJsonp, pickCookie, postsFrom,
  extractPostImages, renderMaterial, signParams, threadsFrom, fetchTiebaMaterial, createQr, pollQr, readAuth,
  savePastedCookie, tiebaStatus,
} from '../lib/platforms/tieba/client.js'
import { registerTiebaLook, tiebaLookOnce, parseThreadId } from '../lib/platforms/tieba/look.js'

function pathname(url) {
  try { return new URL(String(url)).pathname } catch { return '' }
}

function jsonRes(data) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
    headers: { getSetCookie: () => [] },
  }
}

const FEED = {
  page_data: {
    feed_list: [
      { layout: 'frs_top_thread_card' },
      {
        layout: 'feed',
        feed: {
          components: [{
            component: 'feed_head',
            feed_head: { main_data: [{ text: { text: '半岛花茶' }, business_info_map: { icon_type: 'name_show' } }] },
          }],
          business_info_map: { title: '大学生该不该分期买耳机', abstract: '大三' },
          log_param: [{ key: 'tid', value: '11157099354' }],
        },
      },
    ],
  },
}

test('签名：非空参数按 key 升序拼接后 MD5', () => {
  const raw = `a=2b=1${SIGN_SECRET}`
  const expect = createHash('md5').update(raw).digest('hex')
  assert.equal(signParams({ b: 1, a: 2, c: '', sign: 'nope' }), expect)
  assert.equal(expect, expect.toLowerCase())
})

test('推荐卡片和帖子页能抽出标题，楼中楼不进正文', () => {
  const threads = threadsFrom(FEED)
  assert.equal(threads.length, 1)
  assert.equal(threads[0].id, '11157099354')
  assert.equal(threads[0].author, '半岛花茶')
  assert.equal(threads[0].url, 'https://tieba.baidu.com/p/11157099354')
  const page = postsFrom({
    thread: { id: '111', title: '耳机' },
    forum: { name: '李毅' },
    post_list: [{
      floor: 1,
      author_id: 7,
      content: [{ type: 0, text: '分期不合适' }],
      sub_post_list: { sub_post_list: [{ content: [{ type: 0, text: '楼中楼不该出现' }] }] },
    }],
    user_list: [{ id: 7, name_show: '花茶' }],
  }, 3)
  assert.equal(page.posts.length, 1)
  assert.equal(page.posts[0].author, '花茶')
  assert.equal(page.posts[0].text, '分期不合适')
  assert.doesNotMatch(renderMaterial({ threads: [page] }), /楼中楼/)
})

test('page_pc 形状没有图；/page 的楼层才抽得出 type 3/20', () => {
  // Contents_pc：文字、表情、@、链接、语音。表情自己的 src 不是帖里的图。
  const pc = postsFrom({
    thread: { id: '1', title: 'pc' },
    forum: { id: '276', name: '测试' },
    post_list: [{
      floor: 1,
      author_id: 1,
      content: [
        { type: 0, text: '只有字' },
        { type: 2, text: 'image_emoticon', src: 'https://tiebapic.baidu.com/emoji.png' },
        { type: 1, text: '链接', link: 'https://tieba.baidu.com/p/1' },
        { type: 4, text: '@甲', uid: 1 },
        { type: 10, voice_md5: 'abc', during_time: 1 },
      ],
    }],
    user_list: [{ id: 1, name_show: '甲' }],
  })
  assert.equal(pc.fid, '276')
  assert.equal(pc.posts.length, 1)
  assert.equal(pc.posts[0].images.length, 0)
  assert.match(pc.posts[0].text, /只有字/)

  // Contents_p 常常包在 data 里，type 是字符串，原图也可能是 // 开头。
  const mobile = postsFrom({
    error_code: '0',
    data: {
      thread: { tid: '9', title: '图帖', fid: 276 },
      forum: { name: '测试' },
      post_list: [{
        floor: 1,
        author_id: '1',
        content: [
          { type: '0', text: '看看图' },
          { type: '3', origin_src: 'https://tiebapic.baidu.com/one.jpg', src: 'https://tiebapic.baidu.com/one_s.jpg' },
          { type: '20', big_src: '//tiebapic.baidu.com/two.gif' },
        ],
      }],
      user_list: [{ id: '1', name_show: '甲' }],
    },
  })
  assert.equal(mobile.fid, '276')
  assert.equal(mobile.id, '9')
  assert.equal(mobile.posts[0].text, '看看图')
  assert.deepEqual(mobile.posts[0].images, [
    'https://tiebapic.baidu.com/one.jpg',
    'https://tiebapic.baidu.com/two.gif',
  ])
})

test('帖子楼层：抽出 type 3/20 图；纯图楼也保留', () => {
  const urls = extractPostImages([
    { type: 0, text: '字' },
    { type: 3, origin_src: 'https://tiebapic.baidu.com/a.jpg', src: 'https://tiebapic.baidu.com/a_s.jpg' },
    { type: 20, big_src: 'https://tiebapic.baidu.com/b.gif' },
    { type: 3, src: 'http://insecure.example/x.jpg' },
  ], 3)
  assert.deepEqual(urls, [
    'https://tiebapic.baidu.com/a.jpg',
    'https://tiebapic.baidu.com/b.gif',
  ])
  const page = postsFrom({
    thread: { id: '9', title: '图帖' },
    forum: { name: '测试' },
    post_list: [{
      floor: 1,
      author_id: 1,
      content: [{ type: 3, origin_src: 'https://tiebapic.baidu.com/only.jpg' }],
    }],
    user_list: [{ id: 1, name_show: '甲' }],
  }, 3)
  assert.equal(page.posts.length, 1)
  assert.equal(page.posts[0].text, '')
  assert.deepEqual(page.posts[0].images, ['https://tiebapic.baidu.com/only.jpg'])
})

test('tieba_look 进帖：开着看图就落盘；关着只有文字', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-tieba-img-'))
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  try {
    await savePastedCookie(root, 'BDUSS=abc123456789', async () => ({
      ok: true, status: 200, text: async () => '{"error_code":0,"data":{"user":{}}}', headers: { getSetCookie: () => [] },
    }))
    const tid = '11157099999'
    // /page 的楼层：type 可能是字符串。page_pc 就算被叫到，也只有 Contents_pc，没有 type 3。
    const mobileJson = {
      error_code: '0',
      thread: { id: tid, title: '有图帖' },
      forum: { id: '276', name: '测试' },
      post_list: [{
        floor: 1,
        author_id: '1',
        content: [
          { type: '0', text: '看看图' },
          { type: '3', origin_src: 'https://tiebapic.baidu.com/one.jpg', src: 'https://tiebapic.baidu.com/one_s.jpg' },
          { type: '20', big_src: 'https://tiebapic.baidu.com/two.gif' },
          { type: '3', origin_src: 'https://tiebapic.baidu.com/three.jpg' },
        ],
      }],
      user_list: [{ id: '1', name_show: '甲' }],
    }
    const pcJson = {
      error_code: 0,
      thread: { id: tid, title: '有图帖' },
      forum: { id: '276', name: '测试' },
      post_list: [{
        floor: 1,
        author_id: 1,
        content: [
          { type: 0, text: '看看图' },
          { type: 2, text: 'image_emoticon' },
        ],
      }],
      user_list: [{ id: 1, name_show: '甲' }],
    }
    const pageBodies = []
    let pics = 0
    let pcHits = 0
    const fetchImpl = async (url, init) => {
      const u = String(url)
      const path = pathname(u)
      if (u.includes('tiebapic.baidu.com')) {
        pics += 1
        return { ok: true, status: 200, arrayBuffer: async () => jpeg }
      }
      if (path === '/c/f/pb/page_pc') {
        pcHits += 1
        return jsonRes(pcJson)
      }
      if (path === '/c/f/pb/page') {
        pageBodies.push(String(init?.body ?? ''))
        const q = new URLSearchParams(String(init?.body ?? ''))
        assert.equal(q.get('_client_type'), '20')
        assert.equal(q.get('subapp_type'), 'pc')
        assert.match(String(init?.headers?.['user-agent'] ?? ''), /Mozilla/)
        return jsonRes(mobileJson)
      }
      return jsonRes({ error_code: 0, data: { anti: { tbs: 't' }, user: {} } })
    }
    const on = await tiebaLookOnce({
      root,
      cfg: normalizeConfig({ tieba: { enabled: true, images: { enabled: true, max: 2 } } }),
      kind: 'thread',
      id: tid,
      fetchImpl,
    })
    assert.equal(on.ok, true, on.note)
    assert.match(on.text, /看看图/)
    assert.match(on.text, /有图存在/)
    assert.match(on.text, /read_image/)
    assert.match(on.text, /media[/\\]tieba-/)
    const pathHits = on.text.match(/media[/\\]tieba-[^\s）]+/g) || []
    assert.equal(pathHits.length, 2, 'max=2 只下两张')
    assert.equal(pics, 2)
    assert.equal(pageBodies.length, 1)
    assert.equal(pcHits, 0, '进帖不走 page_pc')
    assert.equal(pageBodies.some((b) => b.includes('page_pc')), false)

    const off = await tiebaLookOnce({
      root,
      cfg: normalizeConfig({ tieba: { enabled: true, images: { enabled: false } } }),
      kind: 'thread',
      id: tid,
      fetchImpl,
    })
    assert.equal(off.ok, true, off.note)
    assert.match(off.text, /看看图/)
    assert.doesNotMatch(off.text, /read_image|有图存在/)
    assert.equal(pics, 2, '关着看图时不再下载')
    assert.equal(pcHits, 0, '关着看图也仍然走手机端进帖')
    const { events } = await readEvents(root)
    const threadLine = events.map((e) => String(e.text ?? '')).find((t) => t.startsWith(`tieba-thread:${dateKey()} `))
    assert.match(threadLine, /"fid":"276"/)
    assert.match(threadLine, /^tieba-thread:/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('未登录或推荐为空：blocked，不计次数，不写事件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-tieba-'))
  try {
    const cfg = normalizeConfig({ tieba: { enabled: true }, sleep: { daily: { tieba: 2 } } })
    const off = await fetchTiebaMaterial({ root, cfg, fetchImpl: async () => { throw new Error('不该发请求') } })
    assert.equal(off.blocked, true)
    assert.equal(off.why, 'login-required')
    const quiet = async () => ({ ok: true, status: 200, text: async () => '{"error_code":0,"data":{"user":{}}}', headers: { getSetCookie: () => [] } })
    await savePastedCookie(root, 'BDUSS=abc123456789; OTHER=secret; junk', quiet)
    const auth = await readAuth(root)
    assert.match(auth.cookie, /^BDUSS=/)
    assert.doesNotMatch(auth.cookie, /OTHER|junk/)
    if (process.platform !== 'win32') {
      const mode = (await stat(join(root, 'tieba.json'))).mode & 0o777
      assert.equal(mode, 0o600)
    }
    const empty = await fetchTiebaMaterial({
      root,
      cfg,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"error_code":0,"page_data":{}}', json: async () => ({ error_code: 0, page_data: {} }), headers: { getSetCookie: () => [] } }),
    })
    assert.equal(empty.blocked, true)
    assert.equal(empty.acted, false)
    const st = await tiebaStatus(root)
    assert.equal(st.runsToday, 0)
    assert.equal(st.loggedIn, true)
    assert.equal('cookie' in st, false)
    const { events } = await readEvents(root)
    assert.equal(events.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('推荐有内容就记 1 次，响应里不出现 cookie', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-tieba-ok-'))
  try {
    await savePastedCookie(root, 'BDUSS=abc123456789', async () => ({ ok: true, status: 200, text: async () => '{"error_code":0,"data":{"user":{"name_show":"花茶"}}}', headers: { getSetCookie: () => [] } }))
    const cfg = normalizeConfig({
      tieba: { enabled: true, thread: { enabled: false }, forum: { enabled: false } },
      sleep: { daily: { tieba: 2 } },
    })
    let sawCookie = false
    const r = await fetchTiebaMaterial({
      root,
      cfg,
      fetchImpl: async (url, init) => {
        if (String(init?.headers?.cookie ?? '').includes('BDUSS')) sawCookie = true
        const path = String(url)
        const json = path.includes('personalized_pc')
          ? { error_code: 0, ...FEED }
          : { error_code: 0, data: { anti: { tbs: 't' }, user: { is_login: 1, name_show: '花茶' } } }
        return { ok: true, status: 200, text: async () => JSON.stringify(json), headers: { getSetCookie: () => [] } }
      },
    })
    assert.equal(sawCookie, true, '请求要带登录态')
    assert.equal(r.acted, true)
    assert.match(r.text, /大学生该不该分期买耳机/)
    assert.doesNotMatch(r.text, /BDUSS/)
    assert.equal((await tiebaStatus(root)).runsToday, 1)
    const again = await fetchTiebaMaterial({
      root,
      cfg,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ error_code: 0, ...FEED }), headers: { getSetCookie: () => [] } }),
    })
    assert.equal(again.blocked, true, '同一条推荐看过就不再算一次空抓')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('进帖、进吧、再看推荐都记账，但不加每天的次数', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-tieba-act-'))
  try {
    await savePastedCookie(root, 'BDUSS=abc123456789', async () => ({
      ok: true, status: 200, text: async () => '{"error_code":0,"data":{"user":{}}}', headers: { getSetCookie: () => [] },
    }))
    const threadJson = {
      error_code: 0,
      thread: { id: '11157099999', title: '有图帖' },
      forum: { id: '276', name: '测试' },
      post_list: [{ floor: 1, author_id: 1, content: [{ type: 0, text: '看看字' }] }],
      user_list: [{ id: 1, name_show: '甲' }],
    }
    let imageTries = 0
    const fetchImpl = async (url) => {
      const u = String(url)
      const path = pathname(u)
      if (u.includes('tiebapic.baidu.com')) {
        imageTries += 1
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.from([0xff, 0xd8, 0xff]) }
      }
      let json = { error_code: 0, data: { anti: { tbs: 't' }, user: {} } }
      if (u.includes('personalized_pc')) json = { error_code: 0, ...FEED, decoy_image: 'https://tiebapic.baidu.com/rec.jpg' }
      else if (path === '/c/f/pb/page') json = threadJson
      else if (path === '/c/f/pb/page_pc') throw new Error('进帖不该走 page_pc')
      else if (u.includes('frs/page_pc')) {
        json = {
          error_code: 0,
          thread_list: [{ tid: '222', title: '吧里一条' }],
          banner: [{ origin_src: 'https://tiebapic.baidu.com/forum-banner.jpg' }],
        }
      }
      return jsonRes(json)
    }
    const cfg = normalizeConfig({ tieba: { enabled: true } })
    const thread = await tiebaLookOnce({ root, cfg, kind: 'thread', id: '11157099999', fetchImpl })
    const forum = await tiebaLookOnce({ root, cfg, kind: 'forum', name: '测试', fetchImpl })
    const rec = await tiebaLookOnce({ root, cfg, kind: 'recommend', fetchImpl })
    assert.equal(thread.ok, true, thread.note)
    assert.equal(forum.ok, true, forum.note)
    assert.equal(rec.ok, true, rec.note)
    const { events } = await readEvents(root)
    const texts = events.map((e) => String(e.text ?? ''))
    const dk = dateKey()
    assert.ok(texts.some((t) => t.startsWith(`tieba-thread:${dk} `) && t.includes('"fid":"276"')), texts.join('\n'))
    assert.ok(texts.some((t) => t.startsWith(`tieba-forum:${dk} `)), texts.join('\n'))
    assert.ok(texts.some((t) => t.startsWith(`tieba:${dk} `)), texts.join('\n'))
    assert.equal(texts.some((t) => t.startsWith('tieba-comment:')), false)
    assert.equal(imageTries, 0, '推荐和进吧不下图；没图的帖也不下')
    assert.doesNotMatch(`${forum.text}\n${rec.text}`, /有图存在|read_image/)
    assert.equal((await tiebaStatus(root)).runsToday, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tieba_look 只读，关着或没登录只说看不了，说明里不提配额和阶段', async () => {
  const ctx = { tools: { register: (s) => s } }
  const tool = registerTiebaLook(ctx, { root: '/tmp/nope' })
  assert.equal(tool.name, 'tieba_look')
  assert.deepEqual(tool.parameters.properties.kind.enum, ['recommend', 'thread', 'forum'])
  assert.doesNotMatch(tool.description, /配额|阶段/)
  const root = await mkdtemp(join(tmpdir(), 'fish-tieba-look-'))
  try {
    const cfg = normalizeConfig({ tieba: { enabled: false } })
    const off = await tiebaLookOnce({ root, cfg })
    assert.equal(off.note, '现在看不了。')
    assert.equal(parseThreadId('https://tieba.baidu.com/p/11157099354'), '11157099354')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('扫码：轮询成功只落本机档，返回值不含 cookie', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-tieba-qr-'))
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])
  const fetchImpl = async (url) => {
    const u = String(url)
    if (u.includes('getqrcode')) {
      return {
        ok: true,
        json: async () => ({ errno: 0, sign: 'sign-1', imgurl: 'passport.baidu.com/v2/api/qrcode?sign=sign-1' }),
        headers: { getSetCookie: () => ['BAIDUID=bid; Path=/'] },
      }
    }
    if (u.includes('/qrcode')) return { ok: true, arrayBuffer: async () => png, headers: { getSetCookie: () => [] } }
    if (u.includes('unicast')) {
      const channel = JSON.stringify({ status: 0, v: 'temp-v' })
      return { ok: true, text: async () => `cb(${JSON.stringify({ errno: 0, channel_v: channel })})`, headers: { getSetCookie: () => [] } }
    }
    if (u.includes('qrbdusslogin')) {
      return {
        ok: true,
        text: async () => `cb({"data":{"session":{"bduss":"frombody123456"}}})`,
        headers: { getSetCookie: () => ['BDUSS=fromcookie123456; Path=/', 'STOKEN=st; Path=/'] },
      }
    }
    if (u.includes('/c/s/pc/sync')) {
      return { ok: true, text: async () => JSON.stringify({ error_code: 0, data: { user: { name_show: '花茶', is_login: 1 } } }), headers: { getSetCookie: () => [] } }
    }
    throw new Error(`unexpected ${u}`)
  }
  try {
    const qr = await createQr({ fetchImpl })
    assert.equal(qr.ok, true)
    assert.match(qr.image, /^data:image\/png;base64,/)
    const polled = await pollQr(qr.id, { fetchImpl, root })
    assert.equal(polled.status, 'ok')
    assert.equal(polled.cookie, undefined)
    assert.equal(polled.account.name, '花茶')
    const raw = await readFile(join(root, 'tieba.json'), 'utf8')
    assert.match(raw, /BDUSS=fromcookie123456/)
    assert.doesNotMatch(JSON.stringify(polled), /fromcookie|frombody/)
    assert.equal(parseJsonp('cb({"errno":1})').errno, 1)
    assert.equal(bdussFromBody(`cb({"data":{"session":{"bduss":""}}})`), '')
    assert.match(cookieFromSetCookie(['BDUSS=abc; Path=/']), /BDUSS=abc/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('刷贴吧只抓推荐：一次出门只有一个请求，清单带链接；进帖/进吧不自动做', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-tieba-one-'))
  try {
    await savePastedCookie(root, 'BDUSS=abc123456789', async () => ({ ok: true, status: 200, text: async () => '{"error_code":0,"data":{"user":{}}}', headers: { getSetCookie: () => [] } }))
    const cfg = normalizeConfig({ tieba: { enabled: true, thread: { enabled: true, topN: 5 }, forum: { enabled: true, topN: 5, names: ['a'] } }, sleep: { daily: { tieba: 2 } } })
    assert.equal(cfg.tieba.thread, undefined, '不再有「自动进帖」配置')
    assert.equal(cfg.tieba.forum, undefined, '不再有「自动进吧」配置')
    let calls = 0
    const r = await fetchTiebaMaterial({
      root,
      cfg,
      fetchImpl: async (url) => {
        calls += 1
        assert.match(String(url), /personalized_pc/, '只允许首页推荐这一个请求')
        return { ok: true, status: 200, text: async () => JSON.stringify({ error_code: 0, ...FEED }), headers: { getSetCookie: () => [] } }
      },
    })
    assert.equal(calls, 1)
    assert.equal(r.acted, true)
    assert.equal(r.picks.length, 1)
    assert.match(r.picks[0].url, /^https:\/\/tieba\.baidu\.com\/p\/\d+/)
    assert.match(r.text, /大学生该不该分期买耳机/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function speakCfg() {
  return normalizeConfig({
    tieba: { comment: { enabled: true, replyToReplies: true, perDay: 5, replyPerDay: 5 } },
    social: { waiveSpeak: true },
  })
}

async function meta(root, text) {
  await appendEvent({ type: 'meta', text }, { day: 0, stage: 1, source: 'system' }, root)
}

/** 脚本化贴吧接口。进帖若走 page_pc 直接抛。 */
function scriptedTieba(routes) {
  const hits = []
  const fetchImpl = async (url, init) => {
    const path = pathname(url)
    const body = String(init?.body ?? '')
    hits.push({ path, body })
    if (path === '/c/f/pb/page_pc') throw new Error('不该走 page_pc')
    const route = routes[path]
    if (!route) throw new Error(`unexpected ${path}`)
    return route({ path, body })
  }
  return { hits, fetchImpl }
}

function addBody(hits) {
  const hit = [...hits].reverse().find((h) => h.path === '/c/c/post/add')
  assert.ok(hit, hits.map((h) => h.path).join(','))
  return new URLSearchParams(hit.body)
}

test('记下的 fid 会进发评和回帖；旧进帖没有 fid 会先补再发', async () => {
  resetSpeakRisk('tieba')
  const cookie = 'BDUSS=abc123456789'
  const tid = '11157099999'
  const cfg = speakCfg()
  const sync = () => jsonRes({ error_code: 0, data: { anti: { tbs: 't' } } })
  const added = () => jsonRes({ error_code: 0, pid: 'p9' })
  const page = (fid) => () => jsonRes({
    error_code: 0,
    forum: { id: fid, name: '测试' },
    thread: { id: tid, title: '有图帖' },
    post_list: [{ floor: 1, content: [{ type: '0', text: '字' }] }],
  })

  const rooted = await mkdtemp(join(tmpdir(), 'fish-tieba-fid-'))
  try {
    const dk = dateKey()
    await meta(rooted, formatTiebaThread(dk, tid, '有图帖', '测试', { fid: '276' }))
    const direct = scriptedTieba({
      '/c/s/pc/sync': sync,
      '/c/c/post/add': added,
      '/c/f/pb/page': () => { throw new Error('已经记下 fid，不该再进帖') },
    })
    const said = await postComment({
      root: rooted, config: cfg, cookie, tid, text: '跟一句', dateKey: dk, fetchImpl: direct.fetchImpl,
    })
    assert.equal(said.ok, true, said.why)
    const sent = addBody(direct.hits)
    assert.equal(sent.get('fid'), '276')
    assert.equal(sent.get('tid'), tid)
    assert.equal(sent.get('kw'), '测试')
    assert.equal(sent.get('can_no_forum'), '0')
    assert.equal(direct.hits.some((h) => h.path === '/c/f/pb/page'), false)
    const { events } = await readEvents(rooted)
    const commentLine = events.map((e) => String(e.text ?? '')).find((t) => t.startsWith(`tieba-comment:${dk} `))
    assert.match(commentLine, /"fid":"276"/)
    assert.match(commentLine, /^tieba-comment:/)

    const replied = await postReply({
      root: rooted, config: cfg, cookie, tid, parentId: said.id, text: '回一句', dateKey: dk, fetchImpl: direct.fetchImpl,
    })
    assert.equal(replied.ok, true, replied.why)
    const replyBody = addBody(direct.hits)
    assert.equal(replyBody.get('fid'), '276')
    assert.equal(replyBody.get('quote_id'), said.id)
    assert.equal(direct.hits.some((h) => h.path === '/c/f/pb/page'), false)
  } finally {
    await rm(rooted, { recursive: true, force: true })
  }

  const old = await mkdtemp(join(tmpdir(), 'fish-tieba-fid-old-'))
  try {
    const dk = dateKey()
    await meta(old, formatTiebaThread(dk, tid, '有图帖', '测试'))
    const recover = scriptedTieba({
      '/c/s/pc/sync': sync,
      '/c/f/pb/page': page('418'),
      '/c/c/post/add': added,
    })
    const said = await postComment({
      root: old, config: cfg, cookie, tid, text: '跟一句', dateKey: dk, fetchImpl: recover.fetchImpl,
    })
    assert.equal(said.ok, true, said.why)
    const pageHit = recover.hits.find((h) => h.path === '/c/f/pb/page')
    assert.ok(pageHit, '缺 fid 要先补进帖')
    const pq = new URLSearchParams(pageHit.body)
    assert.equal(pq.get('_client_type'), '20')
    assert.equal(pq.get('subapp_type'), 'pc')
    assert.equal(pq.get('kz'), tid)
    const sent = addBody(recover.hits)
    assert.equal(sent.get('fid'), '418')
    assert.equal(sent.get('can_no_forum'), '0')
    const beforeReply = recover.hits.filter((h) => h.path === '/c/f/pb/page').length
    const replied = await postReply({
      root: old, config: cfg, cookie, tid, parentId: said.id, text: '回一句', dateKey: dk, fetchImpl: recover.fetchImpl,
    })
    assert.equal(replied.ok, true, replied.why)
    assert.equal(addBody(recover.hits).get('fid'), '418')
    assert.equal(recover.hits.filter((h) => h.path === '/c/f/pb/page').length, beforeReply, '评论上已经记下 fid，回帖不必再补')
  } finally {
    await rm(old, { recursive: true, force: true })
    resetSpeakRisk('tieba')
  }
})

test('补不到 fid 就不发，也不把空 fid 送出去', async () => {
  resetSpeakRisk('tieba')
  const cookie = 'BDUSS=abc123456789'
  let calls = 0
  const missed = await addThreadPost({
    cookie, tid: '9', kw: '测试', content: '跟',
    fetchImpl: async () => { calls += 1; throw new Error('不该发') },
  })
  assert.equal(missed.code, 'NO_FID')
  assert.match(missed.why, /吧/)
  assert.equal(calls, 0)

  const root = await mkdtemp(join(tmpdir(), 'fish-tieba-fid-miss-'))
  try {
    const dk = dateKey()
    const tid = '11157099999'
    const cfg = speakCfg()
    const bare = scriptedTieba({
      '/c/s/pc/sync': () => jsonRes({ error_code: 0, data: { anti: { tbs: 't' } } }),
      '/c/f/pb/page': () => jsonRes({
        error_code: 0,
        forum: { name: '测试' },
        thread: { id: tid, title: '有图帖' },
        post_list: [{ floor: 1, content: [{ type: 0, text: '字' }] }],
      }),
      '/c/c/post/add': () => { throw new Error('没补到 fid 不该发评') },
    })
    await meta(root, formatTiebaThread(dk, tid, '有图帖', '测试'))
    const said = await postComment({
      root, config: cfg, cookie, tid, text: '跟一句', dateKey: dk, fetchImpl: bare.fetchImpl,
    })
    assert.equal(said.ok, false)
    assert.match(said.why, /吧/)
    assert.equal(bare.hits.some((h) => h.path === '/c/c/post/add'), false)
    assert.equal(bare.hits.some((h) => h.path === '/c/f/pb/page'), true)

    await meta(root, formatTiebaComment(dk, tid, 'mine', '我说过', '测试'))
    const replied = await postReply({
      root, config: cfg, cookie, tid, parentId: 'mine', text: '回一句', dateKey: dk, fetchImpl: bare.fetchImpl,
    })
    assert.equal(replied.ok, false)
    assert.match(replied.why, /吧/)
    assert.equal(bare.hits.some((h) => h.path === '/c/c/post/add'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    resetSpeakRisk('tieba')
  }
})
