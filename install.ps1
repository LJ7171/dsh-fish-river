<#
  dsh-fish-river 安装脚本（2026-11-03）

  做四件事：
    1. 找到你的 DSH profile 目录（多个时默认 desktop，可用 -Profile 指定）
    2. 用 pnpm 把插件装进去（默认从 GitHub，也可 -LocalPath 装本地目录）
    3. 把 "dsh-fish-river" 写进 profile package.json 的 dsh.profile.bundles
    4. 可选：顺手装 ffmpeg（-FfmpegZip 指向官方 zip，不用解压）

  用法：
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -LocalPath D:\fish\dsh-fish-river
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -FfmpegZip D:\downloads\ffmpeg-9.0.2-essentials_build.zip
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun     # 只看它打算做什么

  只改这两处：profile 的 package.json（bundles 数组）、以及可选的 <插件目录>\bin\win32-x64\ffmpeg.exe。
  不改 DSH 自己的文件，不写注册表，不删任何东西。
#>

[CmdletBinding()]
param(
  [string]$Profile = '',
  [string]$LocalPath = '',
  [string]$Source = 'github:bychance6600/dsh-fish-river',
  [string]$FfmpegZip = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-fish-river'
$Separator = ('-' * 62)

function Say([string]$text, [string]$color = 'Gray') {
  Write-Host $text -ForegroundColor $color
}

function Step([string]$n, [string]$text) {
  Write-Host ''
  Write-Host "$n  $text" -ForegroundColor Cyan
}

function Fail([string]$text) {
  Write-Host ''
  Write-Host "×  $text" -ForegroundColor Red
  exit 1
}

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $roots = @(
    (Join-Path $env:ProgramFiles 'DeepSeek Harness'),
    (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness'),
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
    'D:\DeepSeek Harness'
  )
  foreach ($root in $roots) {
    if (-not $root) { continue }
    $candidate = Join-Path $root 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

function Find-Pnpm([string]$NodeExe) {
  $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($cmd) { return @{ Exe = $cmd.Source; Prefix = @() } }

  $roots = @(
    (Join-Path $env:ProgramFiles 'DeepSeek Harness'),
    (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness'),
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
    'D:\DeepSeek Harness'
  )
  foreach ($root in $roots) {
    if (-not $root) { continue }
    $cjs = Join-Path $root 'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
    if ((Test-Path $cjs) -and $NodeExe) { return @{ Exe = $NodeExe; Prefix = @($cjs) } }
  }
  return $null
}

function Get-Profiles {
  $base = Join-Path $env:USERPROFILE '.dsh\profiles'
  if (-not (Test-Path $base)) { return @() }
  $list = @()
  foreach ($dir in Get-ChildItem $base -Directory -ErrorAction SilentlyContinue) {
    if (Test-Path (Join-Path $dir.FullName 'package.json')) { $list += $dir.FullName }
  }
  return $list
}

function Resolve-Profile {
  if ($Profile) {
    $full = [System.IO.Path]::GetFullPath($Profile)
    if (-not (Test-Path (Join-Path $full 'package.json'))) { Fail "这个目录里没有 package.json：$full" }
    return $full
  }

  $all = @(Get-Profiles)
  if ($all.Count -eq 0) { Fail "没找到 DSH profile（$env:USERPROFILE\.dsh\profiles）。先启动一次 DSH 桌面版，或用 -Profile 指定。" }
  if ($all.Count -eq 1) { return $all[0] }

  $desktop = $all | Where-Object { (Split-Path $_ -Leaf) -eq 'desktop' }
  if ($desktop) { return $desktop }

  Say '找到多个 profile：' 'Yellow'
  for ($i = 0; $i -lt $all.Count; $i++) { Say ("  [{0}] {1}" -f ($i + 1), $all[$i]) }
  $answer = Read-Host '用哪个？（回车默认第 1 个）'
  $index = 0
  if ($answer -and [int]::TryParse($answer, [ref]$index)) { $index = $index - 1 }
  if ($index -lt 0 -or $index -ge $all.Count) { $index = 0 }
  return $all[$index]
}

function Test-InsideProfile([string]$profileDir) {
  # 插件正跑着的时候替换文件会 EPERM；这里只做提示，不阻止
  $lock = Join-Path $profileDir 'node_modules\.modules.yaml'
  if (Test-Path $lock) { Say '提示：如果 DSH 正开着，装完请重启（运行中的包文件会被占用）。' 'Yellow' }
}

function Add-Bundle([string]$pkgPath, [string]$name) {
  $raw = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8
  if ($raw -match ('"' + [regex]::Escape($name) + '"\s*(,|\])')) {
    return @{ Changed = $false; Reason = 'bundles 里已经有了' }
  }

  if ($raw -notmatch '"bundles"\s*:\s*\[') {
    return @{ Changed = $false; Reason = '这个 profile 没有 dsh.profile.bundles，装完会在启动时的插件列表里出现，但可能需要手动加' }
  }

  $pattern = '"bundles"\s*:\s*\[(?<body>[^\]]*)\]'
  $m = [regex]::Match($raw, $pattern, 'Singleline')
  if (-not $m.Success) { return @{ Changed = $false; Reason = 'bundles 格式看不懂，跳过' } }

  $body = $m.Groups['body'].Value
  $trimmed = $body.Trim()
  $entry = '"' + $name + '"'

  # 跟着已有条目的缩进走；空数组时用 6 个空格
  $indent = '      '
  $indentMatch = [regex]::Match($body, '(?m)^(?<ind>[ \t]+)"')
  if ($indentMatch.Success) { $indent = $indentMatch.Groups['ind'].Value }
  $closeIndent = '  '
  if ($indent.Length -ge 2) { $closeIndent = ' ' * ($indent.Length - 2) }

  if ($trimmed.Length -eq 0) {
    $newBody = "`n$indent$entry"
  } else {
    $newBody = $body.TrimEnd() + ",`n$indent$entry"
  }
  $replacement = '"bundles": [' + $newBody + "`n$closeIndent]"
  $updated = $raw.Substring(0, $m.Index) + $replacement + $raw.Substring($m.Index + $m.Length)

  $backup = $pkgPath + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss')
  Copy-Item -LiteralPath $pkgPath -Destination $backup
  [System.IO.File]::WriteAllText($pkgPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
  return @{ Changed = $true; Reason = "已写入（备份：$(Split-Path $backup -Leaf)）" }
}

Say $Separator 'DarkGray'
Say '  dsh-fish-river 安装' 'White'
Say '  养一条会自己长大、会去 QQ / B 站 / 抖音 说话的大肥鱼' 'DarkGray'
Say $Separator 'DarkGray'

# 1. profile
Step '1/5' '找 DSH profile'
$profileDir = Resolve-Profile
Say "   → $profileDir" 'Gray'
Test-InsideProfile $profileDir

# 2. 工具链
Step '2/5' '找 node 与 pnpm'
$node = Find-Node
if (-not $node) { Fail '没找到 node。装一个 Node 22+，或先运行一次 DSH 桌面版（它自带 node）。' }
Say "   node：$node" 'Gray'
$pnpm = Find-Pnpm $node
if (-not $pnpm) { Fail '没找到 pnpm。npm i -g pnpm 之后重试，或用 DSH 自带的那个。' }
Say "   pnpm：$($pnpm.Exe) $($pnpm.Prefix -join ' ')" 'Gray'

$major = $null
try { $v = & $node -p 'process.versions.node'; if ($v) { $major = [int]([string]$v).Split('.')[0] } } catch { $major = $null }
if ($major -and [int]$major -lt 22) {
  Say "   注意：当前 Node 是 $major，插件要求 ≥22（QQ 渠道要用内置 WebSocket）。" 'Yellow'
}

# 3. 安装
Step '3/5' '安装插件'
$spec = $Source
if ($LocalPath) {
  $full = [System.IO.Path]::GetFullPath($LocalPath)
  if (-not (Test-Path (Join-Path $full 'package.json'))) { Fail "这个目录不是插件仓库：$full" }
  $spec = 'link:' + ($full -replace '\\', '/')
}
Say "   $spec" 'Gray'

$pkgJson = Join-Path $profileDir 'package.json'
$raw = Get-Content -LiteralPath $pkgJson -Raw -Encoding UTF8
$already = $raw -match ('"' + [regex]::Escape($PackageName) + '"\s*:')

if ($already) {
  Say '   已经在 dependencies 里，跳过 pnpm add（想升级就手动 pnpm update）' 'DarkGray'
} elseif ($DryRun) {
  Say "   [DryRun] 会运行：pnpm add $spec" 'DarkGray'
} else {
  Push-Location $profileDir
  try {
    if ($pnpm.Prefix.Count -gt 0) {
      & $pnpm.Exe @($pnpm.Prefix + @('add', $spec))
    } else {
      & $pnpm.Exe add $spec
    }
    if ($LASTEXITCODE -ne 0) { Fail "pnpm add 失败（退出码 $LASTEXITCODE）。常见原因：网络、或 DSH 正开着占用文件。" }
  } finally {
    Pop-Location
  }
  Say '   装好了' 'Green'
}

# 4. bundles
Step '4/5' '挂进 dsh.profile.bundles'
if ($DryRun) {
  Say "   [DryRun] 会在 $pkgJson 的 bundles 里加上 $PackageName" 'DarkGray'
} else {
  $result = Add-Bundle $pkgJson $PackageName
  if ($result.Changed) { Say ('   ' + $result.Reason) 'Green' } else { Say ('   跳过：' + $result.Reason) 'DarkGray' }
}

# 5. ffmpeg（可选）
Step '5/5' 'ffmpeg（可选，只有「看画面」要用）'
$installDir = $null
if ($LocalPath) { $installDir = [System.IO.Path]::GetFullPath($LocalPath) }
else { $installDir = Join-Path $profileDir "node_modules\$PackageName" }

if ($FfmpegZip) {
  $setup = Join-Path $installDir 'tools\setup-ffmpeg.mjs'
  if (-not (Test-Path $setup)) {
    Say "   跳过：找不到 $setup（先完成第 3 步）" 'Yellow'
  } elseif ($DryRun) {
    Say "   [DryRun] 会运行：node `"$setup`" `"$FfmpegZip`"" 'DarkGray'
  } else {
    Push-Location $installDir
    try {
      & $node $setup $FfmpegZip
      if ($LASTEXITCODE -ne 0) { Say "   ffmpeg 没装成（退出码 $LASTEXITCODE），插件仍可用，只是「看画面」降级。" 'Yellow' }
    } finally {
      Pop-Location
    }
  }
} else {
  $known = Join-Path $installDir 'bin\win32-x64\ffmpeg.exe'
  if (Test-Path $known) {
    Say "   已经有了：$known" 'DarkGray'
  } else {
    Say '   没装。需要「看画面」时再运行（zip 不用解压）：' 'DarkGray'
    Say "     node `"$installDir\tools\setup-ffmpeg.mjs`" D:\downloads\ffmpeg-9.0.2-essentials_build.zip" 'DarkGray'
  }
}

Say ''
Say $Separator 'DarkGray'
if ($DryRun) {
  Say '  DryRun：什么都没改。' 'Yellow'
} else {
  Say '  装完了。下一步：' 'White'
  Say '    1) 重启 DSH（运行中的包文件不会热替换）' 'Gray'
  Say '    2) 设置 → 大肥鱼 → 「渠道」页签，开你要用的渠道' 'Gray'
  Say "    3) 日志：$env:USERPROFILE\.dsh-fish-river\logs\dsh-fish-river.log" 'Gray'
  Say '       看到「===== 启动 0.1.25」就是挂上了；没有就是 bundles 没写进去。' 'Gray'
}
Say $Separator 'DarkGray'
