import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalCatalog } from '../src/data/catalog.js';
import { personalField } from '../src/engine/cardRules.js';
import {
  StartingDraftError,
  createStartingDraft,
  chooseStartingPair,
} from '../src/engine/startingDraft.js';

// 全部牌为显式实验夹具，不用于宣称正式牌库已核验。
function fixture() {
  const gains = [
    [{ type: 'food', amount: 2 }, { type: 'coin', amount: 3 }],
    [{ type: 'iron', amount: 3 }, { type: 'seal', amount: 1 }],
    [{ type: 'pearl', amount: 4 }, { type: 'points', amount: 2 }],
    [{ type: 'chooseResource', amount: 2 }],
  ];
  const common = { verification: 'confirmed', playerCounts: [2, 3, 4] };
  return {
    playerCount: 2,
    limits: { resource: 7, seal: 5 },
    cards: [
      ...gains.map((initialGains, index) => ({
        ...common, id: `resource-${index}`, kind: 'startingResource', initialGains,
        back: [{ type: 'coin', amount: 1 }],
      })),
      ...['courtier', 'gardener', 'warrior'].map((type) => ({
        ...common, id: `action-${type}`, kind: 'startingAction', copies: 2,
        back: [{ type: 'influence', amount: 1 }],
        fields: [{ id: 'action', tone: 'none', cost: [], effects: [{ type, amount: 1 }] }],
      })),
      {
        ...common, id: 'decree-test', kind: 'decree',
        back: [{ type: 'food', amount: 1 }],
      },
    ],
  };
}

const fails = (call, code) => assert.throws(call, (error) => (
  error instanceof StartingDraftError && error.code === code
));
const resourceCard = (config, pair) => config.cards.find((card) => card.id === pair.resourceId);
const choicesFor = (config, pair) => resourceCard(config, pair).initialGains
  .filter((gain) => gain.type === 'chooseResource').flatMap((gain) => Array(gain.amount).fill('food'));
const pick = (draft, actor, pair, config) => chooseStartingPair(draft, actor, pair.id, config, {
  choices: choicesFor(config, pair),
});

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

test('同一种子可重放三对牌，目录和返回状态可独立序列化', () => {
  const config = freezeDeep(fixture());
  const first = createStartingDraft(config, { seed: 'draft-17' });
  assert.deepEqual(first, createStartingDraft(config, { seed: 'draft-17' }));
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.equal(first.pairs.length, 3);
  assert.equal(first.canonicalSignature, canonicalCatalog(config));
  assert.equal(first.mode, 'starting-draft-only');
  assert.equal(first.phase, 'choosing');
  assert.deepEqual(first.players, { 0: null, 1: null });
  assert.equal(Object.hasOwn(first, 'bridges'), false);
  const outcomes = new Set(Array.from({ length: 12 }, (_, seed) => (
    JSON.stringify(createStartingDraft(config, { seed }).pairs)
  )));
  assert.ok(outcomes.size > 1);
});

test('两个独立牌堆都按实体不放回，各设计两张不会去重成一种', () => {
  const config = fixture();
  config.cards = config.cards.filter((card) => card.kind !== 'startingAction');
  config.cards.push({
    ...fixture().cards.find((card) => card.kind === 'startingAction'),
    copies: 3,
  });
  const draft = createStartingDraft(config, { seed: 'physical-copies' });
  assert.equal(new Set(draft.pairs.map((pair) => pair.resourceInstanceId)).size, 3);
  assert.equal(new Set(draft.pairs.map((pair) => pair.actionInstanceId)).size, 3);
  assert.equal(new Set(draft.pairs.map((pair) => pair.resourceId)).size, 3);
  assert.equal(new Set(draft.pairs.map((pair) => pair.actionId)).size, 1);
  config.cards.find((card) => card.kind === 'startingAction').copies = 2;
  fails(() => createStartingDraft(config), 'INSUFFICIENT_CARDS');
});

