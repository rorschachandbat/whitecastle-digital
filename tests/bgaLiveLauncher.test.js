import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('侧栏启动器优先复用兼容服务，保留其他副本并避开非HTTP占用和禁用端口', {
  skip: process.platform !== 'win32',
}, (t) => {
  // 在另一份含空格的目录运行配套脚本，所有进程和网络操作均替换为桩。
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
  foreach ($p in $global:scenario.ports) { [pscustomobject]@{ LocalPort = $p } }
}
function Invoke-RestMethod {
  param($Uri, $TimeoutSec)
  $port = ([uri]$Uri).Port
  if ($global:scenario.nonHttp -contains $port) { throw 'NOT_HTTP' }
  if ($Uri.EndsWith('/state')) {
    return @{ format = 'whitecastle-bga-live-status'; workspaceRoot = $global:projectRoot }
  }
  $extension = Join-Path $global:projectRoot 'browser-extension/bga-live'
  if ($global:scenario.other -contains $port) { $extension = 'other-worktree' }
  $version = if ($global:scenario.old -contains $port) { 5 } else { 6 }
  return @{ extensionPath = $extension; adviceVersion = $version }
}
function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError)
  if ($FilePath -eq 'stub-node') {
    $global:started += $ArgumentList
    if ($WorkingDirectory -ne $global:projectRoot -or $WindowStyle -ne 'Hidden') {
      throw "WRONG_LAUNCH $WorkingDirectory $WindowStyle expected $global:projectRoot"
    }
  } else { $global:opened += $FilePath }
}
$cases = @(
  @{ name='reuse'; ports=@(4192); expected='http://127.0.0.1:4192'; count=0 },
  @{ name='other'; ports=@(4180,4182); old=@(4180); other=@(4182); expected='http://127.0.0.1:4184'; count=1 },
  @{ name='nonHttp'; ports=@(4180); nonHttp=@(4180); expected='http://127.0.0.1:4182'; count=1 },
  @{ name='blocked'; ports=@(4190); initial=4190; expected='http://127.0.0.1:4192'; count=1 },
  @{ name='full'; ports=@(4180,4182,4184,4186,4188,4192,4194,4196,4198,4200);
     old=@(4180,4182,4184,4186,4188,4192,4194,4196,4198,4200); error='BGA_LIVE_NO_AVAILABLE_PORT'; count=0 },
  @{ name='lastFree'; ports=@(); initial=65535; expected='http://127.0.0.1:65535'; count=1 },
  @{ name='lastTaken'; ports=@(65535); old=@(65535); initial=65535; error='BGA_LIVE_NO_AVAILABLE_PORT'; count=0 }
)
$results = foreach ($global:scenario in $cases) {
  $global:started = @()
  $global:opened = @()
  $failure = $null
  $initial = if ($global:scenario.initial) { $global:scenario.initial } else { 4180 }
  try { & (Join-Path $global:projectRoot 'scripts/bga-live.ps1') -Port $initial }
  catch { $failure = $_.Exception.Message }
  if ($failure -ne $global:scenario.error) { throw "Unexpected error: $failure" }
  if ($global:started.Count -ne $global:scenario.count) { throw 'WRONG_START_COUNT' }
  if ($global:scenario.expected -and ($global:opened.Count -ne 1 -or $global:opened[0] -ne $global:scenario.expected)) {
    throw 'WRONG_OPENED_ADDRESS'
  }
  if ($global:scenario.error -and $global:opened.Count) { throw 'OPENED_ON_FAILURE' }
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
  assert.equal(JSON.parse(result.stdout).length, 7);
});
