import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareLiveAdvice } from '../src/integrations/bgaLiveAdvice.js';
import { mapBgaDefinition } from '../src/integrations/bgaReplay.js';
import { loadTrainingConfig } from '../scripts/ai-common.mjs';
import { createLiveAi } from '../scripts/bga-live-ai.mjs';
import { rememberLiveContext, preparePlayingAdvice } from '../src/integrations/bgaLivePlaying.js';
import { chooseStartingPair } from '../src/engine/startingDraft.js';
import { buildLiveBoard } from '../src/integrations/bgaLiveAdvice.js';

const config = loadTrainingConfig();
const mapping = JSON.parse(fs.readFileSync(new URL('../data/bga-mapping.json', import.meta.url)));
const parameters = { ...config, mapping };

function fixture() {
  const card = (family, definition, slot, container, instance) => ({
    family, definition: String(definition), slot: slot === null ? null : String(slot), containers: [container],
    instance: instance ?? `${family}-${definition}`, localId: mapBgaDefinition(mapping, family, String(definition)),
    faceDown: false, back: null,
  });
  const cards = [
    ...[2, 4, 5].map((id, i) => card('steward', id, i + 1, 'twc-steward-card-slots')),
    ...[2, 3].map((id, i) => card('diplomat', id, i + 1, 'twc-diplomat-card-slots')),
    card('daimyo', 2, null, 'twc-daimyo-card-stock'),
    ...[1, 2, 3, 6, 7, 8].map((id, i) => card('garden', id,
      `${['red', 'black', 'white'][i % 3]}-${i < 3 ? 'plant' : 'rock'}`, 'twc-garden-card-slots')),
    ...[8, 6, 9].map((id, i) => card('starting-resources', id, null,
      'twc-starting-resource-draft-stock', `resource-${i}`)),
    ...[1, 2, 3].map((id, i) => ({ ...card('starting-action', id, null,
      'twc-starting-action-draft-stock', `action-${i}`), localId: mapBgaDefinition(mapping, 'starting-action', String(id))[0] })),
  ];
  const pieces = ['0', '1'].flatMap((owner, i) => [
    { type: 'heron', owner, slot: String(i + 1), containers: [] },
    { type: 'influence', owner, slot: 'influence-0', containers: [] },
    ...[['courtier', 'courtiers'], ['gardener', 'gardeners'], ['warrior', 'warriors']].flatMap(([type, row]) =>
      Array.from({ length: 5 }, (_, j) => ({ type, owner, slot: String(j + 1), containers: [`twc-player-board-${row}-${i + 100}`] }))),
  ]);
  return {
    source: { table: '123', gameAssetVersion: mapping.gameAssetVersion }, issues: [],
    observation: { draftPairs: [0, 1, 2].map((i) => ({ resource: `resource-${i}`, action: `action-${i}` })) },
    archive: { publicPosition: {
      progress: 0, players: ['0', '1'].map((seat, i) => ({ seat, platformId: String(i + 100), displayedScore: 0,
        resources: { food: 0, iron: 0, pearl: 0, coin: 0, seal: 0 } })),
      cards, pieces,
      dice: ['red', 'black', 'white'].flatMap((color) => ['left', 'center', 'right'].map((side, i) => ({
        slot: `${color}-${side}`, color: color === 'red' ? 'coral' : color, value: i + 1,
      }))),
      training: [['front', 6], ['back', 3], ['front', 5], ['back', 1]].map(([side, definition], i) => ({
        slot: String(i + 1), side, definition: String(definition), localId: mapBgaDefinition(mapping, 'yard', String(definition), side),
      })),
      dieTiles: [-3, 3, 8, -2, 4, 9, -1, 5, 10, 1, 6, 2, 7].map((slot, i) => ({
        slot: String(slot), side: 'front', color: ['coral', 'black', 'white'][i % 3], reward: null,
      })).concat([11, 12].map((slot) => ({ slot: String(slot), side: 'back', color: null, reward: 'food' }))),
      decks: [{ kind: 'steward', count: 6 }, { kind: 'diplomat', count: 7 }],
    } },
  };
}

test('公开选牌使用主训练编码，三组配对及当前行动者准确对应', () => {
  const result = prepareLiveAdvice(fixture(), parameters);
  assert.equal(result.actor, '101');
  assert.equal(result.scope, 'starting-draft-only');
  assert.equal(result.observation.state.length, 2345);
  assert.equal(result.observation.candidates.length, 3);
  assert.equal(result.observation.candidates[0].length, 160);
  assert.equal(result.candidates[0].resourceInstance, 'resource-0');
  assert.equal(result.candidates[0].action, 'courtier');
  const modified = fixture();
  modified.archive.publicPosition.cards.find((card) => card.family === 'daimyo').definition = '3';
  assert.notDeepEqual(prepareLiveAdvice(modified, parameters).observation.state, result.observation.state);
});

