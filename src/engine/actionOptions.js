import { applyLocalAction, activeLocalPlayer, remainingRoundGardens } from './localMatch.js';
import { castleFields } from './cardRules.js';

const RESOURCES = ['food', 'iron', 'pearl'];
const ACTIONS = ['domain', 'castleAny', 'castleLight', 'castleCoral', 'castleBlack', 'castleWhite'];
const clone = (value) => structuredClone(value);
const affordable = (player, costs = []) => costs.every((cost) => player.resources[cost.type] >= cost.amount);
const option = (value, meta = {}) => ({ value, ...meta });

function permutations(values) {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map((rest) => [value, ...rest]));
}

function decisionOptions(request, match) {
  const { type, player, state } = request;
  const config = match.config;
  if (request.options) return request.options.map((value) => option(value));
  if (type === 'outside') return request.actions.map((action) => option({ type, action }));
  if (type === 'castleOrder') return permutations(request.fields.map((field) => field.id))
    .map((fieldIds) => option({ type, fieldIds }));
  if (type === 'gardener') {
    const available = player.figures.gardener.length < 5 ? config.setup.gardens
      .filter((garden) => !player.figures.gardener.some((figure) => figure.cardId === garden.cardId))
      .filter((garden) => config.cards.find((card) => card.id === garden.cardId)?.foodCost <= player.resources.food) : [];
    return [
      ...available.map((garden) => option({ type, cardId: garden.cardId })),
      option({ type, skip: true }),
    ];
  }
  if (type === 'warrior') {
    const yards = player.figures.warrior.length < 5 ? config.setup.trainingYards
      .filter((yard) => config.trainingZones.find((zone) => zone.id === yard.id)?.ironCost <= player.resources.iron) : [];
    return [
      ...yards.flatMap((yard) => permutations(yard.faceIds).map((faceOrder) => option({ type, yardId: yard.id, faceOrder }))),
      option({ type, skip: true }),
    ];
  }
  if (type === 'domain') return [
    ...config.personalDomainRows.filter((row) => !request.domainRows?.includes(row.id))
      .map((row) => option({ type, row: row.id })),
    option({ type, skip: true }),
  ];
  if (ACTIONS.includes(type)) {
    const colors = { castleCoral: 'coral', castleBlack: 'black', castleWhite: 'white' };
    const options = (state.castleRooms ?? []).filter((room) => room.cardId).flatMap((room) => {
      const card = config.cards.find((item) => item.id === room.cardId);
      return (card?.fields ?? []).filter((field) => affordable(player, field.cost))
        .filter((field) => type === 'castleLight' ? field.tone === 'light'
          : room.tiles.some((tile) => tile.fieldId === field.id && (type === 'castleAny' || tile.color === colors[type])))
        .map((field) => option({ type, roomId: room.id, fieldId: field.id }, { cardId: card.id }));
    });
    return [...options, option({ type, skip: true })];
  }
  return [];
}

/** 用原子规则引擎试走，得到下一项未完成选择；试走不改变实际对局。 */
export function probeLocalAction(match, source) {
  const action = clone(source);
  action.choices ??= [];
  action.decisions ??= [];
  action.effectOrders ??= [];
  action.interactive = true;
  try {
    return { status: 'ready', action, preview: applyLocalAction(match, action) };
  } catch (error) {
    if (error.code !== 'CHOICE_REQUIRED') return { status: 'invalid', code: error.code ?? 'INVALID_ACTION', action };
    let request = error.details;
    if (!request && match.phase === 'draft') {
      request = { type: 'chooseResource', index: action.choices.length };
    }
    if (!request) return { status: 'invalid', code: 'INVALID_ACTION', action };
    let options = [];
    if (request.type === 'chooseResource') {
      options = RESOURCES.map((value) => option(value));
    } else if (request.type !== 'effectOrder') {
      options = decisionOptions(request, match);
      if (request.type === 'field') options = options.filter(({ value }) => value.skip || affordable(request.player, request.field.cost));
    }
    return { status: 'choice', action, request, options };
  }
}

export function chooseActionOption(probe, value) {
  if (probe.status !== 'choice') throw new Error('INVALID_CHOICE');
  const action = clone(probe.action);
  const { type, index } = probe.request;
  if (type === 'chooseResource') action.choices[index] = value;
  else if (type === 'effectOrder') action.effectOrders[index] = value;
  else action.decisions[index] = clone(value);
  return action;
}

/** 棋盘放置候选只过滤当前骰色、容量及先付金币；后续子行动继续由同一引擎验证。 */
export function placementOptions(match, bridgeId, side) {
  if (match.phase !== 'playing') return [];
  const state = match.state;
  const actor = activeLocalPlayer(match);
  const bridge = state.bridges.find((item) => item.id === bridgeId);
  if (!bridge?.dice.length || !['left', 'right'].includes(side)
    || bridge.dice.length === 1 && bridge.singleDieEndpoint !== side) return [];
  const die = bridge.dice[side === 'left' ? 0 : bridge.dice.length - 1];
  return Object.values(state.placements).filter((place) => (
    (place.capacity === null || place.dice.length < place.capacity)
    && (place.owner === undefined || place.owner === actor)
    && die.value - place.comparisonValue + state.players[actor].resources.coin >= 0
  )).filter((place) => {
    if (place.area === 'personal') return match.config.personalDomainRows.find((row) => row.id === place.row)?.dieColor === bridge.color;
    if (place.area === 'castle') {
      const room = state.castleRooms.find((item) => `castle:${item.id}` === place.id);
      const card = match.config.cards.find((item) => item.id === room?.cardId);
      return card && castleFields(card, room.tiles, bridge.color).length > 0;
    }
    return true;
  }).map((place) => ({
    placementId: place.id, delta: die.value - place.comparisonValue,
    action: {
      type: 'placeDie', actor, bridgeId, side,
      target: place.area === 'personal' ? { area: 'personal', row: place.row }
        : place.area === 'well' ? { area: 'well' } : { area: place.area, id: place.id.split(':').slice(1).join(':') },
    },
  }));
}

export function roundGardenOptions(match) {
  return remainingRoundGardens(match).map((cardId) => ({
    type: 'roundGarden', actor: activeLocalPlayer(match), cardId,
  }));
}
