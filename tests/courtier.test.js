import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { applyAction, createPosition, resolveGardenReward } from '../src/engine/engine.js';

const raw = JSON.parse(fs.readFileSync(new URL('../data/whitecastle-2p.json', import.meta.url)));
const fixture = (player = {}) => {
  const config = structuredClone(raw);
  config.bridges = ['coral', 'black', 'white'].map((color) => ({
    id: color, color, dice: [0, 1, 2].map((index) => ({ id: `${color}-${index}`, value: 6 })),
  }));
  config.setup = {
    players: [
      { currentCardId: 'start-action-courtier-1', resources: { coin: 2, pearl: 7 }, ...player },
      { currentCardId: 'start-action-gardener-2' },
    ],
    castleRooms: [
      { id: 'floor1-a', floor: 1, cardId: 'steward-s03', tiles: [] },
      { id: 'floor1-b', floor: 1, cardId: 'steward-s14', tiles: [] },
      { id: 'floor2-a', floor: 2, cardId: 'diplomat-d09', tiles: [] },
    ],
    castleDecks: { steward: ['steward-s02'], diplomat: ['diplomat-d11'] },
    topCardId: 'top-1',
  };
  return config;
};
const place = (state, config, decisions, extra = {}) => applyAction(state, {
  type: 'placeDie', actor: '0', bridgeId: 'coral', side: 'right',
  target: { area: 'personal', row: 'courtier' }, decisions, ...extra,
}, config);
const fails = (fn, code) => assert.throws(fn, (error) => error.code === code);

test('一次家臣可先谒见再晋升新家臣，换个人牌、灯笼并补房间，输入不变', () => {
  const config = fixture();
  const state = createPosition(config), before = structuredClone(state);
  const next = place(state, config, [{
    type: 'courtier', audience: true,
    promote: { figureIndex: 0, steps: 1, roomId: 'floor1-a', fieldId: 'middle' },
  }]);
  assert.equal(next.players['0'].resources.coin, 0);
  assert.equal(next.players['0'].resources.pearl, 7);
  assert.equal(next.players['0'].currentCard, 'steward-s03');
  assert.deepEqual(next.players['0'].lanternCards, ['start-action-courtier-1']);
  assert.deepEqual(next.players['0'].figures.courtier, [{ location: 'floor1', roomId: 'floor1-a' }]);
  assert.equal(next.castleRooms[0].cardId, 'steward-s02');
  assert.deepEqual(next.castleDecks.steward, []);
  assert.deepEqual(state, before);
});

test('跨两层只取得终点二层牌及一项浅色收益，不经过一层', () => {
  const config = fixture({ figures: { courtier: [{ location: 'gate' }] } });
  const next = place(createPosition(config), config, [{
    type: 'courtier', promote: { figureIndex: 0, steps: 2, roomId: 'floor2-a', fieldId: 'lower' },
  }], { choices: ['food', 'iron', 'iron'] });
  assert.equal(next.players['0'].resources.pearl, 2);
  assert.equal(next.players['0'].resources.food, 3);
  assert.equal(next.players['0'].resources.iron, 2);
  assert.equal(next.players['0'].currentCard, 'diplomat-d09');
  assert.equal(next.castleRooms[0].cardId, 'steward-s03');
  assert.equal(next.castleRooms[2].cardId, 'diplomat-d11');
});

test('牌堆空仍执行到达浅色收益，保留房间牌及当前个人牌', () => {
  const config = fixture({ figures: { courtier: [{ location: 'gate' }] } });
  config.setup.castleDecks.steward = [];
  const next = place(createPosition(config), config, [{
    type: 'courtier', promote: { figureIndex: 0, steps: 1, roomId: 'floor1-a', fieldId: 'middle' },
  }]);
  assert.equal(next.players['0'].currentCard, 'start-action-courtier-1');
  assert.deepEqual(next.players['0'].lanternCards, []);
  assert.equal(next.players['0'].resources.pearl, 7);
  assert.equal(next.castleRooms[0].cardId, 'steward-s03');
});

