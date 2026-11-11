import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createLocalClient, submitLocalAction, restoreLocalClient } from '../src/game/localClient.js';
import { activeLocalPlayer, exportLocalMatch } from '../src/engine/localMatch.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/whitecastle-2p.json', import.meta.url)));
const clone = (value) => structuredClone(value);
const fails = (call, code) => assert.throws(call, (error) => error.code === code);

function assertSynchronized(client) {
  const { G, ctx } = client.getState();
  const active = activeLocalPlayer(G);
  if (active !== null) assert.equal(ctx.currentPlayer, active);
  assert.deepEqual(JSON.parse(JSON.stringify(G)), G);
  return G;
}

function chooseDraft(client) {
  for (let count = 0; count < 2; count += 1) {
    const match = assertSynchronized(client);
    const pair = match.draft.pairs.find((item) => item.chosenBy === null);
    const card = match.config.cards.find((item) => item.id === pair.resourceId);
    const number = card.initialGains.filter((effect) => effect.type === 'chooseResource')
      .reduce((sum, effect) => sum + effect.amount, 0);
    submitLocalAction(client, {
      type: 'chooseStartingPair', actor: activeLocalPlayer(match), pairId: pair.id,
      choices: Array(number).fill('food'),
    });
  }
}

function water(client) {
  const match = assertSynchronized(client);
  const bridge = match.state.bridges.find((item) => item.dice.length);
  return submitLocalAction(client, {
    type: 'placeDie', actor: activeLocalPlayer(match), bridgeId: bridge.id,
    side: bridge.dice.length === 1 ? bridge.singleDieEndpoint : 'right',
    target: { area: 'well' },
  });
}

test('真实Client完整18次水井对局，ctx玩家始终与纯规则同步，最后进入gameover', () => {
  const client = createLocalClient(catalog, { seed: 'real-client-18', playOrder: ['1', '0'] });
  try {
    assert.equal(client.getState().ctx.currentPlayer, '0');
    chooseDraft(client);
    assert.equal(assertSynchronized(client).phase, 'playing');
    assert.equal(client.getState().ctx.currentPlayer, '1');
    for (let count = 0; count < 18; count += 1) {
      water(client);
      const match = assertSynchronized(client);
      assert.equal(match.actions.length, count + 3);
      assert.equal(match.state.round, Math.min(3, Math.floor((count + 1) / 6) + 1));
    }
    const { G, ctx } = client.getState();
    assert.equal(G.phase, 'finished');
    assert.equal(G.state.score.complete, true);
    assert.equal(ctx.gameover.winner, G.state.score.winner);
    assert.equal(G.actions.filter((action) => action.type === 'placeDie').length, 18);
    const before = clone(client.getState());
    fails(() => water(client), 'GAME_FINISHED');
    assert.deepEqual(client.getState(), before);
  } finally {
    client.stop();
  }
});

test('真实Client错误actor、区域和资源选择不产生框架stateID或规则状态变化', () => {
  const client = createLocalClient(catalog, { seed: 'real-client-atomic' });
  try {
    chooseDraft(client);
    const match = assertSynchronized(client);
    const actor = activeLocalPlayer(match);
    const bridge = match.state.bridges.find((item) => item.dice.length);
    const base = {
      type: 'placeDie', actor, bridgeId: bridge.id, side: 'right', target: { area: 'well' },
    };
    for (const [action, code] of [
      [{ ...base, actor: actor === '0' ? '1' : '0' }, 'NOT_ACTIVE_PLAYER'],
      [{ ...base, target: { area: 'missing' } }, 'TARGET_NOT_FOUND'],
      [{ ...base, choices: ['food'] }, 'INVALID_ACTION'],
    ]) {
      const before = clone(client.getState());
      fails(() => submitLocalAction(client, action), code);
      assert.deepEqual(client.getState(), before);
    }
    water(client);
    assert.equal(assertSynchronized(client).actions.length, 3);
  } finally {
    client.stop();
  }
});

test('真实Client存档restore以动作重放恢复G/ctx，拒绝篡改动作且忽略伪造state', () => {
  const client = createLocalClient(catalog, { seed: 'real-client-save', playOrder: ['1', '0'] });
  let restored;
  try {
    chooseDraft(client);
    for (let count = 0; count < 8; count += 1) water(client);
    const save = exportLocalMatch(client.getState().G);
    save.state = { phase: 'finished', resources: 'forged' };
    restored = restoreLocalClient(JSON.parse(JSON.stringify(save)));
    assert.deepEqual(restored.getState().G, client.getState().G);
    assert.deepEqual(restored.getState().ctx, client.getState().ctx);
    assert.equal(restored.getState()._stateID, client.getState()._stateID);
    water(client);
    water(restored);
    assert.deepEqual(assertSynchronized(restored), assertSynchronized(client));
    save.actions.push({ type: 'placeDie', actor: 'unknown', target: { area: 'well' } });
    fails(() => restoreLocalClient(save), 'NOT_ACTIVE_PLAYER');
  } finally {
    client.stop();
    restored?.stop();
  }
});

test('Client可从开局选牌中途重放恢复，不多发资源或改变逆序选牌玩家', () => {
  const client = createLocalClient(catalog, { seed: 'client-draft-resume', playOrder: ['0', '1'] });
  let restored;
  try {
    const match = client.getState().G;
    const pair = match.draft.pairs.find((item) => item.chosenBy === null);
    const card = match.config.cards.find((item) => item.id === pair.resourceId);
    const number = card.initialGains.filter((effect) => effect.type === 'chooseResource')
      .reduce((sum, effect) => sum + effect.amount, 0);
    submitLocalAction(client, {
      type: 'chooseStartingPair', actor: '1', pairId: pair.id, choices: Array(number).fill('iron'),
    });
    restored = restoreLocalClient(exportLocalMatch(client.getState().G));
    assert.deepEqual(restored.getState().G, client.getState().G);
    assert.equal(restored.getState().ctx.currentPlayer, '0');
    assert.equal(activeLocalPlayer(restored.getState().G), '0');
  } finally {
    client.stop();
    restored?.stop();
  }
});
