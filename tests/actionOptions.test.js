import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createLocalMatch, activeLocalPlayer } from '../src/engine/localMatch.js';
import { createPosition } from '../src/engine/engine.js';
import {
  probeLocalAction, chooseActionOption, placementOptions, roundGardenOptions,
} from '../src/engine/actionOptions.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/whitecastle-2p.json', import.meta.url)));
const clone = (value) => structuredClone(value);

function fixture(cardId = 'start-action-courtier-1', options = {}) {
  const match = createLocalMatch(catalog, { seed: 'action-options-fixture', playOrder: ['0', '1'] });
  match.config.setup.players = [{
    currentCardId: cardId,
    resources: { coin: 5, pearl: 7, food: 7, iron: 7, ...(options.resources ?? {}) },
    ...(options.player ?? {}),
  }, { currentCardId: 'start-action-courtier-2' }];
  match.config.setup.bridges = ['coral', 'black', 'white'].map((color) => ({
    id: color, color, dice: [0, 1, 2].map((index) => ({ id: `${color}-${index}`, value: options.dieValue ?? 6 })),
  }));
  match.config.setup.castleRooms = [
    { id: 'floor1-a', floor: 1, cardId: 'steward-s03', tiles: [
      { fieldId: 'top', color: 'coral' }, { fieldId: 'middle', color: 'coral' }, { fieldId: 'bottom', color: 'black' },
    ] },
    { id: 'floor2-a', floor: 2, cardId: 'diplomat-d03', tiles: [
      { fieldId: 'upper', color: 'black' }, { fieldId: 'lower', color: 'white' },
    ] },
  ];
  match.config.setup.castleDecks = { steward: ['steward-s02'], diplomat: ['diplomat-d11'] };
  match.config.setup.placements = {
    'castle:floor1-a': { area: 'castle', comparisonValue: 3 },
    'castle:floor2-a': { area: 'castle', comparisonValue: 4 },
    'outside:left': { area: 'outside', comparisonValue: 5 },
    'outside:right': { area: 'outside', comparisonValue: 5 },
  };
  match.config.setup.gardens = [
    { cardId: 'garden-58', bridgeId: 'coral' },
    { cardId: 'garden-59', bridgeId: 'black' },
  ];
  match.config.setup.trainingMode = 'separate-pools';
  match.config.setup.trainingYards = [
    { id: 'yard-cost-1', faceIds: ['yard-face-15'] },
    { id: 'yard-cost-3', faceIds: ['yard-face-2'] },
    { id: 'yard-cost-5', faceIds: ['yard-face-13', 'yard-face-8'] },
  ];
  match.state = createPosition(match.config);
  match.phase = 'playing';
  return match;
}

function personal(row) {
  return {
    type: 'placeDie', actor: '0', bridgeId: { courtier: 'coral', gardener: 'black', warrior: 'white' }[row],
    side: 'right', target: { area: 'personal', row },
  };
}

function select(match, probe, predicate) {
  const selected = probe.options.find((item) => predicate(item.value));
  assert.ok(selected, `缺少测试期望的${probe.request?.type}候选`);
  return probeLocalAction(match, chooseActionOption(probe, selected.value));
}

test('动作向导依次请求同组排序和逐份资源，完成preview但绝不修改原对局', () => {
  const match = fixture();
  match.config.setup.wellRewards = [{ type: 'chooseResource', amount: 2 }, { type: 'coin', amount: 1 }];
  match.state = createPosition(match.config);
  const before = clone(match);
  const action = { type: 'placeDie', actor: '0', bridgeId: 'coral', side: 'right', target: { area: 'well' } };
  let probe = probeLocalAction(match, action);
  assert.equal(probe.status, 'choice');
  assert.equal(probe.request.type, 'effectOrder');
  assert.equal(probe.request.index, 0);
  probe = probeLocalAction(match, chooseActionOption(probe, [1, 2, 0]));
  assert.equal(probe.request.type, 'chooseResource');
  assert.deepEqual(probe.options.map((item) => item.value), ['food', 'iron', 'pearl']);
  probe = select(match, probe, (value) => value === 'food');
  assert.equal(probe.request.index, 1);
  probe = select(match, probe, (value) => value === 'iron');
  assert.equal(probe.status, 'ready');
  assert.equal(probe.preview.state.players['0'].resources.coin, 11);
  assert.deepEqual(match, before);
  assert.equal(action.interactive, undefined);
  assert.deepEqual(probe.action.choices, ['food', 'iron']);
});

