/**
 * selfupdate.js —— 从「有新版」走到「装上了新版」（2026-10-29 用户要求）
 *
 * 为什么加这一步（用户 m00203）：插件发在 GitHub 上，而应用市场的索引要等半天到一天
 * 才更新。也就是说「作者已经发了新版」和「用户能看到新版」之间隔着十几个小时。
 * 检查更新已经能告诉他「有新版」，但接下来还得让他自己去浏览器下载、手动替换目录——
 * 那不是普通用户能做完的事。所以这里补上：确认 → 下载 → 校验 → 安装。
 *
 * 六条约束（全部来自踩过的坑，见避坑指南 §0 铁律 3 / §3.1–3.3）：
 *
 *   1. **绝不在应用运行时替换自己。** 插件代码就在宿主进程里跑着，运行中换包会
 *      `ERR_PNPM_EPERM`，包目录还能被留成"已删除"，下次启动直接缺包。
 *      所以安装动作只能交给一个**应用退出之后**才动手的外部脚本，插件自己只写脚本、
 *      起脚本、然后等着被杀。
 *   2. **每一步都要用户点头。** 检查更新只显示「有新版」；下载是第二次点击（并 confirm）；
 *      安装是第三次点击（再 confirm 一次，明确写着会关掉应用）。没有任何一步是自动发生的。
 *   3. **下载失败/超时必须是能读的中文、能重试、不动既有安装。** 超时按「单源 25 秒、
 *      整批 60 秒」两级预算；一个源失败换下一个（GitHub 直连在国内时通时不通）；
 *      全失败就如实报出来，`.part` 半截文件清掉，磁盘上不会留下一个看起来像安装包的东西。
 *   4. **装之前先验内容。** 不看 HTTP 状态码，看**真的解开来**：gzip → tar 头扫描，
 *      取 `package/package.json` 的 name/version，还要求 `lib/index.js` 在场。
 *      版本对不上、包名不对、解不开，一律不装。这样即便镜像回了半截文件也能拦住。
 *   5. **只升级"被管理的"安装。** 依赖写成 `link:` / `file:` 的是开发版（作者本机就是这样），
 *      升级它等于把作者的源码目录换成下载包——绝对不能干。那种情况如实说「这是开发版，不走自动升级」。
 *   6. **地址全部硬编码、不落盘多余东西。** 源只有 codeload 和两个镜像前缀，绝不接受
 *      客户端传 URL（否则就是 SSRF 口子）。下载文件只落在数据目录 `updates/` 里。
 *
 * Linux WebUI（2026-11-04）：安装器是 bash，不是 .cmd。宿主是 systemd 单元
 * `deepseek-harness`（名字先写死），`process.execPath` 是 node 也照样装。
 * 脚本先用 `systemd-run` 离开服务的 cgroup——否则 `systemctl stop` 会把脚本自己一起杀掉，
 * 停在「正在 stop」上，包永远换不了。停稳之后才备份、`pnpm add` 已校验的 tarball、对版本；
 * 成功和回滚都落到 `systemctl restart deepseek-harness`，避免服务停在 inactive。
 * `link:` / `file:` 仍然不升级。Windows 的 .cmd 路径不改。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { REPO, normalizeVersion } from './update.js'

/** 包名：既用于 tar 里的校验，也用于 profile 里找依赖条目。 */
export const PKG = 'dsh-fish-river'

/**
 * Linux WebUI 的 systemd 单元名。先写死：这台机器就是用
 * `systemctl restart deepseek-harness` 拉起 DSH 的。
 */
export const LINUX_SYSTEMD_UNIT = 'deepseek-harness'

/**
 * 单源超时 / 整批预算（毫秒）。
 * 25 秒是给"能连但很慢"的镜像留的余量；60 秒是用户能忍的上限——
 * 再久他会以为页面卡死了，不如早点说失败并让他重试。
 */
export const PER_SOURCE_TIMEOUT_MS = 25_000
export const BUDGET_MS = 60_000

/** 包大小上限：正常 tarball 已经压到几 MB，64MB 是防止被喂一个无底洞。 */
export const MAX_TARBALL_BYTES = 64 * 1024 * 1024
/** 解开后的上限：防 gzip 炸弹（一个几 KB 的包解出几百 MB）。 */
export const MAX_UNPACKED_BYTES = 96 * 1024 * 1024

/** `v0.6.14` / `0.6.14` → `0.6.14`；认不出返回空串。 */
export function cleanVersion(v) {
  return normalizeVersion(v)
}

