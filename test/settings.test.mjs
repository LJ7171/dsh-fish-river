import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, DEFAULTS, inWindow, dateKey, pickWakeTime, updateConfig, loadConfig } from '../lib/settings.js'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('空配置得到完整默认值（含用户新加的 three 配额项）', () => {
  const c = normalizeConfig({})
  assert.equal(c.growthDays, 30)
  assert.equal(c.daily.events, 4, '2026-11-02 默认 2→4（配合 wakesPerDay 2，有效 2 次/天）')
  assert.equal(c.daily.questions, 1)
  // daily.proactive 已并入 wakesPerDay（两个旋钮管同一件事，必有一个是死键）
  assert.equal(c.daily.proactive, undefined, 'proactive 不应再存在')
  assert.equal(c.wakesPerDay, 2, '唤醒次数唯一旋钮')
  assert.equal(c.diary.enabled, true)
  assert.equal(c.diary.visible, false, '日记默认不给看')
  assert.ok(Array.isArray(c.avoid.keywords) && c.avoid.keywords.includes('恐怖'))
})

test('部分配置自动补全其余键（可扩展性的核心）', () => {
  const c = normalizeConfig({ growthDays: 60, diary: { visible: true } })
  assert.equal(c.growthDays, 60)
  assert.equal(c.diary.visible, true)
  assert.equal(c.diary.enabled, true, '没传的键必须从默认值补回')
  assert.deepEqual(c.window, DEFAULTS.window)
})

test('未知键不会被丢弃（向前兼容：以后加的配置项老版本也不炸）', () => {
  const c = normalizeConfig({ somethingNew: { a: 1 } })
  assert.deepEqual(c.somethingNew, { a: 1 })
})

test('越界值被夹到合法区间', () => {
  const c = normalizeConfig({ growthDays: 9999, wakesPerDay: -5, daily: { events: 99 } })
  assert.equal(c.growthDays, 180)
  assert.equal(c.wakesPerDay, 0)
  assert.equal(c.daily.events, 6)
})

test('非法时间窗回落到默认，不抛错', () => {
  assert.deepEqual(normalizeConfig({ window: ['25:00', 'abc'] }).window, DEFAULTS.window)
  assert.deepEqual(normalizeConfig({ window: ['09:00', '09:00'] }).window, DEFAULTS.window)
  assert.deepEqual(normalizeConfig({ window: ['09:00', '12:30'] }).window, ['09:00', '12:30'])
})

test('黑名单可追加、去重、去空', () => {
  const c = normalizeConfig({ avoid: { keywords: ['恐怖', '恐怖', ' ', '新的禁忌'] } })
  assert.deepEqual(c.avoid.keywords, ['恐怖', '新的禁忌'])
})

test('inWindow 普通与跨零点都正确', () => {
  const at = (h, m) => new Date(2026, 9, 22, h, m)
  const day = normalizeConfig({ window: ['20:00', '23:00'] })
  assert.equal(inWindow(day, at(19, 59)), false)
  assert.equal(inWindow(day, at(20, 0)), true)
  assert.equal(inWindow(day, at(23, 0)), true)
  assert.equal(inWindow(day, at(23, 1)), false)

  const night = normalizeConfig({ window: ['22:00', '02:00'] })
  assert.equal(inWindow(night, at(23, 30)), true)
  assert.equal(inWindow(night, at(1, 30)), true)
  assert.equal(inWindow(night, at(12, 0)), false)
})

test('pickWakeTime 落在窗内', () => {
  const cfg = normalizeConfig({ window: ['20:00', '23:00'] })
  for (const s of [0, 0.25, 0.5, 0.999]) {
    const t = pickWakeTime(cfg, s)
    assert.ok(t >= 20 * 60 && t <= 23 * 60, `${t}`)
  }
})

