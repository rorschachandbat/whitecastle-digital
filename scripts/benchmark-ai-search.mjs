import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { availableParallelism, cpus } from 'node:os';
import { loadTrainingConfig, projectRoot } from './ai-common.mjs';
import { TrainingEnvironment } from '../src/ai/environment.js';
import { chooseHeuristic } from '../src/ai/heuristicPolicy.js';
import { RouteSearchPool, resolveSearchWorkers } from '../src/ai/routeSearchPool.js';

const { values } = parseArgs({ options: {
  workers: { type: 'string', default: '1,2,4,8' }, repeats: { type: 'string', default: '2' },
  positions: { type: 'string', default: '2' }, out: { type: 'string' },
  'search-config': { type: 'string', default: 'data/ai-training-loop.json' },
  weights: { type: 'string', default: 'data/ai-heuristic-r9.json' },
} });
const workers = [...new Set([1, ...values.workers.split(',').map(resolveSearchWorkers)])];
const repeats = Number(values.repeats);
const positions = Number(values.positions);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10
  || !Number.isInteger(positions) || positions < 1 || positions > 6) throw new Error('AI_BAD_BENCHMARK_COUNT');
const output = path.resolve(projectRoot, values.out ?? `.local/ai/search-speed-${Date.now()}.json`);
const relative = path.relative(path.join(projectRoot, '.local'), output);
if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('AI_BENCHMARK_OUTPUT_MUST_BE_LOCAL');
await fs.access(output).then(() => { throw new Error('AI_OUTPUT_EXISTS'); }, (error) => {
  if (error.code !== 'ENOENT') throw error;
});
const { catalog, weights, meta } = loadTrainingConfig(undefined, path.resolve(projectRoot, values.weights));
const config = JSON.parse(await fs.readFile(path.resolve(projectRoot, values['search-config']), 'utf8'));
if (!config.search) throw new Error('AI_MISSING_SEARCH_CONFIG');
const results = [];
const pools = new Map(workers.map((count) => [count, new RouteSearchPool({ workers: count })]));
const deterministic = ({ seconds, execution, workers: count, ...result }) => result;
try {
  for (let position = 0; position < positions; position += 1) {
    const env = new TrainingEnvironment(catalog, weights);
    let observation = env.reset(`benchmark-speed-r9-${position}`);
    while (env.match.phase === 'draft') observation = env.step(chooseHeuristic(observation.heuristic));
    // 第二个局面开始覆盖放骰后的中盘；不读取正式训练种子或私人对局。
    while (env.match.actions.filter((action) => action.type === 'placeDie').length < position * 3 || env.pending) {
      observation = env.step(chooseHeuristic(observation.heuristic));
    }
    const policy = env.getLegalActions().map(() => 1 / env.getLegalActions().length);
    const settings = { ...config.search, seed: `benchmark-samples-${position}`, logTiming: true };
    let expected;
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      // 轮换执行顺序，减少热机与后台负载随时间变化造成的单向偏差。
      const order = repeat % 2 ? [...workers].reverse() : workers;
      for (const count of order) {
        const started = performance.now();
        const result = await pools.get(count).search(env, policy, settings);
        const seconds = (performance.now() - started) / 1000;
        if (!expected) expected = deterministic(result);
        assert.deepEqual(deterministic(result), expected, `workers=${count}, position=${position}, repeat=${repeat}`);
        const row = { position, repeat, workers: count, seconds, nodes: result.nodes,
          nodesPerSecond: result.nodes / seconds, failed: result.failed, unfinished: result.unfinished };
        results.push(row);
        console.log(JSON.stringify(row));
      }
    }
  }
} finally { await Promise.all([...pools.values()].map((pool) => pool.close())); }
const total = (count) => results.filter((row) => row.workers === count).reduce((sum, row) => sum + row.seconds, 0);
const summary = workers.map((count) => ({ workers: count, totalSeconds: total(count), speedup: total(1) / total(count) }));
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify({ meta, search: config.search, positions, repeats,
  cpu: cpus()[0]?.model, availableParallelism: availableParallelism(), node: process.version,
  exactResultsMatched: true, results, summary }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, exactResultsMatched: true, summary }));
