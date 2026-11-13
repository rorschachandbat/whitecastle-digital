import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { projectRoot, loadTrainingConfig } from './ai-common.mjs';
import { auditBgaReplay } from '../src/integrations/bgaAudit.js';

const { values } = parseArgs({ options: {
  database: { type: 'string', default: path.join(projectRoot, '.local/bga-database') },
  out: { type: 'string' }, catalog: { type: 'string' }, players: { type: 'string' },
} });
if (!values.out) throw new Error('BGA_AUDIT_OUTPUT_REQUIRED');
const out = path.resolve(values.out);
if (!out.startsWith(`${path.join(projectRoot, '.local')}${path.sep}`)) throw new Error('BGA_AUDIT_PRIVATE_OUTPUT_REQUIRED');
if (fs.existsSync(out)) throw new Error('BGA_AUDIT_OUTPUT_EXISTS');
const { catalog } = loadTrainingConfig(values.catalog);
const mapping = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data/bga-mapping.json'), 'utf8'));
const database = path.resolve(values.database);
const owners = values.players?.split(',') ?? fs.readdirSync(database).filter((name) => /^\d+$/.test(name));
if (!owners.length || owners.some((name) => !/^\d+$/.test(name))) throw new Error('BGA_AUDIT_PLAYERS');
const seen = new Set();
const tables = [];
const rejected = {};
for (const owner of owners) {
  const folder = path.join(database, owner);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  if (manifest.player !== owner || manifest.gameId !== 2242) throw new Error('BGA_AUDIT_MANIFEST_IDENTITY');
  for (const [table, record] of Object.entries(manifest.tables)) {
    if (record.status !== 'downloaded' || seen.has(table)) continue;
    seen.add(table);
    try {
      if (!/^\d+$/.test(table) || record.path !== `replays/${table}.json.gz`) throw new Error('BGA_AUDIT_MANIFEST_PATH');
      const raw = fs.readFileSync(path.join(folder, record.path));
      const hash = createHash('sha256').update(raw).digest('hex');
      if (hash !== record.sha256) throw new Error('BGA_AUDIT_HASH');
      const archive = JSON.parse(gunzipSync(raw, { maxOutputLength: 64 * 1024 * 1024 }));
      if (String(archive.source?.table) !== table) throw new Error('BGA_AUDIT_TABLE_IDENTITY');
      tables.push({ ...auditBgaReplay(archive, { catalog, mapping }), rawSha256: hash });
    } catch (error) {
      // 第三方文本与账号资料不能拼入共享诊断；明细报告只写本机忽略目录。
      const code = /^BGA_[A-Z_]+$/.test(error.code ?? error.message) ? error.code ?? error.message : 'BGA_AUDIT_FAILED';
      rejected[code] = (rejected[code] ?? 0) + 1;
      tables.push({ table, rejected: code });
    }
  }
}
const audited = tables.filter((table) => !table.rejected);
const clean = audited.filter((table) => table.scoreMatched && !table.issues.length);
const players = audited.filter((table) => table.scoreMatched).flatMap((table) => table.players);
const average = (items, get) => items.length ? items.reduce((sum, item) => sum + get(item), 0) / items.length : null;
const report = { format: 'whitecastle-bga-audit-batch', version: 1, createdAt: new Date().toISOString(),
  catalogHash: createHash('sha256').update(JSON.stringify(catalog)).digest('hex'),
  mappingHash: createHash('sha256').update(JSON.stringify(mapping)).digest('hex'),
  fullActionReplayVerified: false, trainingEligible: false, available: seen.size,
  audited: audited.length, clean: clean.length, rejected,
  scoreMismatches: audited.filter((table) => !table.scoreMatched).length,
  notificationIssues: audited.reduce((sum, table) => sum + table.issues.length, 0),
  summary: { players: players.length, average: average(players, (item) => item.local.total),
    max: players.length ? Math.max(...players.map((item) => item.local.total)) : null,
    atLeast60: players.filter((item) => item.local.total >= 60).length,
    atLeast80: players.filter((item) => item.local.total >= 80).length,
    parts: Object.fromEntries(['points', 'coinAndSeal', 'resources', 'courtier', 'warrior', 'gardener', 'time']
      .map((key) => [key, average(players, (item) => item.local.parts[key])])),
  }, tables };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ ...report, tables: undefined, out }, null, 2));
