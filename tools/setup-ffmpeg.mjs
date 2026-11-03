#!/usr/bin/env node
/**
 * setup-ffmpeg.mjs —— 把官方 ffmpeg 包解到 `bin/<平台>-<架构>/`，让「视频画面理解」能用。
 *
 * 为什么需要这一步（2026-11-02，用户 m03816）：
 *   本机没有 ffmpeg，抽帧那一步会静默失败（日志里只有一行 warn，她只能看标题和热评）。
 *   官方 essentials 包里 `ffmpeg.exe` 约 100 MB，正好卡在 GitHub 单文件 100 MB 的上限上，
 *   所以二进制**不进 git**：`bin/` 在 .gitignore 里，谁要用谁在本机跑一次这个脚本。
 *
 * 用法：
 *   node tools/setup-ffmpeg.mjs                     # 自动在仓库上一级找 ffmpeg-*.zip
 *   node tools/setup-ffmpeg.mjs D:\path\ffmpeg.zip  # 指定压缩包
 *
 * 解压用系统自带的能力（Windows: PowerShell Expand-Archive），不引第三方依赖——
 * 这和仓库「零依赖」是同一条规矩。
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectFfmpeg, bundledFfmpegPath } from '../lib/media.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BIN_DIR = dirname(bundledFfmpegPath())
const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const PROBE = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'

function findZip() {
  const arg = process.argv[2]
  if (arg) return resolve(arg)
  const parent = dirname(ROOT)
  const hits = readdirSync(parent).filter((n) => /^ffmpeg.*\.zip$/i.test(n))
  if (!hits.length) return ''
  hits.sort()
  return join(parent, hits[hits.length - 1])
}

function findBinary(dir, name) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      const hit = findBinary(p, name)
      if (hit) return hit
    } else if (entry.toLowerCase() === name.toLowerCase()) {
      return p
    }
  }
  return ''
}

function main() {
  const already = detectFfmpeg()
  if (already.ok && already.bin !== 'ffmpeg') {
    console.log(`已经装好了：${already.bin} · ${already.version}`)
    return 0
  }

  const zip = findZip()
  if (!zip || !existsSync(zip)) {
    console.error('没找到 ffmpeg 压缩包。用法：node tools/setup-ffmpeg.mjs <ffmpeg-*.zip>')
    return 2
  }
  console.log(`压缩包：${zip}`)

  const tmp = join(ROOT, '.ffmpeg-setup-tmp')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })

  if (process.platform === 'win32') {
    // Expand-Archive 只认 .zip，正好；不用 Add-Type、不用解压库。
    const ps = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`,
    ], { encoding: 'utf8', windowsHide: true })
    if (ps.status !== 0) {
      console.error(`解压失败：${(ps.stderr || ps.stdout || '').trim().slice(0, 400)}`)
      return 3
    }
  } else {
    const un = spawnSync('unzip', ['-o', '-q', zip, '-d', tmp], { encoding: 'utf8' })
    if (un.status !== 0) {
      console.error('解压失败：这台机器上没有 unzip。手动把 ffmpeg 放到 ' + join(BIN_DIR, EXE))
      return 3
    }
  }

  const srcFfmpeg = findBinary(tmp, EXE)
  if (!srcFfmpeg) {
    rmSync(tmp, { recursive: true, force: true })
    console.error(`压缩包里没找到 ${EXE}`)
    return 4
  }
  mkdirSync(BIN_DIR, { recursive: true })
  copyFileSync(srcFfmpeg, join(BIN_DIR, EXE))
  const srcProbe = findBinary(tmp, PROBE)
  if (srcProbe) copyFileSync(srcProbe, join(BIN_DIR, PROBE))
  rmSync(tmp, { recursive: true, force: true })

  const check = detectFfmpeg()
  if (!check.ok) {
    console.error(`放好了但跑不起来：${check.why}`)
    return 5
  }
  console.log(`装好了：${check.bin} · ${check.version}`)
  console.log('「上网」页的「允许看视频画面」现在可以开了（默认就是开的），不用改配置。')
  return 0
}

process.exit(main())
