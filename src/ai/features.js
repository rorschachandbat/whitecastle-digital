import { EFFECT_TYPES } from '../data/catalog.js';
import { personalField } from '../engine/cardRules.js';
import { expandLanternEffects, lanternBacks } from './lanternEffects.js';

export const FEATURE_VERSION = 'public-decisions-v3';
export const COLORS = ['coral', 'black', 'white'];
export const ASSETS = ['food', 'iron', 'pearl', 'coin', 'seal', 'points'];
export const ROWS = ['courtier', 'gardener', 'warrior'];
const ROOMS = ['floor1-1', 'floor1-2', 'floor1-3', 'floor2-1', 'floor2-2'];
const REQUESTS = ['root', 'chooseResource', 'effectOrder', 'outside', 'field', 'gardener', 'warrior',
  'courtier', 'domain', 'castleAny', 'castleLight', 'castleCoral', 'castleBlack', 'castleWhite',
  'castleOrder', 'influence', 'courtierDestination', 'topReward', 'warriorOrder'];
const oneHot = (values, value) => values.map((item) => Number(item === value));
export const cardOf = (match, id) => match.config.cards.find((item) => item.id === (id?.id ?? id));
export const effectsOf = (effects = []) => EFFECT_TYPES.map((type) =>
  effects.filter((effect) => effect.type === type).reduce((sum, effect) => sum + effect.amount, 0) / 5);
const costOf = (costs = []) => ASSETS.slice(0, 5).map((type) =>
  costs.filter((cost) => cost.type === type).reduce((sum, cost) => sum + cost.amount, 0) / 5);
const fieldOf = (field) => [...costOf(field?.cost), ...effectsOf(field?.effects)];
const rewardEffects = (env, effects, player) => env?.lanternExpansion === false ? (effects ?? [])
  : expandLanternEffects(effects, lanternBacks(env.match, player));

function encodePlayer(match, player) {
  const resources = ASSETS.map((key) => (player?.resources?.[key] ?? 0) / (key === 'points' ? 50 : 7));
  const figures = ROWS.map((key) => (player?.figures?.[key]?.length ?? 0) / 5);
  const courtier = ['gate', 'floor1', 'floor2', 'floor3'].map((key) =>
    (player?.figures?.courtier ?? []).filter((figure) => figure.location === key).length / 5);
  const warriors = [1, 3, 5].map((cost) =>
    (player?.figures?.warrior ?? []).filter((figure) => figure.yardId === `yard-cost-${cost}`).length / 5);
  const gardens = match.config.setup.gardens.map((garden) =>
    Number((player?.figures?.gardener ?? []).some((figure) => figure.cardId === garden.cardId)));
  const current = cardOf(match, player?.currentCard ?? player?.currentCardId);
  return [...resources, ...figures, ...courtier, ...warriors, ...gardens,
    (player?.timePosition ?? 0) / 20,
    ...effectsOf((player?.lanternCards ?? player?.lanternCardIds ?? []).flatMap((id) => cardOf(match, id)?.back ?? [])),
    ...ROWS.flatMap((row) => fieldOf(current ? personalField(current, row) : undefined))];
}

