import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrainingEnvironment } from '../src/ai/environment.js';
import { chooseHeuristic } from '../src/ai/heuristicPolicy.js';
import { playOpponentSeat, policyChoice } from '../src/ai/playOpponent.js';
import { championGeneration, describeChampion, createPlayAi } from '../scripts/play-ai.mjs';
import { loadTrainingConfig } from '../scripts/ai-common.mjs';
import { createLocalClient, submitLocalAction } from '../src/game/localClient.js';
import { activeLocalPlayer } from '../src/engine/localMatch.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/whitecastle-2p.json', import.meta.url)));
const weights = JSON.parse(fs.readFileSync(new URL('../data/ai-heuristic.json', import.meta.url)));
const fails = async (call, code) => assert.rejects(call, (error) => error.code === code);

function heuristicPolicy(observation) {
  const index = chooseHeuristic(observation.heuristic);
  return {
    source: 'continuous-champion', method: 'policy-only', model: 'generation-00001',
    policy: observation.candidates.map((_, candidate) => (candidate === index ? 1 : 0)),
  };
}

test('策略并列时选择最小下标，并拒绝无法归一的权重', () => {
  assert.equal(policyChoice([0.5, 0.5], 2), 0);
  assert.equal(policyChoice([0.2, 0.8], 2), 1);
  assert.throws(() => policyChoice([0.2, 0.2], 2), (error) => error.code === 'AI_INVALID_POLICY');
  assert.throws(() => policyChoice([1], 2), (error) => error.code === 'AI_INVALID_POLICY');
});

test('对手席只走指定玩家，无效策略不改局面', async () => {
  const env = new TrainingEnvironment(catalog, weights);
  env.reset('opponent-reject', ['0', '1']);
  const seat = env.actor;
  const before = structuredClone(env.match);
  await fails(() => playOpponentSeat(env, async () => ({
    source: 'continuous-champion', method: 'policy-only', model: 'generation-00001', policy: [1],
  }), { seat }), 'AI_INVALID_POLICY');
  assert.deepEqual(env.match, before);
  await fails(() => playOpponentSeat(env, async () => heuristicPolicy(env.observe()), { seat: '2' }), 'AI_SEAT_INVALID');
  const bounded = await playOpponentSeat(env, async () => heuristicPolicy(env.observe()), { seat, maxDecisions: 0 });
  assert.equal(bounded.bounded, true);
  assert.equal(bounded.actions.length, 0);
  assert.deepEqual(env.match, before);
});

test('模仿预热检查点也可以固定为对手', async () => {
  const env = new TrainingEnvironment(catalog, weights);
  env.reset('opponent-initial', ['0', '1']);
  const result = await playOpponentSeat(env, async (observation) => ({
    ...heuristicPolicy(observation), model: 'initial',
  }), { seat: env.actor, generation: 'initial', maxDecisions: 1 });
  assert.equal(result.model, 'initial');
  assert.equal(result.decisions, 1);
});

test('冠军席贪心与启发式走完整局一致，动作可提交给真实Client', async () => {
  const direct = new TrainingEnvironment(catalog, weights);
  let observation = direct.reset('opponent-match', ['1', '0']);
  while (!observation.done) observation = direct.step(chooseHeuristic(observation.heuristic));

  const seated = new TrainingEnvironment(catalog, weights);
  seated.reset('opponent-match', ['1', '0']);
  while (seated.match.phase !== 'finished') {
    const seat = seated.actor;
    const result = await playOpponentSeat(seated, async (current) => heuristicPolicy(current), { seat, generation: 'generation-00001' });
    assert.equal(result.bounded, false);
    assert.equal(result.model, 'generation-00001');
    assert.ok(result.actions.length > 0);
    assert.ok(result.actions.every((action) => action.actor === seat));
    assert.ok(result.done || result.actor !== seat);
  }
  assert.deepEqual(seated.match.actions, direct.match.actions);
  assert.deepEqual(seated.match.state.score, direct.match.state.score);

  const client = createLocalClient(catalog, { seed: 'opponent-match', playOrder: ['1', '0'] });
  try {
    for (const action of seated.match.actions) submitLocalAction(client, action);
    const match = client.getState().G;
    assert.equal(match.phase, 'finished');
    assert.equal(activeLocalPlayer(match), null);
    assert.deepEqual(match.state.score, direct.match.state.score);
  } finally {
    client.stop();
  }
});

