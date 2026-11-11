/**
 * 《姬路城》纯规则引擎第一批核心。
 *
 * 仅处理已经由 docs/RULES.md 确定、且可以通过配置表达的状态转移。
 * 未核验的卡牌、板块和复杂图标效果会明确拒绝，不使用猜测值。
 */

import { canonicalCatalog } from '../data/catalog.js';
import { personalField, castleFields, lightFields } from './cardRules.js';
import { applyInfluence } from './influence.js';

export const ENGINE_SCHEMA_VERSION = 1;

export const ERROR_CODES = Object.freeze({
  INVALID_STATE: 'INVALID_STATE',
  CONFIG_MISMATCH: 'CONFIG_MISMATCH',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_ACTOR: 'INVALID_ACTOR',
  NOT_ACTIVE_PLAYER: 'NOT_ACTIVE_PLAYER',
  PENDING_ACTION: 'PENDING_ACTION',
  NO_PENDING_ACTION: 'NO_PENDING_ACTION',
  BRIDGE_NOT_FOUND: 'BRIDGE_NOT_FOUND',
  BRIDGE_EMPTY: 'BRIDGE_EMPTY',
  INVALID_BRIDGE_SIDE: 'INVALID_BRIDGE_SIDE',
  SINGLE_DIE_ENDPOINT_UNKNOWN: 'SINGLE_DIE_ENDPOINT_UNKNOWN',
  SINGLE_DIE_WRONG_ENDPOINT: 'SINGLE_DIE_WRONG_ENDPOINT',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  TARGET_NOT_ALLOWED: 'TARGET_NOT_ALLOWED',
  TARGET_FULL: 'TARGET_FULL',
  INSUFFICIENT_COINS: 'INSUFFICIENT_COINS',
  INSUFFICIENT_SEALS: 'INSUFFICIENT_SEALS',
  INSUFFICIENT_RESOURCE: 'INSUFFICIENT_RESOURCE',
  RESOURCE_LIMIT: 'RESOURCE_LIMIT',
  INVALID_RESOURCE: 'INVALID_RESOURCE',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  CHOICE_REQUIRED: 'CHOICE_REQUIRED',
  ROUND_END_UNIMPLEMENTED: 'ROUND_END_UNIMPLEMENTED',
  TURN_LIMIT: 'TURN_LIMIT',
  DATA_UNVERIFIED: 'DATA_UNVERIFIED',
  INVALID_EFFECT: 'INVALID_EFFECT',
});

export class EngineError extends Error {
  constructor(code, message = code, details = undefined) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.details = details;
  }
}

const RESOURCE_NAMES = Object.freeze(['food', 'iron', 'pearl']);
const EFFECT_TYPES = Object.freeze(['food', 'iron', 'pearl', 'coin', 'seal', 'points']);
const FIGURE_NAMES = Object.freeze(['courtier', 'gardener', 'warrior']);
const LOCATION_VALUES = Object.freeze({ gate: 1, floor1: 3, floor2: 6, floor3: 10 });
const DEFAULTS = Object.freeze({
  playerCount: 2,
  resourceLimit: 7,
  sealLimit: 5,
  turnsPerPlayer: 3,
  personalCompareValue: 6,
  wellCompareValue: 1,
  bridgeCount: 3,
});

const deepClone = (value) => structuredClone(value);
const fail = (code, message, details) => {
  throw new EngineError(code, message, details);
};

function configDefaults(input = {}) {
  const limits = input.limits ?? {};
  if ((limits.resource ?? 7) !== 7 || (limits.seal ?? 5) !== 5) {
    fail(ERROR_CODES.INVALID_STATE, '资源与印章上限必须符合基础版规则');
  }
  for (const key of ['resourceLimit', 'sealLimit', 'turnsPerPlayer', 'personalCompareValue', 'wellCompareValue', 'bridgeCount']) {
    if (Object.hasOwn(input, key) && input[key] !== DEFAULTS[key]) {
      fail(ERROR_CODES.INVALID_STATE, `基础版固定参数不可修改：${key}`);
    }
  }
  if (input.policy?.singleDieEndpoint !== undefined
    && input.policy.singleDieEndpoint !== null
    && !['physical', 'left', 'right'].includes(input.policy.singleDieEndpoint)) {
    fail(ERROR_CODES.INVALID_STATE, '孤骰端点策略无效');
  }
  return {
    ...DEFAULTS,
    ...deepClone(input),
    resourceLimit: DEFAULTS.resourceLimit,
    sealLimit: DEFAULTS.sealLimit,
  };
}

function assertConfigMatch(state, config) {
  if (state.configSignature !== canonicalCatalog(config)) {
    fail(ERROR_CODES.CONFIG_MISMATCH, '当前配置与创建局面时的配置不一致');
  }
}

function emptyResources() {
  return { food: 0, iron: 0, pearl: 0, coin: 0, seal: 0, points: 0 };
}

function emptyFigures() {
  return { courtier: [], gardener: [], warrior: [] };
}

function normalizePlayer(id, source = {}) {
  return {
    id: String(id),
    resources: { ...emptyResources(), ...(source.resources ?? {}) },
    figures: deepClone({ ...emptyFigures(), ...(source.figures ?? {}) }),
    currentCard: deepClone(source.currentCard ?? source.currentCardId ?? null),
    lanternCards: deepClone(source.lanternCards ?? source.lanternCardIds ?? []),
    placements: deepClone(source.placements ?? []),
    timePosition: source.timePosition ?? 0,
    timePriority: source.timePriority ?? 0,
    finalOrder: source.finalOrder ?? null,
  };
}

function assertResourceBounds(resources, config) {
  for (const name of RESOURCE_NAMES) {
    if (!Number.isInteger(resources[name]) || resources[name] < 0 || resources[name] > config.resourceLimit) {
      fail(ERROR_CODES.INVALID_STATE, `${name} 必须位于 0..${config.resourceLimit}`);
    }
  }
  if (!Number.isInteger(resources.coin) || resources.coin < 0) fail(ERROR_CODES.INVALID_STATE, '金币不能为负数');
  if (!Number.isInteger(resources.seal) || resources.seal < 0 || resources.seal > config.sealLimit) {
    fail(ERROR_CODES.INVALID_STATE, `印章必须位于 0..${config.sealLimit}`);
  }
  if (!Number.isInteger(resources.points)) fail(ERROR_CODES.INVALID_STATE, '家族分必须是整数');
}

function normalizeBridge(bridge, index) {
  const id = String(bridge?.id ?? `bridge-${index}`);
  return {
    id,
    color: bridge?.color ?? null,
    dice: (bridge?.dice ?? []).map((die, dieIndex) => ({
      id: String(die?.id ?? `${id}-die-${dieIndex}`),
      value: die?.value,
    })),
    singleDieEndpoint: bridge?.singleDieEndpoint ?? null,
  };
}