test('只抽已核验且明确适用两人的牌，不能用未核验牌补足牌堆', () => {
  const config = fixture();
  const resource = config.cards[0];
  const action = config.cards.find((card) => card.kind === 'startingAction');
  config.cards.push(
    { ...resource, id: 'pending-resource', verification: 'pending', initialGains: null },
    { ...resource, id: 'three-player-resource', playerCounts: [3, 4] },
    { ...resource, id: 'unspecified-resource', playerCounts: undefined },
    { ...action, id: 'pending-action', verification: 'pending' },
    { ...action, id: 'three-player-action', playerCounts: [3] },
  );
  for (let seed = 0; seed < 8; seed += 1) {
    const draft = createStartingDraft(config, { seed });
    assert.ok(draft.pairs.every((pair) => /^resource-\d$/.test(pair.resourceId)));
    assert.ok(draft.pairs.every((pair) => /^action-(courtier|gardener|warrior)$/.test(pair.actionId)));
  }
  config.cards[0].verification = 'pending';
  config.cards[1].playerCounts = [3];
  fails(() => createStartingDraft(config), 'INSUFFICIENT_CARDS');
});

test('逆序选牌，先1后0，保留剩下一对并止于选牌完成', () => {
  const config = fixture();
  const draft = freezeDeep(createStartingDraft(config));
  assert.deepEqual(draft.draftOrder, ['1', '0']);
  assert.equal(draft.nextPlayerId, '1');
  fails(() => pick(draft, '0', draft.pairs[0], config), 'NOT_ACTIVE_PLAYER');
  const first = pick(draft, '1', draft.pairs[0], config);
  assert.equal(first.nextPlayerId, '0');
  assert.equal(first.players['1'].currentCardId, draft.pairs[0].actionId);
  assert.equal(draft.players['1'], null);
  fails(() => pick(first, '1', first.pairs[1], config), 'NOT_ACTIVE_PLAYER');
  fails(() => pick(first, '0', first.pairs[0], config), 'TARGET_NOT_ALLOWED');
  const complete = pick(freezeDeep(first), '0', first.pairs[1], config);
  assert.equal(complete.phase, 'complete');
  assert.equal(complete.nextPlayerId, null);
  assert.equal(complete.pairs.filter((pair) => pair.chosenBy === null).length, 1);
  assert.equal(complete.players['0'].currentCardId, first.pairs[1].actionId);
  fails(() => pick(complete, '0', complete.pairs[2], config), 'DRAFT_COMPLETE');
});

test('选牌严格反转调用方提供的行动顺序，行动顺序本身保持不变', () => {
  const config = fixture();
  const playOrder = Object.freeze(['east', 'west']);
  const draft = createStartingDraft(config, { playOrder });
  assert.deepEqual(draft.playOrder, ['east', 'west']);
  assert.deepEqual(draft.draftOrder, ['west', 'east']);
  assert.equal(draft.nextPlayerId, 'west');
  const first = pick(draft, 'west', draft.pairs[0], config);
  assert.equal(first.nextPlayerId, 'east');
});

test('资产来自所选资源牌，资源各上限7、印章5，金币和分数不套用该上限', () => {
  const config = fixture();
  const gains = [
    { type: 'food', amount: 6 }, { type: 'food', amount: 3 },
    { type: 'iron', amount: 9 }, { type: 'pearl', amount: 8 },
    { type: 'seal', amount: 8 }, { type: 'coin', amount: 12 }, { type: 'points', amount: 10 },
  ];
  for (const card of config.cards.filter((item) => item.kind === 'startingResource')) {
    card.initialGains = gains;
  }
  const draft = createStartingDraft(config);
  const next = pick(draft, '1', draft.pairs[0], config);
  assert.deepEqual(next.players['1'].resources, {
    food: 7, iron: 7, pearl: 7, seal: 5, coin: 12, points: 10,
  });
});

test('任选资源必须逐单位显式选择，能选相同或不同资源，溢出仍消耗选择', () => {
  const config = fixture();
  for (const card of config.cards.filter((item) => item.kind === 'startingResource')) {
    card.initialGains = [
      { type: 'food', amount: 7 }, { type: 'chooseResource', amount: 2 },
      { type: 'chooseResource', amount: 1 },
    ];
  }
  const draft = freezeDeep(createStartingDraft(config));
  const pairId = draft.pairs[0].id;
  fails(() => chooseStartingPair(draft, '1', pairId, config), 'CHOICE_REQUIRED');
  fails(() => chooseStartingPair(draft, '1', pairId, config, { choices: ['food'] }), 'CHOICE_REQUIRED');
  for (const choices of [['coin', 'iron', 'pearl'], ['food', 'food', 'food', 'food'], 'food']) {
    fails(() => chooseStartingPair(draft, '1', pairId, config, { choices }), 'INVALID_CHOICE');
  }
  const mixed = chooseStartingPair(draft, '1', pairId, config, { choices: ['food', 'iron', 'pearl'] });
  assert.equal(mixed.players['1'].resources.food, 7);
  assert.equal(mixed.players['1'].resources.iron, 1);
  assert.equal(mixed.players['1'].resources.pearl, 1);
  const same = chooseStartingPair(draft, '1', pairId, config, { choices: ['iron', 'iron', 'iron'] });
  assert.equal(same.players['1'].resources.iron, 3);
  assert.equal(draft.players['1'], null);
});

