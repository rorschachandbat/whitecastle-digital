param(
    [ValidateSet('Start', 'Stop', 'Status')]
    [string]$Action = 'Start',
    [string]$Config = '',
    [string]$OutputDirectory = '',
    [int]$Generations = 0
)

$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (!$Config) { $Config = Join-Path $taskRoot 'data/ai-training-loop.json' }
if (!$OutputDirectory) { $OutputDirectory = Join-Path $taskRoot '.local/ai/continuous-r6' }
$Config = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Config)
$OutputDirectory = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
$taskPython = Join-Path $taskRoot '.local/ai-venv/Scripts/python.exe'
$taskLoop = Join-Path $PSScriptRoot 'train-loop.py'
$taskStop = Join-Path $OutputDirectory 'STOP'
$taskState = Join-Path $OutputDirectory 'loop-state.json'

if ($Action -eq 'Status') {
    if (Test-Path -LiteralPath $taskState) {
        Get-Content -LiteralPath $taskState -Raw
    } else {
        Write-Output 'AI_LOOP_NOT_STARTED'
    }
    return
}
if ($Action -eq 'Stop') {
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    Set-Content -LiteralPath $taskStop -Value 'stop-after-current-game' -Encoding utf8
    Write-Output 'AI_LOOP_STOP_REQUESTED'
    return
}

if (!(Test-Path -LiteralPath $taskPython)) { throw 'AI_PYTHON_ENVIRONMENT_MISSING' }
if (!(Test-Path -LiteralPath $Config)) { throw 'AI_CONFIG_MISSING' }
if ($Generations -lt 0) { throw 'AI_BAD_GENERATIONS' }
# 仅清除调用方指定目录中的停止标记；操作系统文件锁阻止重复启动。
if (Test-Path -LiteralPath $taskStop) { Remove-Item -LiteralPath $taskStop }
Push-Location $taskRoot
try {
    & $taskPython $taskLoop --config $Config --out-dir $OutputDirectory --generations $Generations
    if ($LASTEXITCODE -ne 0) { throw "AI_LOOP_EXIT:$LASTEXITCODE" }
} finally {
    Pop-Location
}
