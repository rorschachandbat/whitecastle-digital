import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { draftMatchFromBga, convertBgaDraft } from '../src/integrations/bgaTraining.js';
import { loadTrainingConfig } from '../scripts/ai-common.mjs';

const config = loadTrainingConfig();
const mapping = JSON.parse(fs.readFileSync(new URL('../data/bga-mapping.json', import.meta.url)));
const parameters = { ...config, mapping, teacherPlayers: ['101'] };

function fixture() {
  const card = (id, type, typeArg, locationArg) => ({ id, type, typeArg, locationArg });
  const data = {
    players: Object.fromEntries(['100', '101'].map((id) => [id, { score: '0', actionCard: false, lanternCards: [],
      extra: { food: 0, iron: 0, pearl: 0, coin: 0, seal: 0 } }])),
    gamestate: { id: 15, active_player: '101' },
    herons: [{ playerId: 100, locationArg: '1' }, { playerId: 101, locationArg: '2' }],
    stewardCards: [2, 4, 5].map((typeArg, i) => ({ ...card(10 + i, 'steward', typeArg, i + 1), location: 'main-board-steward' })),
    diplomatCards: [2, 3].map((typeArg, i) => ({ ...card(20 + i, 'diplomat', typeArg, i + 1), location: 'main-board-diplomat' })),
    stewardCardsDeckCount: 6, diplomatCardsDeckCount: 7,
    daimyoCard: { typeArg: 2 },
    gardenCards: [
      ...[1, 2, 3].map((typeArg, i) => ({ ...card(30 + i, 'plant', typeArg, ['red', 'black', 'white'][i]),
        foodCost: [5, 4, 4][i], pointValue: [9, 7, 7][i] })),
      ...[6, 7, 8].map((typeArg, i) => ({ ...card(40 + i, 'rock', typeArg, ['red', 'black', 'white'][i]),
        foodCost: [1, 1, 2][i], pointValue: [1, 1, 3][i] })),
    ],
    trainingYards: [1, 3, 5].map((cost, i) => ({ id: 3 - i, ironCost: cost, pointValue: cost === 5 ? 2 : 1,
      yardTiles: (cost === 1 ? [['back', 8]] : cost === 3 ? [['front', 7]] : [['front', 1], ['back', 4]])
        .map(([side, typeArg], j) => ({ type: 'base', side, typeArg, locationArg: j + 1 })) })),
    dieTiles: [-3, 3, 8, -2, 4, 9, -1, 5, 10, 1, 6, 2, 7].map((locationArg, i) => ({
      location: 'main-board', locationArg, side: 'front', type: ['red', 'black', 'white'][i % 3],
    })).concat([11, 12].map((locationArg) => ({ locationArg, side: 'back', back: 'food' }))),
    startingResourceCards: [8, 6, 9].map((typeArg, i) => card(50 + i, 'starting-resources', typeArg, i)),
    startingActionCards: [1, 2, 3].map((typeArg, i) => card(60 + i, 'starting-action', typeArg, i)),
  };
  const notifications = [];
  for (const [playerId, index] of [[101, 0], [100, 1]]) {
    notifications.push({ type: 'lanternCardGained', args: { playerId, card: data.startingResourceCards[index] } },
      { type: 'actionCardGained', args: { playerId, card: data.startingActionCards[index] } });
    const gains = index === 0 ? { food: 2, iron: 2, pearl: 1, coin: 4, seal: 1 }
      : { food: 1, iron: 2, pearl: 1, coin: 3, seal: 1 };
    for (const [asset, amount] of Object.entries(gains)) {
      notifications.push(asset === 'coin' ? { type: 'coinGained', args: { playerId, cardId: 50 + index, numberOfCoins: amount, coinValue: amount } }
        : asset === 'seal' ? { type: 'sealGained', args: { playerId, cardId: 50 + index, numberOfSeals: amount, sealValue: amount } }
          : { type: 'resourceGained', args: { playerId, cardId: 50 + index, resource: asset, numberOfResources: amount, resourceValue: amount } });
    }
  }
  notifications.push({ type: 'endDraft', args: [] });
  return { format: 'whitecastle-bga-raw-replay', version: 1, source: { table: '123', versions: { asset: mapping.gameAssetVersion } },
    validation: { initialStatePresent: true, terminalStatePresent: true },
    initialData: data, configuration: { tableOptions: [{ id: 120, value: 1 }, { id: 100, value: 2 },
      ...[104, 105, 108].map((id) => ({ id, value: 0 }))] },
    replayData: { data: [{ table_id: '123', data: notifications }] } };
}

test('真人起始选牌以本地候选编码，资源逐项对账且不监督全局价值', () => {
  const result = convertBgaDraft(fixture(), parameters);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.teacher, 0);
  assert.equal(row.candidates.length, 3);
  assert.equal(row.valueWeight, 0);
  assert.equal(row.z, 0);
  assert.equal(row.game, 'bga:123');
  assert.equal(row.provenance.resourcesVerified, true);
  assert.equal(row.provenance.player, '101');
  assert.ok(row.state.every(Number.isFinite));
});

