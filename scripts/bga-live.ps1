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
$occupiedPorts = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Select-Object -ExpandProperty LocalPort)
$freePort = $null
$candidatePort = $Port
# 先找同副本的兼容服务，再使用空闲端口，避免关闭旧服务后重复启动。
for ($portAttempt = 0; $portAttempt -lt 10; $portAttempt++) {
    # 4190是浏览器禁用的Sieve端口，HTTP探测可成功但侧栏和扩展无法访问。
    if ($candidatePort -eq 4190) { $candidatePort += 2 }
    if ($candidatePort -gt 65535) { break }
    if ($occupiedPorts -contains $candidatePort) {
        $candidateAddress = "http://127.0.0.1:$candidatePort"
        try {
            $probe = Invoke-RestMethod -Uri "$candidateAddress/api/live/state" -TimeoutSec 2
            $config = Invoke-RestMethod -Uri "$candidateAddress/api/live/config" -TimeoutSec 2
            $running = $probe.format -eq 'whitecastle-bga-live-status' -and $probe.workspaceRoot -eq $projectRoot `
                -and $config.extensionPath -eq $expectedExtension -and $config.adviceVersion -eq 6
        } catch { $running = $false }
        if ($running) {
            $Port = $candidatePort
            break
        }
    } elseif ($null -eq $freePort) {
        $freePort = $candidatePort
    }
    $candidatePort += 2
}
if (-not $running) {
    if ($null -eq $freePort) { throw 'BGA_LIVE_NO_AVAILABLE_PORT' }
    $Port = $freePort
}
$address = "http://127.0.0.1:$Port"
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
