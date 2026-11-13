import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { TrainingEnvironment } from '../src/ai/environment.js';
import { exportLocalMatch } from '../src/engine/localMatch.js';
import { loadTrainingConfig } from './ai-common.mjs';
import { RouteSearchPool, resolveSearchWorkers } from '../src/ai/routeSearchPool.js';

const { values } = parseArgs({ options: { catalog: { type: 'string' }, weights: { type: 'string' },
  'search-workers': { type: 'string' } } });
const { catalog, weights, meta } = loadTrainingConfig(values.catalog, values.weights);
const environment = new TrainingEnvironment(catalog, weights);
const searchPool = new RouteSearchPool({ workers: resolveSearchWorkers(values['search-workers']) });
// 标准输出仅传输协议；诊断由调用方处理，不启动网页或构建进程。
try {
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      const request = JSON.parse(line);
      let result;
      if (request.op === 'info') result = meta;
      else if (request.op === 'reset') result = environment.reset(request.seed, request.playOrder);
      else if (request.op === 'load') {
        result = environment.restore(request.save);
        for (const index of request.choices ?? []) result = environment.step(index);
      }
      else if (request.op === 'step' && environment.match) result = environment.step(request.index);
      else if (request.op === 'search' && environment.match) {
        result = await searchPool.search(environment, request.policy, request.settings);
      }
      else if (request.op === 'replay' && environment.match) result = exportLocalMatch(environment.match);
      else throw new Error('AI_INVALID_REQUEST');
      console.log(JSON.stringify({ ok: true, result }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error.code ?? error.message }));
    }
  }
} finally { await searchPool.close(); }