test('先晋升再谒见可用三层奖励金币支付，三层先灯笼再占共享槽', () => {
  const config = fixture({
    resources: { coin: 0, pearl: 2 },
    figures: { courtier: [{ location: 'floor2' }] },
    lanternCardIds: ['decree-points'],
  });
  const next = place(createPosition(config), config, [{
    type: 'courtier', audience: true, order: ['promote', 'audience'],
    promote: { figureIndex: 0, steps: 1, slotId: 'right' },
  }]);
  assert.equal(next.players['0'].resources.coin, 1);
  assert.equal(next.players['0'].resources.points, 1);
  assert.deepEqual(next.topSlots, { right: { actor: '0', figureIndex: 0 } });
  assert.deepEqual(next.players['0'].figures.courtier, [{ location: 'floor3', slotId: 'right' }, { location: 'gate' }]);
  const reverse = [{
    type: 'courtier', audience: true,
    promote: { figureIndex: 0, steps: 1, slotId: 'right' },
  }];
  fails(() => place(createPosition(config), config, reverse), 'INSUFFICIENT_COINS');
});

test('三层全满仍可到达并拿灯笼，不额外获取任一槽奖励', () => {
  const config = fixture({
    resources: { pearl: 2 },
    figures: { courtier: [{ location: 'floor2' }] },
    lanternCardIds: ['decree-coin'],
  });
  config.setup.topSlots = { left: { actor: '1' }, middle: { actor: '1' }, right: { actor: '1' } };
  const next = place(createPosition(config), config, [{
    type: 'courtier', promote: { figureIndex: 0, steps: 1 },
  }]);
  assert.equal(next.players['0'].resources.coin, 1);
  assert.deepEqual(next.players['0'].figures.courtier, [{ location: 'floor3' }]);
  assert.deepEqual(next.topSlots, config.setup.topSlots);
});

test('top-5 左槽执行城堡浅色收益，先灯笼，不激活个人排或骰差额', () => {
  const config = fixture({
    resources: { coin: 0, pearl: 2 },
    figures: { courtier: [{ location: 'floor2' }] },
    lanternCardIds: ['decree-points'],
  });
  config.setup.topCardId = 'top-5';
  const state = createPosition(config);
  const before = structuredClone(state);
  const next = place(state, config, [
    { type: 'courtier', promote: { figureIndex: 0, steps: 1, slotId: 'left' } },
    { type: 'castleLight', roomId: 'floor1-a', fieldId: 'middle' },
  ]);
  assert.equal(next.players['0'].resources.points, 1);
  assert.equal(next.players['0'].resources.pearl, 2);
  assert.equal(next.players['0'].resources.coin, 0);
  assert.deepEqual(next.topSlots, { left: { actor: '0', figureIndex: 0 } });
  assert.deepEqual(state, before);
  fails(() => place(state, config, [
    { type: 'courtier', promote: { figureIndex: 0, steps: 1, slotId: 'left' } },
    { type: 'castleLight', roomId: 'floor1-a', fieldId: 'bottom' },
  ]), 'TARGET_NOT_ALLOWED');
});

test('非法楼层、深色字段、空位和费用不足全部原子拒绝', () => {
  const config = fixture({ resources: { pearl: 2 }, figures: { courtier: [{ location: 'gate' }] } });
  const state = createPosition(config), before = structuredClone(state);
  for (const [promote, code] of [
    [{ figureIndex: 0, steps: 1, roomId: 'floor2-a', fieldId: 'lower' }, 'TARGET_NOT_ALLOWED'],
    [{ figureIndex: 0, steps: 1, roomId: 'floor1-a', fieldId: 'bottom' }, 'TARGET_NOT_ALLOWED'],
    [{ figureIndex: 0, steps: 2, roomId: 'floor2-a', fieldId: 'lower' }, 'INSUFFICIENT_RESOURCE'],
    [{ figureIndex: 9, steps: 1, roomId: 'floor1-a', fieldId: 'middle' }, 'TARGET_NOT_ALLOWED'],
  ]) {
    fails(() => place(state, config, [{ type: 'courtier', promote }]), code);
    assert.deepEqual(state, before);
  }
});

