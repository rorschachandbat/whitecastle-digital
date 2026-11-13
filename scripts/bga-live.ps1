param(
    [ValidateRange(1024, 65535)][int]$Port = 4180
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$nodeCommand = Get-Command node -ErrorAction Stop
$serverFile = Join-Path $PSScriptRoot 'serve-bga-live.mjs'
$runtimeFolder = Join-Path $projectRoot '.local/bga-live'
New-Item -ItemType Directory -Path $runtimeFolder -Force | Out-Null
$expectedExtension = Join-Path $projectRoot 'browser-extension/bga-live'

function Test-CurrentService {
    param([int]$ServicePort, [switch]$RequireCurrentVersion)
    try {
        $baseAddress = "http://127.0.0.1:$ServicePort"
        $probe = Invoke-RestMethod -Uri "$baseAddress/api/live/state" -TimeoutSec 2
        if ($probe.format -ne 'whitecastle-bga-live-status' -or $probe.workspaceRoot -ne $projectRoot) {
            return $false
        }
        if ($RequireCurrentVersion) {
            $config = Invoke-RestMethod -Uri "$baseAddress/api/live/config" -TimeoutSec 2
            if ($config.extensionPath -ne $expectedExtension -or $config.adviceVersion -ne 6) {
                return $false
            }
        }
        return $true
    } catch { return $false }
}

# 按副本路径加锁，连续双击时串行完成关闭、启动和地址验证。
$hasher = [Security.Cryptography.SHA256]::Create()
try {
    $identity = [BitConverter]::ToString($hasher.ComputeHash(
        [Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))).Replace('-', '')
} finally { $hasher.Dispose() }
$launchMutex = New-Object Threading.Mutex($false, "Local\WhitecastleBgaLive-$identity")
$locked = $false
try {
    try { $locked = $launchMutex.WaitOne(30000) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'BGA_LIVE_LAUNCH_BUSY' }

    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")
    foreach ($serviceProcess in $processes) {
        # 只检查直接运行侧栏脚本的 Node；训练及其他脚本不会进入停止候选。
        $invocation = [regex]::Match($serviceProcess.CommandLine,
            '^\s*(?:"[^"]+"|[^\s"]+)\s+(?:"(?<script>[^"]+)"|(?<script>[^\s"]+))(?:\s|$)')
        if (-not $invocation.Success) { continue }
        $invokedScript = $invocation.Groups['script'].Value.Replace('/', '\')
        $owned = $false
        if ([IO.Path]::IsPathRooted($invokedScript)) {
            $owned = [IO.Path]::GetFullPath($invokedScript) -eq $serverFile
        } elseif ($invokedScript -match '^(?:\.\\)?scripts\\serve-bga-live\.mjs$') {
            # 相对命令行没有工作目录；必须由该进程监听的 HTTP 服务核对副本。
            foreach ($listener in $listeners) {
                if ($listener.OwningProcess -eq $serviceProcess.ProcessId -and $listener.LocalAddress -eq '127.0.0.1' `
                    -and (Test-CurrentService -ServicePort $listener.LocalPort)) {
                    $owned = $true
                    break
                }
            }
        }
        if (-not $owned) { continue }
        # 停止前复核进程身份，避免枚举后 PID 被其他程序复用。
        $currentProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($serviceProcess.ProcessId)"
        if ($currentProcess.CommandLine -ne $serviceProcess.CommandLine `
            -or $currentProcess.CreationDate -ne $serviceProcess.CreationDate) {
            throw 'BGA_LIVE_PROCESS_CHANGED'
        }
        Stop-Process -Id $serviceProcess.ProcessId -ErrorAction Stop
        Wait-Process -Id $serviceProcess.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }

    $freePort = $null
    $candidatePort = $Port
    # 关闭操作结束后重新查询端口；无关程序占用的端口仍视为不可用。
    $occupiedPorts = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Select-Object -ExpandProperty LocalPort)
    for ($portAttempt = 0; $portAttempt -lt 10; $portAttempt++) {
        # 4190 是浏览器禁用端口，不能作为网页侧栏地址。
        if ($candidatePort -eq 4190) { $candidatePort += 2 }
        if ($candidatePort -gt 65535) { break }
        if ($occupiedPorts -notcontains $candidatePort) {
            $freePort = $candidatePort
            break
        }
        $candidatePort += 2
    }
    if ($null -eq $freePort) { throw 'BGA_LIVE_NO_AVAILABLE_PORT' }
    $Port = $freePort
    $address = "http://127.0.0.1:$Port"
    # 启动文件和日志都由当前副本位置推导，不依赖调用者工作目录。
    $arguments = '"' + $serverFile + '" ' + $Port
    $started = Start-Process -FilePath $nodeCommand.Source -ArgumentList $arguments -WorkingDirectory $projectRoot `
        -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeFolder "server-$Port.stdout.log") `
        -RedirectStandardError (Join-Path $runtimeFolder "server-$Port.stderr.log") -PassThru
    $running = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $newListener = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {
            $_.LocalPort -eq $Port -and $_.LocalAddress -eq '127.0.0.1' -and $_.OwningProcess -eq $started.Id
        })
        if ($newListener.Count -and (Test-CurrentService -ServicePort $Port -RequireCurrentVersion)) {
            $running = $true
            break
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $running) { throw 'BGA_LIVE_START_FAILED' }
    Start-Process $address
} finally {
    if ($locked) { $launchMutex.ReleaseMutex() }
    $launchMutex.Dispose()
}
