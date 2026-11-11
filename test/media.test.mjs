/**
 * media.test.mjs —— 图片落盘与抽帧工具的纯逻辑部分。
 *
 * 不联网、不调真 ffmpeg（只调 detectFfmpeg 的探测分支）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  sniffMime,
  fetchableImageUrl,
  decodeBase64Image,
  parseDuration,
  detectFfmpeg,
  bundledFfmpegPath,
  saveImage,
  sweepMedia,
  mediaDir,
  MAX_IMAGE_BYTES,
} from '../lib/core/media.js'

// 1×1 透明 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-fish-media-'))
}

test('sniffMime 认得 png/jpeg/webp/gif，其余一律 null', () => {
  assert.equal(sniffMime(Buffer.from(PNG_B64, 'base64')), 'image/png')
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg')
  const webp = Buffer.alloc(16)
  webp.write('RIFF', 0, 'latin1')
  webp.write('WEBP', 8, 'latin1')
  assert.equal(sniffMime(webp), 'image/webp')
  assert.equal(sniffMime(Buffer.from('GIF89a______', 'latin1')), 'image/gif')
  assert.equal(sniffMime(Buffer.from('not an image at all')), null)
  assert.equal(sniffMime(null), null)
  assert.equal(sniffMime(Buffer.alloc(3)), null)
})

test('decodeBase64Image 接受裸 base64 与 data URL 两种写法', () => {
  const a = decodeBase64Image(PNG_B64)
  assert.equal(a.ok, true)
  assert.equal(a.buf.length > 0, true)

  const b = decodeBase64Image(`data:image/png;base64,${PNG_B64}`)
  assert.equal(b.ok, true)
  assert.equal(b.declared, 'image/png')
  assert.deepEqual(b.buf, a.buf)

  assert.equal(decodeBase64Image('').ok, false)
  assert.equal(decodeBase64Image(null).ok, false)
})

test('parseDuration 解析 ffmpeg 的 Duration 行，认不出返回 0', () => {
  const stderr = '  Duration: 00:03:07.52, start: 0.000000, bitrate: 812 kb/s'
  assert.equal(parseDuration(stderr), 3 * 60 + 7.52)
  assert.equal(parseDuration('  Duration: 01:00:00.00'), 3600)
  assert.equal(parseDuration('no duration here'), 0)
  assert.equal(parseDuration(undefined), 0)
})

test('detectFfmpeg：指到不存在的路径时如实报红，并说明那个环境变量', () => {
  const r = detectFfmpeg({ DSH_FISH_FFMPEG: 'C:/definitely/not/here/ffmpeg.exe' })
  assert.equal(r.ok, false)
  assert.match(r.why, /DSH_FISH_FFMPEG/)
})

test('detectFfmpeg：环境变量是空串时当作没设，不能抛异常', () => {
  // 空串会被 spawn 当成「文件名为空」直接抛 TypeError，连「没找到 ffmpeg」这条路都走不到。
  // 2026-10-30 把 ffmpeg 从 PATH 拿掉复现 CI 时踩到。
  const r = detectFfmpeg({ DSH_FISH_FFMPEG: '' })
  assert.equal(typeof r.ok, 'boolean')
  assert.equal(typeof r.why, 'string')
})

test('bundledFfmpegPath：按平台和架构落在 bin/ 下', () => {
  // 2026-11-02：用户把官方 ffmpeg 包丢进工作区要求「打进项目」。二进制不进 git
  // （ffmpeg.exe 正好 100 MB，卡在 GitHub 单文件上限），所以固定放在这个位置，
  // 由 tools/setup-ffmpeg.mjs 解压，detectFfmpeg 在没有环境变量时优先用它。
  const win = bundledFfmpegPath({ platform: 'win32', arch: 'x64' })
  assert.match(win, /bin[\\/]win32-x64[\\/]ffmpeg\.exe$/)
  const linux = bundledFfmpegPath({ platform: 'linux', arch: 'arm64' })
  assert.match(linux, /bin[\\/]linux-arm64[\\/]ffmpeg$/)
  // 「自带的那份」和「PATH 里的 ffmpeg」必须是两个不同的字符串，
  // 否则日志里分不清到底用了哪个。
  assert.notEqual(bundledFfmpegPath(), 'ffmpeg')
})

test('saveImage：真的写进 media/，名字带前缀，坏数据与空数据被拒', async () => {
  const root = await tmpRoot()
  try {
    const r = await saveImage(root, Buffer.from(PNG_B64, 'base64'), { prefix: 'pic' })
    assert.equal(r.ok, true)
    assert.equal(r.mime, 'image/png')
    assert.match(r.name, /^pic-/)
    assert.equal(r.path, join(await mediaDir(root), r.name))

    assert.equal((await saveImage(root, Buffer.alloc(0))).ok, false)
    assert.equal((await saveImage(root, Buffer.from('hello world'))).ok, false)

    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1)
    big[0] = 0x89
    big[1] = 0x50
    big[2] = 0x4e
    big[3] = 0x47
    const tooBig = await saveImage(root, big)
    assert.equal(tooBig.ok, false)
    assert.match(tooBig.why, /太大了/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('sweepMedia：只删过期的，留着新的；空目录不炸', async () => {
  const root = await tmpRoot()
  try {
    const dir = await mediaDir(root)
    await writeFile(join(dir, 'old.png'), Buffer.from(PNG_B64, 'base64'))
    await writeFile(join(dir, 'new.png'), Buffer.from(PNG_B64, 'base64'))

    const now = Date.now()
    const fourDaysAgo = (now - 4 * 24 * 3600 * 1000) / 1000
    await utimes(join(dir, 'old.png'), fourDaysAgo, fourDaysAgo)

    const r = await sweepMedia(root, { now })
    assert.equal(r.removed, 1)
    assert.equal(r.kept, 1)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('sweepMedia：目录还不存在时返回全零，不抛错', async () => {
  const root = join(tmpdir(), `dsh-fish-missing-${Date.now()}`)
  const r = await sweepMedia(root)
  assert.deepEqual(r, { removed: 0, kept: 0 })
})


test('评论图 URL 只放 https 的公网地址：http / 本机 / 私网一律不抓', () => {
  assert.equal(fetchableImageUrl('https://i0.hdslb.com/bfs/x.jpg'), 'https://i0.hdslb.com/bfs/x.jpg')
  assert.equal(fetchableImageUrl('http://i0.hdslb.com/bfs/x.jpg'), '')
  assert.equal(fetchableImageUrl('https://localhost/a.png'), '')
  assert.equal(fetchableImageUrl('https://127.0.0.1:3080/a.png'), '')
  assert.equal(fetchableImageUrl('https://10.0.0.5/a.png'), '')
  assert.equal(fetchableImageUrl('https://172.20.1.1/a.png'), '')
  assert.equal(fetchableImageUrl('https://192.168.1.2/a.png'), '')
  assert.equal(fetchableImageUrl('https://169.254.169.254/latest/meta-data'), '')
  assert.equal(fetchableImageUrl('file:///etc/passwd'), '')
  assert.equal(fetchableImageUrl('nonsense'), '')
})