test('第二位选牌仅在公开资源和背面唯一对账后分析，缺少配对和未结算收益拒绝', () => {
  const value = fixture();
  const p = value.archive.publicPosition;
  const resource = p.cards.find((card) => card.instance === 'resource-0');
  const local = config.catalog.cards.find((card) => card.id === resource.localId);
  Object.assign(resource, { faceDown: true, localId: null, back: local.back,
    containers: ['twc-lantern-card-stock-101'] });
  p.cards.find((card) => card.instance === 'action-0').containers = ['twc-action-card-stock-101'];
  p.players[1].resources = { food: 2, iron: 2, pearl: 1, coin: 4, seal: 1 };
  value.observation.draftPairs.shift();
  const result = prepareLiveAdvice(value, parameters);
  assert.equal(result.actor, '100');
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].resourceInstance, 'resource-1');
  p.players[1].resources.coin = 3;
  assert.throws(() => prepareLiveAdvice(value, parameters), { code: 'BGA_ADVICE_DRAFT_INCOMPLETE' });
});

test('不读取未来信息，放骰、缺失或未知映射不产生建议', () => {
  const value = fixture();
  const before = prepareLiveAdvice(value, parameters);
  value.archive.history = [{ future: 'private-future' }];
  value.observation.logs = [{ future: 'private-future' }];
  assert.deepEqual(prepareLiveAdvice(value, parameters), before);
  for (const [modify, code] of [
    [(v) => { v.observation.draftPairs = []; }, 'BGA_ADVICE_PAIRS'],
    [(v) => { v.archive.publicPosition.dice[0].slot = 'well'; }, 'BGA_ADVICE_PHASE'],
    [(v) => { v.archive.publicPosition.pieces.find((piece) => piece.type === 'warrior').containers = ['twc-training-yard-1']; }, 'BGA_ADVICE_PHASE'],
    [(v) => { v.issues.push({ code: 'BGA_MAPPING_MISSING' }); }, 'BGA_ADVICE_MAPPING'],
  ]) {
    const current = fixture();
    modify(current);
    assert.throws(() => prepareLiveAdvice(current, parameters), { code });
  }
});

test('主模型服务拒绝混入微调模型来源，不能将其作为持续训练冠军返回', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whitecastle-live-ai-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true }));
  fs.mkdirSync(path.join(temporaryRoot, 'data'));
  fs.mkdirSync(path.join(temporaryRoot, 'loop'));
  fs.writeFileSync(path.join(temporaryRoot, 'data/bga-live-ai.json'), JSON.stringify({ loopDirectory: 'loop' }));
  for (const name of ['whitecastle-2p.json', 'ai-heuristic.json', 'bga-mapping.json']) {
    fs.copyFileSync(new URL(`../data/${name}`, import.meta.url), path.join(temporaryRoot, 'data', name));
  }
  fs.writeFileSync(path.join(temporaryRoot, 'loop/loop-state.json'), JSON.stringify({
    meta: config.meta, champion: '/old-branch/loop/generation-00098/candidate.pt',
  }));
  let called = false;
  const ai = createLiveAi({ root: temporaryRoot, inferModel: async () => {
    called = true;
    return { source: 'bga-finetune', model: 'imitation', policy: [0.4, 0.3, 0.3] };
  } });
  const result = await ai.analyze(fixture());
  assert.equal(called, true);
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'AI_INVALID_POLICY');
  assert.notEqual(result.source, 'bga-finetune');
  assert.equal(result.candidates, undefined);
});

test('本机冠军实际推理能返回同编码候选的策略排序', {
  skip: process.env.BGA_LIVE_SMOKE !== '1',
}, async () => {
  const ai = createLiveAi();
  const status = await ai.trainingStatus();
  assert.equal(status.status, 'available');
  const result = await ai.analyze(fixture());
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.equal(result.source, 'continuous-champion');
  assert.match(result.model, /^generation-\d+$/);
  assert.equal(result.candidates.length, 3);
  assert.ok(result.candidates[0].policyWeight >= result.candidates[1].policyWeight);
  assert.equal('rawValue' in result, false);
  assert.ok(Math.abs(result.candidates.reduce((sum, item) => sum + item.policyWeight, 0) - 1) < 0.0001);
  console.log(JSON.stringify({ model: result.model, source: result.source,
    tested: 'synthetic-opening-position', bestColumn: result.candidates[0].column }));
});

