import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { TrainingEnvironment } from './environment.js';
import { probeLocalAction } from '../engine/actionOptions.js';
import { canonicalCatalog } from '../data/catalog.js';
import { evaluateHighScore, EVALUATOR_VERSION } from './highScore.js';

export const SEARCH_VERSION = 'public-high-score-rollout-v2';
export const TRAIN_SEARCH = Object.freeze({ width: 3, samples: 1, maxDecisions: 40, maxPlacements: 4 });
export const LIVE_SEARCH = Object.freeze({ width: 4, samples: 2, maxDecisions: 64, maxPlacements: 6 });
const keyOf = ({ action, value, orderIndex }) => canonicalCatalog({ action, value, orderIndex });

/** 实时服务把模拟放到工作线程，避免阻塞盘面心跳和其他网页请求。 */
export function searchRoutesAsync(env, policy, settings) {
  const source = { match: env.match, pending: env.pending, probe: env.probe, orderPrefix: env.orderPrefix,
    options: env.getLegalActions().map(({ action, value, orderIndex, prefix }) => ({ action, value, orderIndex, prefix })),
    weights: env.weights, lanternExpansion: env.lanternExpansion, legacyFeatureEncoding: env.legacyFeatureEncoding,
    publicInitialBridges: env.publicInitialBridges };
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./routeSearchWorker.js', import.meta.url), {
      workerData: { source, policy, settings }, execArgv: [],
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(Object.assign(new Error('AI_SEARCH_TIMEOUT'), { code: 'AI_SEARCH_TIMEOUT' }));
    }, Math.min(60000, settings?.timeoutMilliseconds ?? 60000));
    worker.once('message', (result) => {
      clearTimeout(timer);
      if (result.error) reject(Object.assign(new Error(result.error), { code: result.error }));
      else resolve(result);
    });
    worker.once('error', (error) => { clearTimeout(timer); reject(error); });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (code) reject(Object.assign(new Error('AI_SEARCH_FAILED'), { code: 'AI_SEARCH_FAILED' }));
    });
  });
}

