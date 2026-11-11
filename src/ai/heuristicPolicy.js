import { cardOf, ROWS } from './features.js';

/** 攻略只提供可调整的软偏好，不改变规则或终局胜负。 */
export function heuristicScore(env, option, weights) {
  const { match, probe } = env;
  const state = probe?.request?.state ?? match.state;
  const player = probe?.request?.player ?? state?.players[env.actor] ?? match.draft.players[env.actor];
  const round = state?.round ?? 1;
  const stage = weights.rounds[Math.max(0, round - 1)];
  const value = option.value;
  const object = typeof value === 'object' && value !== null ? value : {};
  const action = option.action;
  const asset = (type) => {
    if (type === 'food' && (player?.figures?.gardener.length ?? 0) >= 5) return 0.1;
    const amount = player?.resources?.[type] ?? 0;
    return (stage[type] ?? weights.effect[type] ?? 0) * (amount >= 7 && ['food', 'iron', 'pearl'].includes(type) ? 0.1 : 1);
  };
  const effects = (items = []) => items.reduce((sum, effect) => sum + asset(effect.type) * effect.amount, 0);
  const field = (item) => effects(item?.effects) - effects(item?.cost) * 0.6;
  let result = 0;
  if (typeof value === 'string') result += asset(value);
  if (object.skip) result -= weights.skipPenalty;
  if (object.pay) result += weights.payGate;
  if (object.type === 'field') result += object.skip ? 0 : field(probe.request.field);
  if (option.orderIndex !== undefined) {
    const effect = probe.request.effects[option.orderIndex];
    result += effects([effect]) + (ROWS.includes(effect.type) ? -2 : 1);
  }
  if (object.type === 'gardener' && !object.skip) {
    const card = cardOf(match, object.cardId);
    result += stage.gardener + card.victoryPoints * weights.points
      - card.foodCost * asset('food') * 0.5 + field(card.fields[0]);
  }
  if (object.type === 'warrior' && !object.skip) {
    const zone = match.config.trainingZones.find((item) => item.id === object.yardId);
    const internal = (player.figures.courtier ?? []).filter((item) => item.location !== 'gate').length;
    result += stage.warrior + zone.value * internal * weights.points - zone.ironCost * asset('iron') * 0.5;
    for (const id of object.faceOrder) result += field(match.config.yardFaces.find((face) => face.id === id));
  }
  if (object.type === 'courtier' && !object.skip) {
    result += object.audience ? stage.courtier - asset('coin') : 0;
    result += object.promote ? stage.courtier + object.promote.steps * 2.5
      - (object.promote.steps === 2 ? 5 : 2) * asset('pearl') * 0.5 : 0;
  }
  if (['domain', 'castleAny', 'castleLight', 'castleCoral', 'castleBlack', 'castleWhite'].includes(object.type) && !object.skip) {
    if (object.type === 'domain') {
      const current = cardOf(match, player.currentCard);
      result += effects(current?.fields.flatMap((item) => item.effects)) + weights.chain;
    } else {
      const room = state.castleRooms.find((item) => item.id === object.roomId);
      result += field(cardOf(match, room.cardId)?.fields.find((item) => item.id === object.fieldId)) + weights.chain;
    }
  }
  if (object.type === 'outside') result += stage[object.action] ?? 0;
  if (action?.type === 'chooseStartingPair') {
    const pair = match.draft.pairs.find((item) => item.id === action.pairId);
    const resource = cardOf(match, pair.resourceId);
    result += effects(resource.initialGains) + effects(resource.back) * weights.startLantern;
    result += effects(cardOf(match, pair.actionId).fields[0].effects);
  }
  if (action?.type === 'exchangeSeal' || object.type === 'exchangeSeal') result -= weights.exchangePenalty;
  if (action?.type === 'roundGarden') result += field(cardOf(match, action.cardId).fields[0]);
  if (action?.type === 'placeDie') {
    const bridge = match.state.bridges.find((item) => item.id === action.bridgeId);
    const die = bridge.dice[action.side === 'left' ? 0 : bridge.dice.length - 1];
    const key = action.target.area === 'personal' ? `personal:${env.actor}:${action.target.row}`
      : action.target.area === 'well' ? 'well' : `${action.target.area}:${action.target.id}`;
    result += (die.value - match.state.placements[key].comparisonValue) * asset('coin');
    if (action.side === 'left') result += effects(player.lanternCards.flatMap((id) => cardOf(match, id)?.back ?? []));
    if (action.target.area === 'castle') {
      const room = match.state.castleRooms.find((item) => item.id === action.target.id);
      for (const tile of room.tiles.filter((item) => item.color === bridge.color)) {
        result += field(cardOf(match, room.cardId).fields.find((item) => item.id === tile.fieldId));
      }
    }
    if (action.target.area === 'personal') {
      result += effects(cardOf(match, player.currentCard)?.fields.flatMap((item) => item.effects)) + weights.chain;
    }
    if (action.target.area === 'outside') result += Math.max(stage.courtier, stage.gardener, stage.warrior);
    if (action.target.area === 'well') result += weights.well;
    if (bridge.dice.length === 1 && round < 3) {
      const own = player.figures.gardener.filter((figure) => figure.bridgeId === bridge.id).length;
      const opponent = match.state.players[env.actor === '0' ? '1' : '0'].figures.gardener
        .filter((figure) => figure.bridgeId === bridge.id).length;
      result += (opponent - own) * weights.clearBridge;
    }
  }
  return result;
}

export function chooseHeuristic(scores) {
  return scores.reduce((best, value, index) => value > scores[best] ? index : best, 0);
}
