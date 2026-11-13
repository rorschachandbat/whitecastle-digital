import { canonicalCatalog } from '../data/catalog.js';
import { chooseStartingPair } from '../engine/startingDraft.js';
import { TrainingEnvironment } from '../ai/environment.js';
import { buildBgaDraftSetup } from './bgaTraining.js';
import { mapBgaDefinition } from './bgaReplay.js';

const ASSETS = ['food', 'iron', 'pearl', 'coin', 'seal', 'points'];
const equal = (a, b) => canonicalCatalog(a) === canonicalCatalog(b);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const one = (items, code = 'BGA_ADVICE_SETUP') => {
  if (items.length !== 1) fail(code);
  return items[0];
};
const inside = (item, container) => item.containers.includes(container);
const draftSessions = new WeakMap();
export const getDraftSession = (prepared) => draftSessions.get(prepared);

/** R-SETUP-04：只从公开选牌盘面生成主网络输入，不访问回放或网页内部状态。 */
export function prepareLiveAdvice(latest, { catalog, mapping, weights }) {
  if (!latest?.archive || latest.issues?.length || latest.source.gameAssetVersion !== mapping.gameAssetVersion
    || catalog.revision !== mapping.catalogRevision) fail('BGA_ADVICE_MAPPING');
  const p = latest.archive.publicPosition;
  const ownCards = (player, area) => p.cards.filter((card) => inside(card, `twc-${area}-card-stock-${player.platformId}`));
  const selected = p.players.filter((player) => ownCards(player, 'action').length);
  // 只有尚未放骰、所有人员仍在个人板的选牌阶段可以无歧义重建；不以标题文字猜行动栈。
  if (p.players.length !== 2 || p.progress !== 0 || selected.length > 1 || p.dice.length !== 9
    || !['red', 'black', 'white'].every((color) => ['left', 'center', 'right'].every((side) =>
      p.dice.filter((die) => die.slot === `${color}-${side}` && die.color === (color === 'red' ? 'coral' : color)).length === 1))) {
    fail('BGA_ADVICE_PHASE');
  }
  for (const player of p.players) {
    if (player.displayedScore !== 0 || p.pieces.filter((piece) => piece.type === 'influence'
      && piece.owner === player.seat && piece.slot === 'influence-0').length !== 1) fail('BGA_ADVICE_PHASE');
    for (const [type, row] of [['courtier', 'courtiers'], ['gardener', 'gardeners'], ['warrior', 'warriors']]) {
      const pieces = p.pieces.filter((piece) => piece.type === type && piece.owner === player.seat);
      if (pieces.length !== 5 || pieces.some((piece) => !inside(piece, `twc-player-board-${row}-${player.platformId}`))) {
        fail('BGA_ADVICE_PHASE');
      }
    }
  }
  const herons = p.pieces.filter((piece) => piece.type === 'heron').sort((a, b) => Number(a.slot) - Number(b.slot));
  if (herons.length !== 2 || herons.some((piece, i) => piece.slot !== String(i + 1))
    || new Set(herons.map((piece) => piece.owner)).size !== 2
    || herons.some((piece) => !p.players.some((player) => player.seat === piece.owner))) fail('BGA_ADVICE_SETUP');
  const playOrder = herons.map((piece) => piece.owner);
  const chosen = selected[0];
  if (chosen && chosen.seat !== playOrder[1]) fail('BGA_ADVICE_PHASE');
  const resourcesOf = (player) => Object.fromEntries(ASSETS.map((key) => [key, key === 'points'
    ? player.displayedScore : player.resources[key]]));
  for (const player of p.players.filter((item) => item !== chosen)) {
    if (Object.values(resourcesOf(player)).some((value) => value !== 0) || ownCards(player, 'lantern').length) fail('BGA_ADVICE_PHASE');
  }
  const visiblePairs = latest.observation.draftPairs;
  if (!Array.isArray(visiblePairs) || visiblePairs.length !== 3 - selected.length) fail('BGA_ADVICE_PAIRS');
  const pairs = visiblePairs.map((pair) => ({
    resource: one(p.cards.filter((card) => card.instance === pair.resource && card.family === 'starting-resources'
      && !card.faceDown && card.localId && inside(card, 'twc-starting-resource-draft-stock')), 'BGA_ADVICE_PAIRS'),
    action: one(p.cards.filter((card) => card.instance === pair.action && card.family === 'starting-action'
      && !card.faceDown && card.localId && inside(card, 'twc-starting-action-draft-stock')), 'BGA_ADVICE_PAIRS'),
  }));
  if (['resource', 'action'].some((key) => new Set(pairs.map((pair) => pair[key].instance)).size !== pairs.length)
    || p.cards.filter((card) => inside(card, 'twc-starting-resource-draft-stock')).length !== pairs.length
    || p.cards.filter((card) => inside(card, 'twc-starting-action-draft-stock')).length !== pairs.length) fail('BGA_ADVICE_PAIRS');
  let chosenChoices = [];
  if (chosen) {
    const action = one(ownCards(chosen, 'action').filter((card) => card.family === 'starting-action' && !card.faceDown && card.localId));
    const lanterns = ownCards(chosen, 'lantern');
    const back = one(lanterns.filter((card) => card.family === 'starting-resources' && card.faceDown));
    // 已选资源牌只在公开收益、牌背和法令共同唯一确定设计时还原；收益尚未结算完就拒绝。
    const resource = one(catalog.cards.filter((card) => card.kind === 'startingResource' && equal(card.back, back.back)
      && !pairs.some((pair) => pair.resource.localId === card.id)
      && equal(lanterns.filter((item) => item.family === 'decree').map((item) => item.localId).sort(),
        card.grantDecreeId ? [card.grantDecreeId] : []))
      .filter((card) => {
        const gains = Object.fromEntries(ASSETS.map((key) => [key,
          card.initialGains.filter((gain) => gain.type === key).reduce((sum, gain) => sum + gain.amount, 0)]));
        const flexible = card.initialGains.filter((gain) => gain.type === 'chooseResource').reduce((sum, gain) => sum + gain.amount, 0);
        return ASSETS.slice(3).every((key) => gains[key] === resourcesOf(chosen)[key])
          && ASSETS.slice(0, 3).every((key) => resourcesOf(chosen)[key] >= gains[key])
          && ASSETS.slice(0, 3).reduce((sum, key) => sum + resourcesOf(chosen)[key] - gains[key], 0) === flexible;
      }), 'BGA_ADVICE_DRAFT_INCOMPLETE');
    if (lanterns.length !== (resource.grantDecreeId ? 2 : 1)) fail('BGA_ADVICE_DRAFT_INCOMPLETE');
    const definition = one(Object.entries(mapping.mappings['starting-resources']).filter(([, id]) => id === resource.id))[0];
    pairs.push({ resource: { ...back, definition, localId: resource.id }, action });
    chosenChoices = ASSETS.slice(0, 3).flatMap((key) => Array(resourcesOf(chosen)[key]
      - resource.initialGains.filter((gain) => gain.type === key).reduce((sum, gain) => sum + gain.amount, 0)).fill(key));
  }
  const match = buildLiveBoard(latest, pairs, { catalog, mapping, playOrder });
  if (chosen) {
    match.draft = chooseStartingPair(match.draft, chosen.seat, 'starting-pair-3', match.config, { choices: chosenChoices });
    if (!equal(match.draft.players[chosen.seat].resources, resourcesOf(chosen))) fail('BGA_ADVICE_DRAFT_INCOMPLETE');
  }
  const env = new TrainingEnvironment(catalog, weights);
  const observation = env.initialize(match);
  env.publicInitialBridges = ['coral', 'black', 'white'].map((color) => ({
    id: color, color, dice: p.dice.filter((die) => die.color === color)
      .sort((a, b) => a.value - b.value).map((die) => ({ id: die.instance, value: die.value })),
  }));
  const actor = one(p.players.filter((player) => player.seat === observation.actor));
  const result = { observation, actor: actor.platformId, scope: 'starting-draft-only',
    draftContext: pairs.map(({ resource, action }) => ({
      resource: { instance: resource.instance, family: resource.family, definition: resource.definition, localId: resource.localId },
      action: { instance: action.instance, family: action.family, definition: action.definition, localId: action.localId },
    })),
    candidates: env.getLegalActions().map((option) => {
      const index = match.draft.pairs.findIndex((pair) => pair.id === option.action.pairId);
      const pair = match.draft.pairs[index];
      const resource = one(catalog.cards.filter((card) => card.id === pair.resourceId));
      const actionId = mapBgaDefinition(mapping, 'starting-action', pairs[index].action.definition)[0];
      const action = one(catalog.cards.filter((card) => card.id === actionId));
      return { column: index + 1, resourceId: pair.resourceId, actionId: pair.actionId,
        resourceInstance: pairs[index].resource.instance, actionInstance: pairs[index].action.instance,
        gains: resource.initialGains, action: action.fields[0].effects[0].type,
        lantern: [...resource.back, ...(resource.grantDecreeId
          ? one(catalog.cards.filter((card) => card.id === resource.grantDecreeId)).back : [])] };
    }) };
  draftSessions.set(result, { env, uncertainPriority: false });
  return result;
}

