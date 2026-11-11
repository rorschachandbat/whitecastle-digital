import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { EFFECT_TYPES, parseCatalog, validateCatalog, catalogFingerprint } from '../src/data/catalog.js';
import { text } from '../src/ui/StringTable.js';

const raw = fs.readFileSync(new URL('../data/whitecastle-2p.json', import.meta.url), 'utf8');
const config = JSON.parse(raw);
const copy = () => structuredClone(config);

test('两人数据目录可解析，花园数量与训练单面数量符合已核验组件', () => {
  assert.deepEqual(parseCatalog(raw), config);
  assert.equal(config.cards.filter((card) => card.kind === 'plant').length, 5);
  assert.equal(config.cards.filter((card) => card.kind === 'stone').length, 5);
  assert.equal(config.yardFaces.length, 16);
  assert.equal(config.tokens.length, 8);
});

test('个人面板颜色与人员不能互换，已核验混合收益包含币印章和灯笼', () => {
  const invalid = copy();
  invalid.personalDomainRows[1].dieColor = 'white';
  assert.ok(validateCatalog(invalid).some((issue) => issue.code === 'rowMapping'));
  const [coral, black, white] = config.personalDomainRows;
  assert.deepEqual([coral.baseGain.type, black.baseGain.type, white.baseGain.type], ['food', 'iron', 'pearl']);
  assert.deepEqual(black.revealedGains[2], { type: 'lantern', amount: 1 });
  assert.deepEqual(white.revealedGains[4], { type: 'lantern', amount: 1 });
  invalid.personalDomainRows[1] = { ...invalid.personalDomainRows[1], id: 'unknown', figureType: 'unknown' };
  delete invalid.personalDomainRows[1].dieColor;
  assert.ok(validateCatalog(invalid).some((issue) => issue.code === 'rowMapping'));
});

test('确认训练实体必须有两个独立存在且未复用的面', () => {
  const invalid = copy();
  invalid.tokens[0].verification = 'confirmed';
  invalid.tokens[0].sourceRef = 'https://example.com/evidence';
  assert.ok(validateCatalog(invalid).some((issue) => issue.code === 'pairRequired'));
  invalid.tokens[0].faceIds = ['yard-face-1', 'yard-face-1'];
  assert.ok(validateCatalog(invalid).some((issue) => issue.code === 'faceReference'));
  invalid.tokens[0].faceIds = ['yard-face-1', 'yard-face-2'];
  assert.ok(validateCatalog(invalid).some((issue) => issue.code === 'faceSides'));
});

test('配置拒绝未知效果、负数量、付费行动当资源费用及缺失核验来源', () => {
  const invalid = copy();
  invalid.cards[0].fields[0].effects[0].type = 'arbitrary-code';
  invalid.cards[0].fields[0].cost[0].type = 'courtier';
  invalid.cards[0].foodCost = -1;
  invalid.cards[0].sourceRef = '';
  const codes = new Set(validateCatalog(invalid).map((issue) => issue.code));
  for (const code of ['effect', 'cost', 'gardenValues', 'sourceRequired']) assert.ok(codes.has(code));
  assert.throws(() => parseCatalog(JSON.stringify(invalid)), /CATALOG_INVALID/);
  assert.deepEqual(config.cards[0].foodCost, 5);
});

test('同一配置不受属性顺序影响，数据修改改变 SHA-256 指纹', async () => {
  const first = await catalogFingerprint(config);
  const reordered = Object.fromEntries(Object.entries(config).reverse());
  assert.equal(await catalogFingerprint(reordered), first);
  const changed = copy();
  changed.cards[0].foodCost += 1;
  assert.notEqual(await catalogFingerprint(changed), first);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('编辑器全部结构化效果都有 StringTable 文案', () => {
  for (const type of EFFECT_TYPES) assert.ok(text(`editor.effect.${type}`).length);
  assert.equal(text('editor.spot', { n: 3 }), '移走第 3 个人员后揭开');
});

test('错误输入和过大导入文件被拒绝', () => {
  assert.throws(() => parseCatalog(null), /CATALOG_SIZE/);
  assert.throws(() => parseCatalog(' '.repeat(1000001)), /CATALOG_SIZE/);
  assert.throws(() => parseCatalog('null'), /CATALOG_INVALID/);
  const invalid = copy();
  invalid.cards[0].fields = [null];
  invalid.personalDomainRows[0].revealedGains = [null];
  assert.ok(validateCatalog(invalid).length > 0);
});