/**
 * 下载地址：codeload 的 tag tarball，加两个镜像前缀。
 * 顺序＝直连优先，失败再走镜像（镜像有缓存滞后的可能，所以只在直连不行时用）。
 *
 * 镜像前缀**不能直接套 codeload 的地址**（2026-10-29 实测：ghproxy.net / ghfast.top
 * 对 `…/codeload.github.com/…/tar.gz/…` 一律回 403 `Invalid input.`），要走
 * `github.com/<repo>/archive/refs/tags/v<ver>.tar.gz`——同一份包，两种入口。
 */
export function sourcesFor(version) {
  const v = cleanVersion(version)
  if (!v) return []
  const direct = `https://codeload.github.com/${REPO}/tar.gz/refs/tags/v${v}`
  const archive = `https://github.com/${REPO}/archive/refs/tags/v${v}.tar.gz`
  return [
    { name: 'GitHub 直连', url: direct },
    { name: 'ghproxy 镜像', url: `https://ghproxy.net/${archive}` },
    { name: 'ghfast 镜像', url: `https://ghfast.top/${archive}` },
  ]
}

/** `github:LJ7171/dsh-fish-river#v0.6.14` —— pnpm add 用的 spec，仓库与检查更新同一处。 */
export function specFor(version) {
  return `github:${REPO}#v${cleanVersion(version)}`
}

/** 下载到本地用的文件名。带上版本，同一份数据目录里留着几版也不会混。 */
export function fileNameFor(version) {
  return `${PKG}-v${cleanVersion(version)}.tgz`
}

/**
 * profile 里那条依赖属于哪种情况？
 *   local    —— `link:` / `file:`（开发版，作者本机）；升级它会把源码换成下载包，禁止
 *   github   —— `github:...#tag`：正常用户从 GitHub 装的那种，可以升级
 *   registry —— 版本号/`^1.2.3`：从 npm registry 装的，也能升级（但改用同一套 spec 会变成 github 源）
 *   missing  —— profile 里没有这条依赖（比如插件是被手动放进 node_modules 的）
 *
 * 认不出的一律当"不归我管"，不猜。
 */
export function classifySpec(spec) {
  const s = String(spec ?? '').trim()
  if (!s) return 'missing'
  if (/^(link|file):/i.test(s)) return 'local'
  if (/^github:/i.test(s)) return 'github'
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return 'other'
  return 'registry'
}

/**
 * 从模块自己的路径反推 profile 目录。
 *
 * 安装成 `github:` / registry 时，文件真身就在 `<profile>/node_modules/dsh-fish-river/lib/...`；
 * 装成 `link:` 时 realpath 会落在源码目录（不含 node_modules）——那种情况返回空串，
 * 上层据此判定为开发版、拒绝自动升级。
 */
export function profileDirOf(moduleUrl) {
  let file = ''
  try {
    file = fileURLToPath(moduleUrl).replace(/\\/g, '/')
  } catch {
    return ''
  }
  const marker = '/node_modules/dsh-fish-river/'
  const i = file.lastIndexOf(marker)
  if (i < 0) return ''
  return file.slice(0, i)
}

/** 读 profile/package.json，返回 dsh-fish-river 那条依赖的 spec（读不到给空串）。 */
export function readDependency(profileDir) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    return String(json?.dependencies?.[PKG] ?? json?.devDependencies?.[PKG] ?? '')
  } catch {
    return ''
  }
}

