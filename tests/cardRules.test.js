import assert from 'node:assert/strict';
import test from 'node:test';
import { personalField, castleFields, lightFields } from '../src/engine/cardRules.js';

const field = (id, tone = 'light', extra = {}) => ({
  id, tone, cost: [], effects: [{ type: 'food', amount: 1 }], ...extra,
});
const steward = () => ({
  kind: 'steward',
  fields: [field('top'), field('middle', 'dark'), field('bottom')],
});
const diplomat = (rowSpan) => ({
  kind: 'diplomat', rowSpan,
  fields: [field('upper', 'dark'), field('lower')],
});
const invalid = (call) => assert.throws(call, { code: 'CARD_FIELD_INVALID' });

test('起始行动牌同一字段适用于三种人员排，不复制或改动字段', () => {
  const card = { kind: 'startingAction', fields: [field('action', 'none')] };
  const before = structuredClone(card);
  for (const row of ['courtier', 'gardener', 'warrior']) {
    assert.equal(personalField(card, row), card.fields[0]);
  }
  assert.deepEqual(card, before);
});

test('一层按印刷上中下对应三排，数组乱序不改变位置', () => {
  const card = steward();
  const [top, middle, bottom] = card.fields;
  card.fields = [bottom, top, middle];
  assert.equal(personalField(card, 'courtier'), top);
  assert.equal(personalField(card, 'gardener'), middle);
  assert.equal(personalField(card, 'warrior'), bottom);
});

test('使节上下高度分别支持1+2与2+1，浅深色不决定个人排映射', () => {
  const upperSmall = diplomat([1, 2]);
  assert.equal(personalField(upperSmall, 'courtier'), upperSmall.fields[0]);
  assert.equal(personalField(upperSmall, 'gardener'), upperSmall.fields[1]);
  assert.equal(personalField(upperSmall, 'warrior'), upperSmall.fields[1]);
  const upperLarge = diplomat([2, 1]);
  assert.equal(personalField(upperLarge, 'courtier'), upperLarge.fields[0]);
  assert.equal(personalField(upperLarge, 'gardener'), upperLarge.fields[0]);
  assert.equal(personalField(upperLarge, 'warrior'), upperLarge.fields[1]);
});

test('字段layoutRows显式保存使节两种布局，缺失和冲突布局拒绝猜测', () => {
  const card = {
    kind: 'diplomat',
    fields: [
      field('upper', 'light', { layoutRows: ['courtier'] }),
      field('lower', 'dark', { layoutRows: ['gardener', 'warrior'] }),
    ],
  };
  assert.equal(personalField(card, 'gardener'), card.fields[1]);
  card.rowSpan = [2, 1];
  invalid(() => personalField(card, 'gardener'));
  invalid(() => personalField(diplomat(undefined), 'courtier'));
  card.rowSpan = [1, 2];
  card.fields[1].layoutRows = ['courtier', 'warrior'];
  invalid(() => personalField(card, 'courtier'));
  const swapped = {
    kind: 'diplomat',
    fields: [
      field('upper', 'dark', { layoutRows: ['courtier', 'gardener'] }),
      field('lower', 'light', { layoutRows: ['warrior'] }),
    ],
  };
  assert.equal(personalField(swapped, 'gardener'), swapped.fields[0]);
  assert.equal(personalField(swapped, 'warrior'), swapped.fields[1]);
});

test('一层同色两块分别返回相应字段，保留可由玩家选择执行次序的输入', () => {
  // 规则正文明确一层同色出现两次时可以执行两个对应行动。
  const card = steward();
  const tiles = [
    { color: 'white', fieldId: 'bottom' },
    { color: 'black', fieldId: 'middle' },
    { color: 'white', fieldId: 'top' },
  ];
  assert.deepEqual(castleFields(card, tiles, 'white'), [card.fields[2], card.fields[0]]);
  assert.equal(castleFields(card, tiles, 'white')[0], card.fields[2]);
  assert.deepEqual(castleFields(card, tiles, 'coral'), []);
});

test('城堡助手逐引用保留次数，二层重复输入仅是解析契约测试', () => {
  // 此例不声称实体规则允许同一使节字段对应两块板块，房间设置另行验证。
  const card = diplomat([1, 2]);
  const tiles = [
    { color: 'coral', fieldId: 'lower' },
    { color: 'coral', fieldId: 'lower' },
  ];
  const before = structuredClone({ card, tiles });
  const result = castleFields(card, tiles, 'coral');
  assert.equal(result.length, 2);
  assert.equal(result[0], card.fields[1]);
  assert.equal(result[1], card.fields[1]);
  assert.deepEqual({ card, tiles }, before);
});

test('家臣到达只列浅色字段，组合收益不被拆开且返回原字段引用', () => {
  const card = steward();
  card.fields[0].effects = [{ type: 'coin', amount: 1 }, { type: 'well', amount: 1 }];
  const result = lightFields(card);
  assert.deepEqual(result, [card.fields[0], card.fields[2]]);
  assert.equal(result[0], card.fields[0]);
  assert.equal(result[0].effects.length, 2);
  assert.equal(result.some((item) => item === card.fields[1]), false);
});

test('未知行、字段、颜色或无效布局返回统一稳定错误且输入不变', () => {
  const card = steward();
  const before = structuredClone(card);
  invalid(() => personalField(card, 'black'));
  invalid(() => personalField({ ...card, kind: 'unknown' }, 'courtier'));
  invalid(() => castleFields(card, [{ color: 'white', fieldId: 'missing' }], 'black'));
  invalid(() => castleFields(card, [{ color: 'unknown', fieldId: 'top' }], 'white'));
  invalid(() => castleFields(card, [], 'red'));
  invalid(() => lightFields({ fields: [field('top'), field('top')] }));
  invalid(() => lightFields(null));
  invalid(() => personalField(diplomat([1, 1]), 'courtier'));
  invalid(() => personalField({ kind: 'startingAction', fields: [field('top')] }, 'courtier'));
  assert.deepEqual(card, before);
});