test('冠军指针只接受循环目录内的候选检查点', () => {
  assert.equal(championGeneration('E:/other/continuous-r4/generation-00117/candidate.pt'), 'generation-00117');
  assert.equal(championGeneration('generation-00002/candidate.pt'), 'generation-00002');
  assert.equal(championGeneration('../generation-00117/candidate.pt'), 'generation-00117');
  assert.equal(championGeneration('../candidate.pt'), null);
  assert.equal(championGeneration('generation-117/candidate.pt'), null);
  assert.equal(championGeneration('generation-00117/latest.pt'), null);
  assert.equal(championGeneration('initial/imitation.pt'), 'initial');
  const meta = { profile: 'local-practice-v1' };
  assert.equal(describeChampion({
    state: { champion: 'generation-00003/candidate.pt', meta }, checkpointExists: true, pythonExists: true,
    meta, catalogMatches: true,
  }).status, 'available');
  assert.equal(describeChampion({
    state: { champion: 'generation-00003/candidate.pt', meta: { profile: 'other' } }, checkpointExists: true,
    pythonExists: true, meta, catalogMatches: true,
  }).code, 'AI_MODEL_CONFIG_MISMATCH');
  assert.equal(describeChampion({
    state: { champion: 'generation-00003/candidate.pt', meta }, checkpointExists: true, pythonExists: true,
    meta, catalogMatches: false,
  }).code, 'AI_REPLAY_CONFIG_MISMATCH');
  assert.equal(describeChampion({
    state: { champion: 'C:/outside/candidate.pt', meta }, checkpointExists: false, pythonExists: true,
    meta, catalogMatches: true,
  }).status, 'unavailable');
});

test('可选旧版和新版AI，仅放宽旧摆设版本，名单不接受路径且确认后固定检查点', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whitecastle-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/whitecastle-2p.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(root, 'data/ai-heuristic.json'), JSON.stringify(weights));
  const { meta } = loadTrainingConfig();
  for (const [id, checkpoint, old] of [['r4', 'generation-00117/candidate.pt', true], ['r6', 'initial/imitation.pt', false]]) {
    const loop = path.join(root, '.local/ai', `continuous-${id}`);
    fs.mkdirSync(path.dirname(path.join(loop, checkpoint)), { recursive: true });
    fs.writeFileSync(path.join(loop, checkpoint), 'fixture');
    fs.writeFileSync(path.join(loop, 'loop-state.json'), JSON.stringify({
      champion: checkpoint, meta: old ? { ...meta, setupVersion: 'old-setup' } : meta,
    }));
  }
  const called = [];
  const ai = createPlayAi({
    root, settings: { loopDirectory: '.local/ai/continuous-r6', python: process.execPath },
    inferModel: async (observation, generation, modelId) => {
      called.push({ generation, modelId });
      return { ...heuristicPolicy(observation), model: generation };
    },
  });
  t.after(() => ai.close());
  const listing = await ai.status(catalog);
  assert.equal(listing.models.length, 2);
  assert.equal(listing.models.find((item) => item.modelId === 'r4').legacySetup, true);
  assert.equal(listing.models.find((item) => item.modelId === 'r6').generation, 'initial');
  assert.ok(listing.models.every((item) => item.status === 'available'));
  await fails(() => ai.status(catalog, '../r4'), 'AI_MODEL_INVALID');
  const client = createLocalClient(catalog, { seed: 'model-select', playOrder: ['0', '1'] });
  const session = { client };
  t.after(() => session.client.stop());
  await ai.assignSeat(session, '1', 'r4');
  assert.equal(session.aiModel, 'r4');
  assert.equal(session.aiGeneration, 'generation-00117');
  // 名单更新不能改变已确认对局的检查点。
  await ai.status(catalog, 'r6');
  await ai.play(session);
  assert.ok(called.every((item) => item.modelId === 'r4' && item.generation === 'generation-00117'));
  await ai.assignSeat(session, null);
  await ai.assignSeat(session, activeLocalPlayer(session.client.getState().G), 'r6');
  assert.equal(session.aiModel, 'r6');
  assert.equal(session.aiGeneration, 'initial');
  const incompatible = JSON.parse(fs.readFileSync(path.join(root, '.local/ai/continuous-r4/loop-state.json')));
  incompatible.meta.encoderHash = 'wrong';
  fs.writeFileSync(path.join(root, '.local/ai/continuous-r4/loop-state.json'), JSON.stringify(incompatible));
  assert.equal((await ai.status(catalog, 'r4')).status, 'incompatible');
});
