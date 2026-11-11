import { canonicalCatalog } from '../data/catalog.js';
import { createLocalMatch } from '../engine/localMatch.js';
import { chooseStartingPair } from '../engine/startingDraft.js';
import { TrainingEnvironment } from '../ai/environment.js';
import { mapBgaDefinition } from './bgaReplay.js';

export const BGA_TRAINING_VERSION = 'bga-verified-draft-v1';
const COLORS = { red: 'coral', black: 'black', white: 'white' };
const ASSETS = ['food', 'iron', 'pearl', 'coin', 'seal', 'points'];
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const equal = (a, b) => canonicalCatalog(a) === canonicalCatalog(b);

/** 只从开局已公开的对象建摆设；剩余牌堆仅用目录补足计数，不读取未来揭牌事件。 */
export function draftMatchFromBga(archive, catalog, mapping) {
  if (archive?.format !== 'whitecastle-bga-raw-replay' || archive.version !== 1
    || !archive.validation?.initialStatePresent || !archive.validation?.terminalStatePresent) fail('BGA_RAW_INVALID');
  if (archive.source?.versions?.asset !== mapping.gameAssetVersion
    || catalog.revision !== mapping.catalogRevision) fail('BGA_VERSION_UNSUPPORTED');
  const data = archive.initialData;
  const players = Object.keys(data?.players ?? {});
  if (players.length !== 2) fail('BGA_NOT_TWO_PLAYERS');
  const options = new Map((archive.configuration?.tableOptions ?? []).map((item) => [Number(item.id), Number(item.value)]));
  if ([120, 100, 104, 105, 108].some((id) => !options.has(id))) fail('BGA_OPTIONS_UNKNOWN');
  if (options.get(120) !== 1 || options.get(100) !== 2
    || [104, 105, 108].some((id) => options.get(id) !== 0)) fail('BGA_OPTIONS_UNSUPPORTED');
  const herons = [...(data.herons ?? [])].sort((a, b) => Number(a.locationArg) - Number(b.locationArg));
  if (herons.length !== 2 || herons.some((item, i) => Number(item.locationArg) !== i + 1)
    || new Set(herons.map((item) => String(item.playerId))).size !== 2
    || herons.some((item) => !players.includes(String(item.playerId)))) fail('BGA_ORDER_INVALID');
  const order = herons.map((item) => String(item.playerId));
  const seatMap = Object.fromEntries(order.map((id, index) => [id, String(index)]));
  if (String(data.gamestate?.active_player) !== order[1] || Number(data.gamestate?.id) !== 15) fail('BGA_DRAFT_INITIAL_INVALID');
  if (players.some((id) => Number(data.players[id].score) !== 0 || data.players[id].actionCard
    || data.players[id].lanternCards?.length
    || ASSETS.slice(0, 5).some((key) => data.players[id].extra?.[key] !== 0))) fail('BGA_DRAFT_INITIAL_INVALID');
  const mapped = (family, definition, side) => {
    const result = mapBgaDefinition(mapping, family, definition, side);
    if (typeof result !== 'string') fail('BGA_CARD_UNSUPPORTED');
    return result;
  };
  const match = createLocalMatch(catalog, { seed: `bga-draft:${archive.source.table}`, playOrder: ['0', '1'] });
  const config = match.config;
  const roomSlots = {
    'floor1-1': [-3, 3, 8], 'floor1-2': [-2, 4, 9], 'floor1-3': [-1, 5, 10],
    'floor2-1': [1, 6], 'floor2-2': [2, 7],
  };
  const rooms = [['steward', data.stewardCards, 1, 3], ['diplomat', data.diplomatCards, 2, 2]]
    .flatMap(([family, cards, floor, count]) => Array.from({ length: count }, (_, index) => {
      const found = cards?.filter((card) => card.location === `main-board-${family}` && Number(card.locationArg) === index + 1);
      if (found?.length !== 1) fail('BGA_ROOM_INVALID');
      const cardId = mapped(family, found[0].typeArg);
      const card = catalog.cards.find((item) => item.id === cardId);
      const id = `floor${floor}-${index + 1}`;
      const tiles = roomSlots[id].map((slot, i) => {
        const values = data.dieTiles.filter((tile) => Number(tile.locationArg) === slot && tile.location === 'main-board');
        if (values.length !== 1 || values[0].side !== 'front' || !COLORS[values[0].type]) fail('BGA_DIE_TILE_INVALID');
        return { fieldId: card.fields[i].id, color: COLORS[values[0].type] };
      });
      return { id, floor, cardId, tiles };
    }));
  const gardens = ['plant', 'rock'].flatMap((kind) => ['red', 'black', 'white'].map((color) => {
    const found = data.gardenCards?.filter((card) => card.type === kind && card.locationArg === color);
    if (found?.length !== 1) fail('BGA_GARDEN_INVALID');
    const cardId = mapped('garden', found[0].typeArg);
    const card = catalog.cards.find((item) => item.id === cardId);
    if (card.foodCost !== found[0].foodCost || card.victoryPoints !== found[0].pointValue) fail('BGA_GARDEN_MISMATCH');
    return { cardId, bridgeId: COLORS[color] };
  }));
  const trainingYards = [1, 3, 5].map((cost) => {
    const found = data.trainingYards?.filter((yard) => yard.ironCost === cost);
    if (found?.length !== 1 || found[0].pointValue !== (cost === 5 ? 2 : 1)) fail('BGA_YARD_INVALID');
    const faceIds = [...found[0].yardTiles].sort((a, b) => a.locationArg - b.locationArg).map((tile) => {
      if (tile.type !== 'base') fail('BGA_YARD_INVALID');
      return mapped('yard', tile.typeArg, tile.side);
    });
    if (faceIds.length !== (cost === 5 ? 2 : 1)) fail('BGA_YARD_INVALID');
    const tones = faceIds.map((id) => catalog.yardFaces.find((face) => face.id === id)?.tone).sort();
    if (!equal(tones, cost === 1 ? ['resource'] : cost === 3 ? ['action'] : ['action', 'resource'])) fail('BGA_YARD_INVALID');
    return { id: `yard-cost-${cost}`, faceIds };
  });
  const wellRewards = [11, 12].map((slot) => {
    const found = data.dieTiles.filter((tile) => Number(tile.locationArg) === slot);
    if (found.length !== 1 || found[0].side !== 'back') fail('BGA_WELL_INVALID');
    const type = found[0].back === 'resource' ? 'chooseResource' : found[0].back;
    if (!['chooseResource', 'food', 'iron', 'pearl', 'coin', 'seal'].includes(type)) fail('BGA_WELL_INVALID');
    return { type, amount: 1 };
  });
  const castleDecks = Object.fromEntries([['steward', data.stewardCardsDeckCount], ['diplomat', data.diplomatCardsDeckCount]]
    .map(([family, count]) => {
      const remaining = catalog.cards.filter((card) => card.kind === family && !rooms.some((room) => room.cardId === card.id))
        .map((card) => card.id).sort();
      if (count !== remaining.length) fail('BGA_DECK_COUNT_UNSUPPORTED');
      return [family, remaining];
    }));
  config.setup = { ...config.setup, castleRooms: rooms, gardens, trainingYards, wellRewards, castleDecks,
    topCardId: mapped('daimyo', data.daimyoCard?.typeArg) };
  const resourceCards = data.startingResourceCards;
  const actionCards = data.startingActionCards;
  if (resourceCards?.length !== 3 || actionCards?.length !== 3) fail('BGA_DRAFT_PAIRS_INVALID');
  const used = new Map();
  const pairs = [0, 1, 2].map((index) => {
    const resource = resourceCards.filter((card) => card.locationArg === index && card.type === 'starting-resources');
    const action = actionCards.filter((card) => card.locationArg === index && card.type === 'starting-action');
    if (resource.length !== 1 || action.length !== 1) fail('BGA_DRAFT_PAIRS_INVALID');
    const resourceId = mapped('starting-resources', resource[0].typeArg);
    const copies = mapBgaDefinition(mapping, 'starting-action', action[0].typeArg);
    const copy = used.get(action[0].typeArg) ?? 0;
    const actionId = Array.isArray(copies) ? copies[copy] : null;
    if (!actionId) fail('BGA_DRAFT_PAIRS_INVALID');
    used.set(action[0].typeArg, copy + 1);
    return { id: `starting-pair-${index + 1}`, resourceId, actionId,
      resourceInstanceId: JSON.stringify([resourceId, 0]), actionInstanceId: JSON.stringify([actionId, 0]),
      chosenBy: null };
  });
  if (new Set(pairs.map((pair) => pair.resourceId)).size !== 3) fail('BGA_DRAFT_PAIRS_INVALID');
  match.draft.pairs = pairs;
  match.draft.canonicalSignature = canonicalCatalog(config);
  return { match, seatMap };
}