function randomGenerator(seed) {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleDeck(deck, random, revealed = 0) {
  const prefix = deck.slice(0, revealed);
  // 先排序再抽样，使相同公开集合不会因实际隐藏顺序不同而改变搜索结果。
  const rest = deck.slice(revealed).sort();
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [...prefix, ...rest];
}

/** 独立抽样未来骰子和补牌；已经在当前连锁公开的牌保持原样。 */
export function samplePublicEnvironment(source, seed, priorityOrder) {
  const match = structuredClone(source.match);
  const random = randomGenerator(seed);
  match.seed = `search:${seed}`;
  match.options.seed = match.seed;
  if (priorityOrder && match.state) {
    // 公开快照未记录同格到达顺序时，以共同假设比较候选，不沿用任意重建顺序。
    for (const [index, actor] of ['0', '1'].entries()) match.state.players[actor].timePriority = priorityOrder[index];
  }
  const decks = match.state?.castleDecks ?? match.config.setup.castleDecks;
  for (const family of ['steward', 'diplomat']) {
    const visibleRemaining = source.probe?.request?.state?.castleDecks?.[family]?.length;
    const revealed = visibleRemaining === undefined ? 0 : Math.max(0, decks[family].length - visibleRemaining);
    decks[family] = sampleDeck(decks[family], random, revealed);
  }
  if (!match.state) {
    if (source.publicInitialBridges) match.config.setup.bridges = structuredClone(source.publicInitialBridges);
    match.draft.canonicalSignature = canonicalCatalog(match.config);
  }
  const branch = new TrainingEnvironment(source.catalog, source.weights, { maxDecisions: 2000 });
  branch.match = match;
  branch.pending = structuredClone(source.pending);
  branch.probe = branch.pending ? probeLocalAction(match, branch.pending) : null;
  branch.orderPrefix = [...source.orderPrefix];
  branch.decisions = 0;
  branch.options = null;
  branch.lanternExpansion = source.lanternExpansion;
  branch.legacyFeatureEncoding = source.legacyFeatureEncoding;
  branch.searchInitialBridges = Boolean(source.publicInitialBridges && !match.state);
  return branch;
}

function advance(branch, index) {
  const observation = branch.step(index);
  if (branch.searchInitialBridges && branch.match.state) {
    // 已公开的第一轮骰子只覆盖第一轮；下一轮仍使用独立机会抽样。
    delete branch.match.config.setup.bridges;
    branch.match.state.configSignature = canonicalCatalog(branch.match.config);
    branch.searchInitialBridges = false;
  }
  return observation;
}

/** 主线程固定提名、种子和任务顺序；串行与并行共用同一计划。 */
export function prepareRouteSearch(env, policy, settings = {}) {
  const config = { ...LIVE_SEARCH, ...settings };
  for (const [key, maximum] of Object.entries({ width: 16, samples: 8, maxDecisions: 300, maxPlacements: 18 })) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > maximum) throw new Error('AI_BAD_SEARCH_CONFIG');
  }
  const options = env.getLegalActions();
  if (!Array.isArray(policy) || policy.length !== options.length || !policy.every((p) => Number.isFinite(p) && p >= 0)
    || Math.abs(policy.reduce((a, b) => a + b, 0) - 1) > 0.001) throw new Error('AI_INVALID_POLICY');
  if (options.length === 1) return { single: true };
  const observation = env.observe();
  const byPolicy = policy.map((_, i) => i).sort((a, b) => policy[b] - policy[a]);
  const byGuide = policy.map((_, i) => i).sort((a, b) => observation.heuristic[b] - observation.heuristic[a]);
  const selected = [];
  // 策略与攻略交错提名，避免只搜索网络原本偏爱的路线。
  for (let i = 0; selected.length < Math.min(config.width, options.length); i += 1) {
    for (const index of [byPolicy[i], byGuide[i]]) {
      if (index !== undefined && !selected.includes(index) && selected.length < config.width) selected.push(index);
    }
  }
  const seed = String(config.seed ?? randomBytes(12).toString('hex'));
  const priorities = Object.values(env.match.state?.players ?? {}).map((player) => player.timePriority);
  const unresolvedPriority = config.uncertainPriority && priorities.length === 2
    && [...priorities, env.probe?.request?.player?.timePriority ?? 0].every((priority) => priority <= 2);
  return { config, policy, selected, targets: selected.map((index) => keyOf(options[index])), seed,
    actor: env.actor, rootRound: env.match.state?.round ?? 0, unresolvedPriority,
    firstPriority: randomGenerator(`${seed}:priority`)() < 0.5 ? 0 : 1 };
}

/** 每个候选/机会样本拥有独立状态，不能读取其他任务结果或真实隐藏顺序。 */
export function evaluateRouteSample(env, plan, sample, candidate) {
  const { config, seed, unresolvedPriority, firstPriority, actor, rootRound } = plan;
  const result = { candidate, nodes: 0, terminal: 0, cutoff: 0, failed: 0, unfinished: 0,
    maxRoundsAhead: 0, maxPlacementsAhead: 0, extendedDecisions: 0, score: null, potential: 0 };
  try {
    // 各候选使用同一机会样本，减少仅由骰运不同引起的比较噪声。
    const sampleSeed = `${seed}:${sample}`;
    const priorityOrder = unresolvedPriority ? [[1, 2], [2, 1]][(sample + firstPriority) % 2] : null;
    const branch = samplePublicEnvironment(env, sampleSeed, priorityOrder);
    const first = branch.getLegalActions().findIndex((option) => keyOf(option) === plan.targets[candidate]);
    if (first < 0) { result.failed = 1; return result; }
    const random = randomGenerator(`${sampleSeed}:continuation`);
    const initialActions = branch.match.actions.length;
    let placements = 0;
    let current = advance(branch, first);
    result.nodes += 1;
    // 预算只在完整动作边界截断；不能拿尚未提交的长连锁当成零收益。
    for (let step = 1; !current.done && step < config.maxDecisions + 160; step += 1) {
      placements = branch.match.actions.slice(initialActions).filter((action) => action.type === 'placeDie').length;
      if (!branch.pending && (placements >= config.maxPlacements || step >= config.maxDecisions)) break;
      if (step >= config.maxDecisions) result.extendedDecisions += 1;
      const ranking = current.heuristic.map((_, i) => i).sort((a, b) => current.heuristic[b] - current.heuristic[a]);
      // 小概率探索次优续行；不是提前知道对手下一手。
      const next = random() < 0.12 && ranking.length > 1 ? ranking[1] : ranking[0];
      current = advance(branch, next);
      result.nodes += 1;
    }
    placements = branch.match.actions.slice(initialActions).filter((action) => action.type === 'placeDie').length;
    result.maxPlacementsAhead = placements;
    result.maxRoundsAhead = Math.max(0, (branch.match.state?.round ?? 0) - rootRound);
    if (branch.pending) { result.unfinished = 1; result.failed = 1; return result; }
    if (current.done) result.terminal = 1;
    else result.cutoff = 1;
    const evaluation = evaluateHighScore(branch.match, actor, branch.weights);
    result.potential = evaluation.potential;
    result.score = evaluation.total;
  } catch (error) {
    // 部分机会样本可能在练习规则中无法完成；明确记录，不赋予虚假零分。
    if (!String(error.code ?? error.message).match(/^(AI_|INVALID_|TARGET_|DATA_|INSUFFICIENT_|NOT_|CHOICE_)/)) throw error;
    result.failed += 1;
  }
  return result;
}

