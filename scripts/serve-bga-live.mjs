import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { sanitizeLiveCapture, mapLiveCapture } from '../src/integrations/bgaLive.js';
import { createLiveAi } from './bga-live-ai.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticFiles = new Map([
  ['/', 'bga-live.html'], ['/bga-live.html', 'bga-live.html'],
  ...['src/ui/bgaLive.js', 'src/ui/bgaLive.css', 'src/ui/StringTable.js'].map((name) => [`/${name}`, name]),
]);
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { code, status }); };
async function bodyOf(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) fail('BGA_LIVE_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('BGA_LIVE_INVALID_JSON'); }
}

export async function createLiveServer({ catalog, mapping, token = randomBytes(24).toString('hex'), ai = createLiveAi() } = {}) {
  catalog ??= JSON.parse(await fs.readFile(path.join(root, 'data/whitecastle-2p.json'), 'utf8'));
  mapping ??= JSON.parse(await fs.readFile(path.join(root, 'data/bga-mapping.json'), 'utf8'));
  let watch = null;
  let latest = null;
  let digest = null;
  let updates = 0;
  let queued = null;
  let analyzing = false;
  let training = null;
  let trainingCheckedAt = 0;
  let importedSnapshot = null;
  const analyzeNext = async () => {
    if (analyzing || !queued) return;
    analyzing = true;
    const job = queued;
    queued = null;
    try {
      const result = await ai.analyze(job.latest);
      if (watch?.active && watch.id === job.watchId && latest === job.latest
        && Date.now() - Date.parse(watch.receivedAt) <= 6000) latest.recommendations = result;
    } catch {
      if (watch?.active && watch.id === job.watchId && latest === job.latest
        && Date.now() - Date.parse(watch.receivedAt) <= 6000) {
        latest.recommendations = { status: 'error', code: 'AI_INFERENCE_FAILED' };
      }
    } finally { analyzing = false; void analyzeNext(); }
  };
  const server = http.createServer(async (request, response) => {
    const json = (status, value) => {
      response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    try {
      const port = server.address().port;
      const origin = `http://127.0.0.1:${port}`;
      if (request.headers.host !== `127.0.0.1:${port}`) fail('BGA_LIVE_HOST_REJECTED', 403);
      const requestOrigin = request.headers.origin;
      const extension = /^chrome-extension:\/\/[a-p]{32}$/.test(requestOrigin ?? '');
      if (requestOrigin && requestOrigin !== origin && !extension) fail('BGA_LIVE_ORIGIN_REJECTED', 403);
      const url = new URL(request.url, origin);
      if (extension) {
        response.setHeader('Access-Control-Allow-Origin', requestOrigin);
        response.setHeader('Vary', 'Origin');
        if (request.method === 'OPTIONS' && ['/api/live/connect', '/api/live/capture', '/api/live/stop'].includes(url.pathname)) {
          response.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'POST',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
          return response.end();
        }
        if (request.method !== 'POST') fail('BGA_LIVE_ORIGIN_REJECTED', 403);
      }
      if (url.pathname === '/api/live/config' && request.method === 'GET') {
        return json(200, { token, extensionPath: path.join(root, 'browser-extension/bga-live'),
          assetVersion: mapping.gameAssetVersion, adviceVersion: 3 });
      }
      if (url.pathname === '/api/live/state' && request.method === 'GET') {
        return json(200, { format: 'whitecastle-bga-live-status', workspaceRoot: root,
          watch, latest, updates, serverTime: new Date().toISOString() });
      }
      if (url.pathname === '/api/live/snapshot' && request.method === 'GET') {
        return json(200, { latest: importedSnapshot });
      }
      if (url.pathname === '/api/live/training' && request.method === 'GET') {
        if (!training || Date.now() - trainingCheckedAt > 10_000) {
          training = await ai.trainingStatus();
          trainingCheckedAt = Date.now();
        }
        return json(200, training);
      }
      if (url.pathname === '/api/live/analyze-snapshot' && request.method === 'POST') {
        if (extension) fail('BGA_LIVE_ORIGIN_REJECTED', 403);
        const supplied = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail('BGA_LIVE_PAIR_REQUIRED', 401);
        const data = await bodyOf(request);
        const time = Date.parse(data.receivedAt);
        if (data.format !== 'whitecastle-bga-live-snapshot' || data.version !== 1
          || !Number.isFinite(time) || time > Date.now()) fail('BGA_LIVE_INVALID');
        const capture = sanitizeLiveCapture({ watchId: randomUUID(), sequence: 1,
          source: data.source, observation: data.observation });
        // 导出文件中的映射和建议都重新计算，不信任附带的引擎状态或训练标志。
        const imported = { source: capture.source, observation: capture.observation,
          ...mapLiveCapture(capture, catalog, mapping), changedAt: data.receivedAt, trainingEligible: false };
        imported.recommendations = await ai.analyze(imported);
        importedSnapshot = imported;
        return json(200, { mode: 'snapshot', latest: imported });
      }
      if (['/api/live/connect', '/api/live/capture', '/api/live/stop'].includes(url.pathname) && request.method === 'POST') {
        const supplied = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail('BGA_LIVE_PAIR_REQUIRED', 401);
        const data = await bodyOf(request);
        if (url.pathname === '/api/live/connect') {
          if (!/^[\da-f-]{36}$/.test(data.watchId ?? '') || !/^\d+$/.test(data.table ?? '')) fail('BGA_LIVE_INVALID');
          watch = { id: data.watchId, table: data.table, connectedAt: new Date().toISOString(),
            receivedAt: null, sequence: 0, active: true };
          latest = null;
          digest = null;
          updates = 0;
          queued = null;
        } else {
          if (!watch?.active || watch.id !== data.watchId) fail('BGA_LIVE_WATCH_EXPIRED', 409);
          if (url.pathname === '/api/live/stop') {
            watch.active = false;
            queued = null;
            if (latest) latest.recommendations = null;
          }
          else {
            const capture = sanitizeLiveCapture(data);
            if (capture.source.table !== watch.table || capture.sequence <= watch.sequence) fail('BGA_LIVE_STALE_CAPTURE', 409);
            watch.receivedAt = new Date().toISOString();
            watch.sequence = capture.sequence;
            const nextDigest = createHash('sha256').update(JSON.stringify([capture.source, capture.observation])).digest('hex');
            if (digest !== nextDigest) {
              const result = mapLiveCapture(capture, catalog, mapping);
              latest = { source: capture.source, observation: capture.observation, ...result,
                changedAt: watch.receivedAt, trainingEligible: false, recommendations: { status: 'pending' } };
              digest = nextDigest;
              updates += 1;
              const observed = latest;
              const observedWatch = watch.id;
              // 先保留每次公开选牌事实，再合并耗时推理任务，避免快速操作丢失开局上下文。
              try { await ai.observe?.(observed); } catch {}
              if (watch?.active && watch.id === observedWatch && latest === observed) {
                queued = { latest: observed, watchId: observedWatch };
                void analyzeNext();
              }
            } else if (latest?.recommendations?.status === 'pending' && !analyzing && !queued) {
              queued = { latest, watchId: watch.id };
              void analyzeNext();
            }
          }
        }
        return json(200, { ok: true });
      }
      const name = staticFiles.get(url.pathname);
      if (!name || !['GET', 'HEAD'].includes(request.method)) fail('BGA_LIVE_NOT_FOUND', 404);
      const content = await fs.readFile(path.join(root, name));
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(name)];
      response.writeHead(200, { ...headers, 'Content-Type': `${type}; charset=utf-8` });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      json(error.status ?? 400, { code: error.code ?? 'BGA_LIVE_INVALID' });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 4180);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('BGA_LIVE_INVALID_PORT');
  const server = await createLiveServer();
  server.on('error', (error) => { console.error(error.code ?? 'BGA_LIVE_SERVER_FAILED'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`BGA盘面侧栏：http://127.0.0.1:${port}/`));
}