test('入场奖励触发的灯笼能看到刚翻面的旧个人牌', () => {
  const config = fixture({
    currentCardId: 'steward-s03',
    figures: { courtier: [{ location: 'gate' }] },
  });
  config.setup.castleRooms[0].cardId = 'steward-s04';
  config.cards.find((card) => card.id === 'steward-s03').back = [{ type: 'coin', amount: 2 }];
  const next = place(createPosition(config), config, [
    { type: 'field', fieldId: 'top', skip: true },
  ]);
  assert.equal(next.players['0'].resources.coin, 2);
  // 用城外家臣行动避免原个人牌自身的非家臣字段。
  config.setup.placements = { 'outside:left': { area: 'outside', comparisonValue: 6 } };
  const reached = applyAction(createPosition(config), {
    type: 'placeDie', actor: '0', bridgeId: 'coral', side: 'right', target: { area: 'outside', id: 'left' },
    decisions: [
      { type: 'outside', action: 'courtier' },
      { type: 'courtier', promote: { figureIndex: 0, steps: 1, roomId: 'floor1-a', fieldId: 'bottom' } },
    ],
  }, config);
  assert.equal(reached.players['0'].currentCard, 'steward-s04');
  assert.equal(reached.players['0'].resources.coin, 4);
});

test('interactive逐项返回字段、顺序、家臣完整候选，普通调用不增加选择', () => {
  const config = fixture();
  const state = createPosition(config);
  let request;
  try { place(state, config, [], { interactive: true }); } catch (error) { request = error; }
  assert.equal(request.code, 'CHOICE_REQUIRED');
  assert.equal(request.details.type, 'field');
  assert.equal(request.details.options[0].skip, false);
  try {
    place(state, config, [{ type: 'field', fieldId: 'action', skip: false }], { interactive: true });
  } catch (error) { request = error; }
  assert.equal(request.details.type, 'courtier');
  assert.equal(request.details.index, 1);
  assert.ok(request.details.options.some((option) => option.audience && option.promote?.figureIndex === 0));
});

test('轮末花园只执行奖励，不再部署或支付食物，选择错误不修改状态', () => {
  const config = fixture({ resources: { food: 0 }, figures: { gardener: [{ cardId: 'garden-58' }] } });
  const state = createPosition(config);
  state.phase = 'round-gardens';
  const before = structuredClone(state);
  const next = resolveGardenReward(state, '0', 'garden-58', { choices: ['food', 'iron'] }, config);
  assert.equal(next.players['0'].resources.food, 1);
  assert.equal(next.players['0'].resources.iron, 1);
  assert.equal(next.players['0'].figures.gardener.length, 1);
  assert.deepEqual(state, before);
  fails(() => resolveGardenReward(state, '1', 'garden-58', {}, config), 'NOT_ACTIVE_PLAYER');
  fails(() => resolveGardenReward(state, '0', 'garden-58', {}, config), 'CHOICE_REQUIRED');
  assert.deepEqual(state, before);
});

test('连锁中的印章可以先换珍珠母再支付晋升，兑换仍为同一原子回合', () => {
  const config = fixture({
    resources: { seal: 2, pearl: 1 },
    figures: { courtier: [{ location: 'gate' }] },
  });
  const next = place(createPosition(config), config, [
    { type: 'exchangeSeal', amount: 2, resource: 'pearl' },
    { type: 'courtier', promote: { figureIndex: 0, steps: 1, roomId: 'floor1-a', fieldId: 'middle' } },
  ]);
  assert.equal(next.players['0'].resources.seal, 0);
  assert.equal(next.players['0'].resources.pearl, 2);
});

