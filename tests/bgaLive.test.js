import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { once } from 'node:events';
import { sanitizeLiveCapture, mapLiveCapture } from '../src/integrations/bgaLive.js';
import { createLiveServer } from '../scripts/serve-bga-live.mjs';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/whitecastle-2p.json', import.meta.url)));
const mapping = JSON.parse(fs.readFileSync(new URL('../data/bga-mapping.json', import.meta.url)));
const watchId = '11111111-1111-1111-1111-111111111111';
const capture = () => ({
  watchId, sequence: 1, source: { table: '123', host: 'boardgamearena.com', gameAssetVersion: mapping.gameAssetVersion },
  observation: {
    format: 'whitecastle-bga-observation', version: 1, cursor: null, progress: null,
    title: '当前行动', roundText: '1', players: ['12', '34'].map((id, index) => ({
      id, name: `<script>${id}</script>`, score: 0, color: index ? '#112233' : '#aabbcc',
      resources: { coin: 1, seal: 1, food: 2, iron: 3, pearl: 4 },
    })),
    cards: [], pieces: [], tiles: [], dice: [], decks: [], logs: [{ cookie: 'not-collected' }],
  },
});

test('实时缺失游标保留null，私密附加字段及未来日志不进入快照', () => {
  const value = capture();
  value.cookie = 'secret';
  value.observation.players[0].privateData = 'secret';
  const cleaned = sanitizeLiveCapture(value);
  assert.equal(cleaned.observation.cursor, null);
  assert.equal(JSON.stringify(cleaned).includes('secret'), false);
  assert.deepEqual(cleaned.observation.logs, []);
  const result = mapLiveCapture(cleaned, catalog, mapping);
  assert.ok(result.archive);
  assert.equal(result.archive.status.executable, false);
  assert.equal(result.archive.status.trainingEligible, false);
  assert.equal(result.archive.publicPosition.cursor, null);
});

test('不同资产版本和多人数可以展示原始数据，但不冒充两人映射', () => {
  const value = capture();
  value.source.gameAssetVersion = 'unknown';
  assert.equal(mapLiveCapture(sanitizeLiveCapture(value), catalog, mapping).archive, null);
  value.source.gameAssetVersion = mapping.gameAssetVersion;
  value.observation.players.push({ ...value.observation.players[0], id: '56' });
  assert.equal(mapLiveCapture(sanitizeLiveCapture(value), catalog, mapping).issues[0].code, 'BGA_LIVE_TWO_PLAYERS_REQUIRED');
  value.source.host = 'boardgamearena.com.evil.test';
  assert.throws(() => sanitizeLiveCapture(value), { code: 'BGA_LIVE_INVALID' });
});

