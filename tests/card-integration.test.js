import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { validateCatalog } from '../src/data/catalog.js';
import { createPosition, applyAction, score } from '../src/engine/engine.js';
import { createStartingDraft, chooseStartingPair } from '../src/engine/startingDraft.js';
import { personalField } from '../src/engine/cardRules.js';

const raw = JSON.parse(fs.readFileSync(new URL('../data/whitecastle-2p.json', import.meta.url)));
const configWith = (cardId, resources = {}) => {
  const config = structuredClone(raw);
  config.bridges = ['coral', 'black', 'white'].map((color) => ({
    id: color, color, dice: [1, 2, 3].map((n) => ({ id: `${color}-${n}`, value: 6 })),
  }));
  config.setup = {
    players: [{ currentCardId: cardId, resources }, { currentCardId: 'start-action-courtier-2' }],
    gardens: raw.cards.filter((card) => ['plant', 'stone'].includes(card.kind))
      .map((card) => ({ cardId: card.id, bridgeId: 'coral' })),
  };
  return config;
};
const place = (config, row, extra = {}) => applyAction(createPosition(config), {
  type: 'placeDie', actor: '0', bridgeId: { courtier: 'coral', gardener: 'black', warrior: 'white' }[row],
  side: 'right', target: { area: 'personal', row }, ...extra,
}, config);
const fails = (call, code) => assert.throws(call, (error) => error.code === code);

test('用户原图目录只启用两人55实体卡，起始行动每种两份，城堡人数筛选准确', () => {
  assert.deepEqual(validateCatalog(raw), []);
  assert.equal(raw.cards.length, 55);
  assert.deepEqual(raw.coverage, { plant: 5, stone: 5, startingResource: 9, startingAction: 6, steward: 9, diplomat: 9, top: 9, decree: 3 });
  for (const type of ['courtier', 'gardener', 'warrior']) {
    assert.equal(raw.cards.filter((card) => card.designId === `start-action-${type}`).length, 2);
  }
  assert.deepEqual(raw.cards.filter((card) => card.kind === 'steward').map((card) => card.sourcePosition),
    [2, 3, 4, 5, 6, 8, 10, 14, 15]);
  assert.deepEqual(raw.cards.filter((card) => card.kind === 'diplomat').map((card) => card.sourcePosition),
    [1, 2, 3, 4, 5, 7, 9, 11, 12]);
  assert.ok(raw.cards.filter((card) => ['steward', 'diplomat'].includes(card.kind)).every((card) => card.playerCounts.join() === '2'));
  assert.equal(raw.tokens.length, 0);
  assert.equal(raw.trainingPools.length, 2);
  assert.equal(raw.unclassifiedAssets.length, 2);
  assert.ok(raw.unclassifiedAssets.every((item) => item.enabled === false));
});

test('资源牌三组牌背与法令图标对应，选择时只发正面资产', () => {
  for (const type of ['food', 'iron', 'pearl']) {
    assert.ok(raw.cards.filter((card) => card.id.startsWith(`start-resource-${type}-`))
      .every((card) => card.back.length === 1 && card.back[0].type === type));
  }
  assert.equal(raw.cards.find((card) => card.id === 'start-resource-food-1').grantDecreeId, 'decree-points');
  assert.equal(raw.cards.find((card) => card.id === 'start-resource-iron-2').grantDecreeId, 'decree-seal');
  assert.equal(raw.cards.find((card) => card.id === 'start-resource-pearl-1').grantDecreeId, 'decree-coin');
  let draft = createStartingDraft(raw, { seed: 'user-card-acceptance' });
  for (const actor of ['1', '0']) {
    const pair = draft.pairs.find((item) => item.chosenBy === null);
    const resource = raw.cards.find((card) => card.id === pair.resourceId);
    const count = resource.initialGains.filter((gain) => gain.type === 'chooseResource').reduce((sum, gain) => sum + gain.amount, 0);
    draft = chooseStartingPair(draft, actor, pair.id, raw, { choices: Array(count).fill('pearl') });
    assert.equal(draft.players[actor].resources.points, 0);
  }
  assert.equal(draft.phase, 'complete');
});

