import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { auditBgaReplay } from '../src/integrations/bgaAudit.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/whitecastle-2p.json', import.meta.url)));
const mapping = JSON.parse(fs.readFileSync(new URL('../data/bga-mapping.json', import.meta.url)));
const parameters = { catalog, mapping };

/** 合成对局不包含真人账号；只覆盖投影、门槛和计分，不冒充完整规则动作链。 */
function fixture() {
  const players = Object.fromEntries(['100', '101'].map((id) => [id, {
    score: '0', extra: { coin: 0, seal: 0, food: 0, iron: 0, pearl: 0 },
    ...Object.fromEntries(['courtier', 'warrior', 'gardener'].map((type) => [`${type}s`,
      Array.from({ length: 5 }, (_, i) => ({ id: `${id}-${type}-${i}`, playerId: Number(id), type,
        location: `player-${type}-${id}`, locationArg: String(i + 1) }))])),
  }]));
  const dice = () => ['red', 'black', 'white'].flatMap((type, i) =>
    ['left', 'center', 'right'].map((locationArg, j) => ({ id: i * 3 + j + 1, type, side: 1, location: 'bridge', locationArg })));
  const data = { players, roundNumber: 0, bridgeDice: dice(), actionSpaceDice: [],
    influenceMarkers: ['100', '101'].map((id) => ({ playerId: Number(id), location: 'influence-0' })),
    herons: ['100', '101'].map((id, i) => ({ playerId: Number(id), locationArg: String(i + 1) })),
    gardenCards: [1, 2, 3, 6, 7, 8].map((typeArg, i) => {
      const card = catalog.cards.find((item) => item.id === mapping.mappings.garden[typeArg]);
      return { id: i + 1, typeArg, locationArg: ['red', 'black', 'white'][i % 3],
        foodCost: card.foodCost, pointValue: card.victoryPoints };
    }),
    trainingYards: [1, 3, 5].map((ironCost, i) => ({ id: 3 - i, ironCost, pointValue: ironCost === 5 ? 2 : 1 })),
    stewardCards: [2, 4, 5].map((typeArg, i) => ({ typeArg, location: 'main-board-steward', locationArg: i + 1 })),
    diplomatCards: [2, 3].map((typeArg, i) => ({ typeArg, location: 'main-board-diplomat', locationArg: i + 1 })),
    dieTiles: [-3, 3, 8, -2, 4, 9, -1, 5, 10, 1, 6, 2, 7].map((locationArg, i) =>
      ({ locationArg, side: 'front', type: ['red', 'black', 'white'][i % 3] })),
  };
  const events = [{ type: 'gameStateChange', args: { name: 'gameSetup' } }];
  const emit = (type, args) => events.push({ type, args });
  for (const roundNumber of [1, 2, 3]) {
    emit('roundNumberUpdated', { roundNumber });
    if (roundNumber > 1) emit('diceRolled', { dice: dice() });
    let bridge = dice();
    // 每座桥取左、右、剩余左端；每轮两人各用三骰，白桥保留三骰。
    for (const [i, dieId] of [1, 3, 2, 4, 6, 5].entries()) {
      const source = bridge.find((die) => die.id === dieId);
      emit('diePlaced', { playerId: i % 2 ? 101 : 100, die: { ...source, location: 'action-space-main-board-well', locationArg: '1' },
        actionSpace: { id: 'action-space-main-board-well', type: 'any', value: 1 }, isUndo: false });
      bridge = bridge.filter((die) => die.id !== dieId);
      const same = bridge.filter((die) => die.type === source.type);
      if (same.length === 2) {
        const center = same.find((die) => die.locationArg === 'center');
        center.locationArg = source.locationArg;
      }
      emit('bridgeDiceUpdated', { bridgeDice: structuredClone(bridge) });
    }
  }
  const gain = (kind, quantity, value = quantity) => emit(kind === 'coin' ? 'coinGained' : kind === 'seal' ? 'sealGained' : 'resourceGained',
    { playerId: 100, resource: kind, numberOfCoins: quantity, numberOfSeals: quantity,
      numberOfResources: quantity, coinValue: value, sealValue: value, resourceValue: value, isUndo: false });
  gain('coin', 4); gain('seal', 1); gain('food', 3); gain('iron', 7); gain('pearl', 2);
  emit('scoreUpdated', { playerId: 100, score: 8 });
  emit('scoreUpdated', { playerId: 101, score: 21 });
  const piece = (type, i, location, locationArg = '1') => emit(`${type}Assigned`,
    { playerId: 100, [type]: { ...players['100'][`${type}s`][i], location, locationArg }, isUndo: false });
  piece('courtier', 0, 'main-board-gate');
  piece('courtier', 1, 'main-board-steward-1');
  piece('courtier', 2, 'main-board-daimyo');
  piece('warrior', 0, 'yard', '1');
  piece('warrior', 1, 'yard', '3');
  piece('gardener', 0, 'garden', '1');
  emit('passageOfTimeMoved', { influenceMarkers: [
    { playerId: 100, location: 'influence-6' }, { playerId: 101, location: 'influence-0' },
  ] });
  emit('gameStateChange', { id: 95 });
  emit('updateLiveScore', { scoreBreakdown: {
    100: { vpDuringTheGame: 8, coinsAndSeals: 1, food: 1, iron: 2, pearl: 0,
      passageOfTime: 3, courtiers: 14, warriors: 6, gardeners: 9, score: 44 },
    101: { vpDuringTheGame: 21, coinsAndSeals: 0, food: 0, iron: 0, pearl: 0,
      passageOfTime: 0, courtiers: 0, warriors: 0, gardeners: 0, score: 21 },
  } });
  for (const [playerId, score] of [[100, 44], [101, 21]]) {
    emit('scoreUpdated', { playerId, score });
    emit('setPlayerCounter', { playerId, name: 'player_score', value: score });
  }
  emit('gameStateChange', { id: 99 });
  return { format: 'whitecastle-bga-raw-replay', version: 1,
    source: { table: '123', versions: { asset: mapping.gameAssetVersion } },
    history: { players: '100,101', scores: '44,21', concede: '0' },
    validation: { initialStatePresent: true, terminalStatePresent: true }, initialData: data,
    configuration: { tableOptions: [{ id: 120, value: 1 }, { id: 100, value: 2 },
      ...[104, 105, 108].map((id) => ({ id, value: 0 }))] },
    replayData: { data: [{ table_id: '123', packet_id: '1', data: events }] } };
}

