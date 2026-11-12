import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { TrainingEnvironment } from '../src/ai/environment.js';
import { chooseHeuristic } from '../src/ai/heuristicPolicy.js';
import { encodeState } from '../src/ai/features.js';
import { importLocalMatch, exportLocalMatch } from '../src/engine/localMatch.js';
import { probeLocalAction, chooseActionOption } from '../src/engine/actionOptions.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/whitecastle-2p.json', import.meta.url)));
const weights = JSON.parse(fs.readFileSync(new URL('../data/ai-heuristic.json', import.meta.url)));
const environment = () => new TrainingEnvironment(catalog, weights);

test('AI 观察只使用公开信息，不受种子、补牌顺序及配置签名字符串影响', () => {
  const env = environment();
  const first = env.reset('public-information');
  const before = structuredClone(env.match);
  assert.deepEqual(encodeState(env), first.state);
  assert.deepEqual(env.match, before);
  env.match.seed = 'different-private-seed';
  env.match.config.setup.castleDecks.steward.reverse();
  env.match.config.setup.castleDecks.diplomat.reverse();
  env.match.configSignature = 'private';
  assert.deepEqual(encodeState(env), first.state);
});

test('AI 选项编码与观察在整个三轮保持定长有限数，完整动作可重放', () => {
  const env = environment();
  let observation = env.reset('ai-guide-0', ['0', '1']);
  const stateSize = observation.state.length;
  const optionSize = observation.candidates[0].length;
  const original = structuredClone(env.match);
  env.getLegalActions();
  env.observe();
  assert.deepEqual(env.match, original);
  assert.throws(() => env.step(-1), /AI_INVALID_INDEX/);
  while (!observation.done) {
    assert.equal(observation.state.length, stateSize);
    assert.ok(observation.state.every(Number.isFinite));
    for (const candidate of observation.candidates) {
      assert.equal(candidate.length, optionSize);
      assert.ok(candidate.every(Number.isFinite));
    }
    observation = env.step(chooseHeuristic(observation.heuristic));
  }
  assert.equal(observation.placements, 18);
  assert.ok(observation.score.complete);
  assert.deepEqual(importLocalMatch(exportLocalMatch(env.match)).state, env.match.state);
  assert.deepEqual(env.getLegalActions(), []);
});

test('AI 合法前缀过滤没有金币完成谒见的晋升分支，保留有完整续行的选项', () => {
  const env = environment();
  let observation = env.reset('courtier-prefix-fixture', ['1', '0']);
  while (env.match.phase === 'draft') observation = env.step(chooseHeuristic(observation.heuristic));
  // 显式构造零金币家臣场景，不依赖随机开局下启发式恰好走到某条晋升分支。
  const actor = env.actor;
  const player = env.match.state.players[actor];
  player.resources = { coin: 0, seal: 0, food: 0, iron: 0, pearl: 2, points: 0 };
  player.currentCard = 'start-action-courtier-1';
  player.lanternCards = [];
  player.figures.courtier = [{ location: 'gate' }];
  env.match.state.castleRooms.find((room) => room.floor === 1).cardId = 'steward-s03';
  const bridge = env.match.state.bridges.find((item) => item.id === 'coral');
  bridge.dice.at(-1).value = 6;
  const action = { type: 'placeDie', actor, bridgeId: 'coral', side: 'right', target: { area: 'personal', row: 'courtier' } };
  let probe = probeLocalAction(env.match, action);
  if (probe.request.type === 'effectOrder') probe = probeLocalAction(env.match, chooseActionOption(probe, null));
  assert.equal(probe.request.type, 'field');
  probe = probeLocalAction(env.match, chooseActionOption(probe, probe.options.find((item) => item.value.skip === false).value));
  assert.equal(probe.request.type, 'courtier');
  env.pending = probe.action;
  env.probe = probe;
  env.options = null;
  env.witnesses.clear();
  let checked = false;
  for (const { value } of env.probe.options) {
    if (value.order?.[0] !== 'promote') continue;
    const next = probeLocalAction(env.match, chooseActionOption(env.probe, value));
    if (!env.canComplete(next)) {
      assert.ok(!env.getLegalActions().some((option) => JSON.stringify(option.value) === JSON.stringify(value)));
      checked = true;
    }
  }
  assert.ok(checked, '测试必须命中晋升后无法付费的分支');
  assert.ok(env.getLegalActions().some((option) => option.value.promote && !option.value.audience));
  assert.ok(env.getLegalActions().every((option) => env.canComplete(option.next)));
});

test('AI 显式限制决策步数并提供机器错误，不自动跳过或代做动作', () => {
  const env = new TrainingEnvironment(catalog, weights, { maxDecisions: 1 });
  let observation = env.reset('limit');
  observation = env.step(chooseHeuristic(observation.heuristic));
  assert.throws(() => env.step(chooseHeuristic(observation.heuristic)), /AI_DECISION_LIMIT/);
});

test('AI v2 区分同层不同房间的家臣及放置骰点，不把公开不同局面压成同一编码', () => {
  const env = environment();
  let observation = env.reset('visible-details');
  while (env.match.phase === 'draft') observation = env.step(chooseHeuristic(observation.heuristic));
  const actor = env.actor;
  env.match.state.players[actor].figures.courtier = [{ location: 'floor1', roomId: 'floor1-1' }];
  const first = encodeState(env);
  env.match.state.players[actor].figures.courtier[0].roomId = 'floor1-2';
  assert.notDeepEqual(encodeState(env), first);
  env.match.state.placements['castle:floor1-1'].dice = [{ color: 'coral', value: 2 }];
  const second = encodeState(env);
  env.match.state.placements['castle:floor1-1'].dice[0].value = 5;
  assert.notDeepEqual(encodeState(env), second);
  env.match.state.placements['castle:floor1-1'].dice[0] = { value: 5, sourceBridge: 'coral' };
  const third = encodeState(env);
  env.match.state.placements['castle:floor1-1'].dice[0].sourceBridge = 'black';
  assert.notDeepEqual(encodeState(env), third);
  const fourth = encodeState(env);
  env.match.state.castleDecks.steward.reverse();
  env.match.state.castleDecks.diplomat.reverse();
  env.match.seed = 'private-seed-must-not-affect-network';
  assert.deepEqual(encodeState(env), fourth);
  assert.equal(observation.featureVersion, 'public-decisions-v2');
});

test('AI 存档分析从同一引擎恢复，拒绝其他配置的存档', () => {
  const env = environment();
  env.reset('analysis-restore');
  while (env.match.actions.length === 0) env.step(chooseHeuristic(env.observe().heuristic));
  const save = exportLocalMatch(env.match);
  const expected = env.observe();
  const restored = environment();
  assert.deepEqual(restored.restore(save), expected);
  const changed = structuredClone(save);
  changed.catalog.cards[0].name = 'different-card-data';
  assert.throws(() => restored.restore(changed), /AI_REPLAY_CONFIG_MISMATCH/);
  assert.ok(expected.choices.every((choice) => !('next' in choice)));
});