/** 只编码双方可见信息；不读取种子、未来骰子、补牌堆顺序或配置签名。 */
export function encodeState(env) {
  const { match, probe } = env;
  const actor = env.actor;
  const state = probe?.request?.state ?? match.state;
  const player = probe?.request?.player ?? state?.players?.[actor] ?? match.draft.players[actor];
  const other = actor === '0' ? '1' : '0';
  const opponent = state?.players?.[other] ?? match.draft.players[other];
  const values = [
    ...oneHot(['draft', 'playing', 'round-gardens', 'finished'], match.phase),
    (state?.round ?? 0) / 3,
    (state?.turnsUsed?.[actor] ?? 0) / 3, (state?.turnsUsed?.[actor === '0' ? '1' : '0'] ?? 0) / 3,
    Number(state?.playOrder?.[0] === actor),
    ...oneHot(REQUESTS, probe?.request?.type ?? 'root'),
    ...encodePlayer(match, player), ...encodePlayer(match, opponent),
  ];
  for (const color of COLORS) {
    const bridge = state?.bridges?.find((item) => item.color === color);
    values.push(...[0, 1, 2].map((index) => (bridge?.dice?.[index]?.value ?? 0) / 6),
      Number(bridge?.singleDieEndpoint === 'left'));
  }
  for (const roomId of ROOMS) {
    const room = state?.castleRooms?.find((item) => item.id === roomId)
      ?? match.config.setup.castleRooms.find((item) => item.id === roomId);
    const card = cardOf(match, room?.cardId);
    for (let index = 0; index < 3; index += 1) {
      const field = card?.fields?.[index];
      values.push(...fieldOf(field), ...oneHot(COLORS, room?.tiles?.find((tile) => tile.fieldId === field?.id)?.color),
        Number(field?.tone === 'dark'));
    }
    values.push((state?.placements?.[`castle:${roomId}`]?.dice?.length ?? 0) / 2);
  }
  for (const garden of match.config.setup.gardens) {
    const card = cardOf(match, garden.cardId);
    values.push((card?.foodCost ?? 0) / 5, (card?.victoryPoints ?? 0) / 10, ...fieldOf(card?.fields?.[0]),
      ...oneHot(COLORS, garden.bridgeId));
  }
  for (const yard of match.config.setup.trainingYards) {
    for (let index = 0; index < 2; index += 1) {
      values.push(...fieldOf(match.config.yardFaces.find((face) => face.id === yard.faceIds[index])));
    }
  }
  for (const owner of [actor, actor === '0' ? '1' : '0']) {
    for (const row of ROWS) values.push(state?.placements?.[`personal:${owner}:${row}`]?.dice?.length ?? 0);
  }
  for (const side of ['left', 'right']) values.push(state?.placements?.[`outside:${side}`]?.dice?.length ?? 0);
  values.push(...costOf(probe?.request?.field?.cost),
    ...effectsOf(rewardEffects(env, probe?.request?.field?.effects, player)),
    ...effectsOf(rewardEffects(env, probe?.request?.effects, player)));
  const top = cardOf(match, state?.topCardId ?? match.config.setup.topCardId);
  for (let index = 0; index < 3; index += 1) {
    const field = top?.fields[index];
    values.push(...fieldOf(field), Number(Boolean(state?.topSlots?.[field?.id])));
  }
  values.push(...effectsOf(match.config.setup.wellRewards),
    ...ROWS.map((row) => Number(Boolean(probe?.request?.domainRows?.includes(row)))),
    (probe?.request?.gate?.at ?? 0) / 20, (probe?.request?.gate?.cost ?? 0) / 5);
  values.push(...oneHot(COLORS, env.pending?.bridgeId), Number(env.pending?.side === 'left'),
    ...oneHot(['castle', 'outside', 'personal', 'well'], env.pending?.target?.area),
    ...oneHot(ROWS, env.pending?.target?.row),
    ...Array.from({ length: 20 }, (_, index) => ((env.orderPrefix ?? [])[index] ?? -1) / 20));
  // 增补公开细节；不读取剩余牌堆的身份或顺序，也不读取随机数状态。
  for (const owner of [actor, other]) {
    const person = owner === actor ? player : opponent;
    values.push(Number((person?.timePriority ?? 0) > (owner === actor ? opponent?.timePriority ?? 0 : player?.timePriority ?? 0)),
      ...[0, 1].map((rank) => Number(person?.finalOrder === rank)));
    for (let index = 0; index < 5; index += 1) {
      const figure = person?.figures?.courtier?.[index];
      values.push(Number(Boolean(figure)),
        ...oneHot(['gate', 'floor1', 'floor2', 'floor3'], figure?.location),
        ...oneHot(ROOMS, figure?.roomId),
        ...[0, 1, 2].map((slot) => Number(figure?.slotId === top?.fields?.[slot]?.id && Boolean(figure))));
    }
    for (const rowId of ROWS) {
      const row = match.config.personalDomainRows.find((item) => item.id === rowId);
      const count = person?.figures?.[row?.figureType]?.length ?? 0;
      values.push(...effectsOf(rewardEffects(env, person ? [row.baseGain, ...row.revealedGains.slice(0, count)] : [], person)));
    }
    for (const garden of match.config.setup.gardens) {
      values.push(Number(Boolean(match.roundGardens?.remaining?.[owner]?.includes(garden.cardId))));
    }
  }
  const places = [...ROOMS.map((id) => `castle:${id}`), 'outside:left', 'outside:right', 'well',
    ...[actor, other].flatMap((owner) => ROWS.map((row) => `personal:${owner}:${row}`))];
  for (const id of places) {
    const place = state?.placements?.[id];
    values.push((place?.comparisonValue ?? match.config.setup.placements[id]?.comparisonValue ?? 0) / 6,
      (place?.dice.length ?? 0) / 9);
    // 非水井格至多一骰；水井没有比较骰覆盖，数量足以表达占用。
    if (id !== 'well') {
      const die = place?.dice[0];
      values.push((die?.value ?? 0) / 6, ...oneHot(COLORS,
        state?.bridges?.find((bridge) => bridge.id === die?.sourceBridge)?.color ?? die?.color));
    }
  }
  for (const pair of match.draft.pairs) {
    const resource = cardOf(match, pair.resourceId);
    const action = cardOf(match, pair.actionId);
    values.push(Number(pair.chosenBy === null), Number(pair.chosenBy === actor), Number(pair.chosenBy === other),
      ...effectsOf(resource?.initialGains), ...effectsOf(resource?.back),
      ...effectsOf(cardOf(match, resource?.grantDecreeId)?.back),
      ...ROWS.flatMap((row) => fieldOf(action ? personalField(action, row) : undefined)));
  }
  values.push((state?.castleDecks?.steward?.length ?? match.config.setup.castleDecks.steward.length) / 9,
    (state?.castleDecks?.diplomat?.length ?? match.config.setup.castleDecks.diplomat.length) / 9,
    ...oneHot(ROOMS, env.pending?.target?.id));
  for (let index = 0; index < 20; index += 1) {
    values.push(...effectsOf(rewardEffects(env, probe?.request?.effects?.[index] ? [probe.request.effects[index]] : [], player)),
      Number((env.orderPrefix ?? []).includes(index)));
  }
  for (let index = 0; index < 3; index += 1) {
    const slot = top?.fields[index]?.id;
    const occupied = state?.topSlots?.[slot];
    values.push(Number(Boolean(occupied)), Number(occupied?.actor === actor),
      Number(occupied?.actor === other));
  }
  return values;
}

