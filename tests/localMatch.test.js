import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { applyInfluence } from '../src/engine/influence.js';
import {
  createLocalMatch, applyLocalAction, activeLocalPlayer, remainingRoundGardens,
  exportLocalMatch, importLocalMatch, replayLocalMatch, localMatchSignature,
} from '../src/engine/localMatch.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/whitecastle-2p.json', import.meta.url)));
const fails = (call, code) => assert.throws(call, (error) => error.code === code);
function start(options = {}) {
  let match = createLocalMatch(catalog, { seed: 'local-match-tests', ...options });
  for (let count = 0; count < 2; count += 1) {
    const pair = match.draft.pairs.find((item) => item.chosenBy === null);
    const card = match.config.cards.find((item) => item.id === pair.resourceId);
    const chooseCount = card.initialGains.filter((effect) => effect.type === 'chooseResource')
      .reduce((sum, effect) => sum + effect.amount, 0);
    match = applyLocalAction(match, {
      type: 'chooseStartingPair', actor: activeLocalPlayer(match), pairId: pair.id,
      choices: Array(chooseCount).fill('food'),
    });
  }
  return match;
}
function water(match, bridgeId) {
  const bridge = bridgeId ?? match.state.bridges.find((item) => item.dice.length > 0).id;
  const source = match.state.bridges.find((item) => item.id === bridge);
  return applyLocalAction(match, {
    type: 'placeDie', actor: activeLocalPlayer(match), bridgeId: bridge,
    side: source.dice.length === 1 ? source.singleDieEndpoint : 'right', target: { area: 'well' },
  });
}
function finishRound(match) {
  const round = match.state.round;
  while (match.phase === 'playing' && match.state.round === round) match = water(match);
  return match;
}

test('本地练习的种子、完整牌组和初始行动顺序可复现', () => {
  const first = createLocalMatch(catalog, { seed: 'identical' });
  const second = createLocalMatch(catalog, { seed: 'identical' });
  assert.deepEqual(first, second);
  assert.equal(first.phase, 'draft');
  assert.equal(first.mode, 'local-practice');
  assert.equal(first.profile.id, 'local-practice-v1');
  assert.ok(first.profile.warnings.length);
  assert.deepEqual(catalog.policy, { singleDieEndpoint: null });
  assert.notDeepEqual(first.config.setup.castleRooms, createLocalMatch(catalog, { seed: 'different' }).config.setup.castleRooms);
});

test('R-SETUP-01/02/03：两人开局九骰、五房间与补牌堆、六花园，不重复卡牌', () => {
  const match = start();
  assert.equal(match.phase, 'playing');
  assert.equal(match.state.bridges.length, 3);
  assert.ok(match.state.bridges.every((bridge) => bridge.dice.length === 3
    && bridge.dice.every((die, index, dice) => index === 0 || die.value >= dice[index - 1].value)));
  const rooms = match.state.castleRooms;
  assert.equal(rooms.filter((room) => room.floor === 1).length, 3);
  assert.equal(rooms.filter((room) => room.floor === 2).length, 2);
  const cards = [...rooms.map((room) => room.cardId), ...Object.values(match.config.setup.castleDecks).flat()];
  assert.equal(cards.length, 18);
  assert.equal(new Set(cards).size, 18);
  assert.equal(match.config.setup.gardens.length, 6);
  assert.equal(new Set(match.config.setup.gardens.map((garden) => garden.cardId)).size, 6);
  assert.ok(rooms.every((room) => new Set(room.tiles.map((tile) => tile.color)).size >= 2));
  assert.equal(match.config.setup.trainingMode, 'separate-pools');
  const yards = match.config.setup.trainingYards;
  const allFaces = yards.flatMap((yard) => yard.faceIds);
  assert.equal(allFaces.length, 4);
  assert.equal(new Set(allFaces).size, 4);
  assert.equal(allFaces.filter((id) => match.config.trainingPools.find((pool) => pool.id === 'gold').faceIds.includes(id)).length, 2);
  assert.equal(allFaces.filter((id) => match.config.trainingPools.find((pool) => pool.id === 'silver').faceIds.includes(id)).length, 2);
});