test('资源牌和指向敕令按顺序进入灯笼区，选牌时不执行牌背或当前行动', () => {
  const config = fixture();
  for (const card of config.cards.filter((item) => item.kind === 'startingResource')) {
    card.initialGains = [{ type: 'coin', amount: 2 }];
    card.grantDecreeId = 'decree-test';
    card.back = [{ type: 'coin', amount: 99 }];
  }
  const draft = createStartingDraft(config);
  const selected = draft.pairs[0];
  const next = pick(draft, '1', selected, config);
  assert.deepEqual(next.players['1'].lanternCardIds, [selected.resourceId, 'decree-test']);
  assert.equal(next.players['1'].resources.coin, 2);
  assert.equal(next.players['1'].resources.food, 0);
  assert.equal(next.players['1'].currentCardId, selected.actionId);
  assert.equal(next.players['1'].lanternCardIds.includes(selected.actionId), false);
  const action = config.cards.find((card) => card.id === selected.actionId);
  assert.equal(personalField(action, 'courtier'), personalField(action, 'warrior'));
  fails(() => pick(next, '0', next.pairs[1], config), 'TARGET_NOT_ALLOWED');
});

test('没有敕令时只加入资源牌，各玩家从自己的所选牌获得资产', () => {
  const config = fixture();
  const draft = createStartingDraft(config, { seed: 'separate-assets' });
  const first = pick(draft, '1', draft.pairs[0], config);
  const second = pick(first, '0', first.pairs[1], config);
  for (const [id, pair] of [['1', draft.pairs[0]], ['0', draft.pairs[1]]]) {
    assert.deepEqual(second.players[id].lanternCardIds, [pair.resourceId]);
    const gains = resourceCard(config, pair).initialGains;
    const expected = { food: 0, iron: 0, pearl: 0, coin: 0, seal: 0, points: 0 };
    for (const gain of gains) {
      expected[gain.type === 'chooseResource' ? 'food' : gain.type] += gain.amount;
    }
    assert.deepEqual(second.players[id].resources, expected);
  }
});

test('配置绑定规范化内容，属性重排可继续，收益或签名变化拒绝且失败原子化', () => {
  const config = fixture();
  const draft = createStartingDraft(config);
  const before = structuredClone({ draft, config });
  const changed = structuredClone(config);
  changed.cards[0].initialGains[0].amount += 1;
  fails(() => pick(draft, '1', draft.pairs[0], changed), 'CONFIG_MISMATCH');
  const forged = { ...draft, canonicalSignature: 'different' };
  fails(() => pick(forged, '1', forged.pairs[0], config), 'CONFIG_MISMATCH');
  const reordered = Object.fromEntries(Object.entries(config).reverse());
  assert.deepEqual(pick(draft, '1', draft.pairs[0], reordered), pick(draft, '1', draft.pairs[0], config));
  assert.deepEqual({ draft, config }, before);
});

test('不存在、未核验、人数不符或类型不符的敕令不能被引用', () => {
  for (const [change, code] of [
    [(config) => { config.cards[0].grantDecreeId = 'missing'; }, 'TARGET_NOT_FOUND'],
    [(config) => { config.cards[0].grantDecreeId = 'resource-1'; }, 'TARGET_NOT_ALLOWED'],
    [(config) => { config.cards.at(-1).verification = 'pending'; }, 'DATA_UNVERIFIED'],
    [(config) => { config.cards.at(-1).playerCounts = [3]; }, 'DATA_UNVERIFIED'],
  ]) {
    const config = fixture();
    config.cards[0].grantDecreeId = 'decree-test';
    change(config);
    const before = structuredClone(config);
    fails(() => createStartingDraft(config), code);
    assert.deepEqual(config, before);
  }
});

