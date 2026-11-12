import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareLiveAdvice } from '../src/integrations/bgaLiveAdvice.js';
import { preparePlayingAdvice, rememberLiveContext } from '../src/integrations/bgaLivePlaying.js';
import { loadTrainingConfig, projectRoot } from './ai-common.mjs';

const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const modelLabel = (value) => String(value ?? '').replaceAll('\\', '/').split('/').at(-2) ?? null;
const sameMeta = (a, b) => Object.keys(b).every((key) => a?.[key] === b[key]);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

/** 配置和权重都相对当前副本；实时分析只使用持续训练冠军，不切换到选牌微调权重。 */
export function createLiveAi({ root = projectRoot, inferModel } = {}) {
  let settings;
  let parameters;
  const contexts = new Map();
  let contextQueue = Promise.resolve();
  const config = async () => {
    settings ??= await read(path.join(root, 'data/bga-live-ai.json'));
    parameters ??= loadTrainingConfig(path.join(root, 'data/whitecastle-2p.json'), path.join(root, 'data/ai-heuristic.json'));
    return { ...settings, loop: path.resolve(root, settings.loopDirectory), ...parameters };
  };
  const observe = (latest) => {
    const task = contextQueue.then(() => observeContext(latest));
    contextQueue = task.catch(() => {});
    return task;
  };
  async function observeContext(latest) {
    const c = await config();
    const mapping = await read(path.join(root, 'data/bga-mapping.json'));
    const table = latest.source?.table;
    if (!/^\d+$/.test(table ?? '')) fail('BGA_ADVICE_MAPPING');
    const contextFile = path.join(root, '.local/bga-live/contexts', `${table}.json`);
    if (!contexts.has(table)) contexts.set(table, await read(contextFile).catch(() => null));
    const context = rememberLiveContext(contexts.get(table), latest, { ...c, mapping });
    if (context && JSON.stringify(context) !== JSON.stringify(contexts.get(table))) {
      await fs.mkdir(path.dirname(contextFile), { recursive: true });
      await fs.writeFile(`${contextFile}.tmp`, JSON.stringify(context));
      await fs.rename(`${contextFile}.tmp`, contextFile);
      contexts.set(table, context);
    }
    return { ...c, mapping, context };
  }
  async function trainingStatus() {
    try {
      const { loop, meta } = await config();
      const state = await read(path.join(loop, 'loop-state.json'));
      let running = false;
      try { process.kill(state.pid, 0); running = Date.now() / 1000 - state.updatedAt < 600; } catch {}
      const champion = modelLabel(state.champion);
      let summary = null;
      if (/^generation-\d+$/.test(champion ?? '')) {
        try { summary = (await read(path.join(loop, champion, 'evaluation.json'))).summary?.guide ?? null; } catch {}
      }
      return { status: sameMeta(state.meta, meta) ? 'available' : 'incompatible',
        profile: state.meta?.profile, running, generation: state.generation, phase: state.phase,
        completedSelfplayGames: state.completedSelfplayGames, champion, latest: modelLabel(state.latest),
        updatedAt: state.updatedAt, guideEvaluation: summary && { wins: summary.wins, games: summary.games,
          averageMargin: summary.averageMargin }, modelSource: 'continuous-champion' };
    } catch { return { status: 'unavailable', modelSource: 'continuous-champion' }; }
  }
  async function analyze(latest) {
    let prepared;
    try {
      const c = await observe(latest);
      try { prepared = prepareLiveAdvice(latest, c); }
      catch (error) {
        if (error.code !== 'BGA_ADVICE_PHASE') throw error;
        prepared = preparePlayingAdvice(latest, c);
      }
      const state = await read(path.join(c.loop, 'loop-state.json'));
      if (!sameMeta(state.meta, c.meta)) fail('AI_MODEL_CONFIG_MISMATCH');
      const result = inferModel ? await inferModel(prepared.observation, c)
        : await inferProcess(prepared.observation, c, prepared.observations);
      if (result.source !== 'continuous-champion' || !/^generation-\d+$/.test(result.model)
        || result.policy?.length !== prepared.candidates.length
        || result.policy.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
        || Math.abs(result.policy.reduce((sum, value) => sum + value, 0) - 1) > 0.0001) fail('AI_INVALID_POLICY');
      return { status: 'ready', actor: prepared.actor, scope: prepared.scope,
        model: result.model, source: result.source, method: 'policy-only',
        candidates: prepared.candidates.map((candidate, index) => ({ ...candidate, policyWeight: result.policy[index] }))
          .sort((a, b) => b.policyWeight - a.policyWeight) };
    } catch (error) {
      return { status: String(error.code ?? '').startsWith('BGA_') ? 'unsupported' : 'error',
        code: error.code ?? 'AI_INFERENCE_FAILED', source: 'continuous-champion' };
    }
  }
  async function inferProcess(observation, c, observations) {
    const windowsPython = path.join(root, '.local/ai-venv/Scripts/python.exe');
    const unixPython = path.join(root, '.local/ai-venv/bin/python');
    const python = c.python ? path.resolve(root, c.python)
      : await fs.access(windowsPython).then(() => windowsPython).catch(() => unixPython);
    return new Promise((resolve, reject) => {
      const child = spawn(python, [path.join(root, 'scripts/infer-live.py'), '--loop', c.loop],
        { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, c.timeoutMilliseconds);
      child.on('error', () => { clearTimeout(timer); reject(Object.assign(new Error(), { code: 'AI_PYTHON_UNAVAILABLE' })); });
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.length > 500_000) child.kill();
      });
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          if (timedOut) fail('AI_INFERENCE_TIMEOUT');
          const result = JSON.parse(output);
          if (code !== 0 || result.error) fail(result.error ?? 'AI_INFERENCE_FAILED');
          resolve(result);
        } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify({ meta: c.meta, observation, observations }));
    });
  }
  return { analyze, observe, trainingStatus };
}