/** 只把本次公开摆设交给共用配置器，不补推未知牌面。 */
export function buildLiveBoard(latest, pairs, { catalog, mapping, playOrder, publicRemovedCards = [] }) {
  const p = latest.archive.publicPosition;
  const localCard = (card) => one(catalog.cards.filter((item) => item.id === card.localId));
  const data = {
    stewardCardsDeckCount: one(p.decks.filter((deck) => deck.kind === 'steward')).count,
    diplomatCardsDeckCount: one(p.decks.filter((deck) => deck.kind === 'diplomat')).count,
    daimyoCard: { typeArg: one(p.cards.filter((card) => card.family === 'daimyo' && !card.faceDown && card.localId)).definition },
    dieTiles: p.dieTiles.map((tile) => ({ location: 'main-board', locationArg: Number(tile.slot),
      side: tile.side, type: tile.color === 'coral' ? 'red' : tile.color,
      back: tile.reward === 'chooseResource' ? 'resource' : tile.reward })),
    gardenCards: p.cards.filter((card) => card.family === 'garden' && !card.faceDown && card.localId).map((card) => ({
      type: card.slot?.split('-')[1], typeArg: Number(card.definition), locationArg: card.slot?.split('-')[0],
      foodCost: localCard(card).foodCost, pointValue: localCard(card).victoryPoints,
    })),
    trainingYards: [[1, [4]], [3, [3]], [5, [1, 2]]].map(([cost, slots]) => ({
      ironCost: cost, pointValue: cost === 5 ? 2 : 1,
      yardTiles: slots.map((slot, index) => {
        const tile = one(p.training.filter((item) => item.slot === String(slot) && item.localId));
        return { type: 'base', typeArg: Number(tile.definition), side: tile.side, locationArg: index };
      }),
    })),
    ...Object.fromEntries(['steward', 'diplomat'].map((family) => [`${family}Cards`,
      p.cards.filter((card) => card.family === family && !card.faceDown && card.localId && inside(card, `twc-${family}-card-slots`))
        .map((card) => ({ typeArg: Number(card.definition), location: `main-board-${family}`, locationArg: Number(card.slot) }))])),
    startingResourceCards: pairs.map((pair, index) => ({ type: 'starting-resources', typeArg: Number(pair.resource.definition), locationArg: index })),
    startingActionCards: pairs.map((pair, index) => ({ type: 'starting-action', typeArg: Number(pair.action.definition), locationArg: index })),
  };
  if (p.training.length !== 4 || p.dieTiles.length !== 15 || data.gardenCards.length !== 6) fail('BGA_ADVICE_SETUP');
  let match;
  try { match = buildBgaDraftSetup(data, catalog, mapping, { seed: 'public-live-draft', playOrder, publicRemovedCards }); }
  catch { fail('BGA_ADVICE_SETUP'); }
  return match;
}