/** 解码 + 扫描 tar 头，取出包名、版本、是否带 lib/index.js。认不出就抛。 */
export function inspectPackage(bytes, { name = PKG, version = '' } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw err('EMPTY', '下载到的文件是空的')
  if (bytes.length > MAX_TARBALL_BYTES) throw err('TOO_BIG', `下载到的文件太大（${bytes.length} 字节）`)

  let raw
  try {
    raw = zlib.gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES })
  } catch (e) {
    // 半截文件、HTML 错误页、被代理改过的内容都会在这里失败。
    throw err('NOT_GZIP', `不是有效的压缩包（${e?.message ?? e}）`)
  }

  let name0 = ''
  let version0 = ''
  let hasIndex = false
  let seen = 0
  const files = []
  for (let off = 0; off + 512 <= raw.length;) {
    const head = raw.subarray(off, off + 512)
    // 全 0 块＝归档结束（tar 惯例两块，有一块就够判断）
    if (head.every((b) => b === 0)) break
    const fname = cstr(head.subarray(0, 100))
    const prefix = cstr(head.subarray(345, 500))
    const size = octal(head.subarray(124, 136))
    const type = String.fromCharCode(head[156] || 48)
    const full = prefix ? `${prefix}/${fname}` : fname
    const body = off + 512
    if (body + size > raw.length) throw err('TRUNCATED', '压缩包是半截的（内容长度不够）')
    seen += 1
    if (seen > 20_000) throw err('TOO_MANY', '压缩包里文件太多，不像这个插件')
    // 只关心「根目录/package.json」和「根目录/lib/index.js」，多套一层前缀也认。
    const m = full.match(/^([^/]+)\/(package\.json|lib\/index\.js)$/)
    if (m && type !== '5') {
      files.push(m[2])
      if (m[2] === 'package.json') {
        try {
          const j = JSON.parse(raw.subarray(body, body + size).toString('utf8'))
          if (j && typeof j === 'object') {
            name0 = String(j.name ?? '')
            version0 = String(j.version ?? '')
          }
        } catch {
          throw err('BAD_JSON', '包里的 package.json 读不出来')
        }
      } else if (m[2] === 'lib/index.js') {
        hasIndex = true
      }
    }
    off = body + Math.ceil(size / 512) * 512
  }

  if (!name0) throw err('NO_PACKAGE_JSON', '压缩包里没有 package/package.json')
  if (name0 !== name) throw err('WRONG_PACKAGE', `这个包不是 ${name}（是 ${name0}）`)
  if (!hasIndex) throw err('NO_ENTRY', '压缩包里没有 lib/index.js，不像是能用的插件')
  const want = cleanVersion(version)
  if (want && cleanVersion(version0) !== want) {
    throw err('WRONG_VERSION', `包里的版本是 ${version0 || '空'}，不是要的 ${want}`)
  }
  return { name: name0, version: version0, files }
}

function err(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

function cstr(buf) {
  const i = buf.indexOf(0)
  return Buffer.from(i < 0 ? buf : buf.subarray(0, i)).toString('utf8').replace(/\/+$/, '')
}

function octal(buf) {
  const s = Buffer.from(buf).toString('ascii').replace(/[\0 ]+$/, '').trim()
  const n = parseInt(s, 8)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/**
 * 下载一个版本的 tarball 到 `dir/文件名.part`，校验通过才改名成正式文件。
 * 任何失败都清掉半截文件，不留"看起来像安装包"的东西。
 *
 * @returns {Promise<{ok:true, file:string, bytes:number, source:string} | {ok:false, error:string, tried:string[]}>}
 */
export async function downloadTarball({
  version,
  dir,
  fetchImpl = globalThis.fetch,
  perSourceTimeoutMs = PER_SOURCE_TIMEOUT_MS,
  budgetMs = BUDGET_MS,
  onProgress = () => {},
  sources = null,
} = {}) {
  const v = cleanVersion(version)
  if (!v) return { ok: false, error: '版本号认不出来', tried: [] }
  // 地址默认由版本号重算（硬编码），测试里可以显式传一组本地地址。
  const list = Array.isArray(sources) && sources.length ? sources : sourcesFor(v)
  if (!list.length) return { ok: false, error: '没有可用的下载地址', tried: [] }
  if (typeof fetchImpl !== 'function') return { ok: false, error: '这个环境里没有 fetch，下载不了', tried: [] }
  const progress = typeof onProgress === 'function' ? onProgress : () => {}

  const dest = path.join(dir, fileNameFor(v))
  const part = `${dest}.part`
  await fsp.mkdir(dir, { recursive: true })

  const tried = []
  const deadline = Date.now() + Math.max(5_000, Number(budgetMs) || BUDGET_MS)

  for (const src of list) {
    const left = deadline - Date.now()
    if (left <= 0) {
      tried.push('（整批超时）')
      break
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Math.min(left, perSourceTimeoutMs))
    try {
      const res = await fetchImpl(src.url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { accept: 'application/gzip, application/octet-stream', 'user-agent': `dsh-fish-river-selfupdate/${v}` },
      })
      if (!res || !res.ok) throw new Error(`返回 ${res ? res.status : '没有响应'}`)
      const len = Number(res.headers?.get?.('content-length') ?? 0) || 0
      if (len > MAX_TARBALL_BYTES) throw new Error(`文件太大（${len} 字节）`)

      const chunks = []
      let got = 0
      if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of res.body) {
          const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          got += b.length
          if (got > MAX_TARBALL_BYTES) throw new Error('文件太大')
          chunks.push(b)
          progress({ bytes: got, total: len })
        }
      } else {
        const b = Buffer.from(await res.arrayBuffer())
        got = b.length
        chunks.push(b)
        progress({ bytes: got, total: len })
      }
      const buf = Buffer.concat(chunks)
      // 先验内容，再落盘：验不过的东西不该在磁盘上留下任何痕迹。
      inspectPackage(buf, { version: v })
      await fsp.writeFile(part, buf)
      await fsp.rename(part, dest)
      return { ok: true, file: dest, bytes: buf.length, source: src.name }
    } catch (e) {
      tried.push(`${src.name}：${describeFetchError(e, perSourceTimeoutMs)}`)
      try { await fsp.rm(part, { force: true }) } catch { /* ignore */ }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    ok: false,
    error: `这个版本没能下载成功。${tried.join('；')}。过一会儿再试一次，或者开一下网络工具。`,
    tried,
  }
}

