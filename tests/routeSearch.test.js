import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTrainingConfig } from '../scripts/ai-common.mjs';
import { TrainingEnvironment } from '../src/ai/environment.js';
import { chooseHeuristic } from '../src/ai/heuristicPolicy.js';
import { searchRoutes, searchRoutesAsync, samplePublicEnvironment } from '../src/ai/routeSearch.js';

const { catalog, weights } = loadTrainingConfig();
function playing(seed = 'route-public') {
  const env = new TrainingEnvironment(catalog, weights);
  let observation = env.reset(seed);
  while (env.match.phase === 'draft') observation = env.step(chooseHeuristic(observation.heuristic));
  return env;
}
const uniform = (env) => env.getLegalActions().map(() => 1 / env.getLegalActions().length);

test('搜索比较后续放骰、越过轮末，并且不修改真实行动栈', () => {
  const env = playing();
  let observation = env.observe();
  while (env.match.state.round === 1 && Object.values(env.match.state.turnsUsed).reduce((a, b) => a + b, 0) < 5) {
    observation = env.step(chooseHeuristic(observation.heuristic));
  }
  const before = structuredClone({ match: env.match, pending: env.pending, probe: env.probe, prefix: env.orderPrefix });
  const result = searchRoutes(env, uniform(env), {
    width: 3, samples: 1, maxDecisions: 80, maxPlacements: 4, seed: 'future-route',
  });
  assert.equal(env.observe().decisions, env.decisions);
  assert.equal(result.searched, true);
  assert.ok(result.nodes > result.candidates);
  assert.ok(result.maxRoundsAhead >= 1);
  assert.ok(result.maxPlacementsAhead >= 2);
  assert.equal(result.failed, 0);
  assert.ok(Math.abs(result.policy.reduce((a, b) => a + b, 0) - 1) < 1e-10);
  const best = result.policy.indexOf(Math.max(...result.policy));
  assert.equal(result.scores[best], Math.max(...result.scores.filter((value) => value !== null)));
  assert.deepEqual({ match: env.match, pending: env.pending, probe: env.probe, prefix: env.orderPrefix }, before);
});

test('相同公开盘面不因真实补牌排列或未来骰子种子改变搜索结果', () => {
  const left = playing('route-future-blind');
  const right = playing('route-future-blind');
  right.match.seed = 'secret-future-should-not-be-read';
  right.match.options.seed = right.match.seed;
  for (const family of ['steward', 'diplomat']) right.match.state.castleDecks[family].reverse();
  const config = { width: 2, samples: 1, maxDecisions: 24, maxPlacements: 2, seed: 'public-sample' };
  assert.deepEqual(searchRoutes(left, uniform(left), config), searchRoutes(right, uniform(right), config));
  const a = samplePublicEnvironment(left, 'a');
  const b = samplePublicEnvironment(left, 'b');
  assert.notEqual(a.match.seed, b.match.seed);
  assert.deepEqual(a.match.state.bridges, left.match.state.bridges);
});

test('工作线程搜索与同步搜索一致，不阻塞主线程定时器', async () => {
  const env = playing('route-worker');
  const config = { width: 2, samples: 1, maxDecisions: 16, maxPlacements: 2, seed: 'worker-check' };
  let heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; }, 10);
  const result = await searchRoutesAsync(env, uniform(env), config);
  clearTimeout(timer);
  assert.equal(heartbeat, true);
  assert.deepEqual(result, searchRoutes(env, uniform(env), config));
});

test('时间轨到达顺序未知时，两份共同样本覆盖两种优先关系', () => {
  const env = playing('route-priority');
  const before = structuredClone(env.match.state.players);
  const result = searchRoutes(env, uniform(env), {
    width: 2, samples: 2, maxDecisions: 12, maxPlacements: 1, seed: 'priority', uncertainPriority: true,
  });
  assert.equal(result.searched, true);
  assert.equal(result.prioritySamples, 2);
  assert.deepEqual(env.match.state.players, before);
  const branch = samplePublicEnvironment(env, 'priority', [2, 1]);
  assert.deepEqual(['0', '1'].map((actor) => branch.match.state.players[actor].timePriority), [2, 1]);
});
