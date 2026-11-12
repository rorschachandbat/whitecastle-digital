import { text, StringTable } from './StringTable.js';
import { applyLocalAction, createLocalMatch } from '../engine/localMatch.js';
import { probeLocalAction } from '../engine/actionOptions.js';

const effectName = (type) => text(`editor.effect.${type}`);
const effects = (items = []) => items.length
  ? items.map((item) => `${effectName(item.type)} ×${item.amount}`).join(' · ')
  : text('play.none');
const fieldName = (id) => StringTable[`play.field.${id}`] ? text(`play.field.${id}`) : id;
const cardOf = (config, id) => config.cards.find((card) => card.id === id);
const faceOf = (config, id) => config.yardFaces.find((face) => face.id === id);

function cardLabel(config, id) {
  const card = cardOf(config, id) ?? faceOf(config, id);
  if (!card) return text('play.none');
  if (card.kind && StringTable[`editor.kind.${card.kind}`]) {
    const parts = [text(`editor.kind.${card.kind}`)];
    if (Number.isInteger(card.foodCost)) parts.push(text('play.gardenCost', { cost: card.foodCost, points: card.victoryPoints ?? 0 }));
    if (card.initialGains?.length) parts.push(effects(card.initialGains));
    else if (card.fields?.[0]?.effects?.length) parts.push(effects(card.fields[0].effects));
    else if (card.back?.length) parts.push(effects(card.back));
    return parts.join(' · ');
  }
  if (card.tone) return `${text(card.tone === 'resource' ? 'play.gold' : 'play.silver')} · ${effects(card.effects)}`;
  return text('play.none');
}

function roomName(config, id) {
  const room = config.setup?.castleRooms?.find((item) => item.id === id);
  return room ? text('play.room', { floor: room.floor, n: id.split('-').at(-1) }) : id;
}

function targetName(config, target) {
  if (!target) return text('play.none');
  if (target.area === 'well') return text('play.well');
  if (target.area === 'personal') return text(`editor.row.${target.row}`);
  if (target.area === 'outside') return text(`play.outside.${target.id}`);
  if (target.area === 'castle') return roomName(config, target.id);
  return text('play.none');
}

function exchangeText(value) {
  return text(value.resource ? 'play.story.exchangeResource' : 'play.story.exchangeCoin', {
    amount: value.amount, name: value.resource ? effectName(value.resource) : effectName('coin'),
  });
}

function describeDecision(config, request, value) {
  if (value?.type === 'exchangeSeal') return exchangeText(value);
  if (request.type === 'field' || value?.type === 'field') {
    const field = request.field;
    const where = field?.effects?.length ? effects(field.effects) : fieldName(value.fieldId);
    const cost = field?.cost?.length ? effects(field.cost) : text('play.free');
    return text(value.skip ? 'play.story.fieldSkip' : 'play.story.fieldExecute', { field: fieldName(value.fieldId), effects: where, cost });
  }
  if (value?.skip) return text('play.story.skip', { name: text(`play.prompt.${value.type}`) });
  if (value?.type === 'gardener') return text('play.story.gardener', { name: cardLabel(config, value.cardId) });
  if (value?.type === 'warrior') {
    const zone = config.trainingZones.find((item) => item.id === value.yardId);
    return text('play.story.warrior', {
      yard: text('play.yard', { cost: zone?.ironCost ?? 0 }),
      faces: value.faceOrder.map((id) => cardLabel(config, id)).join(' → '),
    });
  }
  if (value?.type === 'courtier') {
    const parts = [];
    if (value.audience) parts.push(text('play.audience'));
    if (value.promote) {
      const promotion = value.promote;
      const target = promotion.roomId
        ? `${roomName(config, promotion.roomId)} · ${fieldName(promotion.fieldId)}`
        : text('play.slot', { slot: promotion.slotId ? text(`play.slot.${promotion.slotId}`) : text('play.none') });
      parts.push(text('play.promote', { n: promotion.figureIndex + 1, steps: promotion.steps, target }));
    }
    if (value.order) parts.push(text(value.order[0] === 'promote' ? 'play.orderPromoteFirst' : 'play.orderAudienceFirst'));
    return parts.join(' · ') || text('play.story.skip', { name: text('play.prompt.courtier') });
  }
  if (value?.type === 'outside') return text('play.story.outside', { name: effectName(value.action) });
  if (value?.type === 'domain') return text('play.story.domain', { name: effectName(value.row) });
  if (value?.type === 'influence') return value.pay ? text('play.payGate', { cost: request.gate?.cost ?? 0 }) : text('play.stopGate');
  if (value?.type === 'castleOrder') return text('play.story.order', { order: value.fieldIds.map(fieldName).join(' → ') });
  if (value?.roomId) {
    const room = request.state?.castleRooms?.find((item) => item.id === value.roomId);
    const field = cardOf(config, room?.cardId)?.fields?.find((item) => item.id === value.fieldId);
    return text('play.story.castle', {
      room: roomName(config, value.roomId), field: fieldName(value.fieldId), effects: effects(field?.effects),
    });
  }
  return text('play.story.other', { name: text(`play.prompt.${request.type}`) });
}

