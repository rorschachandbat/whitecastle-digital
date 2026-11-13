import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareLiveAdvice, getDraftSession } from '../src/integrations/bgaLiveAdvice.js';
import { searchRoutes, samplePublicEnvironment } from '../src/ai/routeSearch.js';
import { chooseHeuristic } from '../src/ai/heuristicPolicy.js';
import { mapBgaDefinition } from '../src/integrations/bgaReplay.js';
import { loadTrainingConfig } from '../scripts/ai-common.mjs';
import { createLiveAi } from '../scripts/bga-live-ai.mjs';
import { rememberLiveContext, preparePlayingAdvice, getPlayingSession } from '../src/integrations/bgaLivePlaying.js';
import { prepareChainAdvice, advancePublic } from '../src/integrations/bgaLiveChain.js';
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
  assert.equal(result.observation.state.length, 2357);
  assert.equal(result.observation.candidates.length, 3);
  assert.equal(result.observation.candidates[0].length, 160);
  assert.equal(result.candidates[0].resourceInstance, 'resource-0');
  assert.equal(result.candidates[0].action, 'courtier');
  const modified = fixture();
  modified.archive.publicPosition.cards.find((card) => card.family === 'daimyo').definition = '3';
  assert.notDeepEqual(prepareLiveAdvice(modified, parameters).observation.state, result.observation.state);
});

test('选牌搜索沿用已公开首轮骰子，跨轮后恢复独立机会抽样', () => {
  const latest = fixture();
  latest.archive.publicPosition.dice.forEach((die, index) => { die.instance = `public-die-${index}`; });
  const prepared = prepareLiveAdvice(latest, parameters);
  const { env } = getDraftSession(prepared);
  const branch = samplePublicEnvironment(env, 'draft-dice');
  let observation = branch.observe();
  while (branch.match.phase === 'draft') observation = branch.step(chooseHeuristic(observation.heuristic));
  assert.deepEqual(branch.match.state.bridges.map((bridge) => bridge.dice.map((die) => die.value)),
    [[1, 2, 3], [1, 2, 3], [1, 2, 3]]);
  const original = structuredClone(env.match);
  const result = searchRoutes(env, env.getLegalActions().map(() => 1 / env.getLegalActions().length), {
    width: 2, samples: 1, maxDecisions: 160, maxPlacements: 8, seed: 'public-draft-route',
  });
  assert.equal(result.searched, true);
  assert.equal(result.failed, 0);
  assert.ok(result.maxRoundsAhead >= 2);
  assert.deepEqual(env.match, original);
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

test('侧栏按所选版本固定冠军，旧摆设与初始权重可对照，其他编码不匹配仍拒绝', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whitecastle-live-models-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true }));
  fs.mkdirSync(path.join(temporaryRoot, 'data'));
  for (const name of ['whitecastle-2p.json', 'ai-heuristic.json', 'bga-mapping.json']) {
    fs.copyFileSync(new URL(`../data/${name}`, import.meta.url), path.join(temporaryRoot, 'data', name));
  }
  fs.writeFileSync(path.join(temporaryRoot, 'data/bga-live-ai.json'), JSON.stringify({
    loopDirectory: '.local/ai/continuous-r6', python: 'python-stub',
  }));
  fs.writeFileSync(path.join(temporaryRoot, 'python-stub'), '');
  for (const [id, generation] of [['r4', 'generation-00117'], ['r6', 'initial']]) {
    const loop = path.join(temporaryRoot, '.local/ai', `continuous-${id}`);
    const checkpoint = path.join(loop, generation, generation === 'initial' ? 'imitation.pt' : 'candidate.pt');
    fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
    fs.writeFileSync(checkpoint, '');
    fs.writeFileSync(path.join(loop, 'loop-state.json'), JSON.stringify({
      meta: { ...config.meta, ...(id === 'r4' ? { setupVersion: 'old-setup' } : {}) },
      champion: checkpoint, generation: 1, updatedAt: 0,
    }));
  }
  const calls = [];
  const ai = createLiveAi({ root: temporaryRoot, inferModel: async (observation, c) => {
    calls.push([c.modelId, c.generation, c.legacySetup]);
    return { source: 'continuous-champion', model: c.generation, policy: observation.candidates.map(() => 1 / observation.candidates.length) };
  } });
  const listing = await ai.models();
  assert.equal(listing.selectedModel, 'r6');
  assert.ok(listing.models.every((model) => model.status === 'available'));
  const old = await ai.analyze(fixture(), { modelId: 'r4' });
  const initial = await ai.analyze(fixture(), { modelId: 'r6' });
  assert.equal(old.status, 'ready');
  assert.equal(old.modelId, 'r4');
  assert.equal(old.legacySetup, true);
  assert.equal(initial.status, 'ready');
  assert.equal(initial.model, 'initial');
  assert.deepEqual(calls, [['r4', 'generation-00117', true], ['r6', 'initial', false]]);
  const stateFile = path.join(temporaryRoot, '.local/ai/continuous-r4/loop-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile));
  state.meta.encoderHash = 'incompatible';
  fs.writeFileSync(stateFile, JSON.stringify(state));
  assert.equal((await ai.analyze(fixture(), { modelId: 'r4' })).code, 'AI_MODEL_CONFIG_MISMATCH');
  assert.equal((await ai.analyze(fixture(), { modelId: '../r4' })).code, 'AI_MODEL_INVALID');
});