test('接收端验证配对、乱序、换桌、停止和跨域，重复心跳不重复映射', async (t) => {
  const token = 'a'.repeat(48);
  const server = await createLiveServer({ catalog, mapping, token, ai: {
    analyze: async () => ({ status: 'unsupported', code: 'BGA_ADVICE_PHASE' }),
    trainingStatus: async () => ({ status: 'available', modelSource: 'continuous-champion' }),
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, extra = {}) => fetch(`${origin}/api/live/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra },
    body: JSON.stringify(body),
  });
  assert.equal((await post('connect', { watchId, table: '123' }, { Authorization: 'wrong' })).status, 401);
  assert.equal((await post('connect', { watchId, table: '123' }, { Origin: 'https://boardgamearena.com' })).status, 403);
  const extension = `chrome-extension://${'a'.repeat(32)}`;
  const allowed = await post('connect', { watchId, table: '123' }, { Origin: extension });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), extension);
  assert.equal((await fetch(`${origin}/api/live/config`, { headers: { Origin: extension } })).status, 403);
  assert.equal((await post('capture', capture())).status, 200);
  assert.equal((await post('capture', capture())).status, 409);
  assert.equal((await post('capture', { ...capture(), sequence: 2 })).status, 200);
  let state = await (await fetch(`${origin}/api/live/state`)).json();
  assert.equal(state.updates, 1);
  assert.equal(state.watch.sequence, 2);
  assert.equal(state.latest.recommendations.status, 'unsupported');
  assert.equal(state.latest.trainingEligible, false);
  assert.equal((await post('capture', { ...capture(), sequence: 3, source: { ...capture().source, table: '999' } })).status, 409);
  assert.equal((await post('stop', { watchId })).status, 200);
  assert.equal((await post('capture', { ...capture(), sequence: 4 })).status, 409);
  await post('connect', { watchId, table: '999' });
  state = await (await fetch(`${origin}/api/live/state`)).json();
  assert.equal(state.latest, null);
  assert.equal(state.watch.table, '999');
  assert.equal((await fetch(`${origin}/../package.json`)).status, 404);
  assert.equal((await (await fetch(`${origin}/api/live/training`)).json()).modelSource, 'continuous-champion');
});

test('异步建议在新盘面、换桌或停止后不能覆盖当前状态', async (t) => {
  const jobs = [];
  const token = 'b'.repeat(48);
  const server = await createLiveServer({ token, ai: {
    analyze: (latest) => new Promise((resolve) => jobs.push({ latest, resolve })),
    trainingStatus: async () => ({ status: 'unavailable' }),
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (route, data) => fetch(`${origin}/api/live/${route}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const state = async () => (await fetch(`${origin}/api/live/state`)).json();
  await post('connect', { watchId, table: '123' });
  await post('capture', capture());
  const next = capture();
  next.sequence = 2;
  next.observation.title = '下一手';
  await post('capture', next);
  jobs[0].resolve({ status: 'ready', marker: 'old' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await state()).latest.recommendations.status, 'pending');
  assert.equal(jobs.length, 2);
  await post('stop', { watchId });
  jobs[1].resolve({ status: 'ready', marker: 'stopped' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await state()).latest.recommendations, null);
  await post('connect', { watchId, table: '123' });
  await post('capture', capture());
  await post('connect', { watchId: '22222222-2222-2222-2222-222222222222', table: '456' });
  jobs[2].resolve({ status: 'ready', marker: 'other-table' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await state()).latest, null);
});

test('扩展按稳定DOM采样、忽略隐藏元素，停止后没有计时器叠加', async () => {
  let listener;
  let tick;
  let intervals = 0;
  const sent = [];
  const root = {
    querySelector(selector) {
      if (selector === '[id^="twc-player-panel-resources-"]') return {};
      if (selector === '#pagemaintitletext') return { textContent: '当前行动' };
      if (selector.startsWith('#player_name_')) return { textContent: '玩家', style: { color: '#112233' } };
      if (selector.startsWith('#player_score_')) return { textContent: '0' };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[id^="twc-player-panel-resources-"]') return ['12', '34', '56'].map((id, index) => ({
        id: `twc-player-panel-resources-${id}`, getClientRects: () => index === 2 ? [] : [{}],
        querySelectorAll: () => [],
      }));
      if (selector === '.twc-main-card,.twc-garden-card,.twc-daimyo-card') return [{
        id: 'hidden-front', dataset: { side: 'front', accountSecret: 'private' },
        getClientRects: () => [], querySelector: () => null,
      }];
      return [];
    },
  };
  const context = vm.createContext({
    document: { body: root, querySelectorAll: () => [{ src: `/data/thewhitecastle/${mapping.gameAssetVersion}/game.js` }] },
    chrome: { runtime: {
      onMessage: { addListener: (value) => { listener = value; } },
      sendMessage: async (value) => { sent.push(value); return { ok: true }; },
    } },
    setInterval: (value) => { tick = value; intervals += 1; return intervals; },
    clearInterval: (id) => { if (id) intervals -= 1; },
  });
  for (const file of ['capture.js', 'watcher.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../browser-extension/bga-live/${file}`, import.meta.url), 'utf8'), context);
  }
  listener({ type: 'WATCH_START', watchId, table: '123' }, null, () => {});
  assert.equal(sent.length, 0);
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].observation.players.length, 2);
  assert.equal(sent[0].observation.cards.length, 0);
  assert.equal(sent[0].gameAssetVersion, mapping.gameAssetVersion);
  listener({ type: 'WATCH_START', watchId, table: '123' }, null, () => {});
  assert.equal(intervals, 1);
  listener({ type: 'WATCH_STOP' }, null, () => {});
  assert.equal(intervals, 0);
});