function describeFetchError(e, ms) {
  const name = e?.name ?? ''
  if (name === 'AbortError' || /aborted/i.test(String(e?.message ?? ''))) return `等了 ${Math.round(ms / 1000)} 秒没下完`
  return String(e?.message ?? e)
}

/**
 * 生成安装脚本（Windows .cmd）。
 *
 * 脚本里的每一步都写成"失败就回滚"，因为它是**唯一**能改 profile 的环节，
 * 而那时应用已经关了——出错没人能救场，只能靠脚本自己退回去。
 * 日志一律英文：cmd 默认代码页是 GBK，中文写进去在日志里会是乱码。
 */
export function scriptFor({
  version,
  profileDir,
  exe,
  nodeBin,
  pnpmScript,
  logFile,
  backupDir,
  hostName,
  tarball = '',
} = {}) {
  const v = cleanVersion(version)
  if (!v) throw new Error('版本号认不出来')
  if (!profileDir) throw new Error('找不到 profile 目录')
  if (!exe) throw new Error('找不到应用路径')
  // 有应用自带的 node + pnpm.mjs 就直连（不依赖 PATH 里装没装 pnpm）；
  // 没有就退回 PATH 上的 pnpm —— 用户机器上装过 pnpm 也能跑。
  const pnpmCmd = nodeBin && pnpmScript ? `"${nodeBin}" "${pnpmScript}"` : 'pnpm'
  const q = (s) => String(s ?? '')
  // 优先装**已经下载并验过**的那个包（`file:`），不走 `github:`。
  // 原因（2026-10-29 实测）：`github:` spec 要 pnpm 跑 `git ls-remote` 打 github.com:443，
  // 这台机器上直接 Connection reset / ETIMEDOUT —— 而 codeload 和镜像都是通的。
  // 升级要能用，就不能把成败押在 git 协议上。
  const specArg = tarball ? `file:${q(tarball)}` : specFor(v)

  return [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal enableextensions',
    `set "LOG=${q(logFile)}"`,
    `set "BK=${q(backupDir)}"`,
    `set "PROFILE=${q(profileDir)}"`,
    `echo. >> "%LOG%"`,
    `echo ==== dsh-fish-river self-update to v${v} ==== >> "%LOG%"`,
    'echo [1/6] wait for host to exit >> "%LOG%"',
    'rem wait 2s so the HTTP reply reaches the UI before the host dies',
    'timeout /t 2 /nobreak >nul',
    `taskkill /F /IM "${q(hostName)}" >> "%LOG%" 2>&1`,
    'set /a N=0',
    ':waitloop',
    'set /a N+=1',
    `tasklist /FI "IMAGENAME eq ${q(hostName)}" 2>nul | find /I "${q(hostName)}" >nul`,
    'if errorlevel 1 goto exited',
    'if %N% GEQ 60 goto exittimeout',
    'timeout /t 1 /nobreak >nul',
    'goto waitloop',
    ':exittimeout',
    'echo [1/6] host still running after 60s - abort, nothing changed >> "%LOG%"',
    'goto relaunch',
    ':exited',
    'echo [2/6] host exited >> "%LOG%"',
    'mkdir "%BK%" 2>nul',
    'copy /Y "%PROFILE%\\package.json" "%BK%\\package.json" >nul 2>&1',
    'copy /Y "%PROFILE%\\pnpm-lock.yaml" "%BK%\\pnpm-lock.yaml" >nul 2>&1',
    'if exist "%PROFILE%\\node_modules\\dsh-fish-river" (',
    '  if not exist "%BK%\\dsh-fish-river" mkdir "%BK%\\dsh-fish-river"',
    '  xcopy /E /I /H /Y "%PROFILE%\\node_modules\\dsh-fish-river" "%BK%\\dsh-fish-river" >> "%LOG%" 2>&1',
    ')',
    'cd /d "%PROFILE%"',
    `echo [3/6] install ${specArg} >> "%LOG%"`,
    `${pnpmCmd} add "${specArg}" --config.minimumReleaseAge=0 >> "%LOG%" 2>&1`,
    'if errorlevel 1 goto rollback',
    'echo [4/6] verify installed version >> "%LOG%"',
    `"${q(nodeBin) || 'node'}" -e "const p=require('./node_modules/dsh-fish-river/package.json');if(p.version!=='${v}'){console.error('got '+p.version);process.exit(3)}" >> "%LOG%" 2>&1`,
    'if errorlevel 1 goto rollback',
    'echo [5/6] installed OK >> "%LOG%"',
    'goto relaunch',
    ':rollback',
    'echo [4/6] FAILED - rolling back to the previous copy >> "%LOG%"',
    'copy /Y "%BK%\\package.json" "%PROFILE%\\package.json" >nul 2>&1',
    'copy /Y "%BK%\\pnpm-lock.yaml" "%PROFILE%\\pnpm-lock.yaml" >nul 2>&1',
    'if exist "%BK%\\dsh-fish-river" (',
    '  rmdir /S /Q "%PROFILE%\\node_modules\\dsh-fish-river" >> "%LOG%" 2>&1',
    '  xcopy /E /I /H /Y "%BK%\\dsh-fish-river" "%PROFILE%\\node_modules\\dsh-fish-river" >> "%LOG%" 2>&1',
    ')',
    `cd /d "%PROFILE%"`,
    `${pnpmCmd} install --config.minimumReleaseAge=0 >> "%LOG%" 2>&1`,
    'echo [4/6] rollback done >> "%LOG%"',
    ':relaunch',
    'echo [6/6] restart host >> "%LOG%"',
    `start "" "${q(exe)}"`,
    'exit /b 0',
    '',
  ].join('\r\n')
}