test('旧v3选牌和放骰兼容只去掉结构特征，不重复修正灯笼；未知编码拒绝推理', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whitecastle-live-v3-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true }));
  fs.mkdirSync(path.join(temporaryRoot, 'data'));
  for (const name of ['whitecastle-2p.json', 'ai-heuristic.json', 'bga-mapping.json']) {
    fs.copyFileSync(new URL(`../data/${name}`, import.meta.url), path.join(temporaryRoot, 'data', name));
  }
  fs.writeFileSync(path.join(temporaryRoot, 'data/bga-live-ai.json'), JSON.stringify({
    loopDirectory: '.local/ai/continuous-r8',
  }));
  const loop = path.join(temporaryRoot, '.local/ai/continuous-r8');
  fs.mkdirSync(loop, { recursive: true });
  const live = playingFixture();
  fs.mkdirSync(path.join(temporaryRoot, '.local/bga-live/contexts'), { recursive: true });
  fs.writeFileSync(path.join(temporaryRoot, '.local/bga-live/contexts/123.json'),
    JSON.stringify(live.context));
  const stateFile = path.join(loop, 'loop-state.json');
  let expectedLanternCompat = false;
  let calls = 0;
  const ai = createLiveAi({ root: temporaryRoot, inferModel: async (observation, c) => {
    calls += 1;
    assert.equal(observation.state.length, 2345);
    assert.equal(c.lanternCompat, expectedLanternCompat);
    return { source: 'continuous-champion', model: 'initial',
      policy: observation.candidates.map(() => 1 / observation.candidates.length) };
  } });
  for (const version of ['public-decisions-v3', 'public-decisions-v2', 'unknown-encoding']) {
    expectedLanternCompat = version === 'public-decisions-v2';
    fs.writeFileSync(stateFile, JSON.stringify({
      meta: { ...config.meta, featureVersion: version, encoderHash: 'legacy-source' },
      champion: path.join(loop, 'initial/imitation.pt'),
    }));
    const result = await ai.analyze(fixture());
    if (version === 'unknown-encoding') assert.equal(result.code, 'AI_MODEL_CONFIG_MISMATCH');
    else {
      assert.equal(result.status, 'ready', JSON.stringify(result));
      assert.equal(result.lanternAdjusted, expectedLanternCompat);
      const playing = await ai.analyze(live.latest);
      assert.equal(playing.status, 'ready', JSON.stringify(playing));
      assert.equal(playing.lanternAdjusted, expectedLanternCompat);
    }
  }
  assert.ok(calls >= 4);
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
  assert.equal(result.observation.state.length, 2357);
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

test('普通放骰不使用未来日志，缺上下文、跨桌、未来事实、错回合和无效时间轨拒绝', () => {
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
    [(v) => { v.archive.publicPosition.pieces.find((piece) => piece.type === 'influence').slot = 'influence-21'; }, 'BGA_ADVICE_TIME_ORDER'],
    [(v) => { v.observation.title = '甲 必须选择一项城堡行动'; }, 'BGA_ADVICE_PHASE'],
    [(v) => { v.archive.publicPosition.dice[0].slot = 'unknown'; }, 'BGA_ADVICE_DICE_SLOT'],
  ]) {
    const v = structuredClone(latest);
    const c = structuredClone(context);
    change(v, c);
    assert.throws(() => preparePlayingAdvice(v, { ...parameters, context: c }), { code });
  }
});