test('扩展后台只转发手动授权标签页与桌号，页面不能伪造启停指令', async () => {
  const store = {};
  const requests = [];
  const context = vm.createContext({
    URL, crypto: { randomUUID: () => watchId }, AbortSignal, Date,
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true }; },
    chrome: {
      runtime: {
        getURL: (name) => `chrome-extension://${'a'.repeat(32)}/${name}`,
        onMessage: { addListener() {} },
      },
      storage: { session: {
        get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, store[key]])),
        set: async (value) => Object.assign(store, value),
        remove: async (keys) => keys.forEach((key) => delete store[key]),
      } },
      scripting: { executeScript: async () => [] },
      tabs: {
        query: async () => [{ id: 8, url: 'https://boardgamearena.com/table?table=123' }],
        sendMessage: async () => ({ ok: true }),
        onRemoved: { addListener() {} },
      },
    },
  });
  vm.runInContext(fs.readFileSync(new URL('../browser-extension/bga-live/background.js', import.meta.url), 'utf8'), context);
  const handle = vm.runInContext('handle', context);
  const start = { type: 'START', address: 'http://127.0.0.1:4180', token: 'a'.repeat(48) };
  const popup = { url: `chrome-extension://${'a'.repeat(32)}/popup.html` };
  await assert.rejects(handle(start, { tab: { id: 8 }, url: 'https://boardgamearena.com/' }), /SENDER_REJECTED/);
  await assert.rejects(handle({ ...start, address: 'https://evil.test' }, popup), /LOCAL_ADDRESS_INVALID/);
  await handle(start, popup);
  assert.equal(requests.length, 1);
  const message = { type: 'CAPTURE', ...capture() };
  assert.equal((await handle(message, { tab: { id: 9 }, url: 'https://boardgamearena.com/table?table=123' })).ok, false);
  assert.equal((await handle(message, { tab: { id: 8 }, url: 'https://boardgamearena.com/table?table=999' })).ok, false);
  await handle(message, { tab: { id: 8 }, url: 'https://boardgamearena.com/table?table=123' });
  assert.equal(requests.length, 2);
  assert.ok(requests[1].url.endsWith('/api/live/capture'));
  await handle({ type: 'STOP' }, popup);
  assert.equal(store.watch, undefined);
  assert.ok(requests[2].url.endsWith('/api/live/stop'));
});

test('选牌配对来自可见坐标，行换位可对应，重叠或换行不猜组合', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../browser-extension/bga-live/capture.js', import.meta.url), 'utf8'), context);
  const make = (id, left, top) => ({
    id, getClientRects: () => [{}],
    getBoundingClientRect: () => ({ left, top, width: 100, height: 140 }),
  });
  const resources = [make('r2', 200, 0), make('r1', 0, 0)];
  const actions = [make('a1', 0, 150), make('a2', 200, 150)];
  const root = {
    querySelector: () => null,
    querySelectorAll: (selector) => selector.includes('resource-draft-stock') ? resources
      : selector.includes('action-draft-stock') ? actions : [],
  };
  const captureDom = vm.runInContext('whitecastleCaptureBgaDocument', context);
  const pairs = () => JSON.parse(JSON.stringify(captureDom(root, { live: true }).draftPairs));
  assert.deepEqual(pairs(), [{ resource: 'r1', action: 'a1' }, { resource: 'r2', action: 'a2' }]);
  actions[1] = make('a2', 0, 150);
  assert.deepEqual(pairs(), []);
  actions[1] = make('a2', 200, 300);
  assert.deepEqual(pairs(), []);
});
