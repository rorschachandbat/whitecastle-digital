import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  ERROR_CODES,
  EngineError,
  applyAction,
  createPosition,
  replaceCurrentCardWithLantern,
  score,
} from '../src/engine/engine.js';

// 此配置只用于规则边界测试，牌和水井收益都是显式实验夹具。
const fixture = {
  schemaVersion: 1,
  status: 'partial',
  playerCount: 2,
  limits: { resource: 7, seal: 5 },
  policy: { singleDieEndpoint: null },
  bridges: [
    { id: 'red', color: 'coral', dice: [{ id: 'r1', value: 2 }, { id: 'r2', value: 5 }, { id: 'r3', value: 6 }] },
    { id: 'black', color: 'black', dice: [{ id: 'b1', value: 1 }, { id: 'b2', value: 4 }, { id: 'b3', value: 6 }] },
    { id: 'white', color: 'white', dice: [{ id: 'w1', value: 2 }, { id: 'w2', value: 3 }, { id: 'w3', value: 6 }] },
  ],
  personalDomainRows: [
    { id: 'courtier', figureType: 'courtier', dieColor: 'coral', compareValue: 6, verification: 'confirmed', baseGain: { type: 'food', amount: 1 }, revealedGains: Array.from({ length: 5 }, () => ({ type: 'food', amount: 1 })) },
    { id: 'gardener', figureType: 'gardener', dieColor: 'black', compareValue: 6, verification: 'confirmed', baseGain: { type: 'iron', amount: 1 }, revealedGains: [{ type: 'iron', amount: 1 }, { type: 'iron', amount: 1 }, { type: 'lantern', amount: 1 }, { type: 'iron', amount: 1 }, { type: 'coin', amount: 2 }] },
    { id: 'warrior', figureType: 'warrior', dieColor: 'white', compareValue: 6, verification: 'confirmed', baseGain: { type: 'pearl', amount: 1 }, revealedGains: Array.from({ length: 5 }, () => ({ type: 'pearl', amount: 1 })) },
  ],
  cards: [
    { id: 'fixture-action', kind: 'startingAction', verification: 'confirmed', back: [{ type: 'coin', amount: 2 }], fields: ['courtier', 'gardener', 'warrior'].map((id) => ({ id, cost: [], effects: [{ type: 'points', amount: 1 }] })) },
    { id: 'fixture-lantern', kind: 'startingAction', verification: 'confirmed', back: [{ type: 'coin', amount: 5 }, { type: 'food', amount: 2 }], fields: [] },
    { id: 'fixture-garden', kind: 'stone', verification: 'confirmed', foodCost: 3, victoryPoints: 4, back: [], fields: [] },
    { id: 'fixture-complex', kind: 'startingAction', verification: 'confirmed', back: [{ type: 'influence', amount: 1 }], fields: [] },
  ],
  setup: {
    fixtureVersion: 'well-rewards-v1',
    wellRewards: [{ type: 'food', amount: 2 }, { type: 'iron', amount: 1 }],
    players: [{ currentCardId: 'fixture-action' }, { currentCardId: 'fixture-action' }],
  },
};

function withPlayer(config, player, index = 0) {
  const next = structuredClone(config);
  next.setup.players[index] = { ...next.setup.players[index], ...player };
  return next;
}

function place(state, actor = '0', bridgeId = 'red', side = 'left', target = { area: 'well' }, config = fixture, choices = []) {
  return applyAction(state, { type: 'placeDie', actor, bridgeId, side, target, choices }, config);
}

const fails = (fn, code) => assert.throws(fn, (error) => error instanceof EngineError && error.code === code);

