import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('侧栏启动器重启本副本全部旧服务，核对新PID和协议后打开实际地址', {
  skip: process.platform !== 'win32',
}, (t) => {
  // 在另一份含空格的目录运行；关闭进程、启动和网络均替换为桩，不影响真实服务。
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bga launcher branch ')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(new URL('../scripts/bga-live.ps1', import.meta.url), path.join(root, 'scripts', 'bga-live.ps1'));
  const harness = `
$ErrorActionPreference = 'Stop'
$global:projectRoot = '${root.replaceAll("'", "''")}'
function Get-Command { param($Name, $ErrorAction) @{ Source = 'stub-node' } }
function Get-NetTCPConnection {
  param($State, $ErrorAction)
  foreach ($p in $global:ports) {
    [pscustomobject]@{ LocalPort=$p; LocalAddress='127.0.0.1'; OwningProcess=($p + 100000) }
  }
  if ($global:newPort) {
    [pscustomobject]@{ LocalPort=$global:newPort; LocalAddress='127.0.0.1'; OwningProcess=999 }
  }
}
function Get-CimInstance {
  param($ClassName, $Filter)
  if ($Filter -like 'ProcessId=*') {
    $id = [int]($Filter -replace 'ProcessId=', '')
    $item = $global:processes | Where-Object { $_.ProcessId -eq $id }
    if ($global:scenario.changed) { return @{ CommandLine='changed'; CreationDate=2 } }
    return $item
  }
  return $global:processes
}
function Stop-Process {
  param($Id, $ErrorAction)
  if ($global:scenario.stopFailure) { throw 'STOP_FAILED' }
  $global:stopped += $Id
  $global:ports = @($global:ports | Where-Object { ($_ + 100000) -ne $Id })
}
function Wait-Process { param($Id, $Timeout, $ErrorAction) }
function Start-Sleep { param($Milliseconds) }
function Invoke-RestMethod {
  param($Uri, $TimeoutSec)
  $port = ([uri]$Uri).Port
  $workspace = if ($global:scenario.other -contains $port) { 'other-branch' } else { $global:projectRoot }
  if ($Uri.EndsWith('/state')) { return @{ format='whitecastle-bga-live-status'; workspaceRoot=$workspace } }
  $version = if ($global:scenario.badVersion) { 5 } else { 6 }
  return @{ extensionPath=(Join-Path $global:projectRoot 'browser-extension/bga-live'); adviceVersion=$version }
}
function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru)
  if ($FilePath -eq 'stub-node') {
    $global:started += $ArgumentList
    if ($WorkingDirectory -ne $global:projectRoot -or $WindowStyle -ne 'Hidden' -or -not $PassThru) {
      throw 'WRONG_LAUNCH'
    }
    $global:newPort = [int]($ArgumentList -replace '^.*" ', '')
    if ($global:scenario.wrongPid) { return @{Id=998} }
    return @{Id=999}
  }
  $global:opened += $FilePath
}
$cases = @(
  @{ name='allOld'; ports=@(4180,4182,4250); owned=@(4180,4182,4250); expected=4180; stops=3 },
  @{ name='relative'; ports=@(4180); relative=@(4180); expected=4180; stops=1 },
  @{ name='otherBranch'; ports=@(4180); relative=@(4180); other=@(4180); expected=4182; stops=0 },
  @{ name='otherAbsolute'; ports=@(4180); foreign=@(4180); expected=4182; stops=0 },
  @{ name='nonHttp'; ports=@(4180); expected=4182; stops=0 },
  @{ name='training'; ports=@(4180); training=@(4180); expected=4182; stops=0 },
  @{ name='blocked'; ports=@(4190); initial=4190; expected=4192; stops=0 },
  @{ name='custom'; ports=@(4180); owned=@(4180); initial=4210; expected=4210; stops=1 },
  @{ name='stopFailure'; ports=@(4180); owned=@(4180); stopFailure=$true; error='STOP_FAILED'; stops=0 },
  @{ name='changed'; ports=@(4180); owned=@(4180); changed=$true; error='BGA_LIVE_PROCESS_CHANGED'; stops=0 },
  @{ name='wrongPid'; ports=@(); wrongPid=$true; error='BGA_LIVE_START_FAILED'; stops=0 },
  @{ name='badVersion'; ports=@(); badVersion=$true; error='BGA_LIVE_START_FAILED'; stops=0 },
  @{ name='full'; ports=@(4180,4182,4184,4186,4188,4192,4194,4196,4198,4200);
     error='BGA_LIVE_NO_AVAILABLE_PORT'; stops=0 },
  @{ name='lastFree'; ports=@(); initial=65535; expected=65535; stops=0 },
  @{ name='lastTaken'; ports=@(65535); initial=65535; error='BGA_LIVE_NO_AVAILABLE_PORT'; stops=0 }
)
$results = foreach ($global:scenario in $cases) {
  $global:ports = @($global:scenario.ports)
  $global:stopped = @()
  $global:started = @()
  $global:opened = @()
  $global:newPort = $null
  $global:processes = @(
    foreach ($p in $global:ports) {
      $script = if ($global:scenario.owned -contains $p) { Join-Path $global:projectRoot 'scripts/serve-bga-live.mjs' }
        elseif ($global:scenario.relative -contains $p) { 'scripts/serve-bga-live.mjs' }
        elseif ($global:scenario.foreign -contains $p) { 'C:\\other-branch\\scripts\\serve-bga-live.mjs' }
        elseif ($global:scenario.training -contains $p) { Join-Path $global:projectRoot 'scripts/ai-env-server.mjs' }
        else { 'C:\\other-server.js' }
      [pscustomobject]@{ ProcessId=($p + 100000); CommandLine=('"C:\\Program Files\\nodejs\\node.exe" "' + $script + '" ' + $p); CreationDate=1 }
    }
  )
  $failure = $null
  $initial = if ($global:scenario.initial) { $global:scenario.initial } else { 4180 }
  try { & (Join-Path $global:projectRoot 'scripts/bga-live.ps1') -Port $initial }
  catch { $failure = $_.Exception.Message }
  if ($failure -ne $global:scenario.error) { throw "Unexpected error in $($global:scenario.name): $failure" }
  if ($global:stopped.Count -ne $global:scenario.stops) { throw "WRONG_STOP_COUNT $($global:scenario.name)" }
  if ($global:scenario.expected) {
    if ($global:started.Count -ne 1 -or $global:opened.Count -ne 1 -or $global:opened[0] -ne "http://127.0.0.1:$($global:scenario.expected)") {
      throw "WRONG_OPENED_ADDRESS $($global:scenario.name)"
    }
  } elseif ($global:opened.Count) { throw 'OPENED_ON_FAILURE' }
  [pscustomobject]@{ name=$global:scenario.name; passed=$true }
}
$results | ConvertTo-Json -Compress
`;
  const file = path.join(root, 'harness.ps1');
  fs.writeFileSync(file, harness, 'utf8');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
    encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).length, 15);
  const launcher = fs.readFileSync(new URL('../打开BGA侧栏.cmd', import.meta.url), 'utf8');
  assert.ok(launcher.includes('"%~dp0scripts\\bga-live.ps1" %*'));
  assert.ok(launcher.includes('exit /b %BGA_EXIT_CODE%'));
});
