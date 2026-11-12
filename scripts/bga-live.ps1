param(
    [ValidateRange(1024, 65535)][int]$Port = 4180
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction Stop
$serverFile = Join-Path $PSScriptRoot 'serve-bga-live.mjs'
$runtimeFolder = Join-Path $projectRoot '.local/bga-live'
New-Item -ItemType Directory -Path $runtimeFolder -Force | Out-Null
$running = $false
$expectedExtension = Join-Path $projectRoot 'browser-extension/bga-live'
# 旧版服务继续保留，新版自动选择相邻端口；不结束用户现有进程或其他工作副本。
for ($portAttempt = 0; $portAttempt -lt 10; $portAttempt++) {
    $address = "http://127.0.0.1:$Port"
    $occupied = $false
    try {
        $probe = Invoke-RestMethod -Uri "$address/api/live/state" -TimeoutSec 2
        $occupied = $true
        $config = Invoke-RestMethod -Uri "$address/api/live/config" -TimeoutSec 2
        $running = $probe.format -eq 'whitecastle-bga-live-status' -and $config.extensionPath -eq $expectedExtension `
            -and $config.adviceVersion -eq 3
    } catch {}
    if ($running -or -not $occupied) { break }
    $Port += 2
    if ($Port -gt 65535) { throw 'BGA_LIVE_NO_AVAILABLE_PORT' }
}
if ($occupied -and -not $running) { throw 'BGA_LIVE_NO_AVAILABLE_PORT' }
if (-not $running) {
    # 配套脚本从启动器位置定位，任意分支副本均不依赖当前工作目录。
    $arguments = '"' + $serverFile + '" ' + $Port
    Start-Process -FilePath $nodeCommand.Source -ArgumentList $arguments -WorkingDirectory $projectRoot `
        -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeFolder "server-$Port.stdout.log") `
        -RedirectStandardError (Join-Path $runtimeFolder "server-$Port.stderr.log") | Out-Null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try {
            $probe = Invoke-RestMethod -Uri "$address/api/live/state" -TimeoutSec 1
            $running = $probe.format -eq 'whitecastle-bga-live-status' -and $probe.workspaceRoot -eq $projectRoot
            if ($running) { break }
        } catch {}
        Start-Sleep -Milliseconds 200
    }
    if (-not $running) { throw 'BGA_LIVE_START_FAILED' }
}
Start-Process $address
