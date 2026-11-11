import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringTable } from '../src/ui/StringTable.js';

// 从脚本位置确定根目录，支持在不同分支工作副本及其他当前目录执行。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'AGENTS.md', 'README.md', 'CHANGELOG.md',
  'docs/RULES.md', 'docs/boardgameio-guide.md', 'docs/implementation-plan.md',
  'docs/development-workflow.md', 'docs/sources.md', 'docs/deployment.md', 'docs/CHANGELOG.md',
  'src/game/CHANGELOG.md', 'src/ui/CHANGELOG.md',
  'scripts/CHANGELOG.md', 'tests/CHANGELOG.md',
];
for (const name of required) {
  if (!fs.existsSync(path.join(root, name))) {
    throw new Error(`缺少项目文件：${name}`);
  }
}

const source = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const keys = [...source.matchAll(/(?:text|element)\(\s*['"]([^'"]+)['"]/g)]
  .filter((match) => match[0].startsWith('text'))
  .map((match) => match[1]);
// 页面文案有些以数组形式传递，额外检查全部已声明的文案键。
for (const match of source.matchAll(/['"]((?:app|status|framework|rules|guide|plan|workflow|changelog|roadmap|footer)\.[A-Za-z]+)['"]/g)) {
  keys.push(match[1]);
}
for (const key of keys) {
  if (!(key in StringTable)) throw new Error(`缺少 StringTable 键：${key}`);
}

for (const match of source.matchAll(/import\s+(?:.*?from\s+)?['"](\.\.?\/[^'"]+)['"]/g)) {
  const target = match[1].replace(/\?raw$/, '');
  if (!fs.existsSync(path.resolve(root, 'src', target))) {
    throw new Error(`导入目标不存在：${target}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.dependencies['boardgame.io'] !== '0.50.2') {
  throw new Error('框架版本变化后应同步核对指南和兼容性');
}

// 只核验已存在文档的相对文件链接，不发起外网请求，也不推断标题锚点。
const documents = [
  'README.md',
  ...fs.readdirSync(path.join(root, 'docs')).filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`),
];
let localLinkCount = 0;
for (const file of documents) {
  const body = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue;
    const relative = decodeURIComponent(href.split('#')[0]);
    if (!fs.existsSync(path.resolve(root, path.dirname(file), relative))) {
      throw new Error(`文档链接目标不存在：${file} → ${href}`);
    }
    localLinkCount += 1;
  }
}
console.log(`项目结构、导入路径、${new Set(keys).size} 个界面文案键及 ${localLinkCount} 个文档本地链接检查通过。`);
