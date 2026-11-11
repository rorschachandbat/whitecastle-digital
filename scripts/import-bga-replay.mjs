import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importBgaObservation, bgaMappingCoverage, scoreBgaPublicPosition } from '../src/integrations/bgaReplay.js';
import { canonicalCatalog } from '../src/data/catalog.js';

// 从脚本位置找目录；输入和输出路径相对调用者，不依赖盘符或分支名。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [input, output, prefinalInput] = process.argv.slice(2);
if (!input || !output) throw new Error('用法：node scripts/import-bga-replay.mjs 输入.json 输出.json [计分前观察.json]');
const request = JSON.parse(await fs.readFile(input, 'utf8'));
const [catalog, mapping] = await Promise.all(['whitecastle-2p.json', 'bga-mapping.json'].map(async (name) => (
  JSON.parse(await fs.readFile(path.join(root, 'data', name), 'utf8'))
)));
const archive = importBgaObservation(request.observation, {
  catalog, mapping, source: request.source, seatMap: request.seatMap,
});
if (prefinalInput) {
  const observation = JSON.parse(await fs.readFile(prefinalInput, 'utf8'));
  if (archive.publicPosition.progress !== 100 || observation.cursor >= archive.publicPosition.cursor) {
    throw new Error('最终观察与计分前观察的时点不符');
  }
  const before = importBgaObservation(observation, {
    catalog, mapping, source: request.source, seatMap: request.seatMap,
  });
  // 计分前后资源、实际人员位置必须一致，防止误拿其他时点凑出同分。
  const scoreBasis = (position) => ({
    players: position.players.map(({ seat, resources }) => ({ seat, resources })),
    pieces: position.pieces.filter((piece) => piece.type !== 'heron')
      .sort((left, right) => left.instance.localeCompare(right.instance)),
    gardens: position.cards.filter((card) => card.family === 'garden'),
  });
  if (canonicalCatalog(scoreBasis(before.publicPosition)) !== canonicalCatalog(scoreBasis(archive.publicPosition))) {
    throw new Error('计分前后资源或人员位置不一致');
  }
  const report = scoreBgaPublicPosition(before, catalog, { scoreTiming: 'before-final-scoring' });
  report.matchesDisplayedScores = report.result.complete && archive.publicPosition.players.every((player) => (
    report.result.players[player.seat].total === player.displayedScore
  ));
  archive.validation = { terminalScore: report };
}
await fs.writeFile(output, `${JSON.stringify(archive, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({
  output: path.resolve(output), coverage: bgaMappingCoverage(catalog, mapping),
  status: archive.status, history: archive.historySummary,
  scores: archive.publicPosition.players.map(({ seat, displayedScore }) => ({ seat, displayedScore })),
  validation: archive.validation ?? null,
}, null, 2));
