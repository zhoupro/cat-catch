<#
猫抓 (cat-catch) 本地 API 宿主 安装脚本 (Windows)

用法:
  powershell -ExecutionPolicy Bypass -File install.ps1              安装
  powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall   卸载
  powershell -ExecutionPolicy Bypass -File install.ps1 -ExtensionId <扩展ID>

安装后宿主程序位于 %LOCALAPPDATA%\cat-catch, 并写入 HKCU 注册表指向宿主清单,
浏览器在扩展调用时自动拉起宿主, 监听 127.0.0.1:23789 提供 HTTP 接口。
#>

param(
    [switch]$Uninstall,
    [string]$ExtensionId = "goalojkljpmbbpnjbpkjgohlhdoidenp",
    [string]$FirefoxExtensionId = "xifangczy@gmail.com"
)

$ErrorActionPreference = "Stop"
$HostName = "com.cat_catch.api"
$InstallDir = Join-Path $env:LOCALAPPDATA "cat-catch"
$ManifestPath = Join-Path $InstallDir "$HostName.json"
$FirefoxManifestPath = Join-Path $InstallDir "$HostName.firefox.json"

$ChromeRegistryKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Vivaldi\NativeMessagingHosts\$HostName"
)
$FirefoxRegistryKey = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"

if ($Uninstall) {
    foreach ($key in $ChromeRegistryKeys + $FirefoxRegistryKey) {
        if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force }
    }
    if (Test-Path $InstallDir) { Remove-Item -Path $InstallDir -Recurse -Force }
    Write-Host "已卸载: 注册表项和 $InstallDir 已删除"
    exit 0
}

$Node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $Node) {
    Write-Error "未找到 node, 请先安装 Node.js (https://nodejs.org) 后重试"
    exit 1
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item (Join-Path $PSScriptRoot "cat-catch-api.js") $InstallDir -Force
Copy-Item (Join-Path $PSScriptRoot "cat-catch-api.bat") $InstallDir -Force
Set-Content -Path (Join-Path $InstallDir "node-path.txt") -Value $Node.Source -Encoding ASCII

# 复制 cat-catch-server, 宿主收到扩展 init 消息时会自动拉起 (默认 7777)
$ServerSrc = Join-Path (Split-Path $PSScriptRoot -Parent) "tools\server"
if (Test-Path (Join-Path $ServerSrc "index.js")) {
    $ServerDst = Join-Path $InstallDir "server"
    if (Test-Path $ServerDst) { Remove-Item $ServerDst -Recurse -Force }
    New-Item -ItemType Directory -Path $ServerDst -Force | Out-Null
    Copy-Item -Path (Join-Path $ServerSrc "*") -Destination $ServerDst -Recurse -Force -Exclude "node_modules"
    try {
        Push-Location $ServerDst
        & npm install --omit=dev --no-audit --no-fund | Out-Null
        Write-Host "cat-catch-server 已安装: $ServerDst"
    } catch {
        Write-Warning "cat-catch-server 依赖安装失败, 请手动执行: cd $ServerDst && npm install"
    } finally {
        Pop-Location
    }
} else {
    Write-Warning "未找到 $ServerSrc, 跳过 cat-catch-server 安装"
}

$BatPath = (Join-Path $InstallDir "cat-catch-api.bat").Replace("\", "\\")

# 从浏览器配置中探测已加载的扩展 ID (已安装过的扩展 ID 由路径决定, 与 key 无关)
function Get-DetectedExtensionIds {
    $target = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    $ids = New-Object System.Collections.Generic.HashSet[string]
    $roots = @(
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"),
        (Join-Path $env:LOCALAPPDATA "Chromium\User Data"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data"),
        (Join-Path $env:LOCALAPPDATA "BraveSoftware\Brave-Browser\User Data"),
        (Join-Path $env:LOCALAPPDATA "Vivaldi\User Data")
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        foreach ($profile in Get-ChildItem $root -Directory -ErrorAction SilentlyContinue) {
            if ($profile.Name -ne "Default" -and -not $profile.Name.StartsWith("Profile ")) { continue }
            foreach ($file in @("Preferences", "Secure Preferences")) {
                $prefs = Join-Path $profile.FullName $file
                if (-not (Test-Path $prefs)) { continue }
                try { $json = Get-Content $prefs -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
                $settings = $json.extensions.settings
                if (-not $settings) { continue }
                foreach ($prop in $settings.PSObject.Properties) {
                    $extensionPath = $prop.Value.path
                    if (-not $extensionPath) { continue }
                    $real = $null
                    try { $real = (Resolve-Path $extensionPath).Path } catch { continue }
                    if ($real -eq $target) { [void]$ids.Add($prop.Name) }
                }
            }
        }
    }
    return $ids
}

$Origins = New-Object System.Collections.Generic.List[string]
$Origins.Add("chrome-extension://$ExtensionId/")
$DetectedIds = Get-DetectedExtensionIds
foreach ($id in $DetectedIds) {
    $origin = "chrome-extension://$id/"
    if (-not $Origins.Contains($origin)) { $Origins.Add($origin) }
}
if ($DetectedIds.Count -gt 0) { Write-Host "检测到浏览器中已加载的扩展 ID: $($DetectedIds -join ' ')" }
$OriginsJson = ($Origins | ForEach-Object { "    `"$_`"" }) -join ",`r`n"

@"
{
  "name": "$HostName",
  "description": "cat-catch local HTTP api host",
  "path": "$BatPath",
  "type": "stdio",
  "allowed_origins": [
$OriginsJson
  ]
}
"@ | Set-Content -Path $ManifestPath -Encoding UTF8

@"
{
  "name": "$HostName",
  "description": "cat-catch local HTTP api host",
  "path": "$BatPath",
  "type": "stdio",
  "allowed_extensions": [
    "$FirefoxExtensionId"
  ]
}
"@ | Set-Content -Path $FirefoxManifestPath -Encoding UTF8

foreach ($key in $ChromeRegistryKeys) {
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name "(Default)" -Value $ManifestPath
}
New-Item -Path $FirefoxRegistryKey -Force | Out-Null
Set-ItemProperty -Path $FirefoxRegistryKey -Name "(Default)" -Value $FirefoxManifestPath

Write-Host "安装完成"
Write-Host "  宿主程序: $InstallDir"
Write-Host "  cat-catch-server: $ServerDst"
Write-Host "  Node.js : $($Node.Source)"
Write-Host "  扩展 ID : $ExtensionId"
Write-Host ""
Write-Host "接下来:"
Write-Host "  1. 在浏览器中重新加载扩展 (edge://extensions 或 chrome://extensions)"
Write-Host "  2. 扩展会自动拉起宿主 (127.0.0.1:23789) 并拉起 cat-catch-server (127.0.0.1:7777)"
Write-Host "  3. 测试: curl 'http://127.0.0.1:23789/api/videos?url=https%3A%2F%2Fexample.com'"
Write-Host "        curl 'http://127.0.0.1:7777/health'"
