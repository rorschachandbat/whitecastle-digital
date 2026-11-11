import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { bgaMappingCoverage, importBgaObservation, mapBgaDefinition, scoreBgaPublicPosition } from '../src/integrations/bgaReplay.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/whitecastle-2p.json', import.meta.url)));
const mapping = JSON.parse(fs.readFileSync(new URL('../data/bga-mapping.json', import.meta.url)));
const source = { table: 'fixture', gameAssetVersion: '260825-0951' };
const options = { catalog, mapping, source, seatMap: { a: '0', b: '1' } };
const item = (id, face, extra = {}) => ({ id, face, data: { side: 'front' }, ancestors: [], ...extra });
const observation = () => ({
  format: 'whitecastle-bga-observation', version: 1, cursor: 1, progress: 0,
  players: ['a', 'b'].map((id, index) => ({
    id, color: ['rgb(94, 150, 208)', '#0a9e36'][index], score: 0,
    resources: { food: 0, iron: 0, pearl: 0, coin: 0, seal: 0 },
  })),
  cards: [], tiles: [], pieces: [], decks: [],
  dice: ['red', 'black', 'white'].flatMap((color) => [1, 2, 3].map((value) => (
    item(`${color}-${value}`, {}, {
      data: { type: color, value: String(value) }, ancestors: [{ slot: `${color}-${value}` }],
    })
  ))),
  logs: [{ move: 2, entries: [{ text: 'fixture' }] }],
});

test('映射覆盖全部两人实体和训练单面，三四人专用牌明确排除', () => {
  assert.deepEqual(bgaMappingCoverage(catalog, mapping), {
    cards: { mapped: 55, total: 55, missing: [] }, yardFaces: { mapped: 16, total: 16, missing: [] },
  });
  assert.equal(mapBgaDefinition(mapping, 'daimyo', 5), 'top-5');
  assert.equal(mapBgaDefinition(mapping, 'daimyo', 8), 'top-2');
  assert.equal(mapBgaDefinition(mapping, 'diplomat', 10), 'diplomat-d03');
  assert.equal(mapBgaDefinition(mapping, 'diplomat', 9).excludedInTwoPlayers, true);
  assert.equal(mapBgaDefinition(mapping, 'yard', 7, 'back'), 'yard-face-14');
  assert.throws(() => mapBgaDefinition(mapping, 'garden', 99), { code: 'BGA_MAPPING_MISSING' });
});

test('不同实例使用定义映射；背面只保留收益，不用未来历史猜正面', () => {
  const obs = observation();
  obs.cards = [
    item('twc-main-card-99', { type: 'steward', typeArg: '5' }),
    item('twc-main-card-1', { type: 'steward', typeArg: 'coin' }, { data: { side: 'back' } }),
  ];
  const archive = importBgaObservation(obs, options);
  assert.equal(archive.publicPosition.cards[0].localId, 'steward-s15');
  assert.equal(archive.publicPosition.cards[1].localId, null);
  assert.deepEqual(archive.publicPosition.cards[1].back, [{ type: 'coin', amount: 1 }]);
  assert.equal(archive.publicPosition.history, undefined);
  assert.equal(archive.history[0].move, 2);
  assert.equal(archive.status.trainingEligible, false);
  assert.equal(archive.status.executable, false);
});

test('相同起始行动设计保留两个不同实体，第三张拒绝对应', () => {
  const obs = observation();
  obs.cards = [10, 11, 12].map((id) => item(`twc-main-card-${id}`, { type: 'starting-action', typeArg: '1' }));
  const archive = importBgaObservation(obs, options);
  assert.deepEqual(archive.publicPosition.cards.map((card) => card.localId), [
    'start-action-courtier-1', 'start-action-courtier-2', null,
  ]);
  assert.ok(archive.status.issues.some((issue) => issue.code === 'BGA_DUPLICATE_CARD'));
});

test('缺失资源或版本差异拒绝导入，不默认零', () => {
  const obs = observation();
  delete obs.players[0].resources.food;
  assert.throws(() => importBgaObservation(obs, options), { code: 'BGA_RESOURCE_MISSING' });
  assert.throws(() => importBgaObservation(observation(), {
    ...options, source: { ...source, gameAssetVersion: 'unknown' },
  }), { code: 'BGA_ASSET_VERSION_MISMATCH' });
  assert.throws(() => importBgaObservation(observation(), {
    ...options, catalog: { ...catalog, revision: 3 },
  }), { code: 'BGA_CATALOG_MISMATCH' });
  const invalidColor = observation();
  invalidColor.players[0].color = null;
  assert.throws(() => importBgaObservation(invalidColor, options), { code: 'BGA_PLAYER_COLOR_INVALID' });
  const duplicateColor = observation();
  duplicateColor.players[0].color = duplicateColor.players[1].color;
  assert.throws(() => importBgaObservation(duplicateColor, options), { code: 'BGA_PLAYER_COLOR_INVALID' });
});

test('棋子颜色稳定对应座位；未来日志与撤销只进入历史区', () => {
  const obs = observation();
  obs.pieces = [item('piece', { type: 'courtier', color: '#5e96d0' })];
  obs.logs.push({ move: 3, entries: [{ text: '玩家 撤销其上一行动' }] });
  const before = structuredClone(obs);
  const archive = importBgaObservation(obs, options);
  assert.equal(archive.publicPosition.pieces[0].owner, '0');
  assert.deepEqual(archive.historySummary.undoMoves, [3]);
  assert.equal(archive.historySummary.entries, 2);
  assert.deepEqual(obs, before);
});

test('计分前公开快照复用引擎计分，终局已加分的快照不得重复计分', () => {
  const obs = observation();
  obs.players[0].score = 5;
  obs.players[1].score = 8;
  obs.pieces = [
    item('influence-a', { type: 'influence', color: '#5e96d0' }, { ancestors: [{ slot: 'influence-7' }] }),
    item('influence-b', { type: 'influence', color: '#0a9e36' }, { ancestors: [{ slot: 'influence-10' }] }),
    item('courtier', { type: 'courtier', color: '#5e96d0' }, { ancestors: [{ id: 'twc-castle-room-main-board-steward-1-courtier-stock' }] }),
    item('warrior', { type: 'warrior', color: '#5e96d0' }, { ancestors: [{ id: 'twc-training-yard-1' }] }),
  ];
  const archive = importBgaObservation(obs, options);
  const report = scoreBgaPublicPosition(archive, catalog, { scoreTiming: 'before-final-scoring' });
  assert.equal(report.result.complete, true);
  assert.equal(report.result.players['0'].total, 13);
  assert.equal(report.result.players['0'].parts.warrior, 2);
  assert.equal(report.result.players['1'].total, 11);
  assert.equal(report.actionReplayVerified, false);
  archive.publicPosition.progress = 100;
  assert.throws(() => scoreBgaPublicPosition(archive, catalog, { scoreTiming: 'before-final-scoring' }),
    { code: 'BGA_SCORE_INPUT_INVALID' });
});
