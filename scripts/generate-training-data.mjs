import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import { TrainingEnvironment } from '../src/ai/environment.js';
import { chooseHeuristic } from '../src/ai/heuristicPolicy.js';
import { loadTrainingConfig } from './ai-common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  games: { type: 'string', default: '16' }, out: { type: 'string' },
  prefix: { type: 'string', default: 'ai-guide-v1' }, catalog: { type: 'string' }, weights: { type: 'string' },
} });
const { catalog, weights, meta } = loadTrainingConfig(values.catalog, values.weights);
const games = Number(values.games);
if (!Number.isSafeInteger(games) || games < 2 || games > 100000) throw new Error('AI_INVALID_GAME_COUNT');
const output = path.resolve(values.out ?? path.join(root, '.local', 'ai', 'guide.jsonl.gz'));
fs.mkdirSync(path.dirname(output), { recursive: true });
if (fs.existsSync(output)) throw new Error('AI_OUTPUT_EXISTS');
const file = fs.createWriteStream(output, { flags: 'wx' });
const stream = output.endsWith('.gz') ? createGzip() : file;
if (stream !== file) stream.pipe(file);
file.on('error', (error) => stream.destroy(error));
let records = 0;
const results = [];
const started = Date.now();

for (let game = 0; game < games; game += 1) {
  const rows = [];
  const seed = `${values.prefix}-${game}`;
  try {
    const environment = new TrainingEnvironment(catalog, weights);
    let observation = environment.reset(seed, game % 2 ? ['1', '0'] : ['0', '1']);
    let step = 0;
    while (!observation.done) {
      const best = chooseHeuristic(observation.heuristic);
      rows.push({ ...meta, state: observation.state, candidates: observation.candidates,
        teacher: best, heuristic: observation.heuristic, actor: observation.actor,
        game: seed, step: step++, request: observation.request });
      observation = environment.step(best);
    }
    if (observation.placements !== 18 || !observation.score.complete) throw new Error('AI_INCOMPLETE_GAME');
    for (const row of rows) {
      row.z = observation.score.winner === row.actor ? 1 : -1;
      if (!stream.write(`${JSON.stringify(row)}\n`)) await once(stream, 'drain');
      records += 1;
    }
    results.push({ seed, decisions: observation.decisions, score: observation.score });
    console.log(JSON.stringify({ game: game + 1, games, records, seconds: (Date.now() - started) / 1000 }));
  } catch (error) {
    stream.end();
    throw new Error(`AI_GAME_FAILED:${seed}:${error.code ?? error.message}`, { cause: error });
  }
}
const finished = once(file, 'close');
stream.end();
await finished;
const report = { ...meta, games, completed: results.length, records, output,
  seconds: (Date.now() - started) / 1000, results };
fs.writeFileSync(`${output}.report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ games, completed: results.length, records, output, seconds: report.seconds }));
