import { castleFields, personalField } from '../engine/cardRules.js';

const LIMITED = ['food', 'iron', 'pearl'];

function cardOf(match, id) {
  return match.config.cards.find((card) => card.id === (id?.id ?? id));
}

/** 当前灯笼区牌背；没有牌背时触发灯笼不会凭空产生收益。 */
export function lanternBacks(match, player) {
  return (player?.lanternCards ?? player?.lanternCardIds ?? [])
    .flatMap((id) => cardOf(match, id)?.back ?? []);
}

/**
 * 把灯笼图标展开成牌背具体收益，并保留灯笼次数。
 * 牌背自身再含灯笼时只展开有限层，避免互相引用。
 */
export function expandLanternEffects(effects = [], backs = [], depth = 0) {
  const expanded = [];
  for (const effect of effects ?? []) {
    if (!effect?.type || !Number.isFinite(effect.amount) || effect.amount < 1) continue;
    if (effect.type === 'lantern' && depth < 4) {
      for (let count = 0; count < effect.amount; count += 1) {
        expanded.push(...expandLanternEffects(backs, backs, depth + 1).filter((item) => item.type !== 'lantern'));
      }
    }
    expanded.push({ type: effect.type, amount: effect.amount });
  }
  return expanded;
}

function actorOf(env) {
  return env.probe?.request?.player ?? env.match.state?.players?.[env.actor] ?? env.match.draft?.players?.[env.actor];
}

function printedEffects(env, option) {
  const { match, probe } = env;
  const value = option.value;
  const action = option.action;
  const object = typeof value === 'object' && value !== null ? value : {};
  if (object.skip) return [];
  if (option.orderIndex !== undefined) return [];
  const effects = [];
  const player = actorOf(env);
  if (object.type === 'field') effects.push(...(probe?.request?.field?.effects ?? []));
  if (object.type === 'gardener' && object.cardId) {
    effects.push(...(cardOf(match, object.cardId)?.fields?.[0]?.effects ?? []));
  }
  if (object.type === 'warrior' && object.faceOrder) {
    for (const id of object.faceOrder) effects.push(...(match.config.yardFaces.find((face) => face.id === id)?.effects ?? []));
  }
  if (action?.type !== 'placeDie') return effects;
  const bridge = match.state.bridges.find((item) => item.id === action.bridgeId);
  if (action.target.area === 'castle') {
    const room = match.state.castleRooms.find((item) => item.id === action.target.id);
    const card = cardOf(match, room?.cardId);
    if (card && room) {
      try {
        for (const field of castleFields(card, room.tiles, bridge.color)) effects.push(...(field.effects ?? []));
      } catch { /* 未核验房间不计入灯笼收益。 */ }
    }
  } else if (action.target.area === 'personal') {
    const current = cardOf(match, player?.currentCard);
    if (current) {
      try { effects.push(...(personalField(current, action.target.row)?.effects ?? [])); } catch { /* 布局无效时不猜测。 */ }
    }
    const row = match.config.personalDomainRows.find((item) => item.id === action.target.row);
    const count = player?.figures?.[row?.figureType]?.length ?? 0;
    if (row) effects.push(row.baseGain, ...(row.revealedGains ?? []).slice(0, count));
  } else if (action.target.area === 'well') {
    effects.push(...(match.config.setup.wellRewards ?? match.config.wellRewards ?? []));
  }
  return effects.filter(Boolean);
}

function applyLimited(resources, type, amount, config) {
  const limit = type === 'seal' ? (config.sealLimit ?? 5)
    : LIMITED.includes(type) ? (config.resourceLimit ?? 7) : Infinity;
  const current = resources[type] ?? 0;
  const taken = Math.max(0, Math.min(amount, limit - current));
  if (taken > 0) resources[type] = current + taken;
  return taken;
}

/** 先结算桥左端灯笼，再计算行动印出的额外灯笼实际进账。已满的铁、食物、珍珠母和印章不计。 */
export function cardLanternMarginalGains(env, option) {
  const player = actorOf(env);
  const config = env.match.config;
  const resources = { ...(player?.resources ?? {}) };
  const backs = lanternBacks(env.match, player);
  if (option.action?.side === 'left') {
    for (const effect of expandLanternEffects([{ type: 'lantern', amount: 1 }], backs)) {
      if (effect.type === 'lantern' || effect.type === 'influence') continue;
      applyLimited(resources, effect.type, effect.amount, config);
    }
  }
  const gained = [];
  for (const effect of expandLanternEffects(printedEffects(env, option).filter((item) => item.type === 'lantern'), backs)) {
    if (effect.type === 'lantern') continue;
    if (effect.type === 'influence') {
      gained.push(effect);
      continue;
    }
    const taken = applyLimited(resources, effect.type, effect.amount, config);
    if (taken > 0) gained.push({ type: effect.type, amount: taken });
  }
  return gained;
}

function assetWeight(type, resources, weights, round) {
  const stage = weights.rounds[Math.max(0, (round ?? 1) - 1)] ?? {};
  const weight = stage[type] ?? weights.effect?.[type] ?? 0;
  const capped = (resources?.[type] ?? 0) >= 7 && LIMITED.includes(type);
  return weight * (capped ? 0.1 : 1);
}

/** 旧检查点没把灯笼牌背乘进候选；这里把额外灯笼的具体收益加进策略对数。 */
export const LANTERN_POLICY_SCALE = 2;

export function adjustPolicyForLantern(policy, env, weights) {
  const options = env.getLegalActions();
  if (!Array.isArray(policy) || policy.length !== options.length) {
    throw Object.assign(new Error('AI_INVALID_POLICY'), { code: 'AI_INVALID_POLICY' });
  }
  const round = (env.probe?.request?.state ?? env.match.state)?.round ?? 1;
  const bonuses = options.map((option) => cardLanternMarginalGains(env, option)
    .reduce((sum, effect) => sum + assetWeight(effect.type, actorOf(env)?.resources, weights, round) * effect.amount, 0));
  const logits = policy.map((value, index) => Math.log(Math.max(value, 1e-12)) + LANTERN_POLICY_SCALE * bonuses[index]);
  const peak = Math.max(...logits);
  const exponent = logits.map((value) => Math.exp(value - peak));
  const total = exponent.reduce((sum, value) => sum + value, 0);
  return exponent.map((value) => value / total);
}