test('dateKey 用本地时区', () => {
  assert.equal(dateKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
})

test('updateConfig 是合并而不是覆盖，且落盘后能被 loadConfig 读回', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-cfg-'))
  try {
    await updateConfig({ growthDays: 45 }, root)
    await updateConfig({ diary: { visible: true } }, root)
    const { config } = await loadConfig(root)
    assert.equal(config.growthDays, 45, '第二次更新不该把第一次的改动冲掉')
    assert.equal(config.diary.visible, true)
    assert.equal(config.daily.events, 4, '默认值仍然在（4 条）')
    const onDisk = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
    assert.equal(onDisk.growthDays, 45)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('配置文件不存在时返回默认值，且不主动写盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-cfg2-'))
  try {
    const r = await loadConfig(root)
    assert.equal(r.fresh, true)
    await assert.rejects(readFile(join(root, 'config.json'), 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('白名单解析：半角/全角逗号、空格、换行都算分隔，去重保序', async () => {
  const { parseToolNames } = await import('../lib/settings.js')
  assert.deepEqual(parseToolNames('skill, web_search，read_image\nskill'), ['skill', 'web_search', 'read_image'])
  assert.deepEqual(parseToolNames(''), [])
  assert.deepEqual(parseToolNames(null), [])
  assert.deepEqual(parseToolNames(['web_search', ' web_search ']), ['web_search'])
})

test('白名单校验：拼错的名字与不存在的工具都不许过，拿不到名单时不做存在性判断', async () => {
  const { validateToolNames } = await import('../lib/settings.js')
  const known = ['web_search', 'read_image', 'skill']

  const ok = validateToolNames('skill, read_image', known)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.names, ['skill', 'read_image'])
  assert.equal(ok.checked, true)

  // 拼错一个字母：形状合法但名单里没有 —— 这正是会让她退回全量工具面的那种
  const typo = validateToolNames('web_serch', known)
  assert.equal(typo.ok, false)
  assert.deepEqual(typo.unknown, ['web_serch'])

  // 大写/空格/中文：连形状都不对
  const shape = validateToolNames('Web_Search', null)
  assert.equal(shape.ok, false)
  assert.deepEqual(shape.unknown, ['Web_Search'])

  // known 为 null：只做形状校验，checked:false（不把「不知道」当「不存在」）
  const blind = validateToolNames('some_future_tool', null)
  assert.equal(blind.ok, true)
  assert.equal(blind.checked, false)

  // 空输入永远合法（留空 = 不额外给）
  assert.equal(validateToolNames('', known).ok, true)
})

test('渠道分段连发默认关，只有显式打开才开', () => {
  assert.equal(normalizeConfig({}).im.bubbleSplit, false)
  assert.equal(DEFAULTS.im.bubbleSplit, false)
  assert.equal(normalizeConfig({ im: { bubbleSplit: true } }).im.bubbleSplit, true)
  assert.equal(normalizeConfig({ im: { bubbleSplit: false } }).im.bubbleSplit, false)
  assert.equal(normalizeConfig({ im: { bubbleSplit: 'true' } }).im.bubbleSplit, false, '字符串不算打开')
  assert.equal(normalizeConfig({ im: 'bubble' }).im.bubbleSplit, false, '形状坏了就当关')
})

test('口语化标点默认开，只有显式关掉才关', () => {
  assert.equal(normalizeConfig({}).im.casualPunctuation, true)
  assert.equal(DEFAULTS.im.casualPunctuation, true)
  assert.equal(normalizeConfig({ im: { casualPunctuation: false } }).im.casualPunctuation, false)
  assert.equal(normalizeConfig({ im: { casualPunctuation: true } }).im.casualPunctuation, true)
  assert.equal(normalizeConfig({ im: { casualPunctuation: 'false' } }).im.casualPunctuation, true, '字符串不算关掉')
  assert.equal(normalizeConfig({ im: 'casual' }).im.casualPunctuation, true, '形状坏了就当开')
  // 只改分段时，口语化仍是默认开，不会被一起关掉
  assert.equal(normalizeConfig({ im: { bubbleSplit: true } }).im.casualPunctuation, true)
  assert.equal(normalizeConfig({ im: { bubbleSplit: true } }).im.bubbleSplit, true)
  assert.equal(normalizeConfig({ im: { casualPunctuation: false } }).im.bubbleSplit, false)
})

test('分段连发的开关在设置页，并且能被 /config 白名单收下', async () => {
  const { readFile } = await import('node:fs/promises')
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const observe = await readFile(new URL('../lib/observe.js', import.meta.url), 'utf8')
  assert.ok(client.includes('渠道回复分段连发'), '设置页要有这个开关')
  assert.ok(client.includes('默认关着'), '文案要说清默认关、关掉与以前一样')
  assert.ok(client.includes('口语化标点'), '设置页要有口语化开关')
  assert.ok(client.includes('默认开着'), '文案要说清口语化默认开')
  assert.ok(client.includes('{ im: patch }'), '开关要单独提交 im，不跟渠道人格键混在一起')
  const m = client.match(/const buildConfig = \(\) => \(\{([\s\S]*?)\n {6}\}\)/)
  assert.ok(m, '要能定位 buildConfig')
  assert.ok(!m[1].includes('bubbleSplit'), '不进整表保存，免得自动保存用旧值把它关掉')
  assert.ok(!m[1].includes('casualPunctuation'), '口语化同样不进整表保存')
  const allowed = observe.match(/const allowed = \[([^\]]+)\]/)
  assert.ok(allowed, '要能定位 /config 白名单')
  assert.ok(allowed[1].includes("'im'"), '漏登记的话设置页一点就 400')
})
