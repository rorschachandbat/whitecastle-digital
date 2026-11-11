import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createLocalClient, restoreLocalClient, submitLocalAction } from '../src/game/localClient.js';
import { exportLocalMatch } from '../src/engine/localMatch.js';
import { probeLocalAction } from '../src/engine/actionOptions.js';
import { parseCatalog } from '../src/data/catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawPort = process.argv[2] ?? '4176';
if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1024 || Number(rawPort) > 65535) throw new Error('端口必须为1024–65535的整数');
const port = Number(rawPort);
const origin = `http://127.0.0.1:${port}`;
const sessions = new Map();
const sourceRoutes = [
  'src/ui/play.js', 'src/ui/play.css', 'src/ui/StringTable.js', 'src/ui/configEditor.js', 'src/ui/styles.css',
  'src/engine/actionOptions.js', 'src/engine/localMatch.js', 'src/engine/engine.js',
  'src/engine/startingDraft.js', 'src/engine/influence.js', 'src/engine/cardRules.js', 'src/data/catalog.js',
];
const routes = new Map([
  ['/', 'play.html'], ['/play.html', 'play.html'], ['/config-editor.html', 'config-editor.html'],
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
function view(id, client) {
  const { G, ctx } = client.getState();
  return { id, match: G, framework: { currentPlayer: ctx.currentPlayer, turn: ctx.turn, gameover: ctx.gameover ?? null } };
}
const server = http.createServer(async (request, response) => {
  if (request.headers.host !== `127.0.0.1:${port}` && request.headers.host !== `localhost:${port}`) return json(response, 403, { code: 'ORIGIN_REJECTED' });
  if (request.headers.origin && ![origin, `http://localhost:${port}`].includes(request.headers.origin)) return json(response, 403, { code: 'ORIGIN_REJECTED' });
  const url = new URL(request.url, origin);
  try {
    if (url.pathname === '/api/session' && request.method === 'POST') {
      if (sessions.size >= 24) return json(response, 409, { code: 'SESSION_LIMIT' });
      const data = await bodyOf(request);
      const catalog = data.catalog ? parseCatalog(JSON.stringify(data.catalog))
        : parseCatalog(await fs.readFile(path.join(root, 'data/whitecastle-2p.json'), 'utf8'));
      const client = data.save ? restoreLocalClient(data.save) : createLocalClient(catalog, { seed: data.seed ?? 'whitecastle-local-v1' });
      const id = randomUUID();
      sessions.set(id, client);
      return json(response, 200, view(id, client));
    }
    if (url.pathname.startsWith('/api/')) {
      const data = request.method === 'GET' ? { id: url.searchParams.get('id') } : await bodyOf(request);
      const client = sessions.get(data.id);
      if (!client) return json(response, 404, { code: 'SESSION_NOT_FOUND' });
      if (url.pathname === '/api/state' && request.method === 'GET') return json(response, 200, view(data.id, client));
      if (url.pathname === '/api/probe' && request.method === 'POST') return json(response, 200, probeLocalAction(client.getState().G, data.action));
      if (url.pathname === '/api/action' && request.method === 'POST') {
        submitLocalAction(client, data.action);
        return json(response, 200, view(data.id, client));
      }
      if (url.pathname === '/api/undo' && request.method === 'POST') {
        const save = exportLocalMatch(client.getState().G);
        save.actions.pop();
        const replacement = restoreLocalClient(save);
        client.stop();
        sessions.set(data.id, replacement);
        return json(response, 200, view(data.id, replacement));
      }
      if (url.pathname === '/api/delete' && request.method === 'POST') {
        client.stop();
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
server.on('close', () => { for (const client of sessions.values()) client.stop(); });
server.on('error', (error) => { console.error(`本地对局服务启动失败：${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`本地双人练习：${origin}/play.html`);
  console.log('boardgame.io在本机承载对局；不运行Vite、不编译。按Ctrl+C停止。');
});
