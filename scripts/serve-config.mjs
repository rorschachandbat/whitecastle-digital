import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 只公开编辑器所需的静态文件，绑定本机回环地址；不构建项目。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawPort = process.argv[2] ?? '4174';
if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1024 || Number(rawPort) > 65535) {
  throw new Error('端口必须为 1024–65535 的整数');
}
const routes = new Map([
  ['/', ['config-editor.html', 'text/html']],
  ['/config-editor.html', ['config-editor.html', 'text/html']],
  ['/data/whitecastle-2p.json', ['data/whitecastle-2p.json', 'application/json']],
  ['/src/ui/configEditor.js', ['src/ui/configEditor.js', 'text/javascript']],
  ['/src/ui/StringTable.js', ['src/ui/StringTable.js', 'text/javascript']],
  ['/src/ui/styles.css', ['src/ui/styles.css', 'text/css']],
  ['/src/data/catalog.js', ['src/data/catalog.js', 'text/javascript']],
]);
const server = http.createServer(async (request, response) => {
  const target = routes.get(new URL(request.url, 'http://127.0.0.1').pathname);
  if (!target || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404);
    response.end();
    return;
  }
  try {
    const content = await fs.readFile(path.join(root, target[0]));
    response.writeHead(200, {
      'Content-Type': `${target[1]}; charset=utf-8`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(500);
    response.end();
  }
});
server.on('error', (error) => {
  console.error(`配置编辑器启动失败：${error.message}`);
  process.exitCode = 1;
});
server.listen(Number(rawPort), '127.0.0.1', () => {
  console.log(`配置编辑器：http://127.0.0.1:${rawPort}/config-editor.html`);
  console.log('只提供静态文件，不运行 Vite、不编译；按 Ctrl+C 停止。');
});