test('终局逐分项复用本地计分器，城门不乘武士且不会重复加分', () => {
  const value = fixture();
  const before = structuredClone(value);
  const result = auditBgaReplay(value, parameters);
  assert.equal(result.scoreMatched, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.players[0].local.total, 44);
  assert.equal(result.players[0].local.parts.warrior, 6);
  assert.deepEqual(result.players[0].local.resourceParts, { food: 1, iron: 2, pearl: 0 });
  assert.equal(result.placements.length, 18);
  assert.equal(result.checks.placementGateChecks, 18);
  assert.equal(result.fullActionReplayVerified, false);
  assert.equal(result.executable, false);
  assert.equal(result.trainingEligible, false);
  assert.deepEqual(value, before);
});

test('撤销后绝对资源值必须回退，撤回的放骰不进入有效18回合', () => {
  const value = fixture();
  const events = value.replayData.data[0].data;
  const placement = structuredClone(events.find((event) => event.type === 'diePlaced'));
  const i = events.findIndex((event) => event.type === 'diePlaced');
  const undo = structuredClone(placement);
  undo.args.isUndo = true;
  undo.args.die = { ...value.initialData.bridgeDice[0] };
  events.splice(i + 2, 0, undo, placement);
  const gainIndex = events.findIndex((event) => event.type === 'coinGained');
  events.splice(gainIndex, 0,
    { type: 'coinGained', args: { playerId: 100, numberOfCoins: 10, coinValue: 10 } },
    { type: 'coinGained', args: { playerId: 100, numberOfCoins: 10, coinValue: 0, isUndo: true } });
  const result = auditBgaReplay(value, parameters);
  assert.equal(result.scoreMatched, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.checks.undoNotifications, 2);
  assert.equal(result.checks.placements, 19);
  assert.equal(result.placements.length, 18);
});