test('R-SETUP-04：逆序选牌后以原行动顺序开始，不额外获得起始资源', () => {
  let match = createLocalMatch(catalog, { seed: 'draft-order', playOrder: ['1', '0'] });
  assert.equal(activeLocalPlayer(match), '0');
  const before = structuredClone(match);
  fails(() => applyLocalAction(match, { type: 'chooseStartingPair', actor: '1', pairId: match.draft.pairs[0].id }), 'NOT_ACTIVE_PLAYER');
  assert.deepEqual(match, before);
  match = start({ playOrder: ['1', '0'] });
  assert.equal(activeLocalPlayer(match), '1');
  for (const actor of ['0', '1']) {
    assert.deepEqual(match.state.players[actor].resources, match.draft.players[actor].resources);
    assert.deepEqual(match.state.players[actor].lanternCards, match.draft.players[actor].lanternCardIds);
  }
});

test('R-INFLUENCE-01：轨道封顶20，跨季关卡及各区间终局分使用已核验主棋盘值', () => {
  const { config } = createLocalMatch(catalog);
  assert.equal(config.influenceTrack.max, 20);
  assert.deepEqual(config.influenceTrack.gates, [
    { at: 6, cost: 1 }, { at: 11, cost: 2 }, { at: 15, cost: 3 },
  ]);
  for (const [position, points] of [[0, 0], [5, 0], [6, 3], [10, 3], [11, 6], [14, 6], [15, 10], [20, 15]]) {
    assert.equal(config.timeTrack[position], points);
  }
  assert.equal(config.timeTrack[21], undefined);
});

test('R-INFLUENCE-01：跨关逐次收费、封顶和拒付练习处理不修改输入', () => {
  const match = start();
  const player = structuredClone(match.state.players['0']);
  player.timePosition = 5;
  player.resources.seal = 5;
  const original = structuredClone(player);
  const context = {
    state: structuredClone(match.state), decisionIndex: 0,
    decisions: [
      { type: 'influence', gate: 6, pay: true },
      { type: 'influence', gate: 11, pay: true },
      { type: 'influence', gate: 15, pay: false },
    ],
  };
  const stopped = applyInfluence(player, 30, match.config, context);
  assert.equal(stopped.timePosition, 14);
  assert.equal(stopped.resources.seal, 2);
  assert.deepEqual(player, original);
  stopped.resources.seal = 3;
  const finished = applyInfluence(stopped, 20, match.config, {
    state: context.state, decisionIndex: 0,
    decisions: [{ type: 'influence', gate: 15, pay: true }],
  });
  assert.equal(finished.timePosition, 20);
  assert.equal(finished.resources.seal, 0);
  fails(() => applyInfluence(player, 1, match.config, {
    state: structuredClone(match.state), decisionIndex: 0, decisions: [],
  }), 'CHOICE_REQUIRED');
});

test('R-ROUND-03：六次放骰后自动进入第二轮，清骰但保留人物和城堡牌', () => {
  let match = start();
  const roomIds = match.state.castleRooms.map((room) => room.cardId);
  match.state.players['0'].figures.warrior.push({ yardId: 'yard-cost-1' });
  match.state.players['0'].figures.courtier.push({ location: 'gate' });
  match = finishRound(match);
  assert.equal(match.state.round, 2);
  assert.equal(match.phase, 'playing');
  assert.deepEqual(match.state.turnsUsed, { '0': 0, '1': 0 });
  assert.equal(match.state.placements.well.dice.length, 0);
  assert.equal(match.state.players['0'].figures.warrior.length, 1);
  assert.equal(match.state.players['0'].figures.courtier.length, 1);
  assert.deepEqual(match.state.castleRooms.map((room) => room.cardId), roomIds);
  assert.equal(match.state.bridges.flatMap((bridge) => bridge.dice).length, 9);
});