function decisionLines(before, action) {
  const partial = structuredClone(action);
  partial.choices = [];
  partial.decisions = [];
  partial.effectOrders = [];
  partial.interactive = true;
  const lines = [];
  for (let guard = 0; guard < 40; guard += 1) {
    const probe = probeLocalAction(before, partial);
    if (probe.status !== 'choice') break;
    const request = probe.request;
    if (request.type === 'chooseResource') {
      const value = action.choices?.[request.index];
      if (typeof value !== 'string') break;
      lines.push(text('play.story.resource', { name: effectName(value) }));
      partial.choices[request.index] = value;
    } else if (request.type === 'effectOrder') {
      const order = action.effectOrders?.[request.index];
      if (!Array.isArray(order)) break;
      lines.push(text('play.story.order', { order: order.map((index) => effects([request.effects[index]])).join(' → ') }));
      partial.effectOrders[request.index] = order;
    } else {
      const value = action.decisions?.[request.index];
      if (!value) break;
      lines.push(describeDecision(before.config, request, value));
      partial.decisions[request.index] = structuredClone(value);
    }
  }
  return lines;
}

function titleOf(before, action) {
  const config = before.config;
  if (action.type === 'chooseStartingPair') {
    const pair = before.draft.pairs.find((item) => item.id === action.pairId);
    return text('play.story.draft', {
      resource: cardLabel(config, pair?.resourceId), action: cardLabel(config, pair?.actionId),
    });
  }
  if (action.type === 'exchangeSeal') return exchangeText(action);
  if (action.type === 'roundGarden') return text('play.story.garden', { name: cardLabel(config, action.cardId) });
  if (action.type === 'placeDie') {
    const bridge = before.state?.bridges?.find((item) => item.id === action.bridgeId);
    const die = bridge?.dice?.[action.side === 'left' ? 0 : bridge.dice.length - 1];
    const placementId = action.target?.area === 'personal'
      ? `personal:${action.actor}:${action.target.row}`
      : action.target?.area === 'well' ? 'well'
        : `${action.target?.area}:${action.target?.id}`;
    const comparison = before.state?.placements?.[placementId]?.comparisonValue;
    const delta = Number.isInteger(die?.value) && Number.isInteger(comparison) ? die.value - comparison : 0;
    return text('play.story.place', {
      color: text(`play.color.${bridge?.color ?? action.bridgeId}`),
      side: text(`play.${action.side}`),
      value: die?.value ?? text('play.none'),
      target: targetName(config, action.target),
      delta: delta > 0 ? text('play.story.deltaGain', { n: delta }) : delta < 0 ? text('play.story.deltaPay', { n: -delta }) : text('play.story.deltaEven'),
    });
  }
  return text('play.story.other', { name: action.type });
}

/** 用同一规则引擎重放每步之前的局面，生成右侧可读记录；失败时不打断页面。 */
export function describeMatch(match) {
  if (!match?.actions?.length) return [];
  try {
    let current = createLocalMatch(match.catalog, match.options);
    return match.actions.map((action) => {
      const entry = { actor: action.actor, title: titleOf(current, action), details: decisionLines(current, action) };
      current = applyLocalAction(current, action);
      return entry;
    });
  } catch {
    return [{ actor: null, title: text('play.story.unreadable'), details: [] }];
  }
}