test('只有确实存在开局通知才归零已含首选收益的 initialData', () => {
  const value = fixture();
  value.initialData.players['100'].extra.coin = 3;
  const result = auditBgaReplay(value, parameters);
  assert.equal(result.checks.initialDraftResetFromSetupEvent, true);
  assert.equal(result.scoreMatched, true);
  assert.deepEqual(result.issues, []);
  value.replayData.data[0].data.shift();
  assert.ok(auditBgaReplay(value, parameters).issues.some((issue) => issue.code === 'BGA_AUDIT_RESOURCE_DELTA'));
});

test('资源上限、总分相同但食物铁分错配也能发现', () => {
  const value = fixture();
  const breakdown = value.replayData.data[0].data.find((event) => event.type === 'updateLiveScore').args.scoreBreakdown;
  breakdown['100'].food = 2;
  breakdown['100'].iron = 1;
  const result = auditBgaReplay(value, parameters);
  assert.equal(result.scoreMatched, false);
  assert.deepEqual(result.players[0].differences.map((item) => item.part), ['food', 'iron']);
  const gain = value.replayData.data[0].data.find((event) => event.type === 'resourceGained');
  gain.args.resourceValue = 8;
  assert.throws(() => auditBgaReplay(value, parameters), { code: 'BGA_AUDIT_RESOURCE_BOUNDS' });
});

test('放骰点差必须产生对应金币通知，不能只满足金币足够条件', () => {
  const value = fixture();
  const events = value.replayData.data[0].data;
  const i = events.findIndex((event) => event.type === 'diePlaced');
  const placed = events[i];
  value.initialData.bridgeDice.find((die) => die.id === placed.args.die.id).side = 2;
  placed.args.die.side = 2;
  // 第一颗骰是左端2点，桥上同色另外两颗也改为2点以维持排序。
  value.initialData.bridgeDice.filter((die) => die.type === placed.args.die.type).forEach((die) => { die.side = 2; });
  const missing = auditBgaReplay(value, parameters);
  assert.ok(missing.issues.some((issue) => issue.code === 'BGA_AUDIT_DIE_COIN_MISSING'));
  events.splice(i + 2, 0, { type: 'coinGained', args: {
    playerId: 100, dieId: placed.args.die.id, numberOfCoins: 2, coinValue: 2, isUndo: false,
  } });
  assert.ok(auditBgaReplay(value, parameters).issues.some((issue) => issue.code === 'BGA_AUDIT_DIE_COIN_DELTA'));
});

test('本地放骰候选发现桥中骰、目标比较值和个人骰色不合法', () => {
  for (const mutate of [
    (event, value) => { value.initialData.bridgeDice[0].locationArg = 'center'; },
    (event) => { event.args.actionSpace.value = 6; },
    (event) => {
      event.args.die.location = 'action-space-player-100-3';
      event.args.actionSpace = { id: event.args.die.location, type: 'white', value: 6 };
    },
  ]) {
    const value = fixture();
    const event = value.replayData.data[0].data.find((item) => item.type === 'diePlaced');
    mutate(event, value);
    assert.ok(auditBgaReplay(value, parameters).issues.length);
  }
});

test('缺终局、多人、认输、未知事件与版本设置不冒充完整验证', () => {
  for (const [mutate, code] of [
    [(a) => { a.source.versions.asset = 'old'; }, 'BGA_AUDIT_VERSION'],
    [(a) => { a.initialData.players.extra = {}; }, 'BGA_AUDIT_TWO_PLAYERS'],
    [(a) => { a.history.concede = '1'; }, 'BGA_AUDIT_CONCEDED'],
    [(a) => { a.configuration.tableOptions = []; }, 'BGA_AUDIT_OPTIONS_UNKNOWN'],
    [(a) => { a.configuration.tableOptions[2].value = 1; }, 'BGA_AUDIT_OPTIONS_UNSUPPORTED'],
    [(a) => { a.replayData.data[0].table_id = '999'; }, 'BGA_AUDIT_PACKET_IDENTITY'],
    [(a) => { a.replayData.data[0].data.pop(); }, 'BGA_AUDIT_FINAL_MISSING'],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => auditBgaReplay(value, parameters), { code });
  }
  const value = fixture();
  value.replayData.data[0].data.push({ type: 'unrecognizedEffect', args: {} });
  assert.ok(auditBgaReplay(value, parameters).issues.some((issue) => issue.code === 'BGA_AUDIT_UNKNOWN_EVENT'));
});
