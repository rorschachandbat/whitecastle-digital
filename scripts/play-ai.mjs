import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { canonicalCatalog } from '../src/data/catalog.js';
import { TrainingEnvironment } from '../src/ai/environment.js';
import { playOpponentSeat } from '../src/ai/playOpponent.js';
import { activeLocalPlayer, exportLocalMatch } from '../src/engine/localMatch.js';
import { restoreLocalClient, submitLocalAction } from '../src/game/localClient.js';
import { loadTrainingConfig, projectRoot } from './ai-common.mjs';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

export function championGeneration(value) {
  const parts = String(value ?? '').replaceAll('\\', '/').split('/').filter(Boolean);
  const folder = parts.at(-1) === 'candidate.pt' ? parts.at(-2) : null;
  return /^generation-\d{5}$/.test(folder ?? '') ? folder : null;
}

export function sameMeta(actual, expected) {
  return Boolean(expected && actual && Object.keys(expected).every((key) => actual[key] === expected[key]));
}

/** 只描述能否使用冠军，不回传路径、进程号或权重。 */
export function describeChampion({ state, checkpointExists, pythonExists, meta, catalogMatches, running = false }) {
  const generation = championGeneration(state?.champion);
  const base = { generation, method: 'policy-only', source: 'continuous-champion', running: Boolean(running) };
  if (!state || !generation || !checkpointExists) return { ...base, status: 'unavailable', code: 'AI_NOT_AVAILABLE' };
  if (!pythonExists) return { ...base, status: 'unavailable', code: 'AI_PYTHON_UNAVAILABLE' };
  if (!sameMeta(state.meta, meta)) return { ...base, status: 'incompatible', code: 'AI_MODEL_CONFIG_MISMATCH' };
  if (!catalogMatches) return { ...base, status: 'catalog-mismatch', code: 'AI_REPLAY_CONFIG_MISMATCH' };
  return { ...base, status: 'available', profile: meta.profile };
}

export async function resolvePython(root, configured) {
  if (configured) return path.resolve(root, configured);
  const windowsPython = path.join(root, '.local/ai-venv/Scripts/python.exe');
  const unixPython = path.join(root, '.local/ai-venv/bin/python');
  try {
    await fs.access(windowsPython);
    return windowsPython;
  } catch {
    return unixPython;
  }
}

function generationNumber(generation) {
  return Number(String(generation ?? '').replace('generation-', ''));
}

