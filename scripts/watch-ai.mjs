import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { text } from '../src/ui/StringTable.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  directory: { type: 'string' },
  log: { type: 'string' },
  'error-log': { type: 'string' },
  interval: { type: 'string', default: '2' },
  once: { type: 'boolean', default: false },
  raw: { type: 'boolean', default: false },
} });
const interval = Number(values.interval);
if (!Number.isFinite(interval) || interval < 1 || interval > 60) throw new Error('AI_BAD_REFRESH_INTERVAL');
const defaults = values.directory ? null
  : JSON.parse(await fs.readFile(path.join(root, 'data/bga-live-ai.json'), 'utf8'));
const directory = values.directory ? path.resolve(values.directory) : path.resolve(root, defaults.loopDirectory);
const model = path.basename(directory).replace(/^continuous-/, '');
const stateFile = path.join(directory, 'loop-state.json');
const logFile = values.log ? path.resolve(values.log) : path.join(path.dirname(directory), `train-${model}.stdout.log`);
const errorFile = values['error-log'] ? path.resolve(values['error-log'])
  : path.join(path.dirname(directory), `train-${model}.stderr.log`);
const phases = { selfplay: 'live.phase.selfplay', evaluation: 'live.phase.evaluation',
  warmup: 'live.phase.warmup', initializing: 'live.phase.warmup', stopped: 'live.phase.stopped' };
let lastState = null;
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

/** 仅从文件尾读取，避免长期训练日志增长后每次刷新都读取整个文件。 */
async function tail(file, limit = 131072) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const size = (await handle.stat()).size;
    const offset = Math.max(0, size - limit);
    const buffer = Buffer.alloc(Math.min(size, limit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    const lines = content.split(/\r?\n/);
    if (offset) lines.shift();
    // 正在写入的最后一行留到下次刷新，避免把半条JSON显示为损坏日志。
    if (!content.endsWith('\n')) lines.pop();
    return lines.filter((line) => line.trim());
  } catch (error) {
    return error.code === 'ENOENT' ? [] : [text('trainingLog.readError', { message: error.message })];
  } finally { await handle?.close(); }
}

function number(value, digits = 0) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

async function render() {
  let stale = false;
  try {
    lastState = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  } catch { stale = true; }
  const state = lastState;
  const [logs, errors] = await Promise.all([tail(logFile), tail(errorFile, 8192)]);
  const rows = logs.flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return row.phase === 'selfplay' && row.scores && Array.isArray(row.learnerSeats) ? [row] : [];
    } catch { return []; }
  }).slice(-10);
  const output = [text('trainingLog.title', { model }), text('trainingLog.refresh', {
    time: new Date().toLocaleString('zh-CN'), seconds: interval,
  }), ''];
  if (state) {
    let running = false;
    if (Number.isInteger(state.pid) && state.pid > 0) {
      try { process.kill(state.pid, 0); running = true; } catch { /* 状态文件不代表进程仍然存活。 */ }
    }
    output.push(text('trainingLog.status', {
      phase: phases[state.phase] ? text(phases[state.phase]) : state.phase ?? '—',
      running: text(running ? 'live.trainingRunning' : 'live.trainingIdle'),
      generation: state.generation ?? 0, games: state.completedSelfplayGames ?? 0,
    }));
    const stats = state.scoreStats;
    if (stats?.count > 0) {
      output.push(text('trainingLog.scores', {
        average: number(stats.total / stats.count, 2), maximum: number(stats.max), count: stats.count,
        sixty: number(100 * stats.atLeast60 / stats.count, 1),
        eighty: number(100 * stats.atLeast80 / stats.count, 1),
      }));
    } else output.push(text('trainingLog.noScores'));
    const updated = Number(state.updatedAt);
    output.push(text('trainingLog.updated', {
      time: Number.isFinite(updated) ? new Date(updated * 1000).toLocaleString('zh-CN') : '—',
    }));
    if (state.error) output.push(text('trainingLog.failure', { message: state.error }));
  } else output.push(text('trainingLog.waiting'));
  if (stale) output.push(text('trainingLog.stale'));
  if (values.raw) {
    output.push('', text('trainingLog.raw'), ...(logs.length ? logs.slice(-10) : [text('trainingLog.noRecords')]));
  } else {
    output.push('', text('trainingLog.recent'));
    if (!rows.length) output.push(text('trainingLog.noRecords'));
    for (const row of rows) {
      output.push(text('trainingLog.row', {
        seats: row.learnerSeats.join('/'),
        own: row.learnerSeats.map((seat) => `${seat}=${row.scores[seat]}`).join(' / '),
        scores: Object.entries(row.scores).map(([seat, score]) => `${seat}=${score}`).join(' / '),
        nodes: row.searchNodes ?? 0,
      }));
    }
  }
  output.push('', text('trainingLog.errors'), ...(errors.length ? errors.slice(-5) : [text('trainingLog.noErrors')]));
  output.push('', text('trainingLog.scope'), text('trainingLog.note'),
    text('trainingLog.path', { file: stateFile }), text('trainingLog.path', { file: logFile }),
    text('trainingLog.path', { file: errorFile }));
  if (process.stdout.isTTY && !values.once) process.stdout.write('\x1b[H\x1b[2J');
  process.stdout.write(`${output.join('\n')}\n`);
}

do {
  await render();
  if (values.once || stopping) break;
  // 短轮询使Ctrl+C能尽快退出查看，不向训练进程发送任何信号。
  for (let elapsed = 0; elapsed < interval * 1000 && !stopping; elapsed += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
} while (!stopping);
