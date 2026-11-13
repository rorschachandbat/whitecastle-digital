import { workerData, parentPort } from 'node:worker_threads';
import { TrainingEnvironment } from './environment.js';
import { searchRoutes } from './routeSearch.js';

try {
  const { source, policy, settings } = workerData;
  const env = Object.assign(new TrainingEnvironment(source.match.catalog, source.weights), source);
  // 规则、启发式及临时行动栈均来自本次服务内存，不开放外部存档导入。
  parentPort.postMessage(searchRoutes(env, policy, settings));
} catch (error) {
  parentPort.postMessage({ error: error.code ?? error.message });
}
