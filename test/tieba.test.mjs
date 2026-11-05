/**
 * tieba.test.mjs —— 贴吧只读素材：签名、解析、配额、扫码不回显 cookie。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../lib/settings.js'
import { readEvents } from '../lib/store.js'
import {
  SIGN_SECRET, bdussFromBody, cookieFromSetCookie, parseJsonp, pickCookie, postsFrom,
  renderMaterial, signParams, threadsFrom, fetchTiebaMaterial, createQr, pollQr, readAuth,
  savePastedCookie, tiebaStatus,
} from '../lib/tieba.js'
import { registerTiebaLook, tiebaLookOnce, parseThreadId } from '../lib/tiebaLook.js'

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
    const mode = (await stat(join(root, 'tieba.json'))).mode & 0o777
    assert.equal(mode, 0o600)
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