test('R-ROUND-01：轮末按影响力位置与顶部优先更新完整顺序', () => {
  let match = start({ playOrder: ['0', '1'] });
  match.state.players['1'].timePosition = 1;
  match.state.players['1'].timePriority = 10;
  match = finishRound(match);
  assert.deepEqual(match.state.playOrder, ['1', '0']);
  assert.equal(activeLocalPlayer(match), '1');
  assert.equal(match.state.players['1'].finalOrder, 0);
  match.state.players['0'].timePosition = 1;
  match.state.players['0'].timePriority = 11;
  match = finishRound(match);
  assert.deepEqual(match.state.playOrder, ['0', '1']);
});

test('R-ROUND-02：花园先按新玩家顺序结算，每名玩家可选自己的花园顺序', () => {
  let match = start({ playOrder: ['0', '1'] });
  const garden = match.config.setup.gardens.find((item) => {
    const card = match.config.cards.find((entry) => entry.id === item.cardId);
    return card.kind === 'stone' && card.fields[0].effects.every((effect) => ['coin', 'seal', 'chooseResource'].includes(effect.type));
  });
  assert.ok(garden);
  match.state.players['0'].figures.gardener.push({ cardId: garden.cardId, bridgeId: garden.bridgeId });
  match.state.players['1'].figures.gardener.push({ cardId: garden.cardId, bridgeId: garden.bridgeId });
  match.state.players['1'].timePosition = 1;
  // 每座桥恰取两骰，确保三个桥都仍有骰子，均符合花园条件。
  for (const id of ['coral', 'coral', 'black', 'black', 'white', 'white']) match = water(match, id);
  assert.equal(match.phase, 'round-gardens');
  assert.equal(match.state.round, 1);
  assert.equal(activeLocalPlayer(match), '1');
  assert.deepEqual(remainingRoundGardens(match), [garden.cardId]);
  const card = match.config.cards.find((item) => item.id === garden.cardId);
  const choices = Array(card.fields[0].effects.filter((effect) => effect.type === 'chooseResource')
    .reduce((sum, effect) => sum + effect.amount, 0)).fill('pearl');
  match = applyLocalAction(match, { type: 'roundGarden', actor: '1', cardId: garden.cardId, choices });
  assert.equal(activeLocalPlayer(match), '0');
  match = applyLocalAction(match, { type: 'roundGarden', actor: '0', cardId: garden.cardId, choices });
  assert.equal(match.phase, 'playing');
  assert.equal(match.state.round, 2);
  assert.equal(match.state.players['0'].figures.gardener.length, 1);
});

test('R-ROUND-02：不符合桥条件的花园不会触发，轮末失败决策保持原局面', () => {
  let match = start();
  const garden = match.config.setup.gardens[0];
  const otherBridge = match.state.bridges.find((bridge) => bridge.id !== garden.bridgeId).id;
  match.state.players['0'].figures.gardener.push({ cardId: garden.cardId, bridgeId: garden.bridgeId });
  for (const bridgeId of [garden.bridgeId, garden.bridgeId, garden.bridgeId, otherBridge, otherBridge, otherBridge]) {
    match = water(match, bridgeId);
  }
  assert.equal(match.state.round, 2);
  assert.equal(match.phase, 'playing');
  const before = structuredClone(match);
  fails(() => applyLocalAction(match, { type: 'roundGarden', actor: activeLocalPlayer(match), cardId: garden.cardId }), 'INVALID_ACTION');
  assert.deepEqual(match, before);
});