/** 按原来的样本优先顺序归并，不让工作线程返回顺序改变浮点累加和策略。 */
export function finishRouteSearch(plan, results, started) {
  if (plan.single) return { policy: [1], scores: [null], searched: false, nodes: 0, version: SEARCH_VERSION };
  const { config, policy, selected, unresolvedPriority } = plan;
  const samples = selected.map(() => []);
  let nodes = 0; let terminal = 0; let cutoff = 0; let failed = 0; let unfinished = 0;
  let maxRoundsAhead = 0; let maxPlacementsAhead = 0; let extendedDecisions = 0;
  let potentialTotal = 0; let completedSamples = 0;
  for (const result of results) {
    nodes += result.nodes; terminal += result.terminal; cutoff += result.cutoff; failed += result.failed;
    unfinished += result.unfinished; extendedDecisions += result.extendedDecisions;
    maxRoundsAhead = Math.max(maxRoundsAhead, result.maxRoundsAhead);
    maxPlacementsAhead = Math.max(maxPlacementsAhead, result.maxPlacementsAhead);
    if (result.score !== null) {
      samples[result.candidate].push(result.score);
      potentialTotal += result.potential;
      completedSamples += 1;
    }
  }
  const scores = policy.map(() => null);
  selected.forEach((index, i) => {
    if (samples[i].length) scores[index] = samples[i].reduce((a, b) => a + b, 0) / samples[i].length;
  });
  const measured = scores.filter((value) => value !== null);
  const diagnostics = { evaluator: EVALUATOR_VERSION, seconds: config.logTiming ? (Date.now() - started) / 1000 : 0,
    unfinished, extendedDecisions, averagePotential: completedSamples ? potentialTotal / completedSamples : 0 };
  if (measured.length < 2) return { policy, scores, searched: false, nodes, failed, terminal, cutoff,
    ...diagnostics, version: SEARCH_VERSION };
  const peak = Math.max(...measured);
  const exponent = scores.map((value, i) => value === null ? 0
    : Math.exp((value - peak) / 2) * (0.9 + 0.1 * policy[i]));
  const total = exponent.reduce((a, b) => a + b, 0);
  return { policy: exponent.map((p) => p / total), scores, searched: true, nodes, terminal, cutoff, failed,
    candidates: measured.length, samples: config.samples, maxRoundsAhead, maxPlacementsAhead,
    prioritySamples: unresolvedPriority ? Math.min(2, config.samples) : 0, ...diagnostics, version: SEARCH_VERSION };
}

/** 比较多条后续路线；对手追求其自身得分，截断处为阶段计分，不能当作终局承诺。 */
export function searchRoutes(env, policy, settings = {}) {
  const plan = prepareRouteSearch(env, policy, settings);
  const started = Date.now();
  const results = [];
  if (!plan.single) {
    for (let sample = 0; sample < plan.config.samples; sample += 1) {
      for (let candidate = 0; candidate < plan.selected.length; candidate += 1) {
        results.push(evaluateRouteSample(env, plan, sample, candidate));
      }
    }
  }
  return finishRouteSearch(plan, results, started);
}