test('未来事件和隐藏补牌无法影响选牌状态或标签，当前公开摆设能影响编码', () => {
  const original = fixture();
  const before = convertBgaDraft(original, parameters).rows;
  const future = structuredClone(original);
  future.replayData.data.push({ table_id: '123', data: [{ type: 'newMainBoardCardRevealed', args: { secret: 'future' } }] });
  future.history = { scores: '99,1', ranks: '1,2' };
  assert.deepEqual(convertBgaDraft(future, parameters).rows, before);
  const current = structuredClone(original);
  current.initialData.daimyoCard.typeArg = 3;
  assert.notDeepEqual(convertBgaDraft(current, parameters).rows[0].state, before[0].state);
});

test('资源不一致、旧资产、多人、未知设置、选牌撤销整局拒绝', () => {
  for (const [change, code] of [
    [(a) => { a.initialData.players.other = {}; }, 'BGA_NOT_TWO_PLAYERS'],
    [(a) => { a.source.versions.asset = 'old'; }, 'BGA_VERSION_UNSUPPORTED'],
    [(a) => { a.configuration.tableOptions = []; }, 'BGA_OPTIONS_UNKNOWN'],
    [(a) => { a.replayData.data[0].data[2].args.resourceValue = 7; }, 'BGA_DRAFT_GAIN_UNSUPPORTED'],
    [(a) => { a.replayData.data[0].data[2].args.isUndo = true; }, 'BGA_DRAFT_UNDO_UNSUPPORTED'],
  ]) {
    const value = fixture();
    change(value);
    assert.throws(() => convertBgaDraft(value, parameters), { code });
  }
});

test('起始牌副本和实例对齐，房间骰色严格取实际槽位', () => {
  const value = fixture();
  const { match } = draftMatchFromBga(value, config.catalog, mapping);
  assert.equal(match.config.setup.castleRooms[0].tiles[0].color, 'coral');
  assert.equal(match.draft.pairs[0].resourceId, mapping.mappings['starting-resources']['8']);
  value.initialData.dieTiles[0].locationArg = -2;
  assert.throws(() => draftMatchFromBga(value, config.catalog, mapping), { code: 'BGA_DIE_TILE_INVALID' });
});

test('任选资源按实际收益生成合法子选择，灯笼牌缺失会被拒绝', () => {
  const value = fixture();
  value.initialData.startingResourceCards[0].typeArg = 2;
  const events = value.replayData.data[0].data;
  const preserved = events.filter((event) => event.args.playerId !== 101
    || ['lanternCardGained', 'actionCardGained'].includes(event.type));
  const insert = preserved.findIndex((event) => event.args.playerId === 100);
  preserved.splice(insert, 0,
    { type: 'coinGained', args: { playerId: 101, cardId: 50, numberOfCoins: 4, coinValue: 4 } },
    { type: 'sealGained', args: { playerId: 101, cardId: 50, numberOfSeals: 2, sealValue: 2 } },
    { type: 'resourceGained', args: { playerId: 101, cardId: 50, resource: 'pearl', numberOfResources: 2, resourceValue: 2 } });
  value.replayData.data[0].data = preserved;
  const result = convertBgaDraft(value, parameters);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows.map((row) => row.request), ['root', 'chooseResource', 'chooseResource']);
  value.initialData.startingResourceCards[0].typeArg = 7;
  assert.throws(() => convertBgaDraft(value, parameters));
});

test('敕令使用牌背语义映射，必须与资源卡授予的灯笼牌相符', () => {
  const value = fixture();
  value.initialData.startingResourceCards[0].typeArg = 4;
  const existing = value.replayData.data[0].data;
  const events = existing.filter((event) => event.args.playerId !== 101
    || ['lanternCardGained', 'actionCardGained'].includes(event.type));
  const insert = events.findIndex((event) => event.args.playerId === 100);
  events.splice(insert, 0,
    { type: 'lanternCardGained', args: { playerId: 101, card: { id: 90, type: 'decree', typeArg: 3, back: 'seal' } } },
    { type: 'coinGained', args: { playerId: 101, cardId: 50, numberOfCoins: 4, coinValue: 4 } },
    { type: 'resourceGained', args: { playerId: 101, cardId: 50, resource: 'pearl', numberOfResources: 2, resourceValue: 2 } },
    { type: 'resourceGained', args: { playerId: 101, cardId: 50, resource: 'iron', numberOfResources: 1, resourceValue: 1 } });
  value.replayData.data[0].data = events;
  assert.equal(convertBgaDraft(value, parameters).rows.length, 1);
  events.find((event) => event.args.card?.type === 'decree').args.card.back = 'coin';
  assert.throws(() => convertBgaDraft(value, parameters), { code: 'BGA_DRAFT_LANTERN_MISMATCH' });
});