test('所有正式个人行动牌覆盖三排，使节面积不造成额外执行次数', () => {
  for (const card of raw.cards.filter((card) => ['startingAction', 'steward', 'diplomat'].includes(card.kind))) {
    for (const row of ['courtier', 'gardener', 'warrior']) assert.ok(card.fields.includes(personalField(card, row)));
  }
  const card = raw.cards.find((item) => item.id === 'diplomat-d03');
  assert.equal(personalField(card, 'gardener').id, 'upper');
  assert.deepEqual(personalField(card, 'gardener').effects, [{ type: 'coin', amount: 2 }, { type: 'lantern', amount: 1 }]);
  assert.equal(personalField(card, 'warrior').id, 'lower');
});

test('真实起始园丁行动部署后支付食物并给两份显式自选资源，不修改输入', () => {
  const config = configWith('start-action-gardener-1', { food: 1 });
  const state = createPosition(config), before = structuredClone(state);
  const next = applyAction(state, {
    type: 'placeDie', actor: '0', bridgeId: 'black', side: 'right', target: { area: 'personal', row: 'gardener' },
    decisions: [{ type: 'gardener', cardId: 'garden-58' }], choices: ['food', 'pearl'],
  }, config);
  assert.equal(next.players['0'].resources.food, 1);
  assert.equal(next.players['0'].resources.pearl, 1);
  assert.equal(next.players['0'].resources.iron, 1);
  assert.equal(next.players['0'].figures.gardener[0].cardId, 'garden-58');
  assert.deepEqual(state, before);
});

test('植物花园部署费用和额外行动金币均实际支付，可明确只部署不激活', () => {
  const config = configWith('start-action-gardener-1', { food: 4, coin: 2 });
  const decisions = [{ type: 'gardener', cardId: 'garden-27' }, { type: 'gardener', skip: true }];
  fails(() => place(config, 'gardener', { decisions }), 'INSUFFICIENT_COINS');
  const next = place(config, 'gardener', { decisions: [{ type: 'gardener', cardId: 'garden-27', activate: false }] });
  assert.equal(next.players['0'].resources.food, 0);
  assert.equal(next.players['0'].resources.coin, 2);
  assert.equal(next.players['0'].figures.gardener.length, 1);
  config.setup.players[0].resources.coin = 3;
  const paid = place(config, 'gardener', { decisions });
  assert.equal(paid.players['0'].resources.coin, 0);
});

test('同一花园不能再部署自己园丁，部署上限与食物不足均明确拒绝', () => {
  const config = configWith('start-action-gardener-1', { food: 0 });
  const decisions = [{ type: 'gardener', cardId: 'garden-58' }];
  fails(() => place(config, 'gardener', { decisions, choices: ['food', 'food'] }), 'INSUFFICIENT_RESOURCE');
  config.setup.players[0].resources.food = 5;
  config.setup.players[0].figures = { gardener: [{ cardId: 'garden-58' }] };
  fails(() => place(config, 'gardener', { decisions }), 'TARGET_NOT_ALLOWED');
  config.setup.players[0].figures.gardener = Array.from({ length: 5 }, (_, i) => ({ cardId: `other-${i}` }));
  fails(() => place(config, 'gardener', { decisions }), 'TARGET_FULL');
});

test('真实训练区支付铁、保留武士，计分使用棋盘系数而非即时收益', () => {
  const config = configWith('start-action-warrior-1', { iron: 1 });
  config.setup.trainingMode = 'manual-visible-faces';
  config.setup.trainingYards = [{ id: 'yard-cost-1', faceIds: ['yard-face-15'] }];
  config.setup.players[0].figures = { courtier: [{ location: 'floor1' }, { location: 'floor2' }] };
  const next = place(config, 'warrior', { decisions: [{ type: 'warrior', yardId: 'yard-cost-1' }] });
  assert.equal(next.players['0'].resources.iron, 0);
  assert.equal(next.players['0'].resources.points, 2);
  assert.deepEqual(next.players['0'].figures.warrior, [{ yardId: 'yard-cost-1' }]);
  assert.equal(score(next, config).players['0'].parts.warrior, 2);
  delete config.setup.trainingMode;
  fails(() => place(config, 'warrior', { decisions: [{ type: 'warrior', yardId: 'yard-cost-1' }] }), 'DATA_UNVERIFIED');
});