test('未知玩家、未知牌对和被篡改的引用或实体副本均拒绝，不修改原状态', () => {
  const config = fixture();
  const draft = createStartingDraft(config);
  fails(() => pick(draft, 'unknown', draft.pairs[0], config), 'INVALID_ACTOR');
  fails(() => pick(draft, 1, draft.pairs[0], config), 'INVALID_ACTOR');
  fails(() => chooseStartingPair(draft, '1', 'missing', config), 'TARGET_NOT_FOUND');
  for (const [mutate, code] of [
    [(value) => { value.pairs[0].resourceId = 'missing'; }, 'TARGET_NOT_FOUND'],
    [(value) => { value.pairs[0].resourceId = value.pairs[0].actionId; }, 'TARGET_NOT_ALLOWED'],
    [(value) => { value.pairs[1].actionInstanceId = value.pairs[0].actionInstanceId; }, 'INVALID_STATE'],
    [(value) => { value.draftOrder.reverse(); }, 'INVALID_STATE'],
    [(value) => { value.nextPlayerId = '0'; }, 'INVALID_STATE'],
    [(value) => { value.players['1'] = { id: '1' }; }, 'INVALID_STATE'],
  ]) {
    const altered = structuredClone(draft);
    mutate(altered);
    const before = structuredClone(altered);
    fails(() => chooseStartingPair(altered, '1', altered.pairs[0].id, config), code);
    assert.deepEqual(altered, before);
  }
});

test('直接引用目录中被过滤的牌仍明确拒绝，不能借改写草稿绕过核验', () => {
  const config = fixture();
  config.cards.push(
    { ...config.cards[0], id: 'pending', verification: 'pending' },
    { ...config.cards[0], id: 'three-player', playerCounts: [3] },
  );
  for (const id of ['pending', 'three-player']) {
    const draft = createStartingDraft(config);
    draft.pairs[0].resourceId = id;
    fails(() => pick(draft, '1', draft.pairs[0], config), 'DATA_UNVERIFIED');
  }
});

test('配置、行动结构、收益数量、实体数量和顺序非法时拒绝猜测', () => {
  for (const mutate of [
    (config) => { config.playerCount = 3; },
    (config) => { config.limits.resource = 8; },
    (config) => { config.limits.seal = 6; },
    (config) => { config.cards.push(structuredClone(config.cards[0])); },
    (config) => { config.cards[0].copies = 0; },
    (config) => { config.cards[0].copies = 1.5; },
  ]) {
    const config = fixture();
    mutate(config);
    fails(() => createStartingDraft(config), 'INVALID_STATE');
  }
  for (const mutate of [
    (config) => { config.cards[0].initialGains = [{ type: 'food', amount: -1 }]; },
    (config) => { config.cards[0].initialGains = [{ type: 'unknown', amount: 1 }]; },
    (config) => { config.cards[0].initialGains = null; },
    (config) => { config.cards[0].back = undefined; },
    (config) => { config.cards[4].fields = []; },
    (config) => { config.cards[4].fields[0].effects[0].amount = 2; },
  ]) {
    const config = fixture();
    mutate(config);
    fails(() => createStartingDraft(config), 'INVALID_EFFECT');
  }
  for (const playOrder of [[], ['0'], ['0', '0'], ['0', '1', '2'], [0, 1]]) {
    fails(() => createStartingDraft(fixture(), { playOrder }), 'INVALID_STATE');
  }
  for (const seed of [null, {}, NaN, Infinity]) {
    fails(() => createStartingDraft(fixture(), { seed }), 'INVALID_SEED');
  }
});

test('任意多余选择和不可精确表示的资产总量失败时保留完整原草稿', () => {
  const config = fixture();
  for (const card of config.cards.filter((item) => item.kind === 'startingResource')) {
    card.initialGains = [{ type: 'coin', amount: Number.MAX_SAFE_INTEGER }, { type: 'coin', amount: 1 }];
  }
  const draft = freezeDeep(createStartingDraft(config));
  const before = structuredClone(draft);
  fails(() => chooseStartingPair(draft, '1', draft.pairs[0].id, config, { choices: ['food'] }), 'INVALID_CHOICE');
  fails(() => chooseStartingPair(draft, '1', draft.pairs[0].id, config), 'INVALID_EFFECT');
  assert.deepEqual(draft, before);
});
