import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareLiveAdvice } from '../src/integrations/bgaLiveAdvice.js';
import { preparePlayingAdvice, rememberLiveContext, getPlayingSession, publicObservations } from '../src/integrations/bgaLivePlaying.js';
import { prepareChainAdvice, describeLiveChoice, advancePublic } from '../src/integrations/bgaLiveChain.js';
import { loadTrainingConfig, projectRoot } from './ai-common.mjs';
import { FEATURE_VERSION } from '../src/ai/features.js';
import { adjustPolicyForLantern } from '../src/ai/lanternEffects.js';
import { createPlayAi, championGeneration } from './play-ai.mjs';

const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const modelLabel = (value) => String(value ?? '').replaceAll('\\', '/').split('/').at(-2) ?? null;
const sameMeta = (a, b) => Object.keys(b).every((key) => a?.[key] === b[key]);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

/** 配置和权重都相对当前副本；按用户选择读取持续训练冠军。 */
export function createLiveAi({ root = projectRoot, inferModel } = {}) {
  let settings;
  let parameters;
  const registry = createPlayAi({ root });
  const contexts = new Map();
  let contextQueue = Promise.resolve();
  const config = async (modelId) => {
    settings ??= await read(path.join(root, 'data/bga-live-ai.json'));
    parameters ??= loadTrainingConfig(path.join(root, 'data/whitecastle-2p.json'), path.join(root, 'data/ai-heuristic.json'));
    if (modelId !== undefined && !/^r\d+$/.test(modelId)) fail('AI_MODEL_INVALID');
    return { ...settings, loop: modelId === undefined ? path.resolve(root, settings.loopDirectory)
      : path.join(root, '.local/ai', `continuous-${modelId}`),
    modelId: modelId ?? path.basename(settings.loopDirectory).replace(/^continuous-/, ''), ...parameters };
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
    let applicable = context;
    if (context?.seenAt > Date.parse(latest.changedAt ?? latest.receivedAt)) {
      // 历史文件只复用当时已公开的开局事实，后采样的牌面和根行动不能倒灌。
      applicable = context.opening ? rememberLiveContext(null, context.opening, { ...c, mapping }) : null;
      applicable = rememberLiveContext(applicable, latest, { ...c, mapping });
    }
    return { ...c, mapping, context: applicable };
  }
  async function models(modelId) {
    return registry.status(undefined, modelId);
  }
  async function trainingStatus(modelId) {
    try {
      const { loop, meta, modelId: selectedModel } = await config(modelId);
      const state = await read(path.join(loop, 'loop-state.json'));
      let running = false;
      try { process.kill(state.pid, 0); running = Date.now() / 1000 - state.updatedAt < 600; } catch {}
      const champion = modelLabel(state.champion);
      let summary = null;
      if (/^generation-\d+$/.test(champion ?? '')) {
        try { summary = (await read(path.join(loop, champion, 'evaluation.json'))).summary?.guide ?? null; } catch {}
      }
      const expected = Object.fromEntries(Object.entries(meta).filter(([key]) => key !== 'setupVersion'));
      return { status: sameMeta(state.meta, expected) ? 'available' : 'incompatible', modelId: selectedModel,
        legacySetup: state.meta?.setupVersion !== meta.setupVersion,
        profile: state.meta?.profile, running, generation: state.generation, phase: state.phase,
        completedSelfplayGames: state.completedSelfplayGames, champion, latest: modelLabel(state.latest),
        updatedAt: state.updatedAt, guideEvaluation: summary && { wins: summary.wins, games: summary.games,
          averageMargin: summary.averageMargin }, modelSource: 'continuous-champion' };
    } catch { return { status: 'unavailable', modelSource: 'continuous-champion' }; }
  }
  async function analyze(latest, { modelId } = {}) {
    let prepared;
    let worker;
    try {
      const c = { ...await observe(latest), ...await config(modelId) };
      try { prepared = prepareLiveAdvice(latest, c); }
      catch (error) {
        if (error.code !== 'BGA_ADVICE_PHASE') throw error;
        try { prepared = preparePlayingAdvice(latest, c); }
        catch (playingError) {
          if (playingError.code !== 'BGA_ADVICE_PHASE') throw playingError;
          prepared = prepareChainAdvice(latest, c);
        }
      }
      const state = await read(path.join(c.loop, 'loop-state.json'));
      const legacySetup = state.meta?.setupVersion !== c.meta.setupVersion;
      const featureCompat = state.meta?.featureVersion !== FEATURE_VERSION;
      const ignored = new Set(['setupVersion', ...(featureCompat ? ['featureVersion', 'encoderHash'] : [])]);
      const expected = Object.fromEntries(Object.entries(c.meta).filter(([key]) => !ignored.has(key)));
      if (!sameMeta(state.meta, expected)) fail('AI_MODEL_CONFIG_MISMATCH');
      c.generation = championGeneration(state.champion);
      c.legacySetup = legacySetup;
      c.featureCompat = featureCompat;
      if (!c.generation) fail('AI_CHAMPION_INVALID');
      worker = inferModel ? null : await inferenceSession(c);
      const infer = async (observation, observations) => {
        const result = inferModel ? await inferModel(observation, c)
          : await worker.infer({ meta: c.meta, observation, observations });
        if (result.source !== 'continuous-champion' || !(result.model === 'initial' || /^generation-\d+$/.test(result.model))
        || result.policy?.length !== observation.candidates.length
        || result.policy.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
        || Math.abs(result.policy.reduce((sum, value) => sum + value, 0) - 1) > 0.0001) fail('AI_INVALID_POLICY');
        if (result.model !== c.generation) fail('AI_CHAMPION_CHANGED');
        return result;
      };
      const session = getPlayingSession(prepared);
      if (c.featureCompat && session) {
        session.env.lanternExpansion = false;
        prepared = { ...prepared, observation: session.env.observe(),
          observations: publicObservations(session.env, session.uncertainPriority) };
      }
      const result = await infer(prepared.observation, prepared.observations);
      const adjust = (policy, env) => c.featureCompat ? adjustPolicyForLantern(policy, env, c.weights) : policy;
      let plan = null;
      let rootPolicy = result.policy;
      if (session) {
        const { env, uncertainPriority } = session;
        rootPolicy = adjust(result.policy, env);
        let index = rootPolicy.indexOf(Math.max(...rootPolicy));
        plan = { rootIndex: index, steps: [], boundary: 'complete' };
        for (let count = 0; count < 32; count += 1) {
          if (!advancePublic(env, index)) { plan.boundary = 'unknown-reveal'; break; }
          if (!env.pending) break;
          const observation = env.observe();
          const next = await infer(observation, publicObservations(env, uncertainPriority));
          if (next.model !== result.model) fail('AI_CHAMPION_CHANGED');
          const adjusted = adjust(next.policy, env);
          index = adjusted.indexOf(Math.max(...adjusted));
          plan.steps.push({ ...describeLiveChoice(env, env.getLegalActions()[index], latest.archive.publicPosition),
            policyWeight: adjusted[index] });
          if (count === 31) plan.boundary = 'decision-limit';
        }
      }
      return { status: 'ready', actor: prepared.actor, scope: prepared.scope,
        modelId: c.modelId, legacySetup: c.legacySetup, lanternAdjusted: c.featureCompat,
        model: result.model, source: result.source, method: 'policy-only',
        plan, uncertainties: prepared.uncertainties ?? [],
        candidates: prepared.candidates.map((candidate, index) => ({ ...candidate, policyWeight: rootPolicy[index] }))
          .sort((a, b) => b.policyWeight - a.policyWeight) };
    } catch (error) {
      return { status: String(error.code ?? '').startsWith('BGA_') ? 'unsupported' : 'error',
        code: error.code ?? 'AI_INFERENCE_FAILED', source: 'continuous-champion' };
    } finally { worker?.close(); }
  }
  async function inferenceSession(c) {
    const windowsPython = path.join(root, '.local/ai-venv/Scripts/python.exe');
    const unixPython = path.join(root, '.local/ai-venv/bin/python');
    const python = c.python ? path.resolve(root, c.python)
      : await fs.access(windowsPython).then(() => windowsPython).catch(() => unixPython);
    const child = spawn(python, [path.join(root, 'scripts/infer-live.py'), '--loop', c.loop,
      '--generation', c.generation, '--stream', ...(c.legacySetup ? ['--allow-legacy-setup'] : []),
      ...(c.featureCompat ? ['--allow-feature-compat'] : [])],
      { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let pending = null;
    let failure = null;
    const rejectPending = (code) => {
      failure = code;
      if (pending) { pending.reject(Object.assign(new Error(code), { code })); pending = null; }
    };
    // 每次分析只加载一次冠军，所有连锁步骤共用该进程；总超时仍有上限。
    const timer = setTimeout(() => { rejectPending('AI_INFERENCE_TIMEOUT'); child.kill(); }, c.timeoutMilliseconds);
    child.on('error', () => { clearTimeout(timer); rejectPending('AI_PYTHON_UNAVAILABLE'); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 500_000) { rejectPending('AI_INFERENCE_FAILED'); child.kill(); return; }
      const newline = output.indexOf('\n');
      if (newline >= 0 && pending) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        const request = pending;
        pending = null;
        try {
          const result = JSON.parse(line);
          if (result.error) fail(result.error);
          request.resolve(result);
        } catch (error) { request.reject(error); }
      }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('close', () => {
      clearTimeout(timer);
      rejectPending(failure ?? 'AI_INFERENCE_FAILED');
    });
    return {
      infer: (request) => new Promise((resolve, reject) => {
        if (failure) { reject(Object.assign(new Error(failure), { code: failure })); return; }
        pending = { resolve, reject };
        child.stdin.write(`${JSON.stringify(request)}\n`);
      }),
      close: () => { clearTimeout(timer); child.stdin.end(); },
    };
  }
  return { analyze, observe, trainingStatus, models };
}
