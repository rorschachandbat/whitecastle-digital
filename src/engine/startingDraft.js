import { ACTION_TYPES, EFFECT_TYPES, canonicalCatalog } from '../data/catalog.js';
import { personalField } from './cardRules.js';

const RESOURCES = Object.freeze(['food', 'iron', 'pearl']);
const ASSETS = Object.freeze([...RESOURCES, 'coin', 'seal', 'points']);
const ROWS = Object.freeze(['courtier', 'gardener', 'warrior']);

export class StartingDraftError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StartingDraftError';
    this.code = code;
  }
}

function fail(code = 'INVALID_STATE') {
  throw new StartingDraftError(code);
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const eligible = (card) => card.verification === 'confirmed'
  && Array.isArray(card.playerCounts) && card.playerCounts.includes(2);

function effectsOf(effects, types) {
  if (!Array.isArray(effects) || effects.some((effect) => !isRecord(effect)
    || !types.includes(effect.type) || !Number.isSafeInteger(effect.amount) || effect.amount < 1)) {
    fail('INVALID_EFFECT');
  }
  return effects;
}

function checkedCard(cards, id, kind) {
  const card = cards.get(id);
  if (!card) fail('TARGET_NOT_FOUND');
  if (card.kind !== kind) fail('TARGET_NOT_ALLOWED');
  if (!eligible(card)) fail('DATA_UNVERIFIED');
  effectsOf(card.back, EFFECT_TYPES);
  return card;
}

function checkedConfig(config) {
  if (!isRecord(config) || config.playerCount !== 2 || !Array.isArray(config.cards)
    || (config.limits?.resource ?? 7) !== 7 || (config.limits?.seal ?? 5) !== 5) fail();
  const cards = new Map();
  for (const card of config.cards) {
    if (!isRecord(card) || typeof card.id !== 'string' || !card.id || cards.has(card.id)) fail();
    cards.set(card.id, card);
  }
  const pools = { startingResource: [], startingAction: [] };
  for (const card of cards.values()) {
    if (!Object.hasOwn(pools, card.kind) || !eligible(card)) continue;
    checkedCard(cards, card.id, card.kind);
    if (card.kind === 'startingResource') {
      effectsOf(card.initialGains, [...ASSETS, 'chooseResource']);
      if (card.grantDecreeId !== undefined) checkedCard(cards, card.grantDecreeId, 'decree');
    } else {
      // 共用字段只校验一次；同一张起始行动牌不会获得三份不同的规则。
      let field;
      try {
        field = personalField(card, ROWS[0]);
      } catch {
        fail('INVALID_EFFECT');
      }
      if (!Array.isArray(field.cost) || field.cost.length !== 0
        || effectsOf(field.effects, ACTION_TYPES).length !== 1 || field.effects[0].amount !== 1) {
        fail('INVALID_EFFECT');
      }
    }
    const copies = card.copies ?? 1;
    if (!Number.isSafeInteger(copies) || copies < 1 || copies > 200) fail();
    for (let index = 0; index < copies; index += 1) {
      // 实体标识用结构化编码，避免设计 ID 与副本序号拼接后碰撞。
      pools[card.kind].push({ cardId: card.id, instanceId: JSON.stringify([card.id, index]) });
    }
  }
  if (Object.values(pools).some((pool) => pool.length < 3)) fail('INSUFFICIENT_CARDS');
  return { cards, pools };
}

function checkedOrder(order) {
  if (!Array.isArray(order) || order.length !== 2
    || order.some((id) => typeof id !== 'string' || !id)
    || new Set(order).size !== 2) fail();
}

function seededRandom(seed) {
  // 显式种子和固定整数运算保证跨运行重放，不读取时钟或全局随机源。
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state = Math.imul(state ^ seed.charCodeAt(index), 16777619) >>> 0;
  }
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function drawThree(pool, random) {
  const shuffled = [...pool];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled.slice(0, 3);
}

/**
 * R-SETUP-04：只创建两人起始选牌阶段，不生成桥、城堡或完整对局。
 * 目录每项代表一种设计，copies 表示实体数量，省略时为一张。
 * 起始行动采用 cardRules 的单一 fields[action]，适用于任意人员排。
 */
export function createStartingDraft(config, { seed = 'whitecastle-starting-draft-v1', playOrder = ['0', '1'] } = {}) {
  const { pools } = checkedConfig(config);
  checkedOrder(playOrder);
  if (!(typeof seed === 'string' || (typeof seed === 'number' && Number.isFinite(seed)))) {
    fail('INVALID_SEED');
  }
  const seedText = String(seed);
  const random = seededRandom(seedText);
  const resources = drawThree(pools.startingResource, random);
  const actions = drawThree(pools.startingAction, random);
  return {
    schemaVersion: 1,
    mode: 'starting-draft-only',
    phase: 'choosing',
    seed: seedText,
    canonicalSignature: canonicalCatalog(config),
    playOrder: [...playOrder],
    draftOrder: [...playOrder].reverse(),
    nextPickIndex: 0,
    nextPlayerId: playOrder[1],
    players: Object.fromEntries(playOrder.map((id) => [id, null])),
    pairs: resources.map((resource, index) => ({
      id: `starting-pair-${index + 1}`,
      resourceId: resource.cardId,
      resourceInstanceId: resource.instanceId,
      actionId: actions[index].cardId,
      actionInstanceId: actions[index].instanceId,
      chosenBy: null,
    })),
  };
}

function checkedDraft(draft, pools, cards) {
  if (!isRecord(draft) || draft.schemaVersion !== 1 || draft.mode !== 'starting-draft-only') fail();
  checkedOrder(draft.playOrder);
  const order = [...draft.playOrder].reverse();
  if (!Array.isArray(draft.draftOrder) || draft.draftOrder.length !== 2
    || draft.draftOrder.some((id, index) => id !== order[index])
    || !Number.isInteger(draft.nextPickIndex) || draft.nextPickIndex < 0 || draft.nextPickIndex > 2
    || draft.phase !== (draft.nextPickIndex === 2 ? 'complete' : 'choosing')
    || draft.nextPlayerId !== (order[draft.nextPickIndex] ?? null)
    || !isRecord(draft.players) || Object.keys(draft.players).length !== 2
    || draft.playOrder.some((id) => !Object.hasOwn(draft.players, id))
    || !Array.isArray(draft.pairs) || draft.pairs.length !== 3) fail();
  const ids = new Set();
  const resourceInstances = new Set();
  const actionInstances = new Set();
  for (const pair of draft.pairs) {
    if (!isRecord(pair) || typeof pair.id !== 'string' || !pair.id || ids.has(pair.id)) fail();
    ids.add(pair.id);
    checkedCard(cards, pair.resourceId, 'startingResource');
    checkedCard(cards, pair.actionId, 'startingAction');
    for (const [kind, id, instanceId, used] of [
      ['startingResource', pair.resourceId, pair.resourceInstanceId, resourceInstances],
      ['startingAction', pair.actionId, pair.actionInstanceId, actionInstances],
    ]) {
      if (used.has(instanceId)
        || !pools[kind].some((instance) => instance.cardId === id && instance.instanceId === instanceId)) fail();
      used.add(instanceId);
    }
    if (pair.chosenBy !== null && !order.slice(0, draft.nextPickIndex).includes(pair.chosenBy)) fail();
  }
  for (const [index, id] of order.entries()) {
    const selected = draft.pairs.filter((pair) => pair.chosenBy === id);
    if (index >= draft.nextPickIndex) {
      if (draft.players[id] !== null || selected.length !== 0) fail();
      continue;
    }
    const player = draft.players[id];
    const pair = selected[0];
    if (selected.length !== 1 || !isRecord(player) || player.id !== id
      || player.selectedPairId !== pair.id || player.currentCardId !== pair.actionId
      || !Array.isArray(player.lanternCardIds)) fail();
    const decreeId = cards.get(pair.resourceId).grantDecreeId;
    const lanternIds = [pair.resourceId, ...(decreeId === undefined ? [] : [decreeId])];
    if (JSON.stringify(player.lanternCardIds) !== JSON.stringify(lanternIds)) fail();
    if (!isRecord(player.resources) || ASSETS.some((asset) => {
      const amount = player.resources[asset];
      const limit = RESOURCES.includes(asset) ? 7 : asset === 'seal' ? 5 : Infinity;
      return !Number.isSafeInteger(amount) || amount < 0 || amount > limit;
    })) fail();
  }
}

function startingAssets(gains, choices) {
  if (!Array.isArray(choices)) fail('INVALID_CHOICE');
  const required = gains.filter((gain) => gain.type === 'chooseResource')
    .reduce((total, gain) => total + gain.amount, 0);
  if (choices.length < required) fail('CHOICE_REQUIRED');
  if (choices.length !== required || choices.some((choice) => !RESOURCES.includes(choice))) {
    fail('INVALID_CHOICE');
  }
  const resources = Object.fromEntries(ASSETS.map((asset) => [asset, 0]));
  const add = (type, amount) => {
    const limit = RESOURCES.includes(type) ? 7 : type === 'seal' ? 5 : Infinity;
    const value = resources[type] + amount;
    // 对有上限的资源先截断；金币和分数仍须能精确序列化。
    resources[type] = value >= limit ? limit : value;
    if (!Number.isSafeInteger(resources[type])) fail('INVALID_EFFECT');
  };
  let used = 0;
  for (const gain of gains) {
    if (gain.type === 'chooseResource') {
      for (let index = 0; index < gain.amount; index += 1) add(choices[used++], 1);
    } else {
      add(gain.type, gain.amount);
    }
  }
  return resources;
}

/**
 * 返回新选牌状态；显式 choices 每项选择一单位食物、铁或珍珠。
 * 任一校验失败均抛出带 code 的错误，原选牌状态与目录保持不变。
 * 资源牌与敕令加入灯笼区，但选牌本身不触发其灯笼收益。
 */
export function chooseStartingPair(draft, actor, pairId, config, { choices = [] } = {}) {
  if (!isRecord(draft) || draft.canonicalSignature !== canonicalCatalog(config)) fail('CONFIG_MISMATCH');
  const { cards, pools } = checkedConfig(config);
  checkedDraft(draft, pools, cards);
  if (typeof actor !== 'string' || !Object.hasOwn(draft.players, actor)) fail('INVALID_ACTOR');
  if (draft.phase === 'complete') fail('DRAFT_COMPLETE');
  if (actor !== draft.nextPlayerId) fail('NOT_ACTIVE_PLAYER');
  const pair = draft.pairs.find((item) => item.id === pairId);
  if (!pair) fail('TARGET_NOT_FOUND');
  if (pair.chosenBy !== null) fail('TARGET_NOT_ALLOWED');
  const resource = cards.get(pair.resourceId);
  const lanternCardIds = [resource.id];
  if (resource.grantDecreeId !== undefined) {
    if (Object.values(draft.players).some((player) => player?.lanternCardIds.includes(resource.grantDecreeId))) {
      fail('TARGET_NOT_ALLOWED');
    }
    lanternCardIds.push(resource.grantDecreeId);
  }
  const resources = startingAssets(resource.initialGains, choices);
  const next = structuredClone(draft);
  next.players[actor] = {
    id: actor,
    selectedPairId: pair.id,
    currentCardId: pair.actionId,
    lanternCardIds,
    resources,
  };
  next.pairs.find((item) => item.id === pairId).chosenBy = actor;
  next.nextPickIndex += 1;
  next.nextPlayerId = next.draftOrder[next.nextPickIndex] ?? null;
  if (next.nextPickIndex === 2) next.phase = 'complete';
  return next;
}