export function createPlayAi({ root = projectRoot, inferModel, settings: injectedSettings } = {}) {
  let settings;
  let parameters;
  let worker;
  let inferQueue = Promise.resolve();
  const config = async () => {
    settings ??= injectedSettings ?? JSON.parse(await fs.readFile(path.join(root, 'data/bga-live-ai.json'), 'utf8'));
    parameters ??= loadTrainingConfig(
      path.join(root, 'data/whitecastle-2p.json'),
      path.join(root, 'data/ai-heuristic.json'),
    );
    return { ...settings, loop: path.resolve(root, settings.loopDirectory), ...parameters };
  };
  async function status(catalog) {
    try {
      const current = await config();
      const state = JSON.parse(await fs.readFile(path.join(current.loop, 'loop-state.json'), 'utf8'));
      const generation = championGeneration(state.champion);
      let checkpointExists = false;
      if (generation) {
        try {
          await fs.access(path.join(current.loop, generation, 'candidate.pt'));
          checkpointExists = true;
        } catch { /* 缺少检查点时只报告不可用。 */ }
      }
      const python = await resolvePython(root, current.python);
      let pythonExists = false;
      try { await fs.access(python); pythonExists = true; } catch { /* 环境缺失由状态码说明。 */ }
      let running = false;
      if (Number.isInteger(state.pid)) {
        try {
          process.kill(state.pid, 0);
          running = Date.now() / 1000 - Number(state.updatedAt) < 600;
        } catch { /* 训练进程不存在时不影响只读推理。 */ }
      }
      return describeChampion({
        state, checkpointExists, pythonExists, meta: current.meta, running,
        catalogMatches: catalog ? canonicalCatalog(catalog) === canonicalCatalog(current.catalog) : true,
      });
    } catch {
      return { status: 'unavailable', code: 'AI_NOT_AVAILABLE', method: 'policy-only', source: 'continuous-champion', generation: null, running: false };
    }
  }
  async function closeWorker() {
    const current = worker;
    worker = null;
    await current?.close();
  }
  async function ensureWorker(generation) {
    if (worker?.generation === generation) return worker;
    await closeWorker();
    const current = await config();
    const python = await resolvePython(root, current.python);
    worker = await createChampionWorker({
      root, python, loop: current.loop, generation,
      timeoutMilliseconds: Math.max(Number(current.timeoutMilliseconds) || 30000, 60000),
    });
    return worker;
  }
  async function inferNow(generation, observation) {
    if (inferModel) return inferModel(observation, generation);
    try {
      const current = await ensureWorker(generation);
      return await current.infer({
        meta: (await config()).meta,
        observation: { state: observation.state, candidates: observation.candidates },
      });
    } catch (error) {
      await closeWorker();
      throw error;
    }
  }
  function infer(generation, observation) {
    const run = inferQueue.then(() => inferNow(generation, observation), () => inferNow(generation, observation));
    inferQueue = run.then(() => {}, () => {});
    return run;
  }
  async function assignSeat(session, seat) {
    if (seat === null) {
      session.aiSeat = null;
      session.aiPaused = false;
      session.aiGeneration = null;
      return { seat: null, generation: null };
    }
    if (seat !== '0' && seat !== '1') fail('AI_SEAT_INVALID');
    const availability = await status(session.client.getState().G.catalog);
    if (availability.status !== 'available') fail(availability.code ?? 'AI_NOT_AVAILABLE');
    session.aiSeat = seat;
    session.aiPaused = false;
    session.aiGeneration = availability.generation;
    return { seat, generation: availability.generation };
  }
  async function play(session) {
    if (!session.aiSeat) return { played: 0, reason: 'not-enabled', method: 'policy-only' };
    if (session.aiPaused) return { played: 0, reason: 'paused', method: 'policy-only', generation: session.aiGeneration };
    const match = session.client.getState().G;
    if (match.phase === 'finished') return { played: 0, reason: 'finished', method: 'policy-only', generation: session.aiGeneration };
    if (activeLocalPlayer(match) !== session.aiSeat) return { played: 0, reason: 'human-turn', method: 'policy-only', generation: session.aiGeneration };
    const current = await config();
    if (canonicalCatalog(match.catalog) !== canonicalCatalog(current.catalog)) fail('AI_REPLAY_CONFIG_MISMATCH');
    if (!session.aiGeneration) fail('AI_CHAMPION_INVALID');
    const environment = new TrainingEnvironment(current.catalog, current.weights);
    environment.restore(exportLocalMatch(match));
    const result = await playOpponentSeat(environment, (observation) => infer(session.aiGeneration, observation), {
      seat: session.aiSeat, generation: session.aiGeneration,
    });
    if (result.model && result.model !== session.aiGeneration) fail('AI_CHAMPION_CHANGED');
    const before = exportLocalMatch(match);
    try {
      for (const action of result.actions) submitLocalAction(session.client, action);
    } catch (error) {
      const replacement = restoreLocalClient(before);
      session.client.stop();
      session.client = replacement;
      throw error;
    }
    return {
      played: result.actions.length, decisions: result.decisions, bounded: result.bounded,
      generation: session.aiGeneration, generationNumber: generationNumber(session.aiGeneration),
      method: 'policy-only', reason: result.bounded ? 'bounded' : (result.done ? 'finished' : 'human-turn'),
    };
  }
  return { status, assignSeat, play, close: closeWorker };
}

export function createChampionWorker({ root, python, loop, generation, timeoutMilliseconds }) {
  if (!/^generation-\d{5}$/.test(generation)) fail('AI_CHAMPION_INVALID');
  const child = spawn(python, [
    path.join(root, 'scripts/infer-live.py'), '--loop', loop, '--generation', generation, '--stream',
  ], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let pending = null;
  let failure = null;
  let settled = false;
  const rejectPending = (code) => {
    failure = code;
    if (pending) {
      const request = pending;
      pending = null;
      clearTimeout(request.timer);
      request.reject(Object.assign(new Error(code), { code }));
    }
  };
  child.on('error', () => rejectPending('AI_PYTHON_UNAVAILABLE'));
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (output.length > 500_000) {
      rejectPending('AI_INFERENCE_FAILED');
      child.kill();
      return;
    }
    const newline = output.indexOf('\n');
    if (newline >= 0 && pending) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      const request = pending;
      pending = null;
      clearTimeout(request.timer);
      try {
        const result = JSON.parse(line);
        if (result.error) fail(result.error);
        request.resolve(result);
      } catch (error) {
        request.reject(error);
      }
    }
  });
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  child.on('close', () => {
    settled = true;
    rejectPending(failure ?? 'AI_INFERENCE_FAILED');
  });
  return {
    generation,
    infer: (request) => new Promise((resolve, reject) => {
      if (failure || settled) {
        reject(Object.assign(new Error(failure ?? 'AI_INFERENCE_FAILED'), { code: failure ?? 'AI_INFERENCE_FAILED' }));
        return;
      }
      const timer = setTimeout(() => {
        rejectPending('AI_INFERENCE_TIMEOUT');
        child.kill();
      }, timeoutMilliseconds);
      pending = { resolve, reject, timer };
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }),
    close: () => {
      if (pending) clearTimeout(pending.timer);
      child.stdin.end();
      if (!settled) child.kill();
    },
  };
}
