import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { loadTrainingConfig, projectRoot } from './ai-common.mjs';
import { convertBgaDraft, BGA_TRAINING_VERSION } from '../src/integrations/bgaTraining.js';

const { values } = parseArgs({ options: {
  database: { type: 'string', default: path.join(projectRoot, '.local/bga-database') },
  out: { type: 'string' }, players: { type: 'string' }, catalog: { type: 'string' }, weights: { type: 'string' },
} });
if (!values.out) throw new Error('BGA_OUTPUT_REQUIRED');
const output = path.resolve(values.out);
if (!output.endsWith('.jsonl.gz') || fs.existsSync(output) || fs.existsSync(`${output}.report.json`)) throw new Error('BGA_OUTPUT_EXISTS_OR_INVALID');
const config = loadTrainingConfig(values.catalog, values.weights);
const mappingPath = path.join(projectRoot, 'data/bga-mapping.json');
const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
const database = path.resolve(values.database);
const owners = (values.players?.split(',') ?? fs.readdirSync(database).filter((name) => /^\d+$/.test(name))).sort();
if (!owners.length || owners.some((name) => !/^\d+$/.test(name))) throw new Error('BGA_PLAYERS_INVALID');
const sources = new Map();
const sourceStatus = {};
for (const player of owners) {
  const folder = path.join(database, player);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  if (manifest.player !== player || manifest.gameId !== 2242) throw new Error('BGA_MANIFEST_IDENTITY');
  sourceStatus[player] = { phase: manifest.phase, updatedAt: manifest.updatedAt, summary: manifest.summary };
  for (const [table, record] of Object.entries(manifest.tables)) {
    if (record.status !== 'downloaded') continue;
    if (!/^\d+$/.test(table) || record.path !== `replays/${table}.json.gz`) throw new Error('BGA_MANIFEST_PATH');
    if (!sources.has(table)) sources.set(table, { folder, record });
  }
}
const rows = [];
const tables = [];
const rejected = {};
for (const [table, { folder, record }] of sources) {
  try {
    const raw = fs.readFileSync(path.join(folder, record.path));
    const hash = createHash('sha256').update(raw).digest('hex');
    if (hash !== record.sha256) throw new Error('BGA_RAW_HASH_MISMATCH');
    const archive = JSON.parse(gunzipSync(raw, { maxOutputLength: 64 * 1024 * 1024 }));
    if (String(archive.source?.table) !== table) throw new Error('BGA_RAW_TABLE_MISMATCH');
    const result = convertBgaDraft(archive, { ...config, mapping, teacherPlayers: owners });
    if (!result.rows.length) throw new Error('BGA_NO_REQUESTED_TEACHER');
    for (const row of result.rows) row.provenance.rawSha256 = hash;
    rows.push(...result.rows);
    tables.push({ table, status: 'accepted', records: result.rows.length, rawSha256: hash });
  } catch (error) {
    // 只记录明确的机器错误，第三方文本和账号内容不得成为诊断消息。
    const code = /^BGA_[A-Z_]+$/.test(error.code ?? error.message) ? error.code ?? error.message : 'BGA_CONVERSION_FAILED';
    rejected[code] = (rejected[code] ?? 0) + 1;
    tables.push({ table, status: 'rejected', code });
  }
}
if (!rows.length) throw new Error('BGA_NO_VERIFIED_DECISIONS');
const bytes = gzipSync(rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
const report = { ...config.meta, datasetFormat: BGA_TRAINING_VERSION, scope: 'starting-draft-only',
  fullActionReplayVerified: false, policyOnly: true, teacherPlayers: owners,
  games: new Set(rows.map((row) => row.game)).size, completed: new Set(rows.map((row) => row.game)).size,
  records: rows.length, availableTables: sources.size, rejected, sourceStatus, tables,
  datasetSha256: createHash('sha256').update(bytes).digest('hex'),
  converterHash: createHash('sha256').update(fs.readFileSync(new URL('../src/integrations/bgaTraining.js', import.meta.url)))
    .update(fs.readFileSync(mappingPath)).digest('hex'),
  createdAt: new Date().toISOString() };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(`${output}.tmp`, bytes, { flag: 'wx' });
fs.renameSync(`${output}.tmp`, output);
fs.writeFileSync(`${output}.report.json.tmp`, JSON.stringify(report, null, 2), { flag: 'wx' });
fs.renameSync(`${output}.report.json.tmp`, `${output}.report.json`);
console.log(JSON.stringify({ output, games: report.games, records: rows.length,
  availableTables: sources.size, rejected, scope: report.scope }));