test('第二三轮、非原点时间轨、真实城外格和大名槽可编码，未知优先顺序显式平均', () => {
  for (const round of [2, 3]) {
    const { latest, context } = playingFixture();
    const p = latest.archive.publicPosition;
    p.roundText = `第 ${round} / 3 轮次`;
    p.pieces.find((piece) => piece.type === 'influence').slot = 'influence-4';
    p.dice[0].slot = 'action-space-main-board-outside-the-walls-2';
    const courtier = p.pieces.find((piece) => piece.type === 'courtier');
    courtier.containers = ['twc-daimyo-courtier-stock'];
    courtier.slot = '2';
    const prepared = preparePlayingAdvice(latest, { ...parameters, context });
    assert.equal(prepared.observation.state[4], round / 3);
    assert.equal(prepared.observations.length, 12);
    assert.deepEqual(prepared.uncertainties, ['time-arrival-order']);
    const { env } = getPlayingSession(prepared);
    assert.equal(env.match.state.players['0'].timePosition, 4);
    assert.equal(env.match.state.players['0'].finalOrder, 0);
    assert.equal(Object.keys(env.match.state.topSlots).length, 1);
    assert.equal(env.match.state.placements['outside:right'].dice.length, 1);
    assert.equal(prepared.candidates.some((candidate) => candidate.target?.area === 'outside'
      && candidate.target.id === 'right'), false);
    p.dice[0].slot = 'action-space-player-101-1';
    const personal = getPlayingSession(preparePlayingAdvice(latest, { ...parameters, context })).env;
    assert.equal(personal.match.state.placements['personal:1:courtier'].dice.length, 1);
  }
});

function chainFixture(type) {
  const { latest, context } = playingFixture();
  // 先让公开资源足以测试不同目标，不依赖随机开局的个人资源分配。
  latest.archive.publicPosition.players[0].resources.food = 7;
  if (type === 'chooseResource') {
    latest.archive.publicPosition.players[0].resources.food = 3;
    latest.archive.publicPosition.dieTiles.filter((tile) => tile.side === 'back')
      .forEach((tile, index) => { tile.reward = index ? 'coin' : 'chooseResource'; });
  }
  let selected;
  const prepared = preparePlayingAdvice(latest, { ...parameters, context });
  for (let index = 0; index < prepared.candidates.length && !selected; index += 1) {
    const candidate = prepared.candidates[index];
    if (candidate.kind !== 'placeDie' || candidate.action.side !== 'right'
      || (type === 'gardener' ? candidate.target.area !== 'outside' || candidate.target.id !== 'left'
        : candidate.target.area !== 'well')) continue;
    const value = preparePlayingAdvice(latest, { ...parameters, context });
    const { env } = getPlayingSession(value);
    if (!advancePublic(env, index)) continue;
    for (let depth = 0; env.pending && depth < 8; depth += 1) {
      if (env.probe.request.type === type) { selected = { env, index }; break; }
      const options = env.getLegalActions();
      const next = options.findIndex((option) => option.next?.status !== 'public-chance' && !option.value?.skip
        && (env.probe.request.type !== 'outside' || option.value.action === 'gardener'));
      if (next < 0 || !advancePublic(env, next)) break;
    }
  }
  assert.ok(selected, type);
  const { env, index } = selected;
  const updated = rememberLiveContext(context, latest, parameters);
  const current = structuredClone(latest);
  current.changedAt = '2026-11-12T01:02:00Z';
  current.observation.title = '甲 必须执行行动';
  const p = current.archive.publicPosition;
  const request = env.probe.request;
  const actor = p.players.find((player) => player.seat === env.actor);
  actor.resources = { ...request.player.resources };
  actor.displayedScore = request.player.resources.points;
  p.pieces.find((piece) => piece.owner === env.actor && piece.type === 'influence').slot = `influence-${request.player.timePosition}`;
  const action = prepared.candidates[index].action;
  const die = p.dice.find((item) => item.slot === `${action.bridgeId === 'coral' ? 'red' : action.bridgeId}-${action.side}`);
  die.slot = action.target.area === 'castle' ? `action-space-main-board-${action.target.id.startsWith('floor1') ? 'steward' : 'diplomat'}-${action.target.id.split('-')[1]}`
    : action.target.area === 'outside' ? `action-space-main-board-outside-the-walls-${action.target.id === 'left' ? 1 : 2}`
      : action.target.area === 'personal' ? `action-space-player-board-${actor.platformId}-${action.target.row}`
        : 'action-space-main-board-well';
  // 模拟取骰动画结束后桥端重新标注。
  for (const color of ['red', 'black', 'white']) {
    const remaining = p.dice.filter((item) => item.slot.startsWith(`${color}-`));
    if (remaining.length === 2) remaining.forEach((item, i) => { item.slot = `${color}-${i ? 'right' : 'left'}`; });
  }
  current.observation.decision = {
    buttons: type === 'chooseResource' ? ['food', 'iron', 'pearl'].map((resource) =>
      ({ id: `twc-perform-action-${resource}`, disabled: false, icons: [] })) : [{ id: 'jj-perform-skip', disabled: false, icons: [] }],
    targets: type === 'gardener' ? p.cards.filter((card) => card.family === 'garden').map((card) => card.instance) : [],
  };
  // 使用真实网站的花园实例标识格式。
  if (type === 'gardener') {
    p.cards.filter((card) => card.family === 'garden').forEach((card, i) => { card.instance = `twc-garden-card-${i + 1}`; });
    current.observation.decision.targets = p.cards.filter((card) => card.family === 'garden').map((card) => card.instance);
  }
  return { current, context: updated };
}

