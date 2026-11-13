import { cardOf, ROWS } from './features.js';
import { expandLanternEffects, lanternBacks } from './lanternEffects.js';
import { personalField } from '../engine/cardRules.js';
import { highScoreStructure } from './highScore.js';

/** 攻略只提供可调整的软偏好，不改变规则或终局胜负。 */
export function heuristicScore(env, option, weights) {
  const { match, probe } = env;
  const state = probe?.request?.state ?? match.state;
  const player = probe?.request?.player ?? state?.players[env.actor] ?? match.draft.players[env.actor];
  const round = state?.round ?? 1;
  const stage = weights.rounds[Math.max(0, round - 1)];
  const highScore = weights.highScore;
  const value = option.value;
  const object = typeof value === 'object' && value !== null ? value : {};
  const action = option.action;
  const asset = (type) => {
    if (type === 'food' && (player?.figures?.gardener.length ?? 0) >= 5) return 0.1;
    if (highScore && ROWS.includes(type)) {
      const figures = player?.figures?.[type] ?? [];
      if (type !== 'courtier' && figures.length >= 5) return 0;
      const r = player?.resources ?? {};
      const structure = highScoreStructure(player, match.config);
      if (type === 'courtier') {
        const canEnter = figures.length < 5 && r.coin >= 2;
        const canPromote = figures.some((figure) => figure.location !== 'floor3') && r.pearl >= 2;
        if (!canEnter && !canPromote) return 0;
        return stage.courtier * (r.pearl >= 2 ? 1 : 0.35)
          + (r.pearl >= 2 ? structure.warriorValue + 3 : 0);
      }
      if (type === 'warrior') {
        if (r.iron < 1 && r.seal < 2) return 0;
        return stage.warrior * (structure.internal ? 1 : 0.3) + structure.internal;
      }
      const affordable = match.config.setup.gardens.some((garden) =>
        !figures.some((figure) => figure.cardId === garden.cardId) && cardOf(match, garden.cardId).foodCost <= r.food);
      return affordable ? stage.gardener : 0;
    }
    const amount = player?.resources?.[type] ?? 0;
    return (stage[type] ?? weights.effect[type] ?? 0) * (amount >= 7 && ['food', 'iron', 'pearl'].includes(type) ? 0.1 : 1);
  };
  const backs = lanternBacks(match, player);
  // 灯笼图标换成牌背具体收益；空灯笼区不再按固定占位分计价。
  const effects = (items = []) => expandLanternEffects(items, backs)
    .filter((effect) => effect.type !== 'lantern')
    .reduce((sum, effect) => sum + asset(effect.type) * effect.amount, 0);
  const field = (item) => highScore && item?.cost?.some((cost) => (player?.resources?.[cost.type] ?? 0) < cost.amount)
    ? -3 : effects(item?.effects) - effects(item?.cost) * 0.6;
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
    const remaining = Math.max(0, (3 - round) * 3 + 3 - (state.turnsUsed?.[env.actor] ?? 0));
    const projected = highScore ? Math.min(5, internal + (5 - internal)
      * highScore.futureCourtierFraction * remaining / 9) : internal;
    result += stage.warrior + zone.value * projected * weights.points - zone.ironCost * asset('iron') * 0.5;
    for (const id of object.faceOrder) result += field(match.config.yardFaces.find((face) => face.id === id));
  }
  if (object.type === 'courtier' && !object.skip) {
    result += object.audience ? stage.courtier - asset('coin') : 0;
    result += object.promote ? stage.courtier + object.promote.steps * 2.5
      - (object.promote.steps === 2 ? 5 : 2) * asset('pearl') * 0.5 : 0;
    if (highScore && object.promote) {
      const from = ['gate', 'floor1', 'floor2', 'floor3'].indexOf(player.figures.courtier[object.promote.figureIndex]?.location ?? 'gate');
      const to = from + object.promote.steps;
      const marginal = [1, 3, 6, 10][to] - [1, 3, 6, 10][from]
        + (from === 0 ? highScoreStructure(player, match.config).warriorValue : 0);
      result += marginal * highScore.marginalScore;
      if (to === 3) {
        result += effects([{ type: 'lantern', amount: 1 }]);
        result += field(cardOf(match, state.topCardId)?.fields.find((item) => item.id === object.promote.slotId));
      } else {
        const room = state.castleRooms.find((item) => item.id === object.promote.roomId);
        result += field(cardOf(match, room?.cardId)?.fields.find((item) => item.id === object.promote.fieldId));
      }
    }
  }
  if (['domain', 'castleAny', 'castleLight', 'castleCoral', 'castleBlack', 'castleWhite'].includes(object.type) && !object.skip) {
    if (object.type === 'domain') {
      const current = cardOf(match, player.currentCard);
      const row = match.config.personalDomainRows.find((item) => item.id === object.row);
      const count = player.figures[row.figureType].length;
      result += field(personalField(current, object.row))
        + effects([row.baseGain, ...row.revealedGains.slice(0, count)]) + weights.chain;
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
      const row = match.config.personalDomainRows.find((item) => item.id === action.target.row);
      result += field(personalField(cardOf(match, player.currentCard), action.target.row))
        + effects([row.baseGain, ...row.revealedGains.slice(0, player.figures[row.figureType].length)]) + weights.chain;
    }
    if (action.target.area === 'outside') result += highScore
      ? Math.max(...(action.target.id === 'left' ? ['courtier', 'gardener'] : ['courtier', 'warrior']).map(asset))
      : Math.max(stage.courtier, stage.gardener, stage.warrior);
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
