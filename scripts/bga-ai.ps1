param(
    [string]$Player = '',
    [ValidateSet('all', 'download', 'prepare', 'train', 'status')]
    [string]$Stage = 'all',
    [int]$Epochs = 4,
    [switch]$Refresh
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPython = Join-Path $taskRoot '.local/ai-venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $taskPython)) { throw 'AI_PYTHON_ENVIRONMENT_MISSING' }
if (!$Player) { $Player = Read-Host '请输入BGA玩家名称、ID或链接' }
$taskArguments = @('-u', (Join-Path $PSScriptRoot 'bga-workflow.py'), $Player, '--stage', $Stage, '--epochs', "$Epochs")
if ($Refresh) { $taskArguments += '--refresh' }
& $taskPython @taskArguments
if ($LASTEXITCODE -ne 0) { throw "BGA_WORKFLOW_EXIT:$LASTEXITCODE" }
