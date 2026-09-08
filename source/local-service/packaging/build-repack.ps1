# 从「已安装的官方版」+ 本仓库源码重新打包安装程序
#
# 用途：机器上没有 .NET SDK / 不想重新下载 Node、whisper 模型、FFmpeg 时，
# 直接复用已安装目录里那套原生宿主与运行时，只把 app 与工作区模板换成当前仓库的版本。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File packaging\build-repack.ps1 `
#     -InstalledRoot "D:\Game\Steam\BsideOliviaLin\OliviaSoul"
param(
    [Parameter(Mandatory = $true)][string]$InstalledRoot,
    [string]$OutputDirectory = "",
    [string]$Iscc = ""
)

$ErrorActionPreference = "Stop"
$project = Split-Path $PSScriptRoot -Parent      # source/local-service
$repository = Split-Path $project -Parent        # source
$version = "2008.2.7"
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path (Split-Path $repository -Parent) "build"
}
$stage = Join-Path $project "dist-repack\stage"

if (-not (Test-Path -LiteralPath (Join-Path $InstalledRoot "OliviaSoul.exe"))) {
    throw "已安装目录不正确（缺少 OliviaSoul.exe）：$InstalledRoot"
}

# ---- 1. 复制原生宿主 + 运行时（排除个人数据与卸载信息） ----
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$excludeDirs = @("app\data", "信件往来", "信件往来_原始语料", "dist-native", "dist-repack")
$robolog = robocopy $InstalledRoot $stage /E /NFL /NDL /NJH /NJS /NP /XF "unins*.exe" "unins*.dat" /XD ($excludeDirs | ForEach-Object { Join-Path $InstalledRoot $_ })
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }
Write-Output "[repack] 已复制原生宿主与运行时"

# ---- 2. 用仓库版本覆盖 app ----
$appStage = Join-Path $stage "app"
Remove-Item -LiteralPath $appStage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $appStage -Force | Out-Null
foreach ($name in @("server.js", "share.js", "transcription.js", "remote-memory.js", "soul-bundle.js", "package.json")) {
    Copy-Item -LiteralPath (Join-Path $project $name) -Destination (Join-Path $appStage $name) -Force
}
Copy-Item -LiteralPath (Join-Path $project "public") -Destination (Join-Path $appStage "public") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $project "desktop") -Destination (Join-Path $appStage "desktop") -Recurse -Force
if (Test-Path -LiteralPath (Join-Path $project "node_modules")) {
    Copy-Item -LiteralPath (Join-Path $project "node_modules") -Destination (Join-Path $appStage "node_modules") -Recurse -Force
}
Write-Output "[repack] 已覆盖 app（含 share.js 与内置封面）"

# ---- 3. 刷新工作区模板（补丁脚本 + overlay + harness + 人设） ----
$template = Join-Path $stage "resources\workspace-template"
foreach ($name in @("patch-feapp-local.ps1", "restore-feapp-original.ps1", "get-feapp-status.ps1", "feapp-upload-overlay.js")) {
    Copy-Item -LiteralPath (Join-Path $repository "tools\$name") -Destination (Join-Path $template "tools\$name") -Force
}
Copy-Item -LiteralPath (Join-Path $repository "林离人设.md") -Destination (Join-Path $template "林离人设.md") -Force
foreach ($name in @("VERSION", "00-栏目.md", "01-预检.md", "01-初始化账本.md", "03-中段生成.md", "04-尾端检查.md", "05-反馈重写.md", "开信.md", "写法.md")) {
    Copy-Item -LiteralPath (Join-Path $repository "harness\$name") -Destination (Join-Path $template "harness\$name") -Force
}
$scriptTarget = Join-Path $template ".cursor\skills\fit-letters\scripts"
foreach ($name in @("deepseek-reply.ps1", "harness-live.ps1", "harness-4step.ps1", "refresh-live-memory.ps1", "memory-lib.ps1", "ds-call.ps1", "score-temp.ps1", "sqlite-memory-load.cjs")) {
    Copy-Item -LiteralPath (Join-Path $repository ".cursor\skills\fit-letters\scripts\$name") -Destination (Join-Path $scriptTarget $name) -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "app.ico") -Destination (Join-Path $stage "app.ico") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "app.ico") -Destination (Join-Path $stage "app-v9.ico") -Force
Write-Output "[repack] 已刷新工作区模板"

# ---- 4. 打包便携 zip + 安装程序 exe ----
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$portable = Join-Path $OutputDirectory "OliviaSoul-$version-Portable.zip"
Remove-Item -LiteralPath $portable -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $portable -CompressionLevel Optimal
Write-Output "[repack] 便携包：$portable"

if ([string]::IsNullOrWhiteSpace($Iscc)) {
    $candidates = @(
        $env:ISCC_PATH,
        (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_) }
    if ($candidates.Count -lt 1) { throw "缺少 Inno Setup 6（ISCC.exe）" }
    # 注意：$candidates 只有一个元素时是字符串，直接 [0] 会取到首字符 "C"，必须包一层 @()
    $Iscc = @($candidates)[0]
}
$env:OLIVIA_SOUL_VERSION = $version
$env:OLIVIA_SOUL_STAGE = $stage
$env:OLIVIA_SOUL_OUTPUT = $OutputDirectory
& $Iscc (Join-Path $PSScriptRoot "OliviaSoul.iss")
if ($LASTEXITCODE -ne 0) { throw "Inno Setup 打包失败" }

$setup = Join-Path $OutputDirectory "OliviaSoul-$version-Setup.exe"
Write-Output "[repack] 安装程序：$setup ($([math]::Round((Get-Item $setup).Length / 1MB, 1)) MB)"
