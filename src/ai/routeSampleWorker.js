import { parentPort } from 'node:worker_threads';
import { TrainingEnvironment } from './environment.js';
import { evaluateRouteSample } from './routeSearch.js';

// 常驻线程每次只处理一个独立分支；不保留上一任务的环境或网络状态。
parentPort.on('message', ({ source, plan, sample, candidate }) => {
  try {
    const env = Object.assign(new TrainingEnvironment(source.catalog, source.weights), source);
    parentPort.postMessage({ result: evaluateRouteSample(env, plan, sample, candidate) });
  } catch (error) {
    parentPort.postMessage({ error: error.code ?? error.message });
  }
});