test('五铁训练区由玩家决定两面顺序：先金币可支持后续谒见，反序资产不足', () => {
  const config = configWith('start-action-warrior-1', { iron: 5, coin: 0 });
  config.setup.trainingMode = 'manual-visible-faces';
  config.setup.trainingYards = [{ id: 'yard-cost-5', faceIds: ['yard-face-13', 'yard-face-8'] }];
  const decisions = [
    { type: 'warrior', yardId: 'yard-cost-5', faceOrder: ['yard-face-13', 'yard-face-8'] },
    { type: 'courtier', audience: true },
  ];
  const next = place(config, 'warrior', { decisions });
  assert.equal(next.players['0'].resources.iron, 0);
  assert.equal(next.players['0'].resources.coin, 3);
  assert.deepEqual(next.players['0'].figures.courtier, [{ location: 'gate' }]);
  decisions[0].faceOrder.reverse();
  fails(() => place(config, 'warrior', { decisions }), 'INSUFFICIENT_COINS');
});

test('花园浅色城堡图标过滤深色，组合收益作为同一字段全部执行', () => {
  const config = configWith('start-action-gardener-1', { food: 2 });
  config.setup.castleRooms = [{ id: 'room-a', cardId: 'steward-s15', tiles: [] }];
  const decisions = [{ type: 'gardener', cardId: 'garden-61' }, { type: 'castleLight', roomId: 'room-a', fieldId: 'top' }];
  fails(() => place(config, 'gardener', { decisions }), 'TARGET_NOT_ALLOWED');
  decisions[1].fieldId = 'middle';
  const next = place(config, 'gardener', { decisions });
  assert.equal(next.players['0'].resources.food, 1);
  assert.equal(next.players['0'].resources.pearl, 1);
});

test('实际城堡同色双行动可排序，先浅色得印章后支付深色费用', () => {
  const config = configWith('start-action-courtier-1');
  config.setup.castleRooms = [{
    id: 'room-a', cardId: 'steward-s08',
    tiles: [{ color: 'coral', fieldId: 'top' }, { color: 'coral', fieldId: 'middle' }, { color: 'black', fieldId: 'bottom' }],
  }];
  config.setup.placements = { 'castle:room-a': { area: 'castle', comparisonValue: 6 } };
  const action = {
    type: 'placeDie', actor: '0', bridgeId: 'coral', side: 'right', target: { area: 'castle', id: 'room-a' },
    choices: ['iron'], decisions: [{ type: 'castleOrder', fieldIds: ['top', 'middle'] }, { type: 'courtier', skip: true }],
  };
  const state = createPosition(config), before = structuredClone(state);
  const next = applyAction(state, action, config);
  assert.equal(next.players['0'].resources.seal, 0);
  assert.equal(next.players['0'].resources.iron, 1);
  action.decisions[0].fieldIds.reverse();
  fails(() => applyAction(state, action, config), 'INSUFFICIENT_SEALS');
  assert.deepEqual(state, before);
});

test('未实现影响力或晋升不被静默忽略，额外决策与无效配置会被拒绝', () => {
  const config = configWith('start-action-courtier-1', { coin: 2 });
  fails(() => place(config, 'courtier', { decisions: [{ type: 'courtier', promote: {} }] }), 'DATA_UNVERIFIED');
  fails(() => place(config, 'courtier', { decisions: [{ type: 'courtier', audience: true }, { type: 'courtier', skip: true }] }), 'INVALID_ACTION');
  const invalid = structuredClone(raw);
  invalid.cards.find((card) => card.kind === 'startingResource').grantDecreeId = 'top-1';
  assert.ok(validateCatalog(invalid).some((issue) => issue.code === 'decreeReference'));
  invalid.cards.find((card) => card.kind === 'diplomat').fields[0].layoutRows = ['unknown'];
  assert.ok(validateCatalog(invalid).some((issue) => issue.code === 'personalLayout'));
});