test('真实放骰后公开状态与可见园丁目标唯一匹配才提供连锁；资源不一致时拒绝', () => {
  const { current, context } = chainFixture('gardener');
  const result = prepareChainAdvice(current, { ...parameters, context });
  assert.equal(result.scope, 'live-chain');
  assert.equal(result.observation.request, 'gardener');
  assert.ok(result.candidates.some((candidate) => candidate.type === 'gardener' && candidate.cardId));
  current.archive.publicPosition.players[0].resources.coin += 1;
  assert.throws(() => prepareChainAdvice(current, { ...parameters, context }), { code: 'BGA_ADVICE_CHAIN_CONTEXT' });
});

test('资源连锁接入同一主编码；已点选部分资源不会当作未选择重复建议', () => {
  const { current, context } = chainFixture('chooseResource');
  const result = prepareChainAdvice(current, { ...parameters, context });
  assert.equal(result.observation.request, 'chooseResource');
  assert.equal(result.observation.state.length, 2357);
  assert.deepEqual(result.candidates.map((candidate) => candidate.resource), ['food', 'iron', 'pearl']);
  current.observation.decision.buttons.push({ id: 'twc-perform-action-confirm', disabled: true, icons: ['food', 'resource'] });
  assert.throws(() => prepareChainAdvice(current, { ...parameters, context }), { code: 'BGA_ADVICE_RESOURCE_PARTIAL' });
});

test('谒见并晋升已有家臣时按其真实楼层判断未知补牌边界', () => {
  const { latest, context } = playingFixture();
  const p = latest.archive.publicPosition;
  p.players[0].resources.coin = 7;
  p.players[0].resources.pearl = 7;
  p.pieces.find((piece) => piece.type === 'courtier' && piece.owner === '0').containers =
    ['twc-castle-room-main-board-steward-1-courtier-stock'];
  const prepared = preparePlayingAdvice(latest, { ...parameters, context });
  const { env } = getPlayingSession(prepared);
  const rootIndex = prepared.candidates.findIndex((candidate) => candidate.kind === 'placeDie'
    && candidate.action.side === 'right' && candidate.target.area === 'outside' && candidate.target.id === 'left');
  assert.ok(advancePublic(env, rootIndex));
  assert.ok(advancePublic(env, env.getLegalActions().findIndex((option) => option.value?.action === 'courtier')));
  assert.equal(env.probe.request.type, 'courtier');
  const climb = (steps) => env.getLegalActions().find((option) => option.value?.audience
    && option.value.promote?.figureIndex === 0 && option.value.promote.steps === steps);
  assert.equal(climb(1).next.status, 'public-chance');
  assert.notEqual(climb(2).next.status, 'public-chance');
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