function validateBridges(bridges) {
  if (bridges.length !== 3 || new Set(bridges.map((bridge) => bridge.id)).size !== 3) {
    fail(ERROR_CODES.INVALID_STATE, '两人局必须有三座不同的桥');
  }
  if (new Set(bridges.map((bridge) => bridge.color)).size !== 3
    || bridges.some((bridge) => !['coral', 'black', 'white'].includes(bridge.color))) {
    fail(ERROR_CODES.INVALID_STATE, '两人局必须有珊瑚、黑、白三种骰色');
  }
  const ids = new Set();
  for (const bridge of bridges) {
    if (bridge.dice.length !== 3) fail(ERROR_CODES.INVALID_STATE, '每座桥开局必须有三颗骰子');
    let lastValue = 0;
    for (const die of bridge.dice) {
      if (!Number.isSafeInteger(die.value) || die.value < 1 || die.value > 6 || die.value < lastValue || ids.has(die.id)) {
        fail(ERROR_CODES.INVALID_STATE, '骰子必须唯一且按点数升序摆放，点数为 1..6');
      }
      lastValue = die.value;
      ids.add(die.id);
    }
  }
}

function seededDice(seed) {
  // 以显式种子生成固定序列，不依赖系统时间或全局随机源。
  let number = 2166136261;
  for (const code of String(seed)) number = Math.imul(number ^ code.charCodeAt(0), 16777619) >>> 0;
  const next = () => {
    number = (number + 0x6D2B79F5) >>> 0;
    let value = number;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return ['coral', 'black', 'white'].map((color) => ({
    id: color,
    color,
    dice: Array.from({ length: 3 }, (_, index) => ({
      id: `${color}-${index}`,
      value: Math.floor(next() * 6) + 1,
    })).sort((left, right) => left.value - right.value),
    singleDieEndpoint: null,
  }));
}

function placementId(target, actor) {
  if (target?.area === 'personal') return `personal:${actor}:${target.row ?? target.id ?? ''}`;
  if (target?.area === 'well') return 'well';
  return `${target?.area ?? ''}:${target?.id ?? ''}`;
}

function buildPlacements(config, playerIds) {
  const source = config.placements ?? config.setup?.placements ?? {};
  const placements = {};
  for (const [id, value] of Object.entries(source)) {
    placements[id] = {
      id,
      area: value.area ?? id.split(':')[0],
      ...(value.owner === undefined ? {} : { owner: value.owner }),
      ...(value.row === undefined ? {} : { row: value.row }),
      comparisonValue: value.comparisonValue ?? value.compareValue ?? null,
      capacity: value.area === 'well' ? null : 1,
      dice: deepClone(value.dice ?? []),
      rewardEffects: deepClone(value.rewardEffects ?? value.effects ?? null),
    };
  }
  placements.well = {
    id: 'well',
    area: 'well',
    comparisonValue: config.wellCompareValue,
    capacity: null,
    dice: deepClone(source.well?.dice ?? []),
    rewardEffects: deepClone(config.wellRewards ?? config.setup?.wellRewards ?? null),
  };
  for (const playerId of playerIds) {
    for (const row of FIGURE_NAMES) {
      const id = `personal:${playerId}:${row}`;
      const configured = source[id] ?? {};
      placements[id] = {
        id,
        area: 'personal',
        owner: playerId,
        row,
        comparisonValue: DEFAULTS.personalCompareValue,
        capacity: 1,
        dice: deepClone(configured.dice ?? []),
        rewardEffects: deepClone(configured.rewardEffects ?? null),
      };
    }
  }
  return placements;
}

function validateState(state) {
  if (!state || state.schemaVersion !== ENGINE_SCHEMA_VERSION || !state.players || !state.placements || !Array.isArray(state.bridges)) {
    fail(ERROR_CODES.INVALID_STATE, '状态结构无效');
  }
  const ids = Object.keys(state.players);
  if (ids.length !== 2 || !ids.includes('0') || !ids.includes('1') || !ids.includes(state.activePlayer)) {
    fail(ERROR_CODES.INVALID_STATE, '两人状态必须包含两个有效玩家');
  }
  if (!Array.isArray(state.playOrder) || state.playOrder.length !== 2
    || new Set(state.playOrder).size !== 2 || state.playOrder.some((id) => !ids.includes(id))) {
    fail(ERROR_CODES.INVALID_STATE, '行动顺序无效');
  }
  for (const id of ids) {
    if (!Number.isSafeInteger(state.turnsUsed?.[id]) || state.turnsUsed[id] < 0 || state.turnsUsed[id] > 3) {
      fail(ERROR_CODES.INVALID_STATE, '已用回合数无效');
    }
    for (const type of FIGURE_NAMES) {
      if (!Array.isArray(state.players[id].figures?.[type]) || state.players[id].figures[type].length > 5) {
        fail(ERROR_CODES.INVALID_STATE, '人员数据无效');
      }
    }
  }
}

function confirmed(record, label) {
  if (!record || record.verification !== 'confirmed') {
    fail(ERROR_CODES.DATA_UNVERIFIED, `${label}缺少已核验数据`);
  }
  return record;
}

function actorOf(state, actor) {
  const id = String(actor);
  if (!state.players[id]) fail(ERROR_CODES.INVALID_ACTOR, `未知玩家：${actor}`);
  return id;
}

function normalizeEffects(effects) {
  if (effects === null || effects === undefined) return [];
  if (!Array.isArray(effects)) fail(ERROR_CODES.INVALID_EFFECT, '效果必须是数组');
  return effects.map((effect) => {
    if (effect?.type && Number.isInteger(effect.amount)) return effect;
    if (effect && typeof effect === 'object' && Object.keys(effect).length === 1) {
      const [type] = Object.keys(effect);
      return { type, amount: effect[type] };
    }
    fail(ERROR_CODES.INVALID_EFFECT, '效果必须是 {type, amount}');
  });
}

function applyEffects(player, effects, config, choices = { values: [], used: 0 }, depth = 0, context) {
  if (depth > 64) fail(ERROR_CODES.INVALID_EFFECT, '灯笼效果递归过深');
  let next = processExchanges(player, config, context);
  let ordered = normalizeEffects(effects);
  if (ordered.length > 1 && context) {
    const index = context.orderIndex++;
    const order = context.effectOrders[index];
    if (context.interactive && order === undefined) {
      fail(ERROR_CODES.CHOICE_REQUIRED, '请选择同组效果顺序', {
        type: 'effectOrder', index, effects: ordered, player: next, state: context.state,
      });
    }
    if (order !== undefined && order !== null) {
      if (!Array.isArray(order) || order.length !== ordered.length || new Set(order).size !== order.length
        || order.some((index) => !Number.isInteger(index) || index < 0 || index >= ordered.length)) {
        fail(ERROR_CODES.INVALID_ACTION, '组合收益顺序必须是完整排列');
      }
      ordered = order.map((index) => ordered[index]);
    }
  }
  for (const effect of ordered) {
    next = processExchanges(next, config, context);
    if (!Number.isSafeInteger(effect.amount) || effect.amount < 1) {
      fail(ERROR_CODES.INVALID_EFFECT, '收益数量必须是正整数');
    }
    if (effect.type === 'lantern') {
      for (let index = 0; index < effect.amount; index += 1) {
        next = applyEffects(next, lanternEffects(next, config), config, choices, depth + 1, context);
      }
      continue;
    }
    if (effect.type === 'well') {
      next = applyEffects(next, wellEffects(config), config, choices, depth + 1, context);
      continue;
    }
    if (effect.type === 'influence') {
      next = applyInfluence(next, effect.amount, config, context);
      continue;
    }
    if (['gardener', 'warrior', 'courtier', 'domain', 'castleAny', 'castleLight', 'castleCoral', 'castleBlack', 'castleWhite'].includes(effect.type)) {
      if (!context || effect.amount !== 1) fail(ERROR_CODES.INVALID_EFFECT, '行动需要完整决策上下文');
      next = resolveCardAction(next, effect.type, config, choices, depth + 1, context);
      continue;
    }
    if (effect.type === 'chooseResource') {
      for (let index = 0; index < effect.amount; index += 1) {
        const chosen = choices.values[choices.used++];
        if (!RESOURCE_NAMES.includes(chosen)) {
          fail(ERROR_CODES.CHOICE_REQUIRED, '必须明确选择食物、铁或珍珠母', {
            type: 'chooseResource', index: choices.used - 1, player: next, state: context?.state,
          });
        }
        next.resources[chosen] = Math.min(config.resourceLimit, next.resources[chosen] + 1);
      }
      continue;
    }
    if (!EFFECT_TYPES.includes(effect.type)) {
      fail(ERROR_CODES.DATA_UNVERIFIED, `尚未实现效果：${effect.type}`);
    }
    const old = next.resources[effect.type];
    const value = old + effect.amount;
    const limit = effect.type === 'seal'
      ? config.sealLimit
      : effect.type === 'coin' || effect.type === 'points'
        ? Infinity
        : config.resourceLimit;
    if (value < 0) {
      const code = effect.type === 'coin'
        ? ERROR_CODES.INSUFFICIENT_COINS
        : effect.type === 'seal'
          ? ERROR_CODES.INSUFFICIENT_SEALS
          : ERROR_CODES.INSUFFICIENT_RESOURCE;
      fail(code, `${effect.type} 不足`);
    }
    next.resources[effect.type] = Math.min(limit, value);
  }
  assertResourceBounds(next.resources, config);
  return next;
}

function cardByReference(reference, config) {
  const id = typeof reference === 'string' ? reference : reference?.id;
  return confirmed(config.cards?.find((card) => card.id === id), `牌 ${id ?? ''}`);
}

function lanternEffects(player, config) {
  const cards = player.lanternCards ?? [];
  return cards.flatMap((reference) => {
    const card = cardByReference(reference, config);
    if (!Array.isArray(card.back)) fail(ERROR_CODES.DATA_UNVERIFIED, '牌背灯笼收益尚未核验');
    return card.back;
  });
}

function wellEffects(config) {
  const setup = config.setup ?? {};
  const rewards = config.wellRewards ?? setup.wellRewards;
  if (!Array.isArray(rewards) || rewards.length === 0) {
    fail(ERROR_CODES.DATA_UNVERIFIED, '水井两个资源面尚未配置');
  }
  // 水井板块尚未进入正式目录；这里只接受显式、版本化的实验夹具。
  if (setup.fixtureVersion !== 'well-rewards-v1') {
    fail(ERROR_CODES.DATA_UNVERIFIED, '水井收益只能通过版本化实验夹具提供');
  }
  return [{ type: 'seal', amount: 1 }, ...rewards];
}

function payCosts(player, costs) {
  const next = deepClone(player);
  if (!Array.isArray(costs)) fail(ERROR_CODES.DATA_UNVERIFIED, '行动费用尚未配置');
  for (const cost of costs) {
    if (!['food', 'iron', 'pearl', 'coin', 'seal'].includes(cost?.type) || !Number.isSafeInteger(cost.amount) || cost.amount < 1) {
      fail(ERROR_CODES.INVALID_EFFECT, '费用必须是正整数资产');
    }
    if (next.resources[cost.type] < cost.amount) {
      fail(cost.type === 'coin' ? ERROR_CODES.INSUFFICIENT_COINS : cost.type === 'seal' ? ERROR_CODES.INSUFFICIENT_SEALS : ERROR_CODES.INSUFFICIENT_RESOURCE, '行动费用不足');
    }
    next.resources[cost.type] -= cost.amount;
  }
  return next;
}

function processExchanges(player, config, context) {
  let next = deepClone(player);
  while (context?.decisions[context.decisionIndex]?.type === 'exchangeSeal') {
    const decision = context.decisions[context.decisionIndex++];
    if (![1, 2].includes(decision.amount)) fail(ERROR_CODES.INVALID_AMOUNT, '只能兑换1或2枚印章');
    if (decision.amount === 2 && !RESOURCE_NAMES.includes(decision.resource)) fail(ERROR_CODES.INVALID_RESOURCE, '印章兑换资源无效');
    next = payCosts(next, [{ type: 'seal', amount: decision.amount }]);
    if (decision.amount === 1) next.resources.coin += 1;
    else next.resources[decision.resource] = Math.min(config.resourceLimit, next.resources[decision.resource] + 1);
    context.state.players[context.actor] = next;
  }
  return next;
}

function personalEffects(player, placement, bridge, config) {
  const row = confirmed(config.personalDomainRows?.find((item) => item.id === placement.row), '个人面板排');
  if (row.dieColor !== bridge.color) fail(ERROR_CODES.TARGET_NOT_ALLOWED, '骰色与个人面板排不符');
  if (!Array.isArray(row.revealedGains) || row.revealedGains.length !== 5 || !row.baseGain) {
    fail(ERROR_CODES.DATA_UNVERIFIED, '个人面板可见收益缺失');
  }
  const figures = player.figures[row.figureType];
  if (!Array.isArray(figures) || figures.length > 5) fail(ERROR_CODES.INVALID_STATE, '人员数组无效');
  const card = cardByReference(player.currentCard, config);
  if (!['startingAction', 'steward', 'diplomat'].includes(card.kind)) {
    fail(ERROR_CODES.DATA_UNVERIFIED, '当前牌不是已核验个人行动牌');
  }
  const fieldId = config.setup?.personalFieldByRow?.[row.id];
  let field = card.fields?.find((item) => item.id === (fieldId ?? row.id));
  if (!field) {
    try { field = personalField(card, row.id); }
    catch { fail(ERROR_CODES.DATA_UNVERIFIED, '个人行动牌布局无效'); }
  }
  if (!field) fail(ERROR_CODES.DATA_UNVERIFIED, '当前个人行动牌缺少对应排');
  return {
    gains: [row.baseGain, ...row.revealedGains.slice(0, figures.length)],
    field,
  };
}

function nextDecision(context, type, player = undefined, details = {}) {
  const index = context.decisionIndex++;
  const decision = context.decisions[index];
  if (!decision) {
    fail(ERROR_CODES.CHOICE_REQUIRED, '必须明确指定行动目标', {
      type, index, player, state: context.state, ...details,
    });
  }
  if (decision.type !== type) fail(ERROR_CODES.INVALID_ACTION, '决策类型与待执行行动不符', { type, index });
  return decision;
}

function executeField(player, field, config, choices, depth, context) {
  player = processExchanges(player, config, context);
  // 字段奖励可整体放弃；已支付的骰差额、部署费用和先前收益不撤销。
  if (context?.decisions[context.decisionIndex]?.type === 'field') {
    const decision = nextDecision(context, 'field', player, {
      field, options: [
        { type: 'field', fieldId: field.id, skip: false },
        { type: 'field', fieldId: field.id, skip: true },
      ],
    });
    if (decision.fieldId !== field.id || decision.skip !== true) {
      if (decision.fieldId !== field.id || decision.skip !== false) {
        fail(ERROR_CODES.INVALID_ACTION, '字段选择必须指明当前字段并决定是否执行');
      }
    } else {
      return player;
    }
  } else if (context?.interactive) {
    fail(ERROR_CODES.CHOICE_REQUIRED, '请选择是否执行当前字段', {
      type: 'field', index: context.decisionIndex, field, player, state: context.state,
      options: [
        { type: 'field', fieldId: field.id, skip: false },
        { type: 'field', fieldId: field.id, skip: true },
      ],
    });
  }
  const paid = payCosts(player, field.cost);
  return applyEffects(paid, field.effects, config, choices, depth + 1, context);
}

function roomFloor(room, config) {
  const kind = config.cards?.find((card) => card.id === room.cardId)?.kind;
  const floor = room.floor ?? (kind === 'steward' ? 1 : kind === 'diplomat' ? 2 : null);
  if (![1, 2].includes(floor) || (room.cardId && kind !== (floor === 1 ? 'steward' : 'diplomat'))) {
    fail(ERROR_CODES.DATA_UNVERIFIED, '房间楼层与行动牌不符');
  }
  return floor;
}

function topCard(state, config) {
  const card = cardByReference(state.topCardId, config);
  if (card.kind !== 'top' || card.selection !== 'oneEmptySlot' || card.fields?.length !== 3
    || card.fields.some((field) => field.capacity !== 1)) {
    fail(ERROR_CODES.DATA_UNVERIFIED, '本局大名卡槽位配置无效');
  }
  return card;
}

function promotionsFor(player, state, config) {
  const options = [];
  const locations = ['gate', 'floor1', 'floor2', 'floor3'];
  for (const [figureIndex, figure] of player.figures.courtier.entries()) {
    const from = locations.indexOf(locationOf(figure));
    if (from < 0) continue;
    for (const steps of [1, 2]) {
      if (player.resources.pearl < (steps === 1 ? 2 : 5)) continue;
      const floor = from + steps;
      if (floor > 3) continue;
      if (floor === 3) {
        const card = config.cards?.find((item) => item.id === state.topCardId && item.kind === 'top');
        if (!card) continue;
        const slots = card.fields.filter((field) => !state.topSlots?.[field.id]);
        for (const slot of slots.length ? slots : [null]) {
          options.push({ figureIndex, steps, ...(slot ? { slotId: slot.id } : {}) });
        }
        continue;
      }
      for (const room of state.castleRooms) {
        if (!room.cardId || roomFloor(room, config) !== floor) continue;
        const card = cardByReference(room.cardId, config);
        for (const field of lightFields(card)) options.push({ figureIndex, steps, roomId: room.id, fieldId: field.id });
      }
    }
  }
  return options;
}

function courtierOptions(player, state, config) {
  const options = [{ type: 'courtier', skip: true }];
  const canAudience = player.figures.courtier.length < 5 && player.resources.coin >= 2;
  if (canAudience) options.push({ type: 'courtier', audience: true });
  for (const promote of promotionsFor(player, state, config)) {
    options.push({ type: 'courtier', promote });
    // 晋升奖励可能先取得金币，因此先晋升后谒见不依赖晋升前的金币数量。
    if (player.figures.courtier.length < 5) {
      options.push({ type: 'courtier', audience: true, promote, order: ['promote', 'audience'] });
    }
    if (canAudience) options.push({ type: 'courtier', audience: true, promote });
  }
  if (canAudience) {
    const withAudience = deepClone(player);
    const figureIndex = withAudience.figures.courtier.length;
    withAudience.figures.courtier.push({ location: 'gate' });
    for (const promote of promotionsFor(withAudience, state, config).filter((item) => item.figureIndex === figureIndex)) {
      options.push({ type: 'courtier', audience: true, promote });
    }
  }
  return options;
}

function promoteCourtier(player, decision, config, choices, depth, context) {
  if (!context.state.castleRooms.length) fail(ERROR_CODES.DATA_UNVERIFIED, '家臣晋升需要本局城堡房间');
  const promotion = decision.promote;
  if (!promotion || !Number.isSafeInteger(promotion.figureIndex) || ![1, 2].includes(promotion.steps)) {
    fail(ERROR_CODES.INVALID_ACTION, '晋升必须指定家臣序号和一层或两层步数');
  }
  let next = deepClone(player);
  const figure = next.figures.courtier[promotion.figureIndex];
  const locations = ['gate', 'floor1', 'floor2', 'floor3'];
  const from = locations.indexOf(locationOf(figure));
  if (from < 0 || from + promotion.steps > 3) fail(ERROR_CODES.TARGET_NOT_ALLOWED, '家臣晋升超出楼层');
  const floor = from + promotion.steps;
  next = payCosts(next, [{ type: 'pearl', amount: promotion.steps === 1 ? 2 : 5 }]);
  if (floor === 3) {
    const card = topCard(context.state, config);
    next.figures.courtier[promotion.figureIndex] = { location: 'floor3' };
    next = applyEffects(next, lanternEffects(next, config), config, choices, depth + 1, context);
    const slots = card.fields.filter((field) => !context.state.topSlots[field.id]);
    if (!slots.length) {
      if (promotion.slotId !== undefined && promotion.slotId !== null) fail(ERROR_CODES.TARGET_FULL, '大名恩赏已无空位');
      return next;
    }
    const slot = slots.find((field) => field.id === promotion.slotId);
    if (!slot) fail(ERROR_CODES.TARGET_NOT_ALLOWED, '请选择大名卡的空槽位');
    context.state.topSlots[slot.id] = { actor: context.actor, figureIndex: promotion.figureIndex };
    next.figures.courtier[promotion.figureIndex].slotId = slot.id;
    return executeField(next, slot, config, choices, depth, context);
  }
  const room = context.state.castleRooms.find((item) => item.id === promotion.roomId);
  if (!room || roomFloor(room, config) !== floor) fail(ERROR_CODES.TARGET_NOT_ALLOWED, '晋升终点必须位于目标楼层');
  const card = cardByReference(room.cardId, config);
  const field = lightFields(card).find((item) => item.id === promotion.fieldId);
  if (!field) fail(ERROR_CODES.TARGET_NOT_ALLOWED, '家臣到达只能选择一项浅色行动');
  const deck = context.state.castleDecks[card.kind];
  if (!Array.isArray(deck)) fail(ERROR_CODES.DATA_UNVERIFIED, '对应楼层牌堆尚未配置');
  next.figures.courtier[promotion.figureIndex] = { location: `floor${floor}`, roomId: room.id };
  if (deck.length === 0) return executeField(next, field, config, choices, depth, context);
  const replacementId = deck.shift();
  if (cardByReference(replacementId, config).kind !== card.kind) fail(ERROR_CODES.INVALID_STATE, '补牌与楼层牌堆类型不符');
  next = replaceCurrentCardWithLantern(next, card.id);
  // 先取走原房间牌，结束入场奖励后再补牌；连锁不能重复取得同一实体。
  room.cardId = null;
  context.state.players[context.actor] = next;
  next = executeField(next, field, config, choices, depth, context);
  room.cardId = replacementId;
  return next;
}

function resolveCardAction(player, type, config, choices, depth, context) {
  if (depth > 64) fail(ERROR_CODES.INVALID_EFFECT, '连锁行动过深');
  player = processExchanges(player, config, context);
  context.state.players[context.actor] = player;
  const details = {
    domainRows: [...context.domainRows],
    ...(type === 'courtier' && !context.decisions[context.decisionIndex]
      ? { options: courtierOptions(player, context.state, config) } : {}),
  };
  const decision = nextDecision(context, type, player, details);
  // 放弃的是卡牌提供的子行动，不能借此跳过整次取放骰。
  if (decision.skip === true) return player;
  let next = deepClone(player);
  if (type === 'gardener') {
    if (!Array.isArray(config.setup?.gardens) || !config.setup.gardens.length) {
      fail(ERROR_CODES.DATA_UNVERIFIED, '本局花园配置尚未提供');
    }
    const garden = config.setup.gardens.find((item) => item.cardId === decision.cardId);
    if (!garden || next.figures.gardener.some((figure) => figure.cardId === decision.cardId)) {
      fail(ERROR_CODES.TARGET_NOT_ALLOWED, '该花园不是本局目标或已经有自己的园丁');
    }
    if (next.figures.gardener.length >= 5) fail(ERROR_CODES.TARGET_FULL, '没有可用园丁');
    const card = cardByReference(garden.cardId, config);
    if (!['plant', 'stone'].includes(card.kind) || !Number.isSafeInteger(card.foodCost) || card.foodCost < 0
      || card.fields?.length !== 1) fail(ERROR_CODES.DATA_UNVERIFIED, '花园数据不完整');
    next = card.foodCost === 0 ? next : payCosts(next, [{ type: 'food', amount: card.foodCost }]);
    next.figures.gardener.push({ cardId: card.id, bridgeId: garden.bridgeId });
    if (decision.activate === false) return next;
    return executeField(next, card.fields[0], config, choices, depth, context);
  }
  if (type === 'warrior') {
    // 用户确认的金银独立牌池模式与旧手工可见面练习均保留显式标记。
    if (!['manual-visible-faces', 'separate-pools'].includes(config.setup?.trainingMode)) {
      fail(ERROR_CODES.DATA_UNVERIFIED, '训练场需要指定金银独立牌池或手工可见面模式');
    }
    const zone = confirmed(config.trainingZones?.find((item) => item.id === decision.yardId), '训练区');
    const yard = config.setup.trainingYards?.find((item) => item.id === zone.id);
    if (!yard || !Array.isArray(yard.faceIds) || yard.faceIds.length !== zone.faceTones?.length) {
      fail(ERROR_CODES.DATA_UNVERIFIED, '训练区可见面数量不符');
    }
    const allFaces = (config.setup.trainingYards ?? []).flatMap((item) => item.faceIds ?? []);
    if (new Set(allFaces).size !== allFaces.length) fail(ERROR_CODES.INVALID_STATE, '本局训练面重复');
    const faces = yard.faceIds.map((id) => confirmed(config.yardFaces?.find((item) => item.id === id), '训练面'));
    if (new Set(faces.map((face) => face.tone)).size !== zone.faceTones.length
      || faces.some((face) => !zone.faceTones.includes(face.tone))) fail(ERROR_CODES.INVALID_STATE, '训练区朝向不符');
    if (config.setup.trainingMode === 'separate-pools') {
      for (const face of faces) {
        const pool = confirmed(config.trainingPools?.find((item) => item.tone === face.tone), '训练池');
        if (!Array.isArray(pool.faceIds) || !pool.faceIds.includes(face.id)) fail(ERROR_CODES.DATA_UNVERIFIED, '训练面未进入对应金银牌池');
      }
    }
    if (next.figures.warrior.length >= 5) fail(ERROR_CODES.TARGET_FULL, '没有可用武士');
    if (!Number.isSafeInteger(zone.ironCost) || zone.ironCost < 1) fail(ERROR_CODES.INVALID_STATE, '训练区费用无效');
    next = payCosts(next, [{ type: 'iron', amount: zone.ironCost }]);
    next.figures.warrior.push({ yardId: zone.id });
    let order = decision.faceOrder;
    if (order === undefined && faces.length === 1) order = [faces[0].id];
    if (!Array.isArray(order)) {
      fail(ERROR_CODES.CHOICE_REQUIRED, '必须选择训练面的执行顺序', {
        type: 'warriorOrder', index: context.decisionIndex - 1,
        yard, faces, player: next, state: context.state,
      });
    }
    if (new Set(order).size !== order.length || order.some((id) => !yard.faceIds.includes(id))) {
      fail(ERROR_CODES.INVALID_ACTION, '训练行动选择无效');
    }
    for (const id of order) next = executeField(next, faces.find((face) => face.id === id), config, choices, depth, context);
    return next;
  }
  if (type === 'courtier') {
    if (decision.promote !== undefined && (!decision.promote
      || !Number.isSafeInteger(decision.promote.figureIndex)
      || ![1, 2].includes(decision.promote.steps))) {
      fail(ERROR_CODES.DATA_UNVERIFIED, '家臣晋升目标尚未配置');
    }
    const parts = [
      ...(decision.audience === true ? ['audience'] : []),
      ...(decision.promote !== undefined ? ['promote'] : []),
    ];
    const order = decision.order ?? parts;
    if (!parts.length || !Array.isArray(order) || order.length !== parts.length
      || new Set(order).size !== order.length || order.some((part) => !parts.includes(part))) {
      fail(ERROR_CODES.INVALID_ACTION, '必须选择谒见、晋升或两者的执行顺序');
    }
    for (const part of order) {
      if (part === 'audience') {
        if (next.figures.courtier.length >= 5) fail(ERROR_CODES.TARGET_FULL, '没有可用家臣');
        next = payCosts(next, [{ type: 'coin', amount: 2 }]);
        next.figures.courtier.push({ location: 'gate' });
      } else {
        next = promoteCourtier(next, decision, config, choices, depth, context);
      }
      context.state.players[context.actor] = next;
    }
    return next;
  }
  if (type === 'domain') {
    if (!FIGURE_NAMES.includes(decision.row)) fail(ERROR_CODES.TARGET_NOT_ALLOWED, '个人面板排行动目标无效');
    if (context.domainRows.has(decision.row)) fail(ERROR_CODES.TARGET_NOT_ALLOWED, '同一回合不能重复用图标激活同排');
    context.domainRows.add(decision.row);
    const row = config.personalDomainRows?.find((item) => item.id === decision.row);
    const personal = personalEffects(next, { row: decision.row }, { color: row?.dieColor }, config);
    next = applyEffects(next, personal.gains, config, choices, depth + 1, context);
    return executeField(next, personal.field, config, choices, depth, context);
  }
  const room = context.state.castleRooms.find((item) => item.id === decision.roomId);
  if (!room) fail(ERROR_CODES.DATA_UNVERIFIED, '城堡房间尚未配置');
  const card = cardByReference(room.cardId, config);
  if (!['steward', 'diplomat'].includes(card.kind)) fail(ERROR_CODES.DATA_UNVERIFIED, '城堡房间牌类型无效');
  const field = card.fields?.find((item) => item.id === decision.fieldId);
  if (!field) fail(ERROR_CODES.TARGET_NOT_FOUND, '城堡行动字段不存在');
  if (type === 'castleLight') {
    if (field.tone !== 'light') fail(ERROR_CODES.TARGET_NOT_ALLOWED, '只能选择浅色行动');
  } else {
    const colors = { castleCoral: 'coral', castleBlack: 'black', castleWhite: 'white' };
    const allowed = (room.tiles ?? []).filter((tile) => type === 'castleAny' || tile.color === colors[type]);
    if (!allowed.some((tile) => tile.fieldId === field.id)) fail(ERROR_CODES.TARGET_NOT_ALLOWED, '该行动没有对应骰色板块');
  }
  return executeField(next, field, config, choices, depth, context);
}

function findBridge(state, id) {
  const bridge = state.bridges.find((item) => item.id === String(id));
  if (!bridge) fail(ERROR_CODES.BRIDGE_NOT_FOUND, `找不到桥：${id}`);
  return bridge;
}

function findPlacement(state, target, actor) {
  if (!target || typeof target !== 'object') fail(ERROR_CODES.INVALID_ACTION, '放置目标无效');
  const id = placementId(target, actor);
  const placement = state.placements[id];
  if (!placement) fail(ERROR_CODES.TARGET_NOT_FOUND, `找不到放置区：${id}`);
  if (placement.area === 'personal' && placement.owner !== actor) {
    fail(ERROR_CODES.TARGET_NOT_ALLOWED, '个人面板只能放置自己的骰子');
  }
  return placement;
}

function takeDie(state, action, config) {
  if (state.pendingDie) fail(ERROR_CODES.PENDING_ACTION, '已有骰子等待放置');
  const actor = actorOf(state, action.actor);
  if (actor !== state.activePlayer) fail(ERROR_CODES.NOT_ACTIVE_PLAYER, '不是该玩家的回合');
  if ((state.turnsUsed[actor] ?? 0) >= config.turnsPerPlayer) fail(ERROR_CODES.TURN_LIMIT, '本轮回合已用完');
  if (!['left', 'right'].includes(action.side)) fail(ERROR_CODES.INVALID_BRIDGE_SIDE, '只能取桥端骰');
  const bridge = findBridge(state, action.bridgeId);
  if (!bridge.dice.length) fail(ERROR_CODES.BRIDGE_EMPTY, '桥上没有骰子');
  if (bridge.dice.length === 1) {
    if (!bridge.singleDieEndpoint) fail(ERROR_CODES.SINGLE_DIE_ENDPOINT_UNKNOWN, '唯一骰端点尚未核验');
    if (bridge.singleDieEndpoint !== action.side) fail(ERROR_CODES.SINGLE_DIE_WRONG_ENDPOINT, '唯一骰不能从该端取');
  }
  const next = deepClone(state);
  const nextBridge = next.bridges.find((item) => item.id === bridge.id);
  const [die] = nextBridge.dice.splice(action.side === 'left' ? 0 : nextBridge.dice.length - 1, 1);
  next.pendingDie = { actor, bridgeId: bridge.id, side: action.side, die };
  nextBridge.singleDieEndpoint = nextBridge.dice.length === 1
    ? config.policy?.singleDieEndpoint === 'physical'
      ? action.side === 'left' ? 'right' : 'left'
      : config.policy?.singleDieEndpoint ?? null
    : null;
  return next;
}

function placeDie(state, action, config) {
  if (!state.pendingDie) fail(ERROR_CODES.NO_PENDING_ACTION, '没有待放置骰');
  const actor = actorOf(state, action.actor);
  if (state.pendingDie.actor !== actor) fail(ERROR_CODES.NOT_ACTIVE_PLAYER, '只能由取骰玩家放置');
  const placement = findPlacement(state, action.target, actor);
  if (placement.capacity !== null && placement.dice.length >= placement.capacity) {
    fail(ERROR_CODES.TARGET_FULL, '放置区已满');
  }
  if (!Number.isInteger(placement.comparisonValue)) fail(ERROR_CODES.DATA_UNVERIFIED, '比较值尚未核验');
  const die = state.pendingDie.die;
  const delta = die.value - placement.comparisonValue;
  const player = state.players[actor];
  if (delta < 0 && player.resources.coin < -delta) fail(ERROR_CODES.INSUFFICIENT_COINS, '金币不足');

  const next = deepClone(state);
  let updated = next.players[actor];
  updated.resources.coin += delta;
  const choices = { values: action.choices ?? [], used: 0 };
  if (!Array.isArray(choices.values)) fail(ERROR_CODES.INVALID_ACTION, '资源选择必须是数组');
  const context = {
    state: next, actor,
    decisions: action.decisions ?? [], decisionIndex: 0,
    effectOrders: action.effectOrders ?? [], orderIndex: 0,
    domainRows: new Set(),
    interactive: action.interactive === true,
  };
  if (!Array.isArray(context.decisions) || context.decisions.some((item) => !item || typeof item !== 'object')
    || !Array.isArray(context.effectOrders)) fail(ERROR_CODES.INVALID_ACTION, '行动决策必须是数组');
  if (state.pendingDie.side === 'left') {
    updated = applyEffects(updated, lanternEffects(updated, config), config, choices, 0, context);
  }
  const target = next.placements[placement.id];
  if (target.area === 'well') {
    updated = applyEffects(updated, wellEffects(config), config, choices, 0, context);
  } else if (target.area === 'personal') {
    const bridge = findBridge(state, state.pendingDie.bridgeId);
    const personal = personalEffects(updated, placement, bridge, config);
    updated = applyEffects(updated, personal.gains, config, choices, 0, context);
    updated = executeField(updated, personal.field, config, choices, 0, context);
  } else if (target.area === 'castle') {
    const room = next.castleRooms.find((item) => item.id === action.target.id);
    if (!room) fail(ERROR_CODES.DATA_UNVERIFIED, '城堡放置区缺少房间配置');
    const card = cardByReference(room.cardId, config);
    let fields;
    try { fields = castleFields(card, room.tiles, findBridge(state, state.pendingDie.bridgeId).color); }
    catch { fail(ERROR_CODES.DATA_UNVERIFIED, '房间骰色板块配置无效'); }
    if (!fields.length) fail(ERROR_CODES.TARGET_NOT_ALLOWED, '房间没有匹配骰色');
    const decision = fields.length > 1 ? nextDecision(context, 'castleOrder', updated, { fields, room }) : null;
    const order = decision?.fieldIds ?? fields.map((field) => field.id);
    if (!Array.isArray(order) || order.length !== fields.length
      || [...order].sort().join('|') !== fields.map((field) => field.id).sort().join('|')) {
      fail(ERROR_CODES.INVALID_ACTION, '必须明确排列所有匹配行动');
    }
    for (const id of order) updated = executeField(updated, fields.find((field) => field.id === id), config, choices, 0, context);
  } else if (target.area === 'outside') {
    if (!['left', 'right'].includes(action.target.id)) fail(ERROR_CODES.DATA_UNVERIFIED, '城外位置未核验');
    const allowed = action.target.id === 'left' ? ['gardener', 'courtier'] : ['courtier', 'warrior'];
    updated = processExchanges(updated, config, context);
    const decision = nextDecision(context, 'outside', updated, { actions: allowed });
    if (!allowed.includes(decision.action)) fail(ERROR_CODES.TARGET_NOT_ALLOWED, '城外位置不能选择该行动');
    updated = applyEffects(updated, [{ type: decision.action, amount: 1 }], config, choices, 0, context);
  } else {
    fail(ERROR_CODES.DATA_UNVERIFIED, '城堡与城外行动尚未实现');
  }
  if (choices.used !== choices.values.length) fail(ERROR_CODES.INVALID_ACTION, '资源选择数量与效果不符');
  if (context.decisionIndex !== context.decisions.length || context.effectOrders.length > context.orderIndex) {
    fail(ERROR_CODES.INVALID_ACTION, '存在多余行动选择或收益排序');
  }
  target.dice.push({ ...deepClone(die), actor, sourceBridge: state.pendingDie.bridgeId });
  next.players[actor] = updated;
  next.pendingDie = null;
  next.turnsUsed[actor] += 1;
  const order = next.playOrder;
  const currentIndex = order.indexOf(actor);
  next.activePlayer = Array.from({ length: order.length }, (_, index) => order[(currentIndex + index + 1) % order.length])
    .find((id) => next.turnsUsed[id] < config.turnsPerPlayer) ?? actor;
  if (Object.values(next.turnsUsed).every((value) => value >= config.turnsPerPlayer)) next.phase = 'round-end';
  return next;
}

function exchangeSeal(state, action, config) {
  if (state.pendingDie) fail(ERROR_CODES.PENDING_ACTION, '必须先完成当前取骰行动');
  const actor = actorOf(state, action.actor);
  if (actor !== state.activePlayer) fail(ERROR_CODES.NOT_ACTIVE_PLAYER, '不是该玩家的回合');
  if (![1, 2].includes(action.amount)) fail(ERROR_CODES.INVALID_AMOUNT, '只能兑换 1 或 2 枚印章');
  const player = state.players[actor];
  if (player.resources.seal < action.amount) fail(ERROR_CODES.INSUFFICIENT_SEALS, '印章不足');
  const next = deepClone(state);
  next.players[actor].resources.seal -= action.amount;
  if (action.amount === 1) {
    next.players[actor].resources.coin += 1;
  } else {
    if (!RESOURCE_NAMES.includes(action.resource)) fail(ERROR_CODES.INVALID_RESOURCE, '兑换资源无效');
    next.players[actor].resources[action.resource] = Math.min(
      config.resourceLimit,
      next.players[actor].resources[action.resource] + 1,
    );
  }
  return next;
}

export function replaceCurrentCardWithLantern(player, nextCard) {
  if (!player || !nextCard) fail(ERROR_CODES.INVALID_ACTION, '牌置换参数无效');
  const next = deepClone(player);
  if (next.currentCard) next.lanternCards.push(next.currentCard);
  next.currentCard = deepClone(nextCard);
  return next;
}

export function createPosition(input = {}, options = {}) {
  const config = configDefaults(input);
  if (config.playerCount !== 2) fail(ERROR_CODES.DATA_UNVERIFIED, '当前核心只开放两人局');
  const setup = config.setup ?? {};
  const playerIds = ['0', '1'];
  const playerSource = config.players ?? setup.players ?? [];
  const players = Object.fromEntries(playerIds.map((id, index) => [id, normalizePlayer(id, playerSource[index])]));
  Object.values(players).forEach((player) => assertResourceBounds(player.resources, config));
  const seed = String(options.seed ?? config.seed ?? 'whitecastle-core-v1');
  const bridgeSource = config.bridges ?? setup.bridges ?? seededDice(seed);
  const bridges = bridgeSource.length
    ? bridgeSource.map(normalizeBridge)
    : Array.from({ length: config.bridgeCount }, (_, index) => normalizeBridge({}, index));
  validateBridges(bridges);
  const activePlayer = String(config.initialPlayer ?? setup.initialPlayer ?? '0');
  const playOrder = deepClone(setup.playOrder ?? ['0', '1']);
  if (!players[activePlayer] || !Array.isArray(playOrder)
    || playOrder.length !== 2 || new Set(playOrder).size !== 2 || playOrder.some((id) => !players[id])) {
    fail(ERROR_CODES.INVALID_STATE, '初始行动顺序无效');
  }
  for (const player of Object.values(players)) {
    for (const type of FIGURE_NAMES) {
      if (!Array.isArray(player.figures[type]) || player.figures[type].length > 5) fail(ERROR_CODES.INVALID_STATE, '人员数据无效');
    }
  }
  return {
    schemaVersion: ENGINE_SCHEMA_VERSION,
    configSignature: canonicalCatalog(input),
    mode: 'core-incomplete',
    seed,
    round: 1,
    phase: 'action',
    activePlayer,
    playOrder,
    turnsUsed: { '0': 0, '1': 0 },
    bridges,
    placements: buildPlacements(config, playerIds),
    castleRooms: deepClone(setup.castleRooms ?? []),
    castleDecks: deepClone(setup.castleDecks ?? {}),
    topCardId: setup.topCardId ?? null,
    topSlots: deepClone(setup.topSlots ?? {}),
    timeSequence: setup.timeSequence ?? 0,
    players,
    pendingDie: null,
    score: null,
    dataStatus: {
      complete: false,
      reason: '未核验的卡牌、板块、花园、训练场和时间轨数据不会自动补齐',
    },
  };
}

export function applyAction(state, action, input = {}) {
  validateState(state);
  assertConfigMatch(state, input);
  const config = configDefaults(input);
  Object.values(state.players).forEach((player) => assertResourceBounds(player.resources, config));
  const normalized = deepClone(action ?? {});
  if (state.phase !== 'action') fail(ERROR_CODES.ROUND_END_UNIMPLEMENTED, '轮末行动尚未实现');
  switch (normalized.type) {
    case 'placeDie': return placeDie(takeDie(state, normalized, config), normalized, config);
    case 'exchangeSeal': return exchangeSeal(state, normalized, config);
    default: fail(ERROR_CODES.INVALID_ACTION, `未支持动作：${normalized.type}`);
  }
}

export function resolveGardenReward(state, actor, cardId, action = {}, input = {}) {
  validateState(state);
  assertConfigMatch(state, input);
  const config = configDefaults(input);
  if (!['round-end', 'round-gardens'].includes(state.phase)) {
    fail(ERROR_CODES.INVALID_ACTION, '只有轮末可以结算花园奖励');
  }
  const id = actorOf(state, actor);
  if (id !== state.activePlayer) fail(ERROR_CODES.NOT_ACTIVE_PLAYER, '应按轮末行动顺序结算花园');
  const card = cardByReference(cardId, config);
  if (!['plant', 'stone'].includes(card.kind) || card.fields?.length !== 1
    || !state.players[id].figures.gardener.some((figure) => figure.cardId === cardId)) {
    fail(ERROR_CODES.TARGET_NOT_ALLOWED, '玩家没有部署在该花园');
  }
  const next = deepClone(state);
  const choices = { values: action.choices ?? [], used: 0 };
  const context = {
    state: next, actor: id,
    decisions: action.decisions ?? [], decisionIndex: 0,
    effectOrders: action.effectOrders ?? [], orderIndex: 0,
    domainRows: new Set(),
    interactive: action.interactive === true,
  };
  if (!Array.isArray(choices.values) || !Array.isArray(context.decisions)
    || context.decisions.some((item) => !item || typeof item !== 'object')
    || !Array.isArray(context.effectOrders)) fail(ERROR_CODES.INVALID_ACTION, '花园奖励决策必须是数组');
  next.players[id] = executeField(next.players[id], card.fields[0], config, choices, 0, context);
  if (choices.used !== choices.values.length || context.decisionIndex !== context.decisions.length
    || context.effectOrders.length > context.orderIndex) fail(ERROR_CODES.INVALID_ACTION, '存在多余花园奖励决策');
  return next;
}

function locationOf(figure) {
  return typeof figure === 'string' ? figure : figure?.location;
}

function resourceScore(value) {
  return value >= 7 ? 2 : value >= 3 ? 1 : 0;
}

export function score(state, input = {}) {
  validateState(state);
  assertConfigMatch(state, input);
  const config = configDefaults(input);
  const missing = [];
  const players = {};
  for (const [id, player] of Object.entries(state.players)) {
    assertResourceBounds(player.resources, config);
    const resources = player.resources;
    const parts = {
      points: resources.points,
      coinAndSeal: Math.floor((resources.coin + resources.seal) / 5),
      resources: RESOURCE_NAMES.reduce((sum, name) => sum + resourceScore(resources[name]), 0),
      courtier: 0,
      warrior: 0,
      gardener: 0,
      time: 0,
    };
    let internal = 0;
    for (const figure of player.figures.courtier) {
      const location = locationOf(figure);
      if (!Object.hasOwn(LOCATION_VALUES, location)) missing.push(`courtier:${id}`);
      else {
        parts.courtier += LOCATION_VALUES[location];
        if (location !== 'gate') internal += 1;
      }
    }
    for (const figure of player.figures.warrior) {
      const yard = config.trainingZones?.find((item) => item.id === figure?.yardId)
        ?? config.setup?.trainingYards?.find((item) => item.id === figure?.yardId);
      const value = yard?.verification === 'confirmed' ? yard.value : null;
      if (!Number.isSafeInteger(value) || value < 0) missing.push(`warrior:${id}`);
      else parts.warrior += value * internal;
    }
    for (const figure of player.figures.gardener) {
      const card = config.cards?.find((item) => item.id === figure?.cardId);
      if (card?.verification !== 'confirmed' || !['plant', 'stone'].includes(card.kind)
        || !Number.isSafeInteger(card.victoryPoints) || card.victoryPoints < 0) {
        missing.push(`gardener:${id}`);
      } else {
        parts.gardener += card.victoryPoints;
      }
    }
    if (player.timePosition !== 0) {
      const time = config.timeTrack?.[player.timePosition];
      if (!Number.isInteger(time)) missing.push(`timeTrack:${id}`);
      else parts.time += time;
    }
    const total = Object.values(parts).reduce((sum, value) => sum + value, 0);
    players[id] = { total, parts, missing: [...new Set(missing.filter((key) => key.endsWith(`:${id}`)))] };
  }
  const order = Object.entries(state.players)
    .sort(([, left], [, right]) => (left.finalOrder ?? Infinity) - (right.finalOrder ?? Infinity))
    .map(([id]) => id);
  const max = Math.max(...Object.values(players).map((item) => item.total));
  const tied = order.filter((id) => players[id].total === max);
  if (tied.length > 1) {
    const positions = tied.map((id) => state.players[id].finalOrder);
    if (positions.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1)
      || new Set(positions).size !== positions.length) missing.push('finalOrder');
  }
  return {
    complete: missing.length === 0,
    missing: [...new Set(missing)],
    players,
    order,
    winner: missing.length === 0 ? tied[0] : null,
  };
}
