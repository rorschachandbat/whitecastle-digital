import test from 'node:test';
import assert from 'node:assert/strict';
import { expandLanternEffects, adjustPolicyForLantern, cardLanternMarginalGains } from '../src/ai/lanternEffects.js';
import { EFFECT_TYPES } from '../src/data/catalog.js';
import { encodeOption } from '../src/ai/features.js';

const weights = {
  rounds: [{ food: 1.6, pearl: 1.4, iron: 1.0, coin: 0.7, seal: 0.85, gardener: 6, courtier: 5, warrior: 2.5 }],
  effect: { influence: 0.8, lantern: 3 },
};

function position() {
  const roomCard = {
    id: 'diplomat-d12', kind: 'diplomat', verification: 'confirmed',
    fields: [
      { id: 'upper', tone: 'dark', effects: [{ type: 'courtier', amount: 1 }] },
      { id: 'lower', tone: 'light', effects: [{ type: 'seal', amount: 1 }, { type: 'lantern', amount: 1 }] },
    ],
  };
  const match = {
    config: {
      resourceLimit: 7, sealLimit: 5, cards: [roomCard],
      personalDomainRows: [], yardFaces: [],
      setup: { wellRewards: [], gardens: [], trainingYards: [] },
    },
    state: {
      round: 1,
      players: { 0: { resources: { food: 0, iron: 6, pearl: 0, coin: 1, seal: 0 }, lanternCards: ['iron-back', 'seal-back', 'influence-back'], timePosition: 0 } },
      bridges: [{ id: 'coral', color: 'coral', dice: [{ value: 4 }, { value: 4 }] }],
      castleRooms: [{ id: 'floor2-1', cardId: 'diplomat-d12', tiles: [{ fieldId: 'upper', color: 'black' }, { fieldId: 'lower', color: 'coral' }] }],
    },
    draft: { pairs: [] },
  };
  match.config.cards.push(
    { id: 'iron-back', back: [{ type: 'iron', amount: 1 }] },
    { id: 'seal-back', back: [{ type: 'seal', amount: 1 }] },
    { id: 'influence-back', back: [{ type: 'influence', amount: 1 }] },
  );
  const outside = { action: { type: 'placeDie', bridgeId: 'coral', side: 'left', target: { area: 'outside', id: 'left' } } };
  const room = { action: { type: 'placeDie', bridgeId: 'coral', side: 'left', target: { area: 'castle', id: 'floor2-1' } } };
  const env = { actor: '0', match, probe: null, getLegalActions: () => [outside, room] };
  return { env, outside, room };
}

test('灯笼图标展开为牌背具体收益，并保留触发次数', () => {
  const backs = [{ type: 'iron', amount: 1 }, { type: 'seal', amount: 1 }, { type: 'influence', amount: 1 }];
  assert.deepEqual(expandLanternEffects([{ type: 'seal', amount: 1 }, { type: 'lantern', amount: 1 }], backs), [
    { type: 'seal', amount: 1 },
    { type: 'iron', amount: 1 },
    { type: 'seal', amount: 1 },
    { type: 'influence', amount: 1 },
    { type: 'lantern', amount: 1 },
  ]);
});

test('铁已满时额外灯笼不计铁，但仍把印章和影响力乘进排序', () => {
  const { env, outside, room } = position();
  assert.deepEqual(cardLanternMarginalGains(env, outside), []);
  const gain = cardLanternMarginalGains(env, room);
  assert.deepEqual(gain, [{ type: 'seal', amount: 1 }, { type: 'influence', amount: 1 }]);
  const adjusted = adjustPolicyForLantern([0.4277621805667877, 0.0622880347073078], env, weights);
  assert.ok(adjusted[1] > adjusted[0]);
  const encoded = encodeOption(env, room);
  env.lanternExpansion = false;
  const plain = encodeOption(env, room);
  assert.equal(encoded.length, plain.length);
  assert.ok(encoded[EFFECT_TYPES.indexOf('seal')] > plain[EFFECT_TYPES.indexOf('seal')]
    || encoded.some((value, index) => value > plain[index] && EFFECT_TYPES.includes('seal')));
  const firstDiff = encoded.findIndex((value, index) => value !== plain[index]);
  assert.ok(firstDiff >= 0);
});