test('轮末花园付费失败可回退，兑换不消耗奖励，允许显式放弃付费字段', () => {
  let match = start({ playOrder: ['0', '1'] });
  const garden = match.config.setup.gardens.find((item) => {
    const card = match.config.cards.find((entry) => entry.id === item.cardId);
    return card.fields[0].cost.some((cost) => cost.type === 'coin');
  });
  assert.ok(garden);
  match.state.players['0'].figures.gardener.push({ cardId: garden.cardId, bridgeId: garden.bridgeId });
  for (const id of ['coral', 'coral', 'black', 'black', 'white', 'white']) match = water(match, id);
  match.state.players['0'].resources.coin = 0;
  match.state.players['0'].resources.seal = 2;
  const before = structuredClone(match);
  fails(() => applyLocalAction(match, { type: 'roundGarden', actor: '0', cardId: garden.cardId }), 'INSUFFICIENT_COINS');
  assert.deepEqual(match, before);
  match = applyLocalAction(match, { type: 'exchangeSeal', actor: '0', amount: 1 });
  assert.equal(match.phase, 'round-gardens');
  assert.equal(match.state.phase, 'round-end');
  assert.deepEqual(remainingRoundGardens(match), [garden.cardId]);
  assert.equal(match.state.players['0'].resources.coin, 1);
  match = applyLocalAction(match, {
    type: 'roundGarden', actor: '0', cardId: garden.cardId,
    decisions: [{ type: 'field', fieldId: 'front', skip: true }],
  });
  assert.equal(match.state.round, 2);
  assert.equal(match.state.players['0'].resources.coin, 1);
});

test('R-ROUND-04/SCORE-02：18次常规放骰完整三轮，第三轮直接结算并禁止继续操作', () => {
  let match = start();
  for (let count = 0; count < 18; count += 1) match = water(match);
  assert.equal(match.phase, 'finished');
  assert.equal(match.state.round, 3);
  assert.equal(match.state.phase, 'finished');
  assert.equal(match.state.score.complete, true);
  assert.ok(['0', '1'].includes(match.state.score.winner));
  assert.deepEqual(match.state.turnsUsed, { '0': 3, '1': 3 });
  assert.equal(match.state.bridges.flatMap((bridge) => bridge.dice).length, 3);
  assert.equal(activeLocalPlayer(match), null);
  fails(() => water(match), 'GAME_FINISHED');
});

test('R-ROUND-04：第三轮即使桥与花园满足条件也不再发放花园奖励', () => {
  let match = finishRound(finishRound(start({ playOrder: ['0', '1'] })));
  const garden = match.config.setup.gardens[0];
  match.state.players['0'].figures.gardener.push({ cardId: garden.cardId, bridgeId: garden.bridgeId });
  for (const id of ['coral', 'coral', 'black', 'black', 'white', 'white']) match = water(match, id);
  assert.equal(match.phase, 'finished');
  assert.equal(match.roundGardens, null);
  assert.equal(match.state.score.players['0'].parts.gardener,
    match.config.cards.find((card) => card.id === garden.cardId).victoryPoints);
});

test('存档带完整目录与种子；重放与撤销可复现且不信任伪造状态', () => {
  let match = start();
  match = water(water(water(match)));
  const save = exportLocalMatch(match);
  save.state = { injected: true };
  const restored = importLocalMatch(JSON.parse(JSON.stringify(save)));
  assert.deepEqual(restored, match);
  assert.equal(localMatchSignature(restored), localMatchSignature(match));
  assert.equal(replayLocalMatch(match, 2).state.turnsUsed['0'], 0);
  assert.equal(replayLocalMatch(match, 0).phase, 'draft');
  assert.equal(match.actions.length, 5);
  save.actions.push({ type: 'placeDie', actor: 'wrong' });
  fails(() => importLocalMatch(save), 'NOT_ACTIVE_PLAYER');
  fails(() => replayLocalMatch(match, -1), 'INVALID_AMOUNT');
});

test('手工训练面必须按区保持面数、朝向及独立ID，额外未核验面不能启用', () => {
  fails(() => createLocalMatch(catalog, { trainingYards: [
    { id: 'yard-cost-1', faceIds: ['yard-face-1'] },
    { id: 'yard-cost-3', faceIds: ['yard-face-7'] },
    { id: 'yard-cost-5', faceIds: ['yard-face-13', 'yard-face-8'] },
  ] }), 'INVALID_STATE');
  fails(() => createLocalMatch(catalog, { trainingYards: [
    { id: 'yard-cost-1', faceIds: ['yard-face-13'] },
    { id: 'yard-cost-3', faceIds: ['yard-face-7'] },
    { id: 'yard-cost-5', faceIds: ['yard-face-13', 'yard-face-8'] },
  ] }), 'INVALID_STATE');
});