/** 按候选语义评分，数据修改后无需为每张牌重新分配固定输出节点。 */
export function encodeOption(env, option) {
  const { match, probe } = env;
  const value = option.value;
  const action = option.action;
  const object = typeof value === 'object' && value !== null ? value : {};
  const bridge = match.state?.bridges.find((item) => item.id === action?.bridgeId);
  const die = bridge?.dice[action?.side === 'left' ? 0 : bridge.dice.length - 1];
  const pair = match.draft.pairs.find((item) => item.id === action?.pairId);
  const garden = cardOf(match, action?.cardId ?? object.cardId);
  const yard = match.config.setup.trainingYards.find((item) => item.id === object.yardId);
  const fields = [];
  if (garden) fields.push(...(garden.fields ?? []));
  if (pair) {
    const resource = cardOf(match, pair.resourceId);
    fields.push({ effects: [...(resource?.initialGains ?? []), ...(resource?.back ?? [])] },
      ...(cardOf(match, pair.actionId)?.fields ?? []));
  }
  if (yard) fields.push(...(object.faceOrder ?? yard.faceIds).map((id) => match.config.yardFaces.find((face) => face.id === id)));
  const roomId = object.roomId ?? object.promote?.roomId ?? action?.target?.id;
  const room = (probe?.request?.state ?? match.state)?.castleRooms?.find((item) => item.id === roomId);
  const card = cardOf(match, room?.cardId);
  if (object.fieldId || object.promote?.fieldId) fields.push(card?.fields.find((field) => field.id === (object.fieldId ?? object.promote.fieldId)));
  else if (action?.target?.area === 'castle') {
    const matching = room?.tiles.filter((tile) => tile.color === bridge?.color).map((tile) => tile.fieldId) ?? [];
    fields.push(...(card?.fields ?? []).filter((field) => matching.includes(field.id)));
  }
  if (object.type === 'field') fields.push(probe.request.field);
  if (object.promote?.slotId) fields.push(cardOf(match, match.state?.topCardId)?.fields.find((field) => field.id === object.promote.slotId));
  if (object.type === 'domain' || action?.target?.area === 'personal') {
    const player = probe?.request?.player ?? match.state?.players[env.actor];
    const current = cardOf(match, player?.currentCard);
    const row = object.row ?? action?.target?.row;
    if (current && row) fields.push(personalField(current, row));
  }
  const orderedEffects = option.orderIndex === undefined ? [] : [probe.request.effects[option.orderIndex]];
  const promoted = (probe?.request?.player ?? match.state?.players[env.actor])
    ?.figures?.courtier?.[object.promote?.figureIndex];
  return [
    ...oneHot(['chooseStartingPair', 'placeDie', 'roundGarden', 'exchangeSeal'], action?.type),
    ...oneHot(REQUESTS, object.type ?? probe?.request?.type),
    ...oneHot(['food', 'iron', 'pearl'], typeof value === 'string' ? value : action?.resource ?? object.resource),
    ...oneHot(COLORS, bridge?.color), Number(action?.side === 'left'), (die?.value ?? 0) / 6,
    ...oneHot(['castle', 'outside', 'personal', 'well'], action?.target?.area),
    ...oneHot(ROWS, object.row ?? action?.target?.row), ...oneHot(ROOMS, roomId),
    Number(object.skip ?? false), Number(object.pay ?? false), Number(object.audience ?? false),
    (object.promote?.steps ?? 0) / 2, (object.promote?.figureIndex ?? -1) / 5,
    Number(object.order?.[0] === 'promote'),
    (action?.amount ?? object.amount ?? 0) / 2, (garden?.foodCost ?? 0) / 5, (garden?.victoryPoints ?? 0) / 10,
    yard ? (match.config.trainingZones.find((zone) => zone.id === yard.id)?.ironCost ?? 0) / 5 : 0,
    ...costOf(fields.flatMap((field) => field?.cost ?? [])),
    ...effectsOf(rewardEffects(env, [
      ...(action?.side === 'left' && env.lanternExpansion !== false ? [{ type: 'lantern', amount: 1 }] : []),
      ...fields.flatMap((field) => field?.effects ?? []), ...orderedEffects,
    ], probe?.request?.player ?? match.state?.players?.[env.actor])),
    ...[0, 1].flatMap((index) => effectsOf(rewardEffects(env,
      object.faceOrder ? match.config.yardFaces.find((face) => face.id === object.faceOrder[index])?.effects
        : object.fieldIds ? card?.fields.find((field) => field.id === object.fieldIds[index])?.effects : [],
      probe?.request?.player ?? match.state?.players?.[env.actor]))),
    ...Array.from({ length: 3 }, (_, index) =>
      ((probe?.request?.fields ?? []).findIndex((field) => field.id === object.fieldIds?.[index]) + 1) / 3),
    ...match.config.setup.gardens.map((item) => Number(item.cardId === (action?.cardId ?? object.cardId))),
    ...match.config.setup.trainingYards.map((item) => Number(item.id === object.yardId)),
    ...oneHot(['gate', 'floor1', 'floor2', 'floor3'], promoted?.location),
    ...oneHot(ROOMS, promoted?.roomId),
    ...effectsOf(card?.back), ...oneHot(['top', 'middle', 'bottom', 'upper', 'lower'], object.fieldId ?? object.promote?.fieldId),
  ];
}
