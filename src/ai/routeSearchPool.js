import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { prepareRouteSearch, evaluateRouteSample, finishRouteSearch } from './routeSearch.js';

/** 线程数是执行设置，不改变实验配置；预留主线程和系统资源，默认最多四个。 */
export function resolveSearchWorkers(value = process.env.AI_SEARCH_WORKERS ?? 'auto') {
  if (value === 'auto') return Math.max(1, Math.min(4, availableParallelism() - 2));
  const count = Number(value);
  if (!/^[1-8]$/.test(String(value)) || !Number.isInteger(count)) throw new Error('AI_BAD_SEARCH_WORKERS');
  return count;
}

/** 规则进程内复用工作线程，只并行独立机会分支；梯度更新和真实落子仍顺序执行。 */
export class RouteSearchPool {
  constructor({ workers = resolveSearchWorkers(), timeoutMilliseconds = 180000 } = {}) {
    this.size = resolveSearchWorkers(workers);
    if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) throw new Error('AI_BAD_SEARCH_TIMEOUT');
    this.timeoutMilliseconds = timeoutMilliseconds;
    this.slots = [];
    this.queue = [];
    this.closed = false;
  }

  async search(env, policy, settings = {}) {
    if (this.closed) throw new Error('AI_SEARCH_POOL_CLOSED');
    const plan = prepareRouteSearch(env, policy, settings);
    const started = Date.now();
    const results = [];
    if (!plan.single) {
      if (this.size === 1) {
        for (let sample = 0; sample < plan.config.samples; sample += 1) {
          for (let candidate = 0; candidate < plan.selected.length; candidate += 1) {
            results.push(evaluateRouteSample(env, plan, sample, candidate));
          }
        }
      } else {
        // 只传公开搜索所需的快照；每个工作线程内部仍会独立重采样未知补牌和未来骰子。
        const source = structuredClone({ catalog: env.catalog, weights: env.weights, match: env.match,
          pending: env.pending, probe: env.probe, orderPrefix: env.orderPrefix,
          lanternExpansion: env.lanternExpansion, legacyFeatureEncoding: env.legacyFeatureEncoding,
          publicInitialBridges: env.publicInitialBridges });
        const tasks = [];
        for (let sample = 0; sample < plan.config.samples; sample += 1) {
          for (let candidate = 0; candidate < plan.selected.length; candidate += 1) {
            tasks.push(this.run({ source, plan, sample, candidate }));
          }
        }
        // Promise.all保留提交顺序，不按耗时排序，避免改变累加和同分结果。
        results.push(...await Promise.all(tasks));
      }
    }
    return { ...finishRouteSearch(plan, results, started), execution: 'persistent-route-pool-v1', workers: this.size };
  }

  start() {
    if (this.slots.length) return;
    try {
      for (let index = 0; index < this.size; index += 1) {
        const worker = new Worker(new URL('./routeSampleWorker.js', import.meta.url), { execArgv: [] });
        const slot = { worker, active: null };
        worker.on('message', (message) => {
          if (!slot.active || !message || typeof message !== 'object'
            || !(typeof message.error === 'string' || message.result && typeof message.result === 'object')) {
            this.fail(new Error('AI_SEARCH_POOL_PROTOCOL')); return;
          }
          const active = slot.active;
          slot.active = null;
          clearTimeout(active.timer);
          if (message.error) active.reject(new Error(message.error));
          else active.resolve(message.result);
          this.dispatch();
        });
        worker.on('error', (error) => this.fail(error));
        worker.on('exit', () => {
          if (!this.closed) this.fail(new Error('AI_SEARCH_WORKER_EXIT'));
        });
        this.slots.push(slot);
      }
    } catch (error) {
      // 部分线程已启动时也必须回收，不能留下等待输入的孤立线程。
      this.fail(error);
      throw error;
    }
  }

  run(task) {
    if (this.closed) return Promise.reject(new Error('AI_SEARCH_POOL_CLOSED'));
    this.start();
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.dispatch();
    });
  }

  dispatch() {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.active || !this.queue.length) continue;
      const active = this.queue.shift();
      slot.active = active;
      active.timer = setTimeout(() => this.fail(new Error('AI_SEARCH_WORKER_TIMEOUT')), this.timeoutMilliseconds);
      try { slot.worker.postMessage(active.task); }
      catch (error) { this.fail(error); return; }
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const slot of this.slots) {
      if (slot.active) {
        clearTimeout(slot.active.timer);
        slot.active.reject(error);
        slot.active = null;
      }
      void slot.worker.terminate();
    }
    for (const item of this.queue.splice(0)) item.reject(error);
  }

  async close() {
    if (!this.closed) this.fail(new Error('AI_SEARCH_POOL_CLOSED'));
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
  }
}
