import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTrainingConfig } from '../scripts/ai-common.mjs';
import { TrainingEnvironment } from '../src/ai/environment.js';
import { chooseHeuristic } from '../src/ai/heuristicPolicy.js';
import { score } from '../src/engine/engine.js';
import { encodeState } from '../src/ai/features.js';
import { highScoreStructure, encodeHighScoreStructure, evaluateHighScore,
  publicScoreDiagnostics } from '../src/ai/highScore.js';
import { searchRoutes } from '../src/ai/routeSearch.js';

const { catalog, weights } = loadTrainingConfig(undefined, 'data/ai-heuristic-r9.json');
function playing(seed) {
  const env = new TrainingEnvironment(catalog, weights);
  let observation = env.reset(seed);
  while (env.match.phase === 'draft') observation = env.step(chooseHeuristic(observation.heuristic));
  return env;
}

test('高分结构只乘城内家臣，和引擎武士分保持一致且不改真实计分', () => {
  const env = playing('high-score-structure');
  const actor = env.actor;
  const player = env.match.state.players[actor];
  player.figures.courtier = [{ location: 'gate' }, { location: 'floor1' }, { location: 'floor3' }];
  player.figures.warrior = [{ yardId: 'yard-cost-1' }, { yardId: 'yard-cost-5' }];
  const before = structuredClone(env.match);
  const actual = score(env.match.state, env.match.config);
  const structure = highScoreStructure(player, env.match.config);
  assert.equal(structure.internal, 2);
  assert.equal(structure.gates, 1);
  assert.equal(structure.warriorValue, 3);
  assert.equal(structure.synergy, actual.players[actor].parts.warrior);
  assert.equal(encodeHighScoreStructure(player, env.match.config).length, 6);
  const evaluation = evaluateHighScore(env.match, actor, weights);
  assert.equal(evaluation.committed, actual.players[actor].total);
  assert.ok(evaluation.potential > 0);
  assert.equal(evaluation.total, evaluation.committed + evaluation.potential);
  assert.deepEqual(publicScoreDiagnostics(env.match).players[actor].committed, actual.players[actor]);
  assert.deepEqual(env.match, before);
});

test('v4只追加12个公开结构特征，v3兼容仍保留原有灯笼编码', () => {
  const env = playing('high-score-encoding');
  const current = encodeState(env);
  assert.equal(current.length, 2357);
  env.legacyFeatureEncoding = true;
  const old = encodeState(env);
  assert.equal(old.length, 2345);
  assert.deepEqual(current.slice(0, old.length), old);
  assert.equal(env.lanternExpansion, undefined);
});

test('微小搜索预算也先完成原子连锁，不能把未提交收益当成零分', () => {
  const env = playing('high-score-atomic-cutoff');
  const before = structuredClone(env.match);
  const policy = env.getLegalActions().map(() => 1 / env.getLegalActions().length);
  const result = searchRoutes(env, policy, {
    width: 2, samples: 1, maxDecisions: 1, maxPlacements: 1, seed: 'high-score-atomic-cutoff',
  });
  assert.equal(result.searched, true);
  assert.equal(result.failed, 0);
  assert.equal(result.unfinished, 0);
  assert.ok(result.extendedDecisions > 0);
  assert.equal(result.cutoff + result.terminal, 2);
  assert.match(result.evaluator, /^public-high-score-potential/);
  assert.deepEqual(env.match, before);
});

test('终局潜力归零，分项诊断必须与实际终局完全相同', () => {
  const env = playing('high-score-terminal');
  let observation = env.observe();
  while (!observation.done) observation = env.step(chooseHeuristic(observation.heuristic));
  for (const actor of ['0', '1']) {
    const evaluation = evaluateHighScore(env.match, actor, weights);
    assert.equal(evaluation.potential, 0);
    assert.equal(evaluation.total, observation.score.players[actor].total);
    assert.deepEqual(observation.diagnostics.players[actor].committed, observation.score.players[actor]);
  }
});