function playingFixture() {
  const opening = fixture();
  opening.changedAt = '2026-11-12T01:00:00Z';
  const context = rememberLiveContext(null, opening, parameters);
  assert.ok(context.pairs);
  const latest = structuredClone(opening);
  latest.changedAt = '2026-11-12T01:01:00Z';
  latest.observation.players = [{ id: '100', name: '甲' }, { id: '101', name: '乙' }];
  latest.observation.title = '甲 必须从桥上选择一个骰子并将它放在一个行动位置上';
  const p = latest.archive.publicPosition;
  p.progress = 11;
  p.roundText = '第 1 / 3 轮次';
  let draft = buildLiveBoard(opening, context.pairs, { ...parameters, playOrder: ['0', '1'] }).draft;
  for (const [index, seat] of [[0, '1'], [1, '0']]) {
    const resource = p.cards.find((card) => card.instance === `resource-${index}`);
    const action = p.cards.find((card) => card.instance === `action-${index}`);
    const definition = config.catalog.cards.find((card) => card.id === resource.localId);
    const choices = definition.initialGains.filter((gain) => gain.type === 'chooseResource')
      .flatMap((gain) => Array(gain.amount).fill('food'));
    draft = chooseStartingPair(draft, seat, `starting-pair-${index + 1}`,
      buildLiveBoard(opening, context.pairs, { ...parameters, playOrder: ['0', '1'] }).config, { choices });
    const player = p.players.find((item) => item.seat === seat);
    player.resources = { ...draft.players[seat].resources };
    Object.assign(resource, { faceDown: true, localId: null, back: definition.back,
      containers: [`twc-lantern-card-stock-${player.platformId}`] });
    action.containers = [`twc-action-card-stock-${player.platformId}`];
    if (definition.grantDecreeId) p.cards.push({ instance: `decree-${seat}`, family: 'decree',
      localId: definition.grantDecreeId, faceDown: true, containers: [`twc-lantern-card-stock-${player.platformId}`] });
  }
  p.dice.forEach((die, index) => { die.instance = `die-${index}`; });
  p.dice[0].slot = 'action-space-main-board-steward-1';
  p.dice[1].slot = 'red-left';
  p.dice[8].slot = 'action-space-main-board-steward-3';
  p.dice[7].slot = 'white-right';
  return { latest, context };
}

test('普通放骰还原双方回合、占位和公开牌背，保持主模型编码尺寸', () => {
  const { latest, context } = playingFixture();
  const result = preparePlayingAdvice(latest, { ...parameters, context });
  assert.equal(result.scope, 'placement-root-only');
  assert.equal(result.actor, '100');
  assert.equal(result.observation.state.length, 2345);
  assert.equal(result.observations.length, 6);
  assert.equal(result.observation.state[5], 1 / 3);
  assert.equal(result.observation.state[6], 1 / 3);
  assert.ok(result.candidates.length > 0);
  for (const candidate of result.candidates) {
    if (candidate.kind !== 'placeDie') continue;
    assert.ok(!['floor1-1', 'floor1-3'].includes(candidate.target.id));
    assert.equal(result.observation.candidates[0].length, 160);
  }
  latest.observation.title = '你 必须从桥中选择一个骰子，并将其放置在一个行动上';
  assert.equal(preparePlayingAdvice(latest, { ...parameters, context }).actor, '100');
});

test('普通放骰不使用未来日志，缺上下文、跨桌、未来事实、错回合、时间轨和连锁拒绝', () => {
  const { latest, context } = playingFixture();
  const before = preparePlayingAdvice(latest, { ...parameters, context });
  latest.archive.history = [{ future: 'future-card' }];
  latest.observation.logs = [{ future: 'future-roll' }];
  assert.deepEqual(preparePlayingAdvice(latest, { ...parameters, context }), before);
  for (const [change, code] of [
    [(v, c) => { c.pairs = null; }, 'BGA_ADVICE_CONTEXT'],
    [(v) => { v.source.table = '456'; }, 'BGA_ADVICE_CONTEXT'],
    [(v, c) => { c.seenAt += 3600_000; }, 'BGA_ADVICE_CONTEXT'],
    [(v) => { v.observation.title = '乙 必须从桥上选择一个骰子并将它放在一个行动位置上'; }, 'BGA_ADVICE_TURN'],
    [(v) => { v.archive.publicPosition.pieces.find((piece) => piece.type === 'influence').slot = 'influence-1'; }, 'BGA_ADVICE_TIME_ORDER'],
    [(v) => { v.observation.title = '甲 必须选择一项城堡行动'; }, 'BGA_ADVICE_PHASE'],
    [(v) => { v.archive.publicPosition.dice[0].slot = 'unknown'; }, 'BGA_ADVICE_DICE_SLOT'],
  ]) {
    const v = structuredClone(latest);
    const c = structuredClone(context);
    change(v, c);
    assert.throws(() => preparePlayingAdvice(v, { ...parameters, context: c }), { code });
  }
});

test('公开上下文不会由后采样覆盖过去，可见背面不抹除曾见正面', () => {
  const { latest, context } = playingFixture();
  const updated = rememberLiveContext(context, latest, parameters);
  assert.equal(updated.faces['resource-0'].localId, context.faces['resource-0'].localId);
  const previous = structuredClone(latest);
  previous.changedAt = '2026-11-12T00:59:00Z';
  previous.archive.publicPosition.cards[0].localId = 'fabricated';
  assert.deepEqual(rememberLiveContext(updated, previous, parameters), updated);
  const swapped = structuredClone(latest);
  swapped.source.table = '789';
  assert.equal(rememberLiveContext(updated, swapped, parameters).pairs, null);
});