test('同一种子生成可复现的三色九骰，全部按点数升序', () => {
  const config = { ...fixture };
  delete config.bridges;
  const first = createPosition(config, { seed: 'seed-17' });
  const second = createPosition(config, { seed: 'seed-17' });
  assert.deepEqual(first, second);
  assert.equal(first.mode, 'core-incomplete');
  assert.equal(first.bridges.flatMap((bridge) => bridge.dice).length, 9);
  for (const bridge of first.bridges) {
    assert.deepEqual(bridge.dice.map((die) => die.value), bridge.dice.map((die) => die.value).sort((a, b) => a - b));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});

test('局面绑定创建时配置，切换牌或夹具配置会明确拒绝', () => {
  const state = createPosition(fixture);
  const changed = structuredClone(fixture);
  changed.setup.wellRewards[0].amount = 3;
  fails(() => place(state, '0', 'red', 'right', { area: 'well' }, changed), ERROR_CODES.CONFIG_MISMATCH);
  fails(() => score(state, changed), ERROR_CODES.CONFIG_MISMATCH);
  const reordered = Object.fromEntries(Object.entries(fixture).reverse());
  assert.deepEqual(score(state, reordered), score(state, fixture));
});

test('开放组件配置不开放两人基础规则常量，不允许改轮数或比较值绕过规则', () => {
  for (const [key, value] of Object.entries({
    resourceLimit: 99, sealLimit: 99, turnsPerPlayer: 4,
    personalCompareValue: 1, wellCompareValue: 6, bridgeCount: 4,
  })) {
    fails(() => createPosition({ ...fixture, [key]: value }), ERROR_CODES.INVALID_STATE);
  }
});

test('真实目录个人面板与夹具行动牌可组合，家臣第三格金币及配置变更实际生效', () => {
  const config = JSON.parse(readFileSync(new URL('../data/whitecastle-2p.json', import.meta.url), 'utf8'));
  config.cards.push(structuredClone(fixture.cards[0]));
  config.bridges = structuredClone(fixture.bridges);
  config.setup = {
    players: [
      { currentCardId: 'fixture-action', figures: { courtier: [{ location: 'gate' }, { location: 'floor1' }, { location: 'floor2' }] } },
      { currentCardId: 'fixture-action' },
    ],
  };
  const action = { type: 'placeDie', actor: '0', bridgeId: 'red', side: 'right', target: { area: 'personal', row: 'courtier' } };
  const original = applyAction(createPosition(config), action, config);
  assert.equal(original.players['0'].resources.food, 3);
  assert.equal(original.players['0'].resources.coin, 2);
  config.personalDomainRows[0].baseGain.amount = 2;
  const changed = applyAction(createPosition(config), action, config);
  assert.equal(changed.players['0'].resources.food, 4);
  assert.equal(changed.players['0'].resources.coin, 2);
});

test('取放是原子动作，付不起时骰子仍留桥，灯笼不可提前借款', () => {
  const config = withPlayer(fixture, { resources: { coin: 0 }, lanternCardIds: ['fixture-lantern'] });
  const state = createPosition(config);
  const before = structuredClone(state);
  fails(() => place(state, '0', 'red', 'left', { area: 'personal', row: 'courtier' }, config), ERROR_CODES.INSUFFICIENT_COINS);
  assert.deepEqual(state, before);
  assert.equal(state.bridges[0].dice[0].id, 'r1');
});

test('先支付差额，再灯笼，再排收益和当前牌，灯笼不天然加分', () => {
  const config = withPlayer(fixture, { resources: { coin: 4, food: 6 }, lanternCardIds: ['fixture-lantern'] });
  const state = createPosition(config);
  const next = place(state, '0', 'red', 'left', { area: 'personal', row: 'courtier' }, config);
  assert.deepEqual(next.players['0'].resources, { food: 7, iron: 0, pearl: 0, coin: 5, seal: 0, points: 1 });
  assert.equal(next.activePlayer, '1');
  assert.equal(next.turnsUsed['0'], 1);
  assert.deepEqual(state.players['0'].resources, { food: 6, iron: 0, pearl: 0, coin: 4, seal: 0, points: 0 });
});

test('水井比较值恒为1且容量不限，收益包含1印章与显式实验板块', () => {
  let state = createPosition(fixture);
  state = place(state);
  assert.equal(state.players['0'].resources.coin, 1);
  assert.equal(state.players['0'].resources.seal, 1);
  assert.equal(state.players['0'].resources.food, 2);
  state = place(state, '1', 'white', 'right');
  assert.equal(state.players['1'].resources.coin, 5);
  assert.equal(state.placements.well.dice.length, 2);
});

test('印章收益不超过5，资源收益不超过7', () => {
  const config = withPlayer(fixture, { resources: { seal: 5, food: 7, iron: 7 } });
  const next = place(createPosition(config), '0', 'black', 'left', { area: 'well' }, config);
  assert.equal(next.players['0'].resources.seal, 5);
  assert.equal(next.players['0'].resources.food, 7);
  assert.equal(next.players['0'].resources.iron, 7);
});

test('仅桥两端可取，唯一骰端点未知时拒绝，不猜灯笼触发', () => {
  let state = createPosition(fixture);
  fails(() => place(state, '0', 'red', 'middle'), ERROR_CODES.INVALID_BRIDGE_SIDE);
  state = place(state, '0', 'red', 'left');
  state = place(state, '1', 'red', 'right');
  assert.deepEqual(state.bridges[0].dice.map((die) => die.id), ['r2']);
  assert.equal(state.bridges[0].singleDieEndpoint, null);
  fails(() => place(state, '0', 'red', 'left'), ERROR_CODES.SINGLE_DIE_ENDPOINT_UNKNOWN);
});

test('个人排每轮一个骰且骰色匹配，非法放置不改变状态', () => {
  const config = withPlayer(fixture, { resources: { coin: 10 } });
  let state = createPosition(config);
  state = place(state, '0', 'red', 'right', { area: 'personal', row: 'courtier' }, config);
  state = place(state, '1', 'black', 'right', { area: 'well' }, config);
  const before = structuredClone(state);
  fails(() => place(state, '0', 'red', 'left', { area: 'personal', row: 'courtier' }, config), ERROR_CODES.TARGET_FULL);
  assert.deepEqual(state, before);
  fails(() => place(state, '0', 'white', 'right', { area: 'personal', row: 'gardener' }, config), ERROR_CODES.TARGET_NOT_ALLOWED);
});

test('城堡与城外两人容量共享且至多1，不开放缺失区域行动', () => {
  const config = structuredClone(fixture);
  config.setup.placements = {
    'outside:left': { area: 'outside', comparisonValue: 5, capacity: 2, dice: [{ id: 'placed-by-other', actor: '1', value: 6 }] },
    'castle:first': { area: 'castle', comparisonValue: 5, capacity: 2, dice: [] },
  };
  const state = createPosition(config);
  assert.equal(state.placements['outside:left'].capacity, 1);
  fails(() => place(state, '0', 'red', 'right', { area: 'outside', id: 'left' }, config), ERROR_CODES.TARGET_FULL);
  fails(() => place(state, '0', 'red', 'right', { area: 'castle', id: 'first' }, config), ERROR_CODES.DATA_UNVERIFIED);
  assert.equal(state.bridges[0].dice.length, 3);
});

test('个人排灯笼格触发牌背，牌费用在排收益之后实际支付', () => {
  const config = withPlayer(fixture, {
    resources: { coin: 0 },
    lanternCardIds: ['fixture-lantern'],
    figures: { gardener: [{ cardId: 'fixture-garden' }, { cardId: 'fixture-garden' }, { cardId: 'fixture-garden' }] },
  });
  config.cards[0].fields.find((field) => field.id === 'gardener').cost = [{ type: 'coin', amount: 3 }];
  const state = createPosition(config);
  const next = place(state, '0', 'black', 'right', { area: 'personal', row: 'gardener' }, config);
  assert.equal(next.players['0'].resources.coin, 2);
  assert.equal(next.players['0'].resources.iron, 3);
  assert.equal(next.players['0'].resources.points, 1);
  assert.equal(next.players['0'].resources.food, 2);
});

test('园丁武士留场，个人排收益按已部署数量揭开', () => {
  const figures = { courtier: [{ location: 'gate' }, { location: 'floor1' }], gardener: [{ cardId: 'fixture-garden' }], warrior: [{ yardId: 'yard-a' }] };
  const config = withPlayer(fixture, { figures });
  const state = createPosition(config);
  const next = place(state, '0', 'red', 'right', { area: 'personal', row: 'courtier' }, config);
  assert.deepEqual(next.players['0'].figures, figures);
  assert.equal(next.players['0'].resources.food, 3);
});

test('印章兑换不消耗回合，溢出丢弃，只允许当前玩家兑换', () => {
  const config = withPlayer(fixture, { resources: { seal: 5, food: 7 } });
  let state = createPosition(config);
  state = applyAction(state, { type: 'exchangeSeal', actor: '0', amount: 1 }, config);
  assert.equal(state.players['0'].resources.coin, 1);
  state = applyAction(state, { type: 'exchangeSeal', actor: '0', amount: 2, resource: 'food' }, config);
  assert.equal(state.players['0'].resources.food, 7);
  assert.equal(state.players['0'].resources.seal, 2);
  assert.equal(state.turnsUsed['0'], 0);
  fails(() => applyAction(state, { type: 'exchangeSeal', actor: '1', amount: 1 }, config), ERROR_CODES.NOT_ACTIVE_PLAYER);
  fails(() => applyAction(state, { type: 'exchangeSeal', actor: '0', amount: 2, resource: 'points' }, config), ERROR_CODES.INVALID_RESOURCE);
});

test('任选资源逐份给定且可不同，缺失或多余均拒绝', () => {
  const config = structuredClone(fixture);
  config.setup.wellRewards = [{ type: 'chooseResource', amount: 2 }];
  const state = createPosition(config);
  fails(() => place(state, '0', 'red', 'right', { area: 'well' }, config), ERROR_CODES.CHOICE_REQUIRED);
  const next = place(state, '0', 'red', 'right', { area: 'well' }, config, ['iron', 'pearl']);
  assert.equal(next.players['0'].resources.iron, 1);
  assert.equal(next.players['0'].resources.pearl, 1);
  fails(() => place(state, '0', 'red', 'right', { area: 'well' }, config, ['iron', 'pearl', 'food']), ERROR_CODES.INVALID_ACTION);
});

test('缺少资料或未支持影响力时原子拒绝，不静默丢弃复杂效果', () => {
  const config = withPlayer(fixture, { lanternCardIds: ['fixture-complex'] });
  const state = createPosition(config);
  const before = structuredClone(state);
  fails(() => place(state, '0', 'red', 'left', { area: 'well' }, config), ERROR_CODES.DATA_UNVERIFIED);
  assert.deepEqual(state, before);
  const missing = structuredClone(fixture);
  delete missing.setup.wellRewards;
  fails(() => place(createPosition(missing), '0', 'red', 'right', { area: 'well' }, missing), ERROR_CODES.DATA_UNVERIFIED);
});

test('旧牌只进入灯笼区，新牌成为唯一当前牌，保留原对象', () => {
  const player = { currentCard: 'old-card', lanternCards: [] };
  const next = replaceCurrentCardWithLantern(player, 'new-card');
  assert.equal(next.currentCard, 'new-card');
  assert.deepEqual(next.lanternCards, ['old-card']);
  assert.deepEqual(player, { currentCard: 'old-card', lanternCards: [] });
});

test('每种资源0/3/6/7得0/1/1/2，金币印章合并计分', () => {
  for (const [amount, expected] of [[0, 0], [3, 1], [6, 1], [7, 2]]) {
    const config = withPlayer(fixture, { resources: { food: amount, coin: 4, seal: 1 }, finalOrder: 0 });
    config.setup.players[1].finalOrder = 1;
    const result = score(createPosition(config), config);
    assert.equal(result.players['0'].parts.resources, expected);
    assert.equal(result.players['0'].parts.coinAndSeal, 1);
    assert.equal(result.players['0'].total, expected + 1);
  }
});

test('武士乘以城内家臣，城门仅给1分，园丁用已核验牌计分', () => {
  const config = withPlayer(fixture, {
    resources: { points: 2 },
    figures: {
      courtier: [{ location: 'gate' }, { location: 'floor1' }, { location: 'floor2' }],
      warrior: [{ yardId: 'yard-a' }, { yardId: 'yard-b' }],
      gardener: [{ cardId: 'fixture-garden' }],
    },
    timePosition: 3,
    finalOrder: 1,
  });
  config.setup.players[1].finalOrder = 0;
  config.setup.trainingYards = [{ id: 'yard-a', value: 1, verification: 'confirmed' }, { id: 'yard-b', value: 3, verification: 'confirmed' }];
  config.timeTrack = { 3: 6 };
  const result = score(createPosition(config), config);
  assert.equal(result.complete, true);
  assert.deepEqual(result.players['0'].parts, { points: 2, coinAndSeal: 0, resources: 0, courtier: 10, warrior: 8, gardener: 4, time: 6 });
  assert.equal(result.players['0'].total, 30);
  assert.equal(result.winner, '0');
});

test('缺少轨道、武士系数或同分顺序时不猜赢家', () => {
  const config = withPlayer(fixture, { timePosition: 4, figures: { warrior: [{ yardId: 'unknown' }] } });
  const result = score(createPosition(config), config);
  assert.equal(result.complete, false);
  assert.equal(result.winner, null);
  assert.ok(result.missing.includes('timeTrack:0'));
  assert.ok(result.missing.includes('warrior:0'));
  assert.ok(result.missing.includes('finalOrder'));
  const ordered = structuredClone(fixture);
  ordered.setup.players[0].finalOrder = 1;
  ordered.setup.players[1].finalOrder = 0;
  assert.equal(score(createPosition(ordered), ordered).winner, '1');
});

test('六次放骰后停在轮末，不自动跳过花园或重置人员', () => {
  let state = createPosition(fixture);
  for (const [actor, bridgeId, side] of [
    ['0', 'red', 'left'], ['1', 'red', 'right'],
    ['0', 'black', 'left'], ['1', 'black', 'right'],
    ['0', 'white', 'left'], ['1', 'white', 'right'],
  ]) state = place(state, actor, bridgeId, side);
  assert.equal(state.phase, 'round-end');
  assert.equal(state.bridges.flatMap((bridge) => bridge.dice).length, 3);
  assert.deepEqual(state.turnsUsed, { '0': 3, '1': 3 });
  fails(() => place(state), ERROR_CODES.ROUND_END_UNIMPLEMENTED);
});
