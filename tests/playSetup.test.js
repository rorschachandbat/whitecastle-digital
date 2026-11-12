import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { text, StringTable } from '../src/ui/StringTable.js';
import { createPosition } from '../src/engine/engine.js';
import { createLocalMatch, applyLocalAction, activeLocalPlayer, exportLocalMatch } from '../src/engine/localMatch.js';
import { describeMatch } from '../src/ui/actionStory.js';
import { personalField } from '../src/engine/cardRules.js';
import { placementOptions, probeLocalAction } from '../src/engine/actionOptions.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/whitecastle-2p.json', import.meta.url)));
const source = fs.readFileSync(new URL('../src/ui/play.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.className = '';
    this.valueText = '';
    this.classList = { add: (...names) => { this.className += ` ${names.join(' ')}`; } };
  }
  set textContent(value) { this.valueText = String(value); }
  get textContent() { return this.valueText + this.children.map((node) => node.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(event, callback) { this.listeners[event] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  scrollIntoView() {}
}
function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}
function page(match, aiSeat = null, actionProbe = null) {
  const root = new Element('main');
  const storage = new Map();
  const document = {
    querySelector: () => root,
    createElement: (tag) => new Element(tag),
    getElementById: (id) => descendants(root).find((node) => node.id === id),
  };
  // 只替换浏览器宿主，不执行模块末尾的网络启动；渲染与按钮事件使用真实页面代码。
  const body = source.slice(0, source.lastIndexOf('\nrender();\nawait run('))
    .replace(/^import .+;\r?\n/gm, '');
  const ui = vm.runInNewContext(`${body}\n({ adopt, render, playAiIfNeeded, setProbe: (value) => { probe = value; } });`, {
    document, crypto: { randomUUID }, text, StringTable, createPosition,
    activeLocalPlayer, exportLocalMatch, describeMatch, structuredClone, personalField, placementOptions,
    queueMicrotask: (callback) => callback(),
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    fetch: () => { throw new Error('布局确认前不应请求AI落子'); },
  });
  ui.adopt({ id: 'setup-test', match, ai: { seat: aiSeat } });
  ui.setProbe(actionProbe);
  ui.render();
  return { root, ui, nodes: () => descendants(root) };
}

test('选牌前显示完整本局布局，确认后保留棋盘并显示三组起始牌', async () => {
  const match = createLocalMatch(catalog, { seed: 'room-colors-check' });
  const before = structuredClone(match);
  const { root, ui, nodes } = page(match);
  assert.match(root.textContent, /第1步 · 查看本局布局/);
  for (const title of ['天守阁', '三桥与花园', '训练场']) assert.ok(root.textContent.includes(title));
  assert.equal(nodes().filter((node) => node.className === 'draft-pair').length, 0);
  const dice = nodes().filter((node) => node.className.startsWith('die '));
  assert.equal(dice.length, 9);
  assert.ok(dice.every((node) => node.disabled));
  assert.equal(nodes().filter((node) => node.className === 'target-button').length, 0);
  assert.ok(nodes().filter((node) => node.tagName === 'h3').some((node) => /1层 · 第 1 室/.test(node.textContent)));
  const confirm = nodes().find((node) => node.tagName === 'button' && node.textContent === text('play.layout.confirm'));
  await confirm.listeners.click();
  assert.equal(nodes().filter((node) => node.className === 'draft-pair').length, 3);
  assert.ok(nodes().some((node) => node.id === 'layout-preview'));
  assert.deepEqual(match, before);
  ui.adopt({ id: 'another-match', match, ai: {} });
  ui.render();
  assert.equal(nodes().filter((node) => node.className === 'draft-pair').length, 0);
});

test('尚未确认本局布局时，即使轮到AI选初始牌也不自动落子', async () => {
  const match = createLocalMatch(catalog, { seed: 'layout-ai-gate' });
  const { ui } = page(match, activeLocalPlayer(match));
  await ui.playAiIfNeeded();
  assert.equal(match.actions.length, 0);
});

test('R-SETUP-01/02/03/04：只读布局预览与选完初始牌后的首轮棋盘完全一致', () => {
  let match = createLocalMatch(catalog, { seed: 'layout-preview-stable' });
  const preview = createPosition(match.config, { seed: `${match.seed}:round:1` });
  while (match.phase === 'draft') {
    const pair = match.draft.pairs.find((item) => item.chosenBy === null);
    const resource = match.config.cards.find((item) => item.id === pair.resourceId);
    const amount = resource.initialGains.filter((effect) => effect.type === 'chooseResource')
      .reduce((sum, effect) => sum + effect.amount, 0);
    match = applyLocalAction(match, {
      type: 'chooseStartingPair', actor: activeLocalPlayer(match), pairId: pair.id,
      choices: Array(amount).fill('food'),
    });
  }
  for (const key of ['castleRooms', 'bridges', 'placements', 'topCardId', 'topSlots']) {
    assert.deepEqual(match.state[key], preview[key]);
  }
  assert.ok(match.config.setup.castleRooms.every((room) => new Set(room.tiles.map((tile) => tile.color)).size >= 2));
});

test('R-AREA-01/GARDENER-01：7食物但缺印章时解释园丁字段费用，补足后允许执行', () => {
  const match = createLocalMatch(catalog, { seed: 'gardener-field-cost-hint', playOrder: ['0', '1'] });
  match.config.setup.players = [{
    currentCardId: 'start-action-warrior-2',
    resources: { food: 7, coin: 10, seal: 0 },
    figures: { gardener: [{ cardId: 'garden-58', bridgeId: 'white' }] },
  }, { currentCardId: 'start-action-courtier-2' }];
  match.config.setup.castleRooms = [{
    id: 'floor1-2', floor: 1, cardId: 'steward-s10',
    tiles: [{ fieldId: 'top', color: 'coral' }, { fieldId: 'middle', color: 'black' }, { fieldId: 'bottom', color: 'white' }],
  }];
  match.state = createPosition(match.config);
  match.phase = 'playing';
  const action = { type: 'placeDie', actor: '0', bridgeId: 'white', side: 'right', target: { area: 'castle', id: 'floor1-2' } };
  const probe = probeLocalAction(match, action);
  assert.equal(probe.request.type, 'field');
  assert.equal(probe.request.player.resources.food, 7);
  assert.deepEqual(probe.options.map(({ value }) => value), [{ type: 'field', fieldId: 'bottom', skip: true }]);
  const blocked = page(match, null, probe).nodes().find((node) => node.className === 'action-panel');
  assert.ok(blocked.textContent.includes(text('play.fieldCost', { cost: '大名印章 ×1' })));
  assert.ok(blocked.textContent.includes(text('play.fieldUnavailable', { missing: '大名印章（需要 1，现有 0）' })));
  assert.ok(blocked.textContent.includes(text('play.skipField')));
  assert.ok(!blocked.textContent.includes(text('play.executeField', { cost: '大名印章 ×1' })));
  match.state.players['0'].resources.seal = 1;
  const available = page(match, null, probeLocalAction(match, action)).nodes().find((node) => node.className === 'action-panel');
  assert.ok(available.textContent.includes(text('play.executeField', { cost: '大名印章 ×1' })));
  assert.ok(!available.textContent.includes('暂时不能执行'));
});