/** R-SETUP-04：只接纳完整且无撤销的选牌段，资源收益必须与本地原子规则逐项相符。 */
export function convertBgaDraft(archive, { catalog, mapping, weights, meta, teacherPlayers = [] }) {
  const { match, seatMap } = draftMatchFromBga(archive, catalog, mapping);
  const events = [];
  let ended = false;
  for (const packet of archive.replayData?.data ?? []) {
    if (String(packet.table_id) !== String(archive.source.table)) fail('BGA_PACKET_MISMATCH');
    for (const event of packet.data ?? []) {
      if (event.type === 'endDraft') { ended = true; break; }
      if (event.args?.isUndo) fail('BGA_DRAFT_UNDO_UNSUPPORTED');
      events.push(event);
    }
    if (ended) break;
  }
  if (!ended) fail('BGA_DRAFT_INCOMPLETE');
  const selections = events.filter((event) => event.type === 'actionCardGained');
  if (selections.length !== 2) fail('BGA_DRAFT_SELECTION_COUNT');
  const env = new TrainingEnvironment(catalog, weights);
  env.initialize(match);
  const allRows = [];
  for (const selection of selections) {
    const platformId = String(selection.args.playerId);
    const actor = seatMap[platformId];
    if (!actor || actor !== env.actor) fail('BGA_DRAFT_ORDER_MISMATCH');
    const resourceEvents = events.filter((event) => event.type === 'lanternCardGained'
      && String(event.args.playerId) === platformId && event.args.card?.type === 'starting-resources');
    if (resourceEvents.length !== 1) fail('BGA_DRAFT_RESOURCE_CARD_MISSING');
    const original = archive.initialData.startingResourceCards.find((card) => card.id === resourceEvents[0].args.card.id);
    const action = archive.initialData.startingActionCards.find((card) => card.id === selection.args.card?.id);
    if (!original || !action || action.locationArg !== original.locationArg
      || original.typeArg !== resourceEvents[0].args.card.typeArg
      || action.typeArg !== selection.args.card.typeArg) fail('BGA_DRAFT_PAIR_MISMATCH');
    const pair = env.match.draft.pairs[original.locationArg];
    const local = catalog.cards.find((card) => card.id === pair.resourceId);
    const gains = events.filter((event) => String(event.args?.playerId) === platformId
      && event.type === 'resourceGained' && event.args.cardId === original.id);
    const flexible = local.initialGains.filter((gain) => gain.type === 'chooseResource')
      .reduce((sum, gain) => sum + gain.amount, 0);
    const choices = flexible ? gains.flatMap((event) => {
      if (!['food', 'iron', 'pearl'].includes(event.args.resource)
        || !Number.isInteger(event.args.numberOfResources) || event.args.numberOfResources < 1
        || event.args.numberOfResources > 3) fail('BGA_DRAFT_RESOURCE_INVALID');
      return Array(event.args.numberOfResources).fill(event.args.resource);
    }) : [];
    if (choices.length !== flexible) fail('BGA_DRAFT_RESOURCE_INVALID');
    const expected = chooseStartingPair(env.match.draft, actor, pair.id, env.match.config, { choices });
    const actual = Object.fromEntries(ASSETS.map((key) => [key, 0]));
    for (const event of events.filter((item) => String(item.args?.playerId) === platformId)) {
      const args = event.args;
      const change = event.type === 'resourceGained' ? [args.resource, args.numberOfResources, args.resourceValue]
        : event.type === 'coinGained' ? ['coin', args.numberOfCoins, args.coinValue]
          : event.type === 'sealGained' ? ['seal', args.numberOfSeals, args.sealValue] : null;
      if (change) {
        if (args.cardId !== original.id || !ASSETS.includes(change[0])
          || !Number.isInteger(change[1]) || change[1] < 0
          || actual[change[0]] + change[1] !== change[2]) fail('BGA_DRAFT_GAIN_UNSUPPORTED');
        actual[change[0]] = change[2];
      } else if (/Paid$|Assigned$|Moved|scoreUpdated/.test(event.type)) fail('BGA_DRAFT_GAIN_UNSUPPORTED');
    }
    if (!equal(actual, expected.players[actor].resources)) fail('BGA_DRAFT_STATE_MISMATCH');
    const lanterns = events.filter((event) => event.type === 'lanternCardGained'
      && String(event.args.playerId) === platformId).map((event) => {
      const card = event.args.card;
      if (!['starting-resources', 'decree'].includes(card?.type)) fail('BGA_DRAFT_LANTERN_MISMATCH');
      const id = mapBgaDefinition(mapping, card.type, card.type === 'decree' ? card.back : card.typeArg);
      if (typeof id !== 'string') fail('BGA_DRAFT_LANTERN_MISMATCH');
      return id;
    }).sort();
    if (!equal(lanterns, [...expected.players[actor].lanternCardIds].sort())) fail('BGA_DRAFT_LANTERN_MISMATCH');
    const emit = (teacher) => {
      const observation = env.observe();
      allRows.push({ ...meta, game: `bga:${archive.source.table}`, step: allRows.length, actor,
        state: observation.state, candidates: observation.candidates, teacher, z: 0, valueWeight: 0,
        request: observation.request,
        provenance: { kind: BGA_TRAINING_VERSION, table: String(archive.source.table), player: platformId,
          scope: 'starting-draft-only', legalityVerified: true, resourcesVerified: true } });
    };
    const index = env.getLegalActions().findIndex((option) => option.action?.pairId === pair.id);
    if (index < 0) fail('BGA_DRAFT_NO_LEGAL_TARGET');
    if (teacherPlayers.includes(platformId)) emit(index);
    // 最后一份选择不生成下一阶段盘面，避免把目录补足的未知牌堆当作真实续局。
    if (env.match.draft.nextPickIndex === 1 && choices.length === 0) {
      env.match.draft = expected;
      break;
    }
    env.step(index);
    for (let i = 0; i < choices.length; i += 1) {
      const option = env.getLegalActions().findIndex((item) => item.value === choices[i]);
      if (env.probe?.request.type !== 'chooseResource' || option < 0) fail('BGA_DRAFT_NO_LEGAL_TARGET');
      if (teacherPlayers.includes(platformId)) emit(option);
      if (env.match.draft.nextPickIndex === 1 && i === choices.length - 1) {
        env.match.draft = expected;
        break;
      }
      env.step(option);
    }
    if (!equal(env.match.draft, expected)) fail('BGA_DRAFT_STATE_MISMATCH');
  }
  if (env.match.draft.phase !== 'complete') fail('BGA_DRAFT_INCOMPLETE');
  return { rows: allRows, mappedCards: 55, mappedYardFaces: 16, scope: 'starting-draft-only' };
}
