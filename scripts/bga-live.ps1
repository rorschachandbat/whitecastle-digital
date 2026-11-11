param(
    [ValidateRange(1024, 65535)][int]$Port = 4180
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction Stop
$serverFile = Join-Path $PSScriptRoot 'serve-bga-live.mjs'
$runtimeFolder = Join-Path $projectRoot '.local/bga-live'
New-Item -ItemType Directory -Path $runtimeFolder -Force | Out-Null
$address = "http://127.0.0.1:$Port"
$running = $false
try {
    $probe = Invoke-RestMethod -Uri "$address/api/live/state" -TimeoutSec 2
    $config = Invoke-RestMethod -Uri "$address/api/live/config" -TimeoutSec 2
    $expectedExtension = Join-Path $projectRoot 'browser-extension/bga-live'
    $running = $probe.format -eq 'whitecastle-bga-live-status' -and $config.extensionPath -eq $expectedExtension
} catch {}
if (-not $running) {
    # 配套脚本从启动器位置定位，任意分支副本均不依赖当前工作目录。
    $arguments = '"' + $serverFile + '" ' + $Port
    Start-Process -FilePath $nodeCommand.Source -ArgumentList $arguments -WorkingDirectory $projectRoot `
        -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeFolder 'server.stdout.log') `
        -RedirectStandardError (Join-Path $runtimeFolder 'server.stderr.log') | Out-Null
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
