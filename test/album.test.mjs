/**
 * album.test.mjs —— keep_image：她自己决定留下的图，不进成长。
 *
 * 守这些事：
 *   - 绝对路径的真图能抄进 album/，回执只有机器状态
 *   - 太大 / 不是图 / 相对路径 / http 都拒绝
 *   - 上限跟着 album.maxBytes 走
 *   - 不写 events.jsonl
 *   - media/ 的 TTL 清扫碰不到相册
 *   - 知乎评论图、B 站评论图在「她点开」时落盘；刷站深读不下载
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

import { keepImage, registerKeepImage, readAlbum, browseImageKeepAllowed, ALBUM_MAX_BYTES_DEFAULT } from '../lib/album.js'
import { sweepMedia } from '../lib/media.js'
import { normalizeConfig, updateConfig } from '../lib/settings.js'
import { readEvents } from '../lib/store.js'
import { commentImageUrls } from '../lib/bili.js'
import { absorb, renderItem } from '../lib/browse.js'
import { lookOnce } from '../lib/look.js'
import { landCommentImages } from '../lib/commentpics.js'
import { renderReplies } from '../lib/comment.js'
import { fetchComments } from '../packages/dsh-fish-river-zhihu/api.js'
import { zhihuLookOnce } from '../lib/zhihuLook.js'
import { HER_TOOLS } from '../lib/restrict.js'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'fish-album-'))
}

test('keep_image 把本机图抄进相册，回执只有机器状态，不写事件', async () => {
  const root = await tempRoot()
  try {
    const src = join(root, 'weixin-media')
    await mkdir(src, { recursive: true })
    const file = join(src, 'm1-0.png')
    await writeFile(file, PNG)
    const r = await keepImage(root, { path: file, why: '想留着' })
    assert.equal(r.ok, true)
    assert.match(r.note, /^\[收进相册\] /)
    assert.match(r.path, /\/album\/\d{4}-\d{2}-\d{2}\/[0-9a-f]+\.png$/)
    const st = await stat(r.path)
    if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600)
    const db = await readAlbum(root)
    assert.equal(db.items.length, 1)
    assert.equal(db.items[0].why, '想留着')
    assert.equal(db.items[0].bytes, PNG.length)
    const ev = await readEvents(root)
    assert.equal(ev.events.length, 0, '相册不进事件流')
    const again = await keepImage(root, { path: r.path })
    assert.match(again.note, /^\[已经在相册\] /)
    assert.equal((await readAlbum(root)).items.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keep_image：太大、不是图、相对路径、http 都拒绝', async () => {
  const root = await tempRoot()
  try {
    const big = join(root, 'big.png')
    const junk = join(root, 'note.txt')
    await writeFile(big, Buffer.concat([PNG, Buffer.alloc(64)]))
    await writeFile(junk, Buffer.from('hello this is not an image!!'))
    assert.equal((await keepImage(root, { path: big, maxBytes: PNG.length })).note, '[太大]')
    assert.equal((await keepImage(root, { path: junk })).note, '[不是图]')
    assert.equal((await keepImage(root, { path: 'weixin-media/a.png' })).note, '[路径不对]')
    assert.equal((await keepImage(root, { path: 'https://example.com/a.png' })).note, '[路径不对]')
    assert.equal((await keepImage(root, { path: join(root, 'missing.png') })).note, '[没有这张]')
    const outside = join(tmpdir(), `fish-album-out-${process.pid}.png`)
    await writeFile(outside, PNG)
    try {
      assert.equal((await keepImage(root, { path: outside })).note, '[路径不对]')
    } finally {
      await rm(outside, { force: true })
    }
    assert.equal((await readAlbum(root)).items.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('album.maxBytes 默认 8MB，设置能改上限', async () => {
  assert.equal(ALBUM_MAX_BYTES_DEFAULT, 8 * 1024 * 1024)
  const fresh = normalizeConfig({})
  assert.equal(fresh.album.maxBytes, 8 * 1024 * 1024)
  const hi = normalizeConfig({ album: { maxBytes: 99 * 1024 * 1024 } })
  assert.equal(hi.album.maxBytes, 20 * 1024 * 1024)
  const lo = normalizeConfig({ album: { maxBytes: 10 } })
  assert.equal(lo.album.maxBytes, 256 * 1024)

  const root = await tempRoot()
  try {
    await updateConfig({ album: { maxBytes: 1024 * 1024 } }, root)
    const regs = new Map()
    const ctx = { tools: { register: (spec) => { regs.set(spec.name, spec); return () => {} } } }
    registerKeepImage(ctx, { root })
    const tool = regs.get('keep_image')
    assert.equal(tool.parameters.type, 'object')
    assert.deepEqual(tool.parameters.required, ['path'])
    const src = join(root, 'a.png')
    await writeFile(src, PNG)
    const ok = await tool.execute({ path: src, why: 'x' })
    assert.match(tool.output.render({}, ok)[0].text, /^\[收进相册\] /)
    assert.ok(HER_TOOLS.includes('keep_image'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sweepMedia 清不掉相册里的图', async () => {
  const root = await tempRoot()
  try {
    const media = join(root, 'media')
    await mkdir(media, { recursive: true })
    const old = join(media, 'old.png')
    await writeFile(old, PNG)
    const past = new Date(Date.now() - 10 * 86400000)
    await utimes(old, past, past)
    const kept = join(root, 'shot.png')
    await writeFile(kept, PNG)
    const saved = await keepImage(root, { path: kept })
    assert.equal(saved.ok, true)
    const r = await sweepMedia(root, { now: Date.now() })
    assert.equal(r.removed, 1)
    const st = await stat(saved.path)
    assert.ok(st.size > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('B 站评论图：点开才下载；深读本身不落盘', async () => {
  assert.deepEqual(
    commentImageUrls({ message: '看', pictures: [{ img_src: 'https://i0.hdslb.com/bfs/comment/a.jpg' }, { img_src: 'ftp://nope' }] }),
    ['https://i0.hdslb.com/bfs/comment/a.jpg'],
  )
  const root = await tempRoot()
  try {
    const client = {
      view: async () => ({ ok: true, data: { desc: '简介', cid: 1, aid: 9, title: 't', up: 'u' } }),
      tags: async () => ({ ok: true, data: [] }),
      replies: async () => ({
        ok: true,
        data: [{ text: '热评', like: 3, images: ['https://i0.hdslb.com/bfs/comment/a.jpg'] }],
      }),
      danmaku: async () => ({ ok: true, data: [] }),
    }
    const cfg = normalizeConfig({ browse: { deepRead: 2, danmaku: 0 } })
    const pack = await absorb(client, { bvid: 'BV1xx411c7mD', aid: 9, title: 't', duration: 10 }, cfg)
    assert.deepEqual(pack.comments[0].images, ['https://i0.hdslb.com/bfs/comment/a.jpg'])
    assert.doesNotMatch(renderItem(pack, 0), /有图存在/)
    let mediaGone = false
    try { await stat(join(root, 'media')); mediaGone = false } catch { mediaGone = true }
    assert.equal(mediaGone, true, 'absorb 不该下载')

    let hits = 0
    const fetchImpl = async () => {
      hits += 1
      return { ok: true, status: 200, arrayBuffer: async () => PNG }
    }
    const seen = await lookOnce({
      what: 'video',
      bvid: 'BV1xx411c7mD',
      root,
      client,
      cfg,
      fetchImpl,
    })
    assert.equal(seen.ok, true)
    assert.equal(hits, 1)
    assert.match(seen.text, /有图存在/)
    assert.match(seen.text, /media\/bili-cmt-/)
    assert.match(seen.text, /read_image/)

    const reply = { text: '回', images: ['https://i0.hdslb.com/bfs/comment/b.jpg'] }
    const lines = await landCommentImages(root, [reply], { fetchImpl, prefix: 'bili-reply', max: 3 })
    assert.match(lines[0], /bili-reply-/)
    const txt = renderReplies([{ bvid: 'BV1xx411c7mD', user: '路人', text: '回', pics: reply.pics }])
    assert.match(txt, /有图存在/)
    assert.match(txt, /bili-reply-/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('她选中的 B 站浏览会下评论图（看图开关控制）', () => {
  const browse = readFileSync(new URL('../lib/browse.js', import.meta.url), 'utf8')
  assert.match(browse, /landCommentImages/)
  assert.ok(browse.includes('browse?.images?.enabled'), '下载受 browse.images 控制')
})

test('知乎评论图会抽出来并在点开评论时落盘', async () => {
  const body = {
    paging: { totals: 1 },
    data: [{
      id: 9,
      like_count: 1,
      author: { name: '甲' },
      content: '<p>看这张</p><img src="https://pic1.zhimg.com/c.jpg">',
      pictures: [{ url: 'https://pic2.zhimg.com/d.png' }],
      child_comment_count: 0,
    }],
  }
  const r = await fetchComments({
    cookie: 'x',
    target: 'answer',
    id: '42',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }),
  })
  assert.equal(r.ok, true, r.why)
  assert.ok(r.comments[0].images.includes('https://pic1.zhimg.com/c.jpg'))
  assert.ok(r.comments[0].images.includes('https://pic2.zhimg.com/d.png'))

  const root = await tempRoot()
  try {
    const cfg = normalizeConfig({ zhihu: { enabled: true } })
    const mod = {
      async readAuth() { return { cookie: 'z' } },
      async fetchComments() {
        return {
          ok: true,
          total: 1,
          comments: [{ id: 'c', author: '甲', likes: 1, text: '看这张', images: ['https://pic1.zhimg.com/c.jpg'], replies: 0 }],
        }
      },
    }
    const seen = await zhihuLookOnce({
      root,
      cfg,
      kind: 'comments',
      id: '42',
      mod,
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => PNG }),
    })
    assert.equal(seen.ok, true)
    assert.match(seen.text, /zhihu-media\/c-42-0\.png/)
    assert.match(seen.text, /read_image/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('工具回执不带她能接着念的句子', () => {
  const regs = new Map()
  registerKeepImage(
    { tools: { register: (spec) => { regs.set(spec.name, spec); return () => {} } } },
    { root: '/tmp/unused-album' },
  )
  const tool = regs.get('keep_image')
  const text = tool.output.render({}, { ok: false, note: '[不是图]', path: '' })[0].text
  assert.equal(text, '[不是图]')
  assert.doesNotMatch(tool.description, /总是|爱发|性格/)
})


test('上网看图关掉时：本平台缓存不能 keep_image', async () => {
  const root = await tempRoot()
  try {
    const zhDir = join(root, 'zhihu-media')
    const media = join(root, 'media')
    await mkdir(zhDir, { recursive: true })
    await mkdir(media, { recursive: true })
    const zh = join(zhDir, 'a-1-0.jpg')
    const tb = join(media, 'tieba-0.jpg')
    const bili = join(media, 'bili-cmt-1.png')
    const wx = join(root, 'weixin-media', 'm.png')
    await mkdir(join(root, 'weixin-media'), { recursive: true })
    await writeFile(zh, PNG)
    await writeFile(tb, PNG)
    await writeFile(bili, PNG)
    await writeFile(wx, PNG)

    const offAll = normalizeConfig({
      zhihu: { images: { enabled: false } },
      tieba: { images: { enabled: false } },
      browse: { images: { enabled: false } },
    })
    assert.equal(browseImageKeepAllowed(offAll, zh, root), false)
    assert.equal(browseImageKeepAllowed(offAll, tb, root), false)
    assert.equal(browseImageKeepAllowed(offAll, bili, root), false)
    assert.equal(browseImageKeepAllowed(offAll, wx, root), true, '微信不拦')

    assert.equal((await keepImage(root, { path: zh, config: offAll })).note, '[没开]')
    assert.equal((await keepImage(root, { path: tb, config: offAll })).note, '[没开]')
    assert.equal((await keepImage(root, { path: bili, config: offAll })).note, '[没开]')
    const kept = await keepImage(root, { path: wx, config: offAll })
    assert.equal(kept.ok, true)
    assert.match(kept.note, /^\[收进相册\] /)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('同一张源图收两次：只复制一份，第二次回「已经在相册」', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-album-dup-'))
  try {
    const src = join(root, 'media', 'one.png')
    await mkdir(join(root, 'media'), { recursive: true })
    await writeFile(src, PNG)
    const a = await keepImage(root, { path: src })
    assert.equal(a.ok, true)
    const b = await keepImage(root, { path: src })
    assert.equal(b.ok, true)
    assert.match(b.note, /已经在相册/)
    assert.equal(a.path, b.path)
    const db = await readAlbum(root)
    assert.equal(db.items.length, 1, '台账里只该有一条')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('B 站评论图 http / 协议相对地址会升级成 https', () => {
  const urls = commentImageUrls({ pictures: [
    { img_src: 'http://i0.hdslb.com/bfs/a.png' },
    { img_src: '//i0.hdslb.com/bfs/b.png' },
    { img_src: 'https://i0.hdslb.com/bfs/c.png' },
    { img_src: 'ftp://nope' },
  ] })
  assert.deepEqual(urls, [
    'https://i0.hdslb.com/bfs/a.png',
    'https://i0.hdslb.com/bfs/b.png',
    'https://i0.hdslb.com/bfs/c.png',
  ])
})

test('相册拦截只看插件自己的媒体目录：别处的 /media/ 不误伤', async () => {
  const root = await tempRoot()
  try {
    const foreign = join(root, 'someone-else', 'media', 'tieba-photo.jpg')
    await mkdir(join(root, 'someone-else', 'media'), { recursive: true })
    await writeFile(foreign, PNG)
    const off = normalizeConfig({ browse: { images: { enabled: false } }, tieba: { images: { enabled: false } } })
    assert.equal(browseImageKeepAllowed(off, foreign, root), true, '不在插件媒体目录里就不拦')
    const kept = await keepImage(root, { path: foreign, config: off })
    assert.equal(kept.ok, true, '外部图片仍可收进相册')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
