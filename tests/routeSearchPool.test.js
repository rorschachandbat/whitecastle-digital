import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTrainingConfig } from '../scripts/ai-common.mjs';
import { TrainingEnvironment } from '../src/ai/environment.js';
import { chooseHeuristic } from '../src/ai/heuristicPolicy.js';
import { searchRoutes } from '../src/ai/routeSearch.js';
import { RouteSearchPool, resolveSearchWorkers } from '../src/ai/routeSearchPool.js';

const { catalog, weights } = loadTrainingConfig(undefined, 'data/ai-heuristic-r9.json');
const uniform = (env) => env.getLegalActions().map(() => 1 / env.getLegalActions().length);
function environment(seed, draft = false) {
  const env = new TrainingEnvironment(catalog, weights);
  let observation = env.reset(seed);
  if (!draft) while (env.match.phase === 'draft') observation = env.step(chooseHeuristic(observation.heuristic));
  return env;
}
const deterministic = ({ seconds, execution, workers, ...result }) => result;
const settings = { width: 2, samples: 2, maxDecisions: 2, maxPlacements: 1, seed: 'pool-samples' };

test('搜索线程数独立于实验参数，非法值不静默回退', () => {
  for (const value of [0, 9, '4.0', '2x', '', null]) {
    assert.throws(() => resolveSearchWorkers(value), /AI_BAD_SEARCH_WORKERS/);
  }
  assert.equal(resolveSearchWorkers('1'), 1);
  assert.equal(resolveSearchWorkers(4), 4);
  assert.ok(resolveSearchWorkers('auto') >= 1 && resolveSearchWorkers('auto') <= 4);
});

test('常驻池与串行在选牌、放骰、未知优先关系、连锁和旧编码下完全一致', async (t) => {
  const pool = new RouteSearchPool({ workers: 2 });
  t.after(() => pool.close());
  for (const kind of ['draft', 'root', 'priority', 'pending', 'legacy']) {
    const env = environment(`pool-${kind}`, kind === 'draft');
    if (kind === 'pending') {
      const observation = env.observe();
      env.step(chooseHeuristic(observation.heuristic));
      assert.ok(env.pending);
    }
    if (kind === 'legacy') { env.legacyFeatureEncoding = true; env.lanternExpansion = false; }
    const config = { ...settings, uncertainPriority: kind === 'priority' };
    const policy = uniform(env);
    const before = structuredClone({ match: env.match, pending: env.pending, prefix: env.orderPrefix });
    const expected = searchRoutes(env, policy, config);
    const result = await pool.search(env, policy, config);
    assert.deepEqual(deterministic(result), deterministic(expected), kind);
    assert.deepEqual({ match: env.match, pending: env.pending, prefix: env.orderPrefix }, before, kind);
    assert.equal(result.workers, 2);
  }
  const ids = pool.slots.map((slot) => slot.worker.threadId);
  const env = environment('pool-reuse');
  await pool.search(env, uniform(env), settings);
  assert.deepEqual(pool.slots.map((slot) => slot.worker.threadId), ids);
  const serial = new RouteSearchPool({ workers: 1 });
  t.after(() => serial.close());
  assert.deepEqual(deterministic(await serial.search(env, uniform(env), settings)),
    deterministic(searchRoutes(env, uniform(env), settings)));
  assert.equal(serial.slots.length, 0);
});

test('任务可以并发排队，真实隐藏顺序不同仍返回相同结果', async (t) => {
  const pool = new RouteSearchPool({ workers: 2 });
  t.after(() => pool.close());
  const a = environment('pool-hidden');
  const b = environment('pool-hidden');
  b.match.seed = 'hidden-future-is-not-an-input';
  b.match.options.seed = b.match.seed;
  for (const family of ['steward', 'diplomat']) b.match.state.castleDecks[family].reverse();
  const [left, right] = await Promise.all([pool.search(a, uniform(a), settings), pool.search(b, uniform(b), settings)]);
  assert.deepEqual(left, right);
});

test('关闭、工作线程退出和超时都拒绝未完成任务，不永久挂起', async () => {
  const env = environment('pool-failure');
  const policy = uniform(env);
  const closed = new RouteSearchPool({ workers: 1 });
  await closed.close();
  await assert.rejects(closed.search(env, policy, settings), /AI_SEARCH_POOL_CLOSED/);
  const timeout = new RouteSearchPool({ workers: 2, timeoutMilliseconds: 1 });
  await assert.rejects(timeout.search(env, policy, settings), /AI_SEARCH_WORKER_TIMEOUT/);
  await timeout.close();
  const exiting = new RouteSearchPool({ workers: 2 });
  const task = exiting.search(env, policy, settings);
  const rejection = assert.rejects(task, /AI_SEARCH_WORKER_EXIT/);
  await exiting.slots[0].worker.terminate();
  await rejection;
  await exiting.close();
  const malformed = new RouteSearchPool({ workers: 2 });
  const invalid = malformed.search(env, policy, settings);
  const protocolRejection = assert.rejects(invalid, /AI_SEARCH_POOL_PROTOCOL/);
  malformed.slots[0].worker.emit('message', null);
  await protocolRejection;
  await malformed.close();
});
