/**
 * meme.test.mjs —— pick_meme：按画面上的词挑一张，不自动发。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pickMeme, registerPickMeme, resetMemePickForTests, bundledMemeDir } from '../lib/meme.js'
import { keepImage } from '../lib/album.js'
import { normalizeConfig, updateConfig } from '../lib/settings.js'
import { readEvents } from '../lib/store.js'
import { sniffMime } from '../lib/media.js'
import { HER_TOOLS } from '../lib/restrict.js'
import { MEME_BRIEF } from '../lib/persona.js'
import { renderSelfDoc } from '../lib/selfdoc.js'
import { setChannelTurn, resetChannelTurnForTests } from '../lib/channelTurn.js'
import { deriveSelf } from '../lib/derive.js'

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'fish-meme-'))
}

test('默认关着；包名会洗干净', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.meme.enabled, false)
  assert.deepEqual(cfg.meme.packs, ['dafeiyu-001', 'plain'])
  const washed = normalizeConfig({ meme: { enabled: true, packs: ['plain', 'plain', '../x', 'mine'] } })
  assert.equal(washed.meme.enabled, true)
  assert.deepEqual(washed.meme.packs, ['plain', 'mine'])
})

test('pick_meme：关着拒绝；开着按词挑到自带图', async () => {
  const root = await tempRoot()
  resetMemePickForTests()
  try {
    const off = await pickMeme(root, { tag: '睡觉', enabled: false })
    assert.equal(off.note, '[没开]')
    const miss = await pickMeme(root, { tag: '', enabled: true })
    assert.equal(miss.note, '[没说]')
    const none = await pickMeme(root, { tag: '夜航', enabled: true, packs: ['plain'] })
    assert.equal(none.note, '[没有这张]')
    const hit = await pickMeme(root, { tag: '睡觉', enabled: true, packs: ['plain'] })
    assert.equal(hit.ok, true)
    assert.match(hit.note, /^\[挑到\] /)
    assert.match(hit.path, /meme-packs\/plain\/sleep\.png$/)
    const buf = await readFile(hit.path)
    assert.equal(sniffMime(buf), 'image/png')
    const ev = await readEvents(root)
    assert.equal(ev.events.length, 0)
    assert.ok(HER_TOOLS.includes('pick_meme'))
    assert.match(bundledMemeDir(), /meme-packs$/)
  } finally {
    resetMemePickForTests()
    await rm(root, { recursive: true, force: true })
  }
})

test('太大的图跳过；数据目录同名包盖过自带的', async () => {
  const root = await tempRoot()
  resetMemePickForTests()
  try {
    const big = await pickMeme(root, { tag: '睡觉', enabled: true, packs: ['plain'], maxBytes: 16 })
    assert.equal(big.note, '[太大]')

    const dir = join(root, 'meme-packs', 'plain')
    await mkdir(dir, { recursive: true })
    const src = join(bundledMemeDir(), 'plain', 'heart.png')
    await writeFile(join(dir, 'only.png'), await readFile(src))
    await writeFile(join(dir, 'pack.json'), JSON.stringify({
      id: 'plain',
      items: [{ file: 'only.png', tags: ['自定义'] }],
    }))
    const got = await pickMeme(root, { tag: '自定义', enabled: true, packs: ['plain'] })
    assert.match(got.path, /meme-packs\/plain\/only\.png$/)
    const old = await pickMeme(root, { tag: '睡觉', enabled: true, packs: ['plain'] })
    assert.equal(old.note, '[没有这张]')
  } finally {
    resetMemePickForTests()
    await rm(root, { recursive: true, force: true })
  }
})

test('相册里 why 对得上的图也能挑到', async () => {
  const root = await tempRoot()
  resetMemePickForTests()
  try {
    const src = join(bundledMemeDir(), 'plain', 'wave.png')
    const local = join(root, 'wave.png')
    await writeFile(local, await readFile(src))
    const kept = await keepImage(root, { path: local, why: '夜航' })
    assert.equal(kept.ok, true)
    const hit = await pickMeme(root, { tag: '夜航', enabled: true, packs: ['missing'] })
    assert.equal(hit.ok, true)
    assert.equal(hit.path, kept.path)
  } finally {
    resetMemePickForTests()
    await rm(root, { recursive: true, force: true })
  }
})

test('渠道轮里一轮只挑一张', async () => {
  const root = await tempRoot()
  resetMemePickForTests()
  resetChannelTurnForTests()
  try {
    setChannelTurn({ channel: 'weixin', conversationId: 'c1', kind: 'dm' })
    const a = await pickMeme(root, { tag: '比心', enabled: true, packs: ['plain'] })
    assert.equal(a.ok, true)
    const b = await pickMeme(root, { tag: '无语', enabled: true, packs: ['plain'] })
    assert.equal(b.note, '[这轮已经挑过]')
  } finally {
    resetMemePickForTests()
    resetChannelTurnForTests()
    await rm(root, { recursive: true, force: true })
  }
})

test('工具回执是机器状态；身份文档默认不提它', async () => {
  const root = await tempRoot()
  try {
    await updateConfig({ meme: { enabled: true, packs: ['plain'] } }, root)
    const regs = new Map()
    registerPickMeme(
      { tools: { register: (spec) => { regs.set(spec.name, spec); return () => {} } } },
      { root },
    )
    const tool = regs.get('pick_meme')
    assert.equal(tool.parameters.required[0], 'tag')
    const out = await tool.execute({ tag: '点赞' })
    assert.equal(tool.output.render({}, out)[0].text, out.note)
    assert.match(out.note, /^\[挑到\] /)
    assert.doesNotMatch(tool.description, /主动发|好感|情绪档/)
    const model = deriveSelf([])
    const doc = renderSelfDoc(model, { meme: false, browse: false, diary: false })
    assert.doesNotMatch(doc, /pick_meme/)
    const on = renderSelfDoc(model, { meme: true, browse: false, diary: false })
    assert.match(on, /pick_meme/)
    assert.match(MEME_BRIEF, /send_image/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