test('个人牌字段先询问执行或放弃，再给完整家臣谒见晋升候选', () => {
  const match = fixture();
  const before = clone(match);
  let probe = probeLocalAction(match, personal('courtier'));
  assert.equal(probe.request.type, 'field');
  assert.equal(probe.options.length, 2);
  probe = select(match, probe, (value) => value.skip === false);
  assert.equal(probe.request.type, 'courtier');
  const selected = probe.options.find(({ value }) => value.audience && value.promote?.figureIndex === 0
    && value.promote.roomId === 'floor1-a' && value.promote.fieldId === 'middle');
  assert.ok(selected);
  probe = probeLocalAction(match, chooseActionOption(probe, selected.value));
  assert.equal(probe.request.type, 'field');
  assert.equal(probe.request.field.id, 'middle');
  probe = select(match, probe, (value) => value.skip === false);
  assert.equal(probe.status, 'ready');
  assert.equal(probe.preview.state.players['0'].currentCard, 'steward-s03');
  assert.equal(probe.preview.state.players['0'].figures.courtier[0].location, 'floor1');
  assert.deepEqual(match, before);
});

test('园丁候选过滤本人已有花园和食品不足，部署后继续字段及自选资源向导', () => {
  const match = fixture('start-action-gardener-1', {
    resources: { food: 1 },
    player: { figures: { gardener: [{ cardId: 'garden-59', bridgeId: 'black' }] } },
  });
  let probe = probeLocalAction(match, personal('gardener'));
  assert.equal(probe.request.type, 'effectOrder');
  probe = probeLocalAction(match, chooseActionOption(probe, null));
  probe = select(match, probe, (value) => value.skip === false);
  assert.equal(probe.request.type, 'gardener');
  assert.deepEqual(probe.options.filter(({ value }) => value.cardId).map(({ value }) => value.cardId), ['garden-58']);
  probe = select(match, probe, (value) => value.cardId === 'garden-58');
  assert.equal(probe.request.type, 'field');
  probe = select(match, probe, (value) => value.skip === false);
  probe = select(match, probe, (value) => value === 'pearl');
  probe = select(match, probe, (value) => value === 'food');
  assert.equal(probe.status, 'ready');
  assert.equal(probe.preview.state.players['0'].figures.gardener.length, 2);
  assert.equal(probe.preview.state.players['0'].resources.food, 1);
});

test('武士候选按铁费过滤，双面训练提供两种顺序，独立面奖励继续正常选择', () => {
  const match = fixture('start-action-warrior-1', { resources: { iron: 5 } });
  let probe = probeLocalAction(match, personal('warrior'));
  probe = select(match, probe, (value) => value.skip === false);
  assert.equal(probe.request.type, 'warrior');
  const five = probe.options.filter(({ value }) => value.yardId === 'yard-cost-5');
  assert.equal(five.length, 2);
  assert.deepEqual(five.map(({ value }) => value.faceOrder), [
    ['yard-face-13', 'yard-face-8'], ['yard-face-8', 'yard-face-13'],
  ]);
  probe = select(match, probe, (value) => value.yardId === 'yard-cost-1');
  probe = select(match, probe, (value) => value.skip === false);
  assert.equal(probe.status, 'ready');
  assert.equal(probe.preview.state.players['0'].resources.points, 2);
  const poor = fixture('start-action-warrior-1', { resources: { iron: 0 } });
  let poorProbe = probeLocalAction(poor, personal('warrior'));
  poorProbe = select(poor, poorProbe, (value) => value.skip === false);
  assert.deepEqual(poorProbe.options.map(({ value }) => value), [{ type: 'warrior', skip: true }]);
});