test('物理端点模式保留最后一骰所在端，左取后留右、右取后留左', () => {
  for (const secondSide of ['left', 'right']) {
    const config = fixture();
    config.policy.singleDieEndpoint = 'physical';
    config.setup.fixtureVersion = 'well-rewards-v1';
    config.setup.wellRewards = [{ type: 'food', amount: 1 }, { type: 'iron', amount: 1 }];
    let state = createPosition(config);
    const well = (actor, side) => ({
      type: 'placeDie', actor, bridgeId: 'coral', side, target: { area: 'well' },
    });
    state = applyAction(state, well('0', 'right'), config);
    state = applyAction(state, well('1', secondSide), config);
    const expected = secondSide === 'left' ? 'right' : 'left';
    assert.equal(state.bridges[0].singleDieEndpoint, expected);
    const before = structuredClone(state);
    fails(() => applyAction(state, well('0', secondSide), config), 'SINGLE_DIE_WRONG_ENDPOINT');
    assert.deepEqual(state, before);
    state = applyAction(state, well('0', expected), config);
    assert.equal(state.bridges[0].dice.length, 0);
    assert.equal(state.bridges[0].singleDieEndpoint, null);
  }
});

test('交互式组合排序先请求再消费，非法或多余排列整次拒绝', () => {
  const config = fixture({
    currentCardId: 'diplomat-d03',
    figures: { courtier: [{ location: 'gate' }] },
  });
  const state = createPosition(config), before = structuredClone(state);
  let request;
  try { place(state, config, [], { interactive: true }); } catch (error) { request = error; }
  assert.equal(request.code, 'CHOICE_REQUIRED');
  assert.equal(request.details.type, 'effectOrder');
  assert.equal(request.details.index, 0);
  assert.equal(request.details.effects.length, 2);
  const decisions = [{ type: 'field', fieldId: 'upper', skip: false }];
  const next = place(state, config, decisions, { interactive: true, effectOrders: [[1, 0], [1, 0]] });
  assert.equal(next.turnsUsed['0'], 1);
  for (const effectOrders of [[[0, 0]], [[1, 0], [1, 0], [0]], [[1]], [[1, 0], [0, 0]]]) {
    fails(() => place(state, config, decisions, { interactive: true, effectOrders }), 'INVALID_ACTION');
    assert.deepEqual(state, before);
  }
});

test('三层槽位在全体玩家间共享，不能重复占用，奖励仍可明确放弃', () => {
  const config = fixture({
    resources: { pearl: 2 },
    figures: { courtier: [{ location: 'floor2' }] },
  });
  config.setup.topSlots = { right: { actor: '1', figureIndex: 0 } };
  const state = createPosition(config), before = structuredClone(state);
  fails(() => place(state, config, [{
    type: 'courtier', promote: { figureIndex: 0, steps: 1, slotId: 'right' },
  }]), 'TARGET_NOT_ALLOWED');
  assert.deepEqual(state, before);
  const next = place(state, config, [
    { type: 'courtier', promote: { figureIndex: 0, steps: 1, slotId: 'middle' } },
    { type: 'field', fieldId: 'middle', skip: true },
  ]);
  assert.equal(next.players['0'].resources.pearl, 0);
  assert.equal(next.topSlots.middle.actor, '0');
  assert.equal(next.topSlots.right.actor, '1');
});

test('金银独立牌池模式仅允许各池已核验可见面', () => {
  const config = fixture({
    currentCardId: 'start-action-warrior-1',
    resources: { iron: 1 },
  });
  config.setup.trainingMode = 'separate-pools';
  config.setup.trainingYards = [{ id: 'yard-cost-1', faceIds: ['yard-face-15'] }];
  const action = {
    type: 'placeDie', actor: '0', bridgeId: 'white', side: 'right',
    target: { area: 'personal', row: 'warrior' },
    decisions: [{ type: 'warrior', yardId: 'yard-cost-1' }],
  };
  const next = applyAction(createPosition(config), action, config);
  assert.equal(next.players['0'].resources.points, 2);
  config.trainingPools.find((pool) => pool.id === 'gold').faceIds = ['yard-face-13'];
  fails(() => applyAction(createPosition(config), action, config), 'DATA_UNVERIFIED');
});
