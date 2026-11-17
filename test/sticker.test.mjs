/**
 * sticker.test.mjs —— 评论表情包
 *
 * 守的是：缺名字或缺「什么时候用」不入库；重名和同一张图拒绝；
 * 她不能删你放的；分页按 6 张切。
 * 顶层评论把 pictures 收成 JSON 字符串；楼中楼不带这个字段，回执说明不能带图。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addSticker, saveOwnerSticker, keepSticker, updateSticker, removeSticker,
  pageStickers, readStickerImage, registerKeepSticker, registerFindSticker,
  findStickers, stickerPath, STICKER_PAGE,
} from '../lib/house/sticker.js'
import { STICKER_BRIEF } from '../lib/mind/persona.js'
import { sendImageOnce } from '../lib/talk/sendImage.js'
import { setChannelTurn, setChannelSender, resetChannelTurnForTests } from '../lib/channels/currentTurn.js'
import { HER_TOOLS } from '../lib/ops/dev/restrict.js'
import { normalizeConfig, dateKey } from '../lib/core/settings.js'
import { appendEvent, writeConfig } from '../lib/core/store.js'
import { speakOnce, registerSpeak, noteSpeakEnabled } from '../lib/platforms/bili/speak.js'
import { createClient } from '../lib/platforms/bili/client.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function pngN(n) {
  return Buffer.concat([PNG, Buffer.from([n])])
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-sticker-'))
  try { return await fn(root) }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
}

async function enable(root, comment) {
  await mkdir(root, { recursive: true })
  await writeConfig(normalizeConfig({ comment: { enabled: true, perDay: 3, replyPerDay: 2, ...comment } }), root)
}

async function seedLook(root, dk) {
  await appendEvent(
    { type: 'meta', text: `browse:${dk} [{"bvid":"BV1","title":"某视频","up":"某UP","duration":600,"view":1000}]` },
    { day: 1, stage: 1, source: 'system' },
    root,
  )
}

test('缺名字或那一句不入库，重名和重复图拒绝', async () => {
  await withRoot(async (root) => {
    const bare = await addSticker(root, { by: 'owner', name: '', when: '笑的时候', buf: PNG })
    assert.equal(bare.ok, false)
    const noWhen = await addSticker(root, { by: 'owner', name: '笑', when: '', buf: PNG })
    assert.equal(noWhen.ok, false)
    assert.equal((await pageStickers(root)).total, 0)

    const ok = await addSticker(root, { by: 'owner', name: '笑', when: '觉得好笑', buf: PNG })
    assert.equal(ok.ok, true)
    const again = await addSticker(root, { by: 'her', name: '另一个', when: '也是笑', buf: PNG })
    assert.match(again.note, /已经有这张/)
    assert.match(again.note, /笑/)
    const sameName = await addSticker(root, { by: 'her', name: '笑', when: '别的时候', buf: pngN(1) })
    assert.match(sameName.note, /重名/)
    const brackets = await addSticker(root, { by: 'owner', name: '[笑]', when: '觉得好笑', buf: pngN(2) })
    assert.equal(brackets.ok, false)
    assert.equal((await pageStickers(root)).total, 1)

    const file = join(root, 'pic.png')
    await writeFile(file, pngN(3))
    const missed = await keepSticker(root, { path: file, name: '新的' })
    assert.equal(missed.ok, false)
    assert.equal((await pageStickers(root)).total, 1)
    const kept = await keepSticker(root, { path: file, name: '新的', when: '想吐槽' })
    assert.equal(kept.ok, true)
    const page = await pageStickers(root)
    assert.equal(page.items.find((it) => it.name === '新的').by, 'her')
    assert.equal(page.items.find((it) => it.name === '笑').by, 'owner')
  })
})

test('她不能删你放的', async () => {
  await withRoot(async (root) => {
    const mine = await addSticker(root, { by: 'owner', name: '笑', when: '觉得好笑', buf: PNG })
    const gone = await removeSticker(root, { id: mine.id, by: 'her' })
    assert.equal(gone.ok, false)
    assert.match(gone.note, /你放的/)
    assert.equal((await pageStickers(root)).total, 1)
    const hers = await addSticker(root, { by: 'her', name: '无语', when: '不想说话', buf: pngN(4) })
    assert.equal((await removeSticker(root, { id: hers.id, by: 'her' })).ok, true)
    assert.equal((await removeSticker(root, { id: mine.id, by: 'owner' })).ok, true)
    assert.equal((await pageStickers(root)).total, 0)
    const renamed = await addSticker(root, { by: 'owner', name: '笑', when: '觉得好笑', buf: PNG })
    assert.equal((await updateSticker(root, { id: renamed.id, name: '微笑', when: '轻轻笑' })).ok, true)
    assert.equal((await pageStickers(root)).items[0].name, '微笑')
  })
})

test('分页按 6 张切，新的在前，出图不出目录外的文件', async () => {
  await withRoot(async (root) => {
    assert.equal(STICKER_PAGE, 6)
    for (let i = 0; i < 7; i++) {
      const r = await addSticker(root, { by: 'owner', name: `名${i}`, when: '随便', buf: pngN(10 + i) })
      assert.equal(r.ok, true, r.note)
    }
    const first = await pageStickers(root, 1)
    const second = await pageStickers(root, 2)
    assert.equal(first.pages, 2)
    assert.equal(first.items.length, 6)
    assert.equal(second.items.length, 1)
    assert.equal(first.items[0].name, '名6')
    assert.equal(second.items[0].name, '名0')
    const img = await readStickerImage(root, first.items[0].id)
    assert.ok(img && img.buf.length > 8)
    assert.equal(await readStickerImage(root, '../config'), null)
    assert.equal(normalizeConfig({}).comment.sticker, false)
    assert.equal(normalizeConfig({ comment: { sticker: 'true' } }).comment.sticker, false)
    assert.equal(normalizeConfig({ comment: { sticker: true } }).comment.sticker, true)
  })
})

test('keep_sticker 三个字段都必填，说明里不列清单', async () => {
  await withRoot(async (root) => {
    const regs = new Map()
    registerKeepSticker({ tools: { register: (spec) => { regs.set(spec.name, spec); return () => {} } } }, { root })
    const tool = regs.get('keep_sticker')
    assert.deepEqual(tool.parameters.required, ['path', 'name', 'when'])
    assert.doesNotMatch(tool.description, /名0|觉得好笑/)
    assert.ok(HER_TOOLS.includes('keep_sticker'))
    const file = join(root, 'b.png')
    await writeFile(file, pngN(9))
    const missed = await tool.execute({ path: file, name: '哈' })
    assert.equal(missed.ok, false)
    assert.equal((await pageStickers(root)).total, 0)
  })
})

test('顶层评论把 pictures 收成 JSON 字符串；楼中楼不带这个字段', async () => {
  await withRoot(async (root) => {
    const seen = []
    const fetchImpl = async (_url, init) => {
      seen.push({ url: String(_url), body: Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body ?? '')) })
      const url = String(_url)
      const data = url.includes('upload_bfs')
        ? { image_url: 'https://i0.hdslb.com/bfs/a.png', image_width: 1, image_height: 1, img_size: PNG.length }
        : { rpid: 3 }
      return { status: 200, text: async () => JSON.stringify({ code: 0, data }) }
    }
    const client = createClient({
      fetchImpl,
      cookie: 'SESSDATA=a; bili_jct=tok',
      minIntervalMs: 1,
      jitterMs: 0,
      random: () => 0,
    })
    const added = await client.replyAdd(1, 'hi', JSON.stringify([{
      img_src: 'https://i0.hdslb.com/bfs/a.png', img_width: 1, img_height: 1, img_size: 8,
    }]))
    assert.equal(added.ok, true)
    const params = new URLSearchParams(seen[0].body.toString())
    const pics = JSON.parse(params.get('pictures'))
    assert.equal(pics[0].img_src, 'https://i0.hdslb.com/bfs/a.png')
    assert.equal(typeof params.get('pictures'), 'string')

    await client.replyReply(1, 11, 22, 'yo')
    const replyParams = new URLSearchParams(seen[1].body.toString())
    assert.equal(replyParams.get('pictures'), null)

    const up = await client.uploadPicture(PNG, { filename: 'a.png', mime: 'image/png' })
    assert.equal(up.ok, true)
    const raw = seen[2].body.toString('latin1')
    assert.match(raw, /name="file_up"/)
    assert.match(raw, /name="category"\r\n\r\ndaily/)
    assert.match(raw, /name="csrf"\r\n\r\ntok/)

    const dk = dateKey()
    await enable(root, { sticker: true })
    await seedLook(root, dk)
    await addSticker(root, { by: 'owner', name: '笑', when: '觉得好笑', buf: PNG })
    let uploads = 0
    const fake = {
      view: async () => ({ ok: true, data: { aid: 9 } }),
      replyAdd: async (_aid, _text, pictures) => { seen.push({ pictures }); return { ok: true, data: { rpid: 1 } } },
      replyReply: async (...args) => { seen.push({ reply: args }); return { ok: true, data: { rpid: 2 } } },
      uploadPicture: async () => {
        uploads += 1
        return { ok: true, data: { image_url: 'https://i0.hdslb.com/bfs/a.png', image_width: 1, image_height: 1, img_size: 8 } }
      },
    }
    const said = await speakOnce({ root, kind: 'comment', bvid: 'BV1', text: '哈哈', sticker: '笑', client: fake, dateKey: dk })
    assert.equal(said.ok, true, said.note)
    assert.equal(uploads, 1)
    const sent = seen.find((x) => Object.hasOwn(x, 'pictures'))
    assert.equal(typeof sent.pictures, 'string')
    assert.equal(JSON.parse(sent.pictures)[0].img_src, 'https://i0.hdslb.com/bfs/a.png')

    const again = await speakOnce({ root, kind: 'comment', bvid: 'BV1', text: '再来', sticker: '笑', client: fake, dateKey: dk })
    assert.equal(again.ok, true, again.note)
    assert.equal(uploads, 1, '同一张不重复上传')

    await appendEvent(
      { type: 'meta', text: `comment:${dk} BV1 111` },
      { day: 1, stage: 1, source: 'system' },
      root,
    )
    const floor = await speakOnce({
      root, kind: 'reply', bvid: 'BV1', text: '回你', parentRpid: '222', sticker: '笑', client: fake, dateKey: dk,
    })
    assert.equal(floor.ok, true, floor.note)
    assert.match(floor.note, /楼中楼不能带图/)
    assert.match(floor.note, /只发了文字/)
    const replied = seen.find((x) => x.reply)
    assert.equal(replied.reply.length, 4)
    assert.equal(uploads, 1)
  })
})

test('名字对不上或开关关着，只发文字，回执最多报 8 个名字', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await enable(root, { sticker: true, perDay: 5 })
    await seedLook(root, dk)
    for (let i = 0; i < 9; i++) {
      await addSticker(root, { by: 'owner', name: `名${i}`, when: '随便', buf: pngN(40 + i) })
    }
    const fake = {
      view: async () => ({ ok: true, data: { aid: 9 } }),
      replyAdd: async (_a, _t, pictures) => { fake.pictures = pictures; return { ok: true, data: { rpid: 1 } } },
      uploadPicture: async () => { throw new Error('不该上传') },
    }
    const missed = await speakOnce({ root, kind: 'comment', bvid: 'BV1', text: '没有这张', sticker: '没有', client: fake, dateKey: dk })
    assert.equal(missed.ok, true, missed.note)
    assert.match(missed.note, /只发了文字/)
    assert.equal(fake.pictures, undefined)
    const listed = missed.note.split('现有的：')[1].replace(/。$/, '').split('、')
    assert.equal(listed.length, 8)
    assert.equal(listed.includes('名0'), false)

    await enable(root, { sticker: false, perDay: 5 })
    const off = await speakOnce({ root, kind: 'comment', bvid: 'BV1', text: '开关关着', sticker: '名8', client: fake, dateKey: dk })
    assert.equal(off.ok, true, off.note)
    assert.match(off.note, /只发了文字/)
    assert.equal(fake.pictures, undefined)
  })
})

test('bili_speak 开着表情包时才在说明里提带图，并且不列名字', async () => {
  await withRoot(async (root) => {
    const ctx = { tools: { register: (spec) => { ctx.spec = spec } } }
    registerSpeak(ctx, { root })
    noteSpeakEnabled(true, false)
    assert.match(ctx.spec.description, /可以给你今天看过的某个视频留一条评论/)
    assert.doesNotMatch(ctx.spec.description, /表情包/)
    noteSpeakEnabled(true, true)
    assert.match(ctx.spec.description, /顶层评论可以带一张表情包，sticker 填名字/)
    assert.doesNotMatch(ctx.spec.description, /名0|觉得好笑|doge/)
    noteSpeakEnabled(false)
  })
})

test('find_sticker 一个词最多三张，空词和关着都不倒账', async () => {
  await withRoot(async (root) => {
    assert.match(STICKER_BRIEF, /find_sticker/)
    assert.match(STICKER_BRIEF, /send_image/)
    assert.doesNotMatch(STICKER_BRIEF, /夸0|觉得好笑/)

    await addSticker(root, { by: 'owner', name: '旁的', when: '下雨天', buf: pngN(70) })
    for (let i = 0; i < 4; i++) {
      const r = await addSticker(root, { by: 'owner', name: `夸${i}`, when: '被夸了', buf: pngN(80 + i) })
      assert.equal(r.ok, true, r.note)
    }
    const off = await findStickers(root, '被夸', { on: false })
    assert.equal(off.note, '现在用不上。')
    assert.doesNotMatch(off.note, /夸|旁的/)

    const empty = await findStickers(root, '  ', { on: true })
    assert.equal(empty.note, '要给一个词。')
    assert.doesNotMatch(empty.note, /夸|旁的/)

    const hit = await findStickers(root, '被夸', { on: true })
    assert.deepEqual(hit.note.split('\n'), ['夸3 —— 被夸了', '夸2 —— 被夸了', '夸1 —— 被夸了'])
    assert.doesNotMatch(hit.note, /夸0|旁的/)

    const none = await findStickers(root, '困', { on: true })
    assert.match(none.note, /没有对上/)
    assert.doesNotMatch(none.note, /夸|旁的|现有/)

    const regs = new Map()
    registerFindSticker({ tools: { register: (spec) => { regs.set(spec.name, spec); return () => {} } } }, { root })
    const tool = regs.get('find_sticker')
    assert.ok(HER_TOOLS.includes('find_sticker'))
    assert.equal(tool.parameters.required[0], 'word')
    assert.doesNotMatch(tool.description, /夸|被夸|——|\[/)
    await writeConfig(normalizeConfig({ comment: { sticker: false } }), root)
    const via = await tool.execute({ word: '被夸' })
    assert.equal(via.note, '现在用不上。')
    assert.doesNotMatch(via.note, /夸/)
  })
})

test('send_image 按名字取表情包，和路径互斥，关着不发', async () => {
  await withRoot(async (root) => {
    resetChannelTurnForTests()
    try {
      await addSticker(root, { by: 'owner', name: '笑', when: '觉得好笑', buf: PNG })
      const found = await stickerPath(root, '笑')
      assert.equal(found.ok, true)
      await writeConfig(normalizeConfig({ comment: { sticker: true } }), root)
      setChannelTurn({ channel: 'weixin', kind: 'dm', conversationId: 'wxid_a' })
      const calls = []
      setChannelSender(async (args) => { calls.push(args); return { ok: true } })

      const sent = await sendImageOnce({ root, herDir: root, sticker: '笑', caption: '哈哈' })
      assert.equal(sent.ok, true, sent.note)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].path, found.path)
      assert.match(calls[0].path, /stickers/)

      const both = await sendImageOnce({ root, herDir: root, path: found.path, sticker: '笑' })
      assert.equal(both.ok, false)
      assert.match(both.note, /只填一个/)
      assert.equal(calls.length, 1)

      await writeConfig(normalizeConfig({ comment: { sticker: false } }), root)
      const closed = await sendImageOnce({ root, herDir: root, sticker: '笑' })
      assert.equal(closed.ok, false)
      assert.match(closed.note, /没带上/)
      assert.doesNotMatch(closed.note, /笑/)
      assert.equal(calls.length, 1)

      await writeConfig(normalizeConfig({ comment: { sticker: true } }), root)
      const miss = await sendImageOnce({ root, herDir: root, sticker: '没有' })
      assert.equal(miss.ok, false)
      assert.match(miss.note, /现有的：笑/)
      assert.equal(calls.length, 1)
    } finally {
      resetChannelTurnForTests()
    }
  })
})