test('字段费用不足时只提供放弃，错误选择及多余资源返回invalid且无输入变化', () => {
  const match = fixture('steward-s08', { resources: { seal: 0 } });
  const before = clone(match);
  let probe = probeLocalAction(match, personal('gardener'));
  assert.equal(probe.request.type, 'field');
  assert.deepEqual(probe.options.map(({ value }) => value), [{ type: 'field', fieldId: 'middle', skip: true }]);
  probe = select(match, probe, (value) => value.skip);
  assert.equal(probe.status, 'ready');
  const invalid = probeLocalAction(match, { ...probe.action, choices: ['food'] });
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.code, 'INVALID_ACTION');
  assert.deepEqual(match, before);
  assert.throws(() => chooseActionOption(probe, {}), /INVALID_CHOICE/);
});

test('城堡同色多字段请求完整排列，城外只显示该侧允许的两种行动', () => {
  const match = fixture();
  let probe = probeLocalAction(match, {
    type: 'placeDie', actor: '0', bridgeId: 'coral', side: 'right', target: { area: 'castle', id: 'floor1-a' },
  });
  assert.equal(probe.request.type, 'castleOrder');
  assert.deepEqual(probe.options.map(({ value }) => value.fieldIds), [['top', 'middle'], ['middle', 'top']]);
  probe = probeLocalAction(match, {
    type: 'placeDie', actor: '0', bridgeId: 'coral', side: 'right', target: { area: 'outside', id: 'left' },
  });
  assert.equal(probe.request.type, 'outside');
  assert.deepEqual(probe.options.map(({ value }) => value.action), ['gardener', 'courtier']);
});

test('放骰候选严格过滤费用、骰色、共享容量、他人面板和孤骰所在端', () => {
  const poor = fixture('start-action-courtier-1', { resources: { coin: 0 }, dieValue: 1 });
  assert.deepEqual(placementOptions(poor, 'coral', 'right').map((item) => item.placementId), ['well']);
  const match = fixture('start-action-courtier-1', { resources: { coin: 5 }, dieValue: 1 });
  const ids = placementOptions(match, 'coral', 'right').map((item) => item.placementId);
  assert.ok(ids.includes('personal:0:courtier'));
  assert.ok(ids.includes('castle:floor1-a'));
  assert.ok(!ids.includes('castle:floor2-a'));
  assert.ok(!ids.includes('personal:0:gardener'));
  assert.ok(!ids.some((id) => id.startsWith('personal:1:')));
  match.state.placements['castle:floor1-a'].dice.push({ id: 'used', value: 6, actor: '1' });
  assert.ok(!placementOptions(match, 'coral', 'right').some((item) => item.placementId === 'castle:floor1-a'));
  match.state.bridges[0].dice = [match.state.bridges[0].dice[0]];
  match.state.bridges[0].singleDieEndpoint = 'left';
  assert.deepEqual(placementOptions(match, 'coral', 'right'), []);
  assert.ok(placementOptions(match, 'coral', 'left').length);
  assert.deepEqual(placementOptions(match, 'missing', 'right'), []);
  assert.deepEqual(placementOptions(match, 'coral', 'middle'), []);
  match.phase = 'finished';
  assert.deepEqual(placementOptions(match, 'coral', 'left'), []);
});

test('轮末候选只属于当前结算玩家且不泄漏可修改的remaining数组', () => {
  const match = fixture();
  assert.deepEqual(roundGardenOptions(match), []);
  match.phase = 'round-gardens';
  match.roundGardens = { order: ['1', '0'], playerIndex: 0, remaining: { '0': ['garden-58'], '1': ['garden-59'] } };
  assert.equal(activeLocalPlayer(match), '1');
  const options = roundGardenOptions(match);
  assert.deepEqual(options, [{ type: 'roundGarden', actor: '1', cardId: 'garden-59' }]);
  options[0].cardId = 'changed';
  assert.deepEqual(match.roundGardens.remaining['1'], ['garden-59']);
});