/** bash 单引号。路径里有空格或引号时，不让 shell 把 profile 拆开。 */
function shSingle(s) {
  return `'${String(s ?? '').replace(/'/g, `'\\''`)}'`
}

/**
 * 生成安装脚本（Linux bash）。
 *
 * 和 Windows 同一套步骤：先等 HTTP 响应离开进程，再停宿主，备份，装已校验的 tarball，
 * 对版本，失败就回滚。停宿主用的是 systemd，不是 taskkill——单元名写死为
 * `deepseek-harness`。成功、回滚、以及「没能停下来所以什么都没改」三条路最后都
 * `systemctl restart`，不把服务留在 stopped。
 *
 * 日志用英文，和 Windows 脚本一致，避免 locale 不是 UTF-8 时把中文记成问号。
 */
export function scriptForLinux({
  version,
  profileDir,
  nodeBin,
  pnpmScript,
  logFile,
  backupDir,
  tarball = '',
  pathEnv = '',
} = {}) {
  const v = cleanVersion(version)
  if (!v) throw new Error('版本号认不出来')
  if (!profileDir) throw new Error('找不到 profile 目录')
  const pnpmCmd = nodeBin && pnpmScript
    ? `${shSingle(nodeBin)} ${shSingle(pnpmScript)}`
    : 'pnpm'
  const nodeCmd = nodeBin ? shSingle(nodeBin) : 'node'
  // 与 Windows 相同：优先装已经下载并验过的那个包，避免 pnpm 再走 git 协议。
  const specArg = tarball ? `file:${tarball}` : specFor(v)
  const unit = LINUX_SYSTEMD_UNIT
  // 服务进程的 PATH 可能在 nvm / 用户目录里才有 pnpm；systemd-run 出来的进程不一定继承它。
  // 系统目录附在后面，保证 systemctl 还找得到。
  const systemPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  const mergedPath = pathEnv ? `${pathEnv}:${systemPath}` : systemPath
  const verifyJs = `const p=require("./node_modules/dsh-fish-river/package.json");if(p.version!=="${v}"){console.error("got "+p.version);process.exit(3)}`

  return [
    '#!/bin/bash',
    '# dsh-fish-river self-update (Linux WebUI).',
    '# systemd KillMode=control-group kills every process still in the service cgroup.',
    '# Re-exec outside that cgroup before `systemctl stop`, or this script dies with the host',
    '# and node_modules is never replaced. Unit name is fixed: deepseek-harness.',
    `LOG=${shSingle(logFile)}`,
    `BK=${shSingle(backupDir)}`,
    `PROFILE=${shSingle(profileDir)}`,
    `SPEC=${shSingle(specArg)}`,
    `export PATH=${shSingle(mergedPath)}`,
    'restart_host() {',
    '  echo "[6/6] restart host" >> "$LOG"',
    `  systemctl restart ${unit} >> "$LOG" 2>&1 || true`,
    '}',
    'rollback() {',
    '  echo "[4/6] FAILED - rolling back to the previous copy" >> "$LOG"',
    '  cp -a "$BK/package.json" "$PROFILE/package.json" >> "$LOG" 2>&1 || true',
    '  cp -a "$BK/pnpm-lock.yaml" "$PROFILE/pnpm-lock.yaml" >> "$LOG" 2>&1 || true',
    '  if [ -d "$BK/dsh-fish-river" ]; then',
    '    rm -rf "$PROFILE/node_modules/dsh-fish-river"',
    '    mkdir -p "$PROFILE/node_modules"',
    '    cp -a "$BK/dsh-fish-river" "$PROFILE/node_modules/dsh-fish-river" >> "$LOG" 2>&1 || true',
    '  fi',
    `  ( cd "$PROFILE" && ${pnpmCmd} install --config.minimumReleaseAge=0 ) >> "$LOG" 2>&1 || true`,
    '  echo "[4/6] rollback done" >> "$LOG"',
    '  restart_host',
    '}',
    'if [ "${1:-}" != "--outside" ]; then',
    '  if command -v systemd-run >/dev/null 2>&1; then',
    '    echo "[0/6] leave service cgroup" >> "$LOG"',
    '    systemd-run --scope --collect --quiet --no-block --unit="dsh-fish-river-selfupdate-$$" /bin/bash "$0" --outside >> "$LOG" 2>&1',
    '    rc=$?',
    '    if [ "$rc" -eq 0 ]; then',
    '      exit 0',
    '    fi',
    '    echo "[0/6] systemd-run failed ($rc); continuing in this process" >> "$LOG"',
    '  else',
    '    echo "[0/6] systemd-run missing; continuing in this process" >> "$LOG"',
    '  fi',
    'fi',
    'echo >> "$LOG"',
    `echo "==== dsh-fish-river self-update to v${v} ====" >> "$LOG"`,
    'echo "[1/6] wait for host to exit" >> "$LOG"',
    '# wait 2s so the HTTP reply reaches the UI before the host dies',
    'sleep 2',
    `echo "[1/6] systemctl stop ${unit}" >> "$LOG"`,
    `systemctl stop ${unit} >> "$LOG" 2>&1 || true`,
    'n=0',
    'while [ "$n" -lt 60 ]; do',
    '  n=$((n + 1))',
    `  state=$(systemctl is-active ${unit} 2>/dev/null || true)`,
    '  if [ "$state" = "inactive" ] || [ "$state" = "failed" ]; then',
    '    break',
    '  fi',
    '  sleep 1',
    'done',
    `state=$(systemctl is-active ${unit} 2>/dev/null || true)`,
    'if [ "$state" != "inactive" ] && [ "$state" != "failed" ]; then',
    '  echo "[1/6] host still running after 60s - abort, nothing changed" >> "$LOG"',
    '  restart_host',
    '  exit 0',
    'fi',
    'echo "[2/6] host exited" >> "$LOG"',
    'mkdir -p "$BK"',
    'cp -a "$PROFILE/package.json" "$BK/package.json" >> "$LOG" 2>&1 || true',
    'cp -a "$PROFILE/pnpm-lock.yaml" "$BK/pnpm-lock.yaml" >> "$LOG" 2>&1 || true',
    'if [ -d "$PROFILE/node_modules/dsh-fish-river" ]; then',
    '  rm -rf "$BK/dsh-fish-river"',
    '  cp -a "$PROFILE/node_modules/dsh-fish-river" "$BK/dsh-fish-river" >> "$LOG" 2>&1 || true',
    'fi',
    'cd "$PROFILE" || {',
    '  echo "[3/6] cannot enter profile - abort, nothing installed" >> "$LOG"',
    '  restart_host',
    '  exit 0',
    '}',
    'echo "[3/6] install $SPEC" >> "$LOG"',
    `${pnpmCmd} add "$SPEC" --config.minimumReleaseAge=0 >> "$LOG" 2>&1`,
    'if [ "$?" -ne 0 ]; then',
    '  rollback',
    '  exit 0',
    'fi',
    'echo "[4/6] verify installed version" >> "$LOG"',
    `${nodeCmd} -e ${shSingle(verifyJs)} >> "$LOG" 2>&1`,
    'if [ "$?" -ne 0 ]; then',
    '  rollback',
    '  exit 0',
    'fi',
    'echo "[5/6] installed OK" >> "$LOG"',
    'restart_host',
    'exit 0',
    '',
  ].join('\n')
}

/**
 * 找应用自带的 node 与 pnpm（`<应用目录>/resources/runtime/primary-runtime/dependencies/`）。
 *
 * 为什么不用 PATH 上的 pnpm：用户机器上很可能没装 pnpm —— 桌面版自带一份，
 * 用自带的就等于"用户不需要为升级做任何准备"。找不到才退回 PATH。
 */
export function runtimeBins({ exe = process.execPath, exists = fs.existsSync } = {}) {
  const appDir = path.dirname(String(exe ?? ''))
  const bases = [appDir, path.join(appDir, '..')]
  for (const base of bases) {
    const dep = path.join(base, 'resources', 'runtime', 'primary-runtime', 'dependencies')
    const nodeBin = path.join(dep, 'node', 'bin', 'node.exe')
    const pnpmScript = path.join(dep, 'pnpm', 'bin', 'pnpm.mjs')
    try {
      if (exists(nodeBin) && exists(pnpmScript)) return { nodeBin, pnpmScript }
    } catch { /* ignore */ }
  }
  return { nodeBin: '', pnpmScript: '' }
}

/**
 * 写脚本 + 起进程（detached，宿主被杀也不会带走它）。
 * 返回脚本路径，调用方负责把状态切到 installing。
 */
export async function armInstall({
  root,
  version,
  profileDir,
  exe,
  nodeBin,
  pnpmScript,
  spawnImpl = spawn,
  hostName,
  backupSuffix = '',
  tarball = '',
  platform = 'win32',
  pathEnv = '',
} = {}) {
  const v = cleanVersion(version)
  const dir = path.join(root, 'updates')
  await fsp.mkdir(dir, { recursive: true })
  const linux = platform === 'linux'
  const scriptPath = path.join(dir, `install-v${v}${backupSuffix}.${linux ? 'sh' : 'cmd'}`)
  const logFile = path.join(dir, 'last.log')
  const backupDir = path.join(dir, `backup-v${v}${backupSuffix}`)
  const script = linux
    ? scriptForLinux({ version: v, profileDir, nodeBin, pnpmScript, logFile, backupDir, tarball, pathEnv })
    : scriptFor({ version: v, profileDir, exe, nodeBin, pnpmScript, logFile, backupDir, hostName, tarball })
  // 无 BOM UTF-8：cmd 不认 BOM，带上反而会把第一行认成 `ï»¿@echo`。bash 同样不需要 BOM。
  await fsp.writeFile(scriptPath, script, 'utf8')
  if (linux) {
    try { await fsp.chmod(scriptPath, 0o755) } catch { /* ignore */ }
  }
  // detached：HTTP 响应先回到页面，随后宿主被停掉也不会把安装脚本一起收走。
  const child = linux
    ? spawnImpl('bash', [scriptPath], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
      })
    : spawnImpl('cmd.exe', ['/c', scriptPath], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
  if (child && typeof child.unref === 'function') child.unref()
  return { scriptPath, logFile, backupDir }
}

/** 读上次安装日志的末尾（只给界面看，不参与判断）。 */
export async function tailUpdateLog(file, maxLines = 12) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    return lines.slice(-maxLines).join('\n')
  } catch {
    return ''
  }
}

/**
 * 状态机 + 对外入口。
 *
 * 四个阶段：idle（还没下）→ downloading（在下的过程中）→ prepared（下完且验过）→ installing（脚本已起）。
 * 任何一步失败都进 failed，并带上**能读的中文原因**；failed 之后可以重新下载（回 downloading）。
 *
 * 这个对象是"每个插件实例一个"，不做持久化：应用一重启，之前下好的包就作废——
 * 留着的风险（磁盘上有个跟当前版本无关的包，之后被误装）比省一次下载大。
 */
export function createSelfUpdater({
  root,
  current = '',
  fetchImpl = globalThis.fetch,
  moduleUrl = import.meta.url,
  exe = process.execPath,
  nodeBin = '',
  pnpmScript = '',
  spawnImpl = spawn,
  downloadImpl = downloadTarball,
  now = () => Date.now(),
  platform = process.platform,
} = {}) {
  const dir = path.join(root, 'updates')
  let st = { phase: 'idle', version: '', error: '', bytes: 0, total: 0, source: '', note: '', file: '', startedAt: 0 }
  let running = false

  const snapshot = () => {
    const profileDir = profileDirOf(moduleUrl)
    const spec = profileDir ? readDependency(profileDir) : ''
    const kind = profileDir ? classifySpec(spec) : 'local'
    return {
      ...st,
      current: normalizeVersion(current) || String(current ?? ''),
      profileDir,
      kind,
      managed: kind === 'github' || kind === 'registry',
      canInstall: st.phase === 'prepared',
    }
  }

  async function start(version) {
    if (running) return { ok: false, error: '已经在下载了，等一下。' }
    const v = cleanVersion(version)
    if (!v) return { ok: false, error: '版本号认不出来' }
    const profileDir = profileDirOf(moduleUrl)
    const kind = profileDir ? classifySpec(readDependency(profileDir)) : 'local'
    if (!profileDir || kind === 'local') {
      return { ok: false, local: true, error: '这台机器上装的是开发版（依赖指向源码目录），不走自动下载。' }
    }
    running = true
    st = { ...st, phase: 'downloading', version: v, error: '', bytes: 0, total: 0, source: '', startedAt: now() }
    // 不 await：下载几十秒，界面靠 /update/status 轮询。
    ;(async () => {
      try {
        const r = await downloadImpl({
          version: v,
          dir,
          fetchImpl,
          onProgress: ({ bytes, total }) => {
            st = { ...st, bytes: Math.max(st.bytes, Number(bytes) || 0), total: Number(total) || st.total }
          },
        })
        if (!r.ok) {
          st = { ...st, phase: 'failed', error: r.error, note: '' }
          return
        }
        st = {
          ...st,
          phase: 'prepared',
          bytes: r.bytes,
          total: r.bytes,
          source: r.source,
          file: r.file ?? '',
          note: '已下载并校验通过，可以安装。',
        }
      } catch (e) {
        st = { ...st, phase: 'failed', error: `下载时出错了：${e?.message ?? e}` }
      } finally {
        running = false
      }
    })()
    return { ok: true, phase: 'downloading', version: v }
  }

  async function install(version) {
    const v = cleanVersion(version || st.version)
    if (!v) return { ok: false, error: '版本号认不出来' }
    if (st.phase !== 'prepared' || cleanVersion(st.version) !== v) {
      return { ok: false, error: '还没有下载好这一版，先下载再装。' }
    }
    const profileDir = profileDirOf(moduleUrl)
    if (!profileDir) return { ok: false, local: true, error: '开发版不走自动升级。' }
    // Linux WebUI：没有桌面 exe。托管安装（github: / registry）写 bash，
    // 由 systemd 停掉再拉起。execPath 是 node 是正常情况。
    if (platform === 'linux') {
      const kind = classifySpec(readDependency(profileDir))
      if (kind === 'local') return { ok: false, local: true, error: '开发版不走自动升级。' }
      if (kind !== 'github' && kind !== 'registry') {
        return { ok: false, error: '这台安装不归自动升级管，请手动更新。' }
      }
      // 桌面版自带的 node.exe 在这里不存在。验证版本时用当前 node；pnpm 优先用调用方传入的，
      // 其次用 node 旁边的那个（/usr/bin/node 与 /usr/bin/pnpm 这种布局）。
      const linuxNode = nodeBin || (exe && fs.existsSync(exe) ? exe : '')
      let linuxPnpm = pnpmScript
      if (!linuxPnpm && linuxNode) {
        const sibling = path.join(path.dirname(linuxNode), 'pnpm')
        if (fs.existsSync(sibling)) linuxPnpm = sibling
      }
      try {
        const note = '正在停止服务并在后台安装，装完会自动拉起。'
        const armed = await armInstall({
          root,
          version: v,
          profileDir,
          exe,
          nodeBin: linuxNode,
          pnpmScript: linuxPnpm,
          spawnImpl,
          hostName: LINUX_SYSTEMD_UNIT,
          tarball: st.file,
          platform: 'linux',
          pathEnv: process.env.PATH || '',
        })
        st = { ...st, phase: 'installing', note }
        return { ok: true, phase: 'installing', script: armed.scriptPath, note }
      } catch (e) {
        return { ok: false, error: `起安装脚本失败：${e?.message ?? e}` }
      }
    }
    // 安装脚本是 cmd 批处理（taskkill/tasklist/xcopy），Windows 以外、又不是上面的 Linux 时不写。
    if (platform !== 'win32') {
      return { ok: false, error: '自动安装目前只做了 Windows 和 Linux；这台机器请手动更新。' }
    }
    if (!exe || !/\.exe$/i.test(exe) || /^node(\.exe)?$/i.test(path.basename(exe))) {
      return { ok: false, error: '当前不是桌面版（没有可重开的 exe），请手动更新。' }
    }
    try {
      const armed = await armInstall({
        root,
        version: v,
        profileDir,
        exe,
        nodeBin,
        pnpmScript,
        spawnImpl,
        hostName: path.basename(exe),
        // 装的是刚才下载并验过的那个包；文件留在 updates/ 里，之后 pnpm install 还要用。
        tarball: st.file,
        platform: 'win32',
      })
      st = { ...st, phase: 'installing', note: '正在关闭应用并在后台安装，装完会自动重开。' }
      return { ok: true, phase: 'installing', script: armed.scriptPath }
    } catch (e) {
      return { ok: false, error: `起安装脚本失败：${e?.message ?? e}` }
    }
  }

  return { status: snapshot, start, install, dir }
}
