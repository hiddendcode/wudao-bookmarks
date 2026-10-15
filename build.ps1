<#
  悟道书签管理器 · 打包脚本
  ========================================================================
  一次命令做完三件事：
    ① 自动把版本号 +1（默认 patch：1.4.3 → 1.4.4），两个 manifest 同步改写
    ② 用 src\common 的公共代码 + 各自 manifest 拼出两个完整的扩展目录
    ③ 打成可以直传商店的 .xpi（Firefox）和 .zip（Chrome / Edge）

  用法（在脚本所在目录执行）：
    .\build.ps1                     # 版本 +0.0.1 后打包（最常用）
    .\build.ps1 -Bump minor         # 版本 +0.1.0 后打包
    .\build.ps1 -Bump major         # 版本 +1.0.0 后打包
    .\build.ps1 -Bump none          # 不改版本，只重新打包（打包参数写错了用这个重打）
    .\build.ps1 -Version 1.5.0      # 直接指定版本号

  为什么每次都要递增版本号：
    Chrome Web Store / Edge 加载项 / Firefox AMO 三家都只认“版本号比线上大”的包，
    重复提交同一个版本号会直接报 "version already exists"。所以默认行为就是递增，
    不需要你手动去改 manifest。

  换行 / 编码说明：manifest.json 只替换 version 那一行的内容，其余字节原样保留。
