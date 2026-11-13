import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createLocalClient, restoreLocalClient, submitLocalAction } from '../src/game/localClient.js';
import { exportLocalMatch } from '../src/engine/localMatch.js';
import { probeLocalAction } from '../src/engine/actionOptions.js';
import { parseCatalog } from '../src/data/catalog.js';
import { createPlayAi } from './play-ai.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawPort = process.argv[2] ?? '4176';
if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1024 || Number(rawPort) > 65535) throw new Error('端口必须为1024–65535的整数');
const port = Number(rawPort);
const origin = `http://127.0.0.1:${port}`;
const sessions = new Map();
const playAi = createPlayAi({ root });
const sourceRoutes = [
  'src/ui/play.js', 'src/ui/actionStory.js', 'src/ui/play.css', 'src/ui/StringTable.js', 'src/ui/configEditor.js', 'src/ui/styles.css',
  'src/engine/actionOptions.js', 'src/engine/localMatch.js', 'src/engine/engine.js',
  'src/engine/startingDraft.js', 'src/engine/influence.js', 'src/engine/cardRules.js', 'src/data/catalog.js',
  'src/ui/bgaReplay.js', 'src/integrations/bgaDom.js', 'browser-extension/bga-live/capture.js',
];
const routes = new Map([
  ['/', 'play.html'], ['/play.html', 'play.html'], ['/config-editor.html', 'config-editor.html'],
  ['/bga-replay.html', 'bga-replay.html'],
  ['/data/whitecastle-2p.json', 'data/whitecastle-2p.json'],
  ...sourceRoutes.map((name) => [`/${name}`, name]),
]);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
function json(response, status, value) {
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
async function bodyOf(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 5_000_000) throw Object.assign(new Error('FILE_TOO_LARGE'), { code: 'FILE_TOO_LARGE' });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function view(id, session) {
  const { G, ctx } = session.client.getState();
  return {
    id, match: G, framework: { currentPlayer: ctx.currentPlayer, turn: ctx.turn, gameover: ctx.gameover ?? null },
    ai: {
      seat: session.aiSeat, paused: session.aiPaused, generation: session.aiGeneration,
      modelId: session.aiModel, legacySetup: Boolean(session.aiLegacySetup),
      method: session.aiSeat ? session.aiMethod ?? 'policy-only' : null,
    },
  };
}
function openSession(client) {
  const id = randomUUID();
  sessions.set(id, { client, aiSeat: null, aiPaused: false, aiGeneration: null, aiQueue: Promise.resolve() });
  return id;
}
function failUndo() { throw Object.assign(new Error('INVALID_ACTION'), { code: 'INVALID_ACTION' }); }
function enqueue(session, task) {
  const run = session.aiQueue.then(task, task);
  session.aiQueue = run.then(() => {}, () => {});
  return run;
}
const server = http.createServer(async (request, response) => {
  if (request.headers.host !== `127.0.0.1:${port}` && request.headers.host !== `localhost:${port}`) return json(response, 403, { code: 'ORIGIN_REJECTED' });
  if (request.headers.origin && ![origin, `http://localhost:${port}`].includes(request.headers.origin)) return json(response, 403, { code: 'ORIGIN_REJECTED' });
  const url = new URL(request.url, origin);
  try {
    if (url.pathname === '/api/ai-status' && request.method === 'GET') {
      const id = url.searchParams.get('id');
      const session = id ? sessions.get(id) : null;
      if (id && !session) return json(response, 404, { code: 'SESSION_NOT_FOUND' });
      return json(response, 200, await playAi.status(session?.client.getState().G.catalog, url.searchParams.get('model') ?? undefined));
    }
    if (url.pathname === '/api/session' && request.method === 'POST') {
      if (sessions.size >= 24) return json(response, 409, { code: 'SESSION_LIMIT' });
      const data = await bodyOf(request);
      const catalog = data.catalog ? parseCatalog(JSON.stringify(data.catalog))
        : parseCatalog(await fs.readFile(path.join(root, 'data/whitecastle-2p.json'), 'utf8'));
      const client = data.save ? restoreLocalClient(data.save) : createLocalClient(catalog, { seed: data.seed ?? 'whitecastle-local-v1' });
      const id = openSession(client);
      return json(response, 200, view(id, sessions.get(id)));
    }
    if (url.pathname.startsWith('/api/')) {
      const data = request.method === 'GET' ? { id: url.searchParams.get('id') } : await bodyOf(request);
      const session = sessions.get(data.id);
      if (!session) return json(response, 404, { code: 'SESSION_NOT_FOUND' });
      if (url.pathname === '/api/state' && request.method === 'GET') return json(response, 200, view(data.id, session));
      if (url.pathname === '/api/probe' && request.method === 'POST') return json(response, 200, probeLocalAction(session.client.getState().G, data.action));
      if (url.pathname === '/api/action' && request.method === 'POST') {
        await enqueue(session, async () => {
          submitLocalAction(session.client, data.action);
          session.aiPaused = false;
        });
        return json(response, 200, view(data.id, session));
      }
      if (url.pathname === '/api/ai-seat' && request.method === 'POST') {
        await enqueue(session, () => playAi.assignSeat(session, data.seat ?? null, data.modelId));
        return json(response, 200, view(data.id, session));
      }
      if (url.pathname === '/api/ai-pause' && request.method === 'POST') {
        session.aiPaused = Boolean(data.paused);
        return json(response, 200, view(data.id, session));
      }
      if (url.pathname === '/api/ai-move' && request.method === 'POST') {
        const move = await enqueue(session, () => playAi.play(session));
        const payload = view(data.id, session);
        payload.ai = { ...payload.ai, ...move };
        return json(response, 200, payload);
      }
      if (url.pathname === '/api/undo' && request.method === 'POST') {
        await enqueue(session, async () => {
          const save = exportLocalMatch(session.client.getState().G);
          if (!save.actions.length) failUndo();
          save.actions.pop();
          const replacement = restoreLocalClient(save);
          session.client.stop();
          session.client = replacement;
          if (session.aiSeat) session.aiPaused = true;
        });
        return json(response, 200, view(data.id, session));
      }
      if (url.pathname === '/api/delete' && request.method === 'POST') {
        session.client.stop();
        sessions.delete(data.id);
        return json(response, 200, { ok: true });
      }
      return json(response, 404, { code: 'TARGET_NOT_FOUND' });
    }
    const name = routes.get(url.pathname);
    if (!name || !['GET', 'HEAD'].includes(request.method)) return json(response, 404, { code: 'TARGET_NOT_FOUND' });
    const content = await fs.readFile(path.join(root, name));
    response.writeHead(200, { ...headers, 'Content-Type': `${types[path.extname(name)]}; charset=utf-8` });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    json(response, 400, { code: error.code ?? 'INVALID_REQUEST' });
  }
});
server.on('close', () => {
  for (const session of sessions.values()) session.client.stop();
  playAi.close();
});
server.on('error', (error) => { console.error(`本地对局服务启动失败：${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`本地练习：${origin}/play.html`);
  console.log('可双人轮流，也可在页面确认后把另一席交给冠军模型。不运行Vite、不编译。按Ctrl+C停止。');
});
process.on('SIGINT', () => {
  playAi.close();
  server.close();
});
