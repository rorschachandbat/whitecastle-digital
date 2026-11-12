import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { TrainingEnvironment } from '../src/ai/environment.js';
import { chooseHeuristic } from '../src/ai/heuristicPolicy.js';
import { describeMatch } from '../src/ui/actionStory.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/whitecastle-2p.json', import.meta.url)));
const weights = JSON.parse(fs.readFileSync(new URL('../data/ai-heuristic.json', import.meta.url)));

function playUntil(seed, limit) {
  const env = new TrainingEnvironment(catalog, weights);
  let observation = env.reset(seed, ['0', '1']);
  while (!observation.done && env.match.actions.length < limit) observation = env.step(chooseHeuristic(observation.heuristic));
  return env.match;
}

test('动作说明用文字写出选牌、取骰和后续选择，不输出原始JSON', () => {
  const match = playUntil('story-readable', 4);
  const story = describeMatch(match);
  assert.equal(story.length, match.actions.length);
  assert.match(story[0].title, /选取起始牌/);
  const placed = story.find((entry) => entry.title.includes('从'));
  assert.ok(placed, '应说明从哪座桥取了几点');
  assert.match(placed.title, /点/);
  assert.ok(story.some((entry) => entry.details.length > 0), '连锁选择应分行写出');
  const rendered = JSON.stringify(story);
  assert.equal(rendered.includes('"type":"placeDie"'), false);
  assert.equal(describeMatch({ ...match, actions: [] }).length, 0);
});

test('无法重放时给出说明，不抛出页面错误', () => {
  const match = playUntil('story-broken', 1);
  match.actions.push({ type: 'placeDie', actor: '0', bridgeId: 'missing', side: 'left', target: { area: 'well' } });
  const story = describeMatch(match);
  assert.equal(story.length, 1);
  assert.match(story[0].title, /无法写成说明/);
});