test('个人面板图标不放骰也不赚骰差，同排图标每回合只能一次', () => {
  const config = configWith('start-action-warrior-1', { iron: 3 });
  config.setup.trainingMode = 'manual-visible-faces';
  config.setup.trainingYards = [{ id: 'yard-cost-3', faceIds: ['yard-face-7'] }];
  const next = place(config, 'warrior', { decisions: [
    { type: 'warrior', yardId: 'yard-cost-3' },
    { type: 'domain', row: 'courtier' },
    { type: 'warrior', skip: true },
  ] });
  assert.equal(next.players['0'].resources.coin, 0);
  assert.equal(next.players['0'].resources.food, 1);
  assert.equal(next.placements['personal:0:courtier'].dice.length, 0);
  assert.equal(next.placements['personal:0:warrior'].dice.length, 1);
  const repeated = [
    { type: 'warrior', yardId: 'yard-cost-3' },
    { type: 'domain', row: 'courtier' },
    { type: 'warrior', yardId: 'yard-cost-3' },
    { type: 'domain', row: 'courtier' },
  ];
  config.setup.players[0].resources.iron = 6;
  fails(() => place(config, 'warrior', { decisions: repeated }), 'TARGET_NOT_ALLOWED');
});

test('水井图标只发资源与固定印章，不产生虚拟骰差额', () => {
  const config = configWith('start-action-gardener-1', { food: 3 });
  config.setup.fixtureVersion = 'well-rewards-v1';
  config.wellRewards = [{ type: 'food', amount: 1 }, { type: 'pearl', amount: 1 }];
  const next = place(config, 'gardener', { decisions: [{ type: 'gardener', cardId: 'garden-62' }] });
  assert.equal(next.players['0'].resources.coin, 0);
  assert.equal(next.players['0'].resources.food, 1);
  assert.equal(next.players['0'].resources.pearl, 1);
  assert.equal(next.players['0'].resources.seal, 1);
  assert.equal(next.placements.well.dice.length, 0);
});

test('放弃深色字段保留放骰及浅色收益，不要求支付被放弃字段的费用', () => {
  const config = configWith('start-action-courtier-1');
  config.setup.castleRooms = [{
    id: 'room-a', cardId: 'steward-s08',
    tiles: [{ color: 'coral', fieldId: 'top' }, { color: 'coral', fieldId: 'middle' }],
  }];
  config.setup.placements = { 'castle:room-a': { area: 'castle', comparisonValue: 6 } };
  const next = applyAction(createPosition(config), {
    type: 'placeDie', actor: '0', bridgeId: 'coral', side: 'right', target: { area: 'castle', id: 'room-a' },
    choices: ['iron'],
    decisions: [
      { type: 'castleOrder', fieldIds: ['middle', 'top'] },
      { type: 'field', fieldId: 'middle', skip: true },
    ],
  }, config);
  assert.equal(next.players['0'].resources.seal, 1);
  assert.equal(next.placements['castle:room-a'].dice.length, 1);
  assert.equal(next.turnsUsed['0'], 1);
});

test('组合字段可重排收益，空排序项保留印刷顺序，无效排列整体拒绝', () => {
  const config = configWith('diplomat-d03');
  config.setup.players[0].lanternCardIds = ['decree-coin'];
  config.setup.players[0].figures = { courtier: [{ location: 'gate' }] };
  const extra = { effectOrders: [null, [1, 0]] };
  const next = place(config, 'courtier', extra);
  assert.equal(next.players['0'].resources.coin, 3);
  assert.equal(next.players['0'].resources.food, 2);
  fails(() => place(config, 'courtier', { effectOrders: [null, [0, 0]] }), 'INVALID_ACTION');
  config.setup.players[0].lanternCardIds = ['start-action-warrior-2'];
  fails(() => place(config, 'courtier'), 'DATA_UNVERIFIED');
});