#>
[CmdletBinding()]
param(
  [ValidateSet('patch', 'minor', 'major', 'none')]
  [string]$Bump = 'patch',

  # 直接指定目标版本号，优先级高于 -Bump
  [string]$Version,

  # 打完包后顺便把产物复制到这个目录（可选，例如你存放提交文件的文件夹）
  [string]$CopyTo
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { Add-Type -AssemblyName System.IO.Compression } catch { }
try { Add-Type -AssemblyName System.IO.Compression.FileSystem } catch { }

# ---------------------------------------------------------------- 路径
$Root       = $PSScriptRoot
$SrcCommon  = Join-Path $Root 'src\common'
$SrcFirefox = Join-Path $Root 'src\firefox'
$SrcChrome  = Join-Path $Root 'src\chrome'
$BuildDir   = Join-Path $Root 'build'
$DistDir    = Join-Path $Root 'dist'

$ManifestFF = Join-Path $SrcFirefox 'manifest.json'
$ManifestCR = Join-Path $SrcChrome  'manifest.json'

function Say([string]$msg) { Write-Host $msg }

function Fail([string]$msg) { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 读版本
if (-not (Test-Path -LiteralPath $ManifestFF)) { Fail "找不到 $ManifestFF" }
if (-not (Test-Path -LiteralPath $ManifestCR)) { Fail "找不到 $ManifestCR" }

function Get-ManifestVersion([string]$path) {
  $txt = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  $m = [regex]::Match($txt, '"version"\s*:\s*"([^"]+)"')
  if (-not $m.Success) { Fail "在 $path 里没有找到 version 字段" }
  return $m.Groups[1].Value
}

$verFF = Get-ManifestVersion $ManifestFF
$verCR = Get-ManifestVersion $ManifestCR
if ($verFF -ne $verCR) { Fail "两个 manifest 版本号不一致：firefox=$verFF，chrome=$verCR（请先对齐）" }
$CurrentVersion = $verFF

# ---------------------------------------------------------------- 算新版本
function Test-VersionString([string]$v) {
  if ($v -notmatch '^\d+(\.\d+){0,3}$') { return $false }
  foreach ($p in $v.Split('.')) {
    if ($p.Length -gt 1 -and $p.StartsWith('0')) { return $false }   # 商店不接受前导零
    if ([int]$p -gt 65535) { return $false }                          # 商店上限 65535
  }
  return $true
}

function Get-NextVersion([string]$cur, [string]$kind) {
  $p = @($cur.Split('.'))
  while ($p.Count -lt 3) { $p += '0' }
  $maj = [int]$p[0]; $min = [int]$p[1]; $pat = [int]$p[2]
  switch ($kind) {
    'major' { $maj++; $min = 0; $pat = 0 }
    'minor' { $min++; $pat = 0 }
    'patch' { $pat++ }
    'none'  { }
  }
  return "$maj.$min.$pat"
}

if ($Version) {
  if (-not (Test-VersionString $Version)) { Fail "版本号格式不合法：$Version（应为 1.4.4 这样的 1~4 段数字）" }
  $NewVersion = $Version
} else {
  $NewVersion = Get-NextVersion $CurrentVersion $Bump
}

if (-not (Test-VersionString $NewVersion)) { Fail "算出来的版本号不合法：$NewVersion" }

# 商店只认递增；只有 -Bump none / -Version 相同时才是重打包
$isRebuild = ($NewVersion -eq $CurrentVersion)

# ---------------------------------------------------------------- 写版本号
function Set-ManifestVersion([string]$path, [string]$ver) {
  $txt = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  $rx  = [regex]::new('("version"\s*:\s*")[^"]*(")')
  $out = $rx.Replace($txt, '${1}' + $ver + '${2}', 1)
  if ($out -eq $txt -and (Get-ManifestVersion $path) -ne $ver) { Fail "改写版本号失败：$path" }
  [System.IO.File]::WriteAllText($path, $out, (New-Object System.Text.UTF8Encoding($false)))
}

if (-not $isRebuild) {
  Set-ManifestVersion $ManifestFF $NewVersion
  Set-ManifestVersion $ManifestCR $NewVersion
}

# 复核
$verFF = Get-ManifestVersion $ManifestFF
$verCR = Get-ManifestVersion $ManifestCR
if ($verFF -ne $NewVersion -or $verCR -ne $NewVersion) {
  Fail "版本号写入后复核不通过：firefox=$verFF，chrome=$verCR，期望=$NewVersion"
}

# ---------------------------------------------------------------- 上架体检
# 商店自己会接管更新地址；manifest 里手写 update_url 会被 Chrome 忽略，
# 而 Edge 加载项提交时带着它反而会让更新源变乱 —— 所以这里直接拦下来。
foreach ($mf in @(@{p = $ManifestFF; n = 'Firefox' }, @{p = $ManifestCR; n = 'Chrome/Edge' })) {
  $t = [System.IO.File]::ReadAllText($mf.p, [System.Text.Encoding]::UTF8)
  if ($t -match '"update_url"') {
    Fail "$($mf.n) 的 manifest.json 里出现了 update_url。走官方商店分发必须去掉它，否则自动更新会失效或被商店忽略。"
  }
}

# Firefox 必须有 gecko.id，否则 AMO 签名/更新识别不了
$tFF = [System.IO.File]::ReadAllText($ManifestFF, [System.Text.Encoding]::UTF8)
if ($tFF -notmatch '"gecko"') { Fail "Firefox 的 manifest.json 缺少 browser_specific_settings.gecko（AMO 签名必需）" }

# ---------------------------------------------------------------- 拼装
Say ""
Say "悟道书签管理器 · 打包"
Say "  版本：$CurrentVersion → $NewVersion$(if ($isRebuild) { '   (重打包，未递增)' })"
Say ""

foreach ($d in @($BuildDir, $DistDir)) {
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

function New-Stage([string]$dest, [string]$manifestPath) {
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -Path (Join-Path $SrcCommon '*') -Destination $dest -Recurse -Force
  Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $dest 'manifest.json') -Force
}

$StageFF = Join-Path $BuildDir 'firefox'
$StageCR = Join-Path $BuildDir 'chrome'
New-Stage $StageFF $ManifestFF
New-Stage $StageCR $ManifestCR

# 清掉可能混进来的垃圾文件（商店会因为它们打回）
$junkNames = @('.DS_Store', 'Thumbs.db', 'desktop.ini')
foreach ($stage in @($StageFF, $StageCR)) {
  Get-ChildItem -LiteralPath $stage -Recurse -Force -File -ErrorAction SilentlyContinue |
    Where-Object { $junkNames -contains $_.Name -or $_.Extension -eq '.map' } |
    Remove-Item -Force -Confirm:$false -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- 压缩
# 1.4.3 那两个包是被三家商店收过的，它们的压缩包里带 4 条目录条目
# （_locales/、_locales/en/、_locales/zh_CN/、icons/），一共 16 条。
# 目录条目对 zip 来说本可省略，但既然已经有一个"商店认可的样板"，
# 这里就按同样的顺序、同样的条目结构写出来，少一个变量。
function New-Package([string]$stageDir, [string]$outFile) {
  if (Test-Path -LiteralPath $outFile) { Remove-Item -LiteralPath $outFile -Force }

  $prefixLen = $stageDir.TrimEnd('\', '/').Length
  $items = New-Object System.Collections.ArrayList
  foreach ($d in (Get-ChildItem -LiteralPath $stageDir -Recurse -Directory)) {
    [void]$items.Add([pscustomobject]@{ Path = $d.FullName; Dir = $true })
  }
  foreach ($f in (Get-ChildItem -LiteralPath $stageDir -Recurse -File)) {
    [void]$items.Add([pscustomobject]@{ Path = $f.FullName; Dir = $false })
  }

  $fs = [System.IO.File]::Open($outFile, [System.IO.FileMode]::CreateNew)
  try {
    $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
      # 按相对路径排序后写入 —— 这样 _locales/ 一定排在自己的子项前面，和 1.4.3 的条目顺序一致
      foreach ($it in ($items | Sort-Object { $_.Path.Substring($prefixLen).TrimStart('\', '/') })) {
        $rel = $it.Path.Substring($prefixLen).TrimStart('\', '/').Replace('\', '/')
        if ($it.Dir) {
          [void]$zip.CreateEntry($rel + '/')          # 目录条目：0 字节，只占个名字
        } else {
          $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
          $es  = $entry.Open()
          $src = [System.IO.File]::OpenRead($it.Path)
          try { $src.CopyTo($es) } finally { $src.Dispose(); $es.Dispose() }
        }
      }
    } finally { $zip.Dispose() }
  } finally { $fs.Dispose() }
}

function Assert-Package([string]$zipPath, [string]$expectVersion) {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $names = @($zip.Entries | ForEach-Object { $_.FullName })
    if ($names -notcontains 'manifest.json') {
      Fail "$([System.IO.Path]::GetFileName($zipPath)) 的 manifest.json 不在压缩包根目录，商店会拒收。"
    }
    $entry = $zip.Entries | Where-Object { $_.FullName -eq 'manifest.json' }
    $sr = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
    $json = $sr.ReadToEnd(); $sr.Dispose()
    if ($json -notmatch ('"version"\s*:\s*"' + [regex]::Escape($expectVersion) + '"')) {
      Fail "$([System.IO.Path]::GetFileName($zipPath)) 里的版本号不是 $expectVersion"
    }
    if ($json -match '"update_url"') { Fail "$([System.IO.Path]::GetFileName($zipPath)) 里含 update_url" }
    return $names.Count
  } finally { $zip.Dispose() }
}

$outFF = Join-Path $DistDir "悟道书签管理器-浏览器扩展-firefox_$NewVersion.xpi"
$outCR = Join-Path $DistDir "悟道书签管理器-浏览器扩展-chrome-edge_$NewVersion.zip"

New-Package $StageFF $outFF
New-Package $StageCR $outCR

$nFF = Assert-Package $outFF $NewVersion
$nCR = Assert-Package $outCR $NewVersion

# 把 dist 里不属于本次版本的旧包挪进 dist\_old\。
# 目的是防止提交时手滑拿错版本 —— 商店对重复版本号只会回一句
# "version already exists"，白白浪费一次审核排队。
$oldDir = Join-Path $DistDir '_old'
$keep   = @((Split-Path -Leaf $outFF), (Split-Path -Leaf $outCR))
$stale  = @(Get-ChildItem -LiteralPath $DistDir -File -ErrorAction SilentlyContinue |
            Where-Object { $keep -notcontains $_.Name })
if ($stale.Count -gt 0) {
  if (-not (Test-Path -LiteralPath $oldDir)) { New-Item -ItemType Directory -Force -Path $oldDir | Out-Null }
  foreach ($f in $stale) {
    $target = Join-Path $oldDir $f.Name
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
    Move-Item -LiteralPath $f.FullName -Destination $target -Force
  }
  Say "  旧版本包已归入 dist\_old\（$($stale.Count) 个），dist 根目录只留本次版本"
  Say ""
}

# ---------------------------------------------------------------- 结果
Say "✓ 打包完成，两个包都过了自检（manifest 在根目录 / 版本号一致 / 无 update_url）"
Say ""
Say ("  Firefox (AMO)   : {0}  [{1} 个条目, {2:N1} KB]" -f (Split-Path -Leaf $outFF), $nFF, ((Get-Item -LiteralPath $outFF).Length / 1KB))
Say ("  Chrome / Edge   : {0}  [{1} 个条目, {2:N1} KB]" -f (Split-Path -Leaf $outCR), $nCR, ((Get-Item -LiteralPath $outCR).Length / 1KB))
Say ""

if ($CopyTo) {
  if (-not (Test-Path -LiteralPath $CopyTo)) { New-Item -ItemType Directory -Force -Path $CopyTo | Out-Null }
  Copy-Item -LiteralPath $outFF, $outCR -Destination $CopyTo -Force
  Say "  已复制到：$CopyTo"
  Say ""
}

Say "接下来："
Say "  1. Firefox  → https://addons.mozilla.org/developers/  上传 .xpi"
Say "  2. Chrome   → https://chrome.google.com/webstore/devconsole  上传 .zip"
Say "  3. Edge     → https://partner.microsoft.com/dashboard/microsoftedge  上传同一个 .zip"
Say ""
Say "  三家商店审核通过后，用户浏览器会自动下载新版本；扩展在启动时会主动催一次"
Say "  更新检查，并在图标上挂 ↑ 角标提示“重启浏览器后生效”。"
Say ""
