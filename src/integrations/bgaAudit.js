import { canonicalCatalog, validateCatalog } from '../data/catalog.js';
import { createPosition, score } from '../engine/engine.js';
import { VERIFIED_TIME_SCORES } from '../engine/influence.js';
import { placementOptions } from '../engine/actionOptions.js';
import { mapBgaDefinition } from './bgaReplay.js';

const clone = (value) => structuredClone(value);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const assets = ['coin', 'seal', 'food', 'iron', 'pearl'];
const pieceKeys = { courtier: 'courtiers', gardener: 'gardeners', warrior: 'warriors' };
const colors = { red: 'coral', black: 'black', white: 'white' };
const integer = (value) => {
  if (!['number', 'string'].includes(typeof value) || value === '' || !Number.isSafeInteger(Number(value))) fail('BGA_AUDIT_INTEGER');
  return Number(value);
};
const equal = (a, b) => canonicalCatalog(a) === canonicalCatalog(b);

/** 原始通知中的撤销也携带回退后的绝对值，必须顺序应用，不能简单过滤 isUndo。 */
export function auditBgaReplay(archive, { catalog, mapping }) {
  if (archive?.format !== 'whitecastle-bga-raw-replay' || archive.version !== 1
    || !archive.validation?.initialStatePresent || !archive.validation?.terminalStatePresent) fail('BGA_AUDIT_RAW_INVALID');
  if (validateCatalog(catalog).length || catalog.revision !== mapping.catalogRevision
    || archive.source?.versions?.asset !== mapping.gameAssetVersion) fail('BGA_AUDIT_VERSION');
  const data = archive.initialData;
  const ids = Object.keys(data?.players ?? {});
  if (ids.length !== 2) fail('BGA_AUDIT_TWO_PLAYERS');
  const options = new Map((archive.configuration?.tableOptions ?? []).map((item) => [Number(item.id), Number(item.value)]));
  if ([120, 100, 104, 105, 108].some((id) => !options.has(id))) fail('BGA_AUDIT_OPTIONS_UNKNOWN');
  if (options.get(120) !== 1 || options.get(100) !== 2
    || [104, 105, 108].some((id) => options.get(id) !== 0)) fail('BGA_AUDIT_OPTIONS_UNSUPPORTED');
  if (archive.history?.concede && String(archive.history.concede) !== '0') fail('BGA_AUDIT_CONCEDED');

  const issues = [];
  const checks = { resourceTransitions: 0, undoNotifications: 0, placements: 0, placementGateChecks: 0,
    placementCoinSettlements: 0, initialDraftResetFromSetupEvent: false };
  const issue = (code, context = {}) => issues.push({ code, ...context });
  const mapped = (family, definition, side) => {
    const id = mapBgaDefinition(mapping, family, definition, side);
    if (typeof id !== 'string') fail('BGA_AUDIT_MAPPING');
    return id;
  };
  const gardens = new Map((data.gardenCards ?? []).map((card) => {
    const localId = mapped('garden', card.typeArg);
    const local = catalog.cards.find((item) => item.id === localId);
    if (local?.foodCost !== card.foodCost || local?.victoryPoints !== card.pointValue) fail('BGA_AUDIT_GARDEN_CONFIG');
    return [String(card.id), { ...clone(card), localId }];
  }));
  const yards = new Map((data.trainingYards ?? []).map((yard) => {
    const local = catalog.trainingZones.find((zone) => zone.ironCost === yard.ironCost);
    if (!local || local.value !== yard.pointValue) fail('BGA_AUDIT_YARD_CONFIG');
    return [String(yard.id), { ...clone(yard), localId: local.id }];
  }));
  if (gardens.size !== 6 || yards.size !== 3 || new Set([...gardens.values()].map((item) => item.localId)).size !== 6
    || !equal([...yards.values()].map((item) => item.ironCost).sort((a, b) => a - b), [1, 3, 5])) fail('BGA_AUDIT_SETUP_INCOMPLETE');
  const players = Object.fromEntries(ids.map((id) => {
    const source = data.players[id];
    return [id, { resources: { ...Object.fromEntries(assets.map((name) => [name, integer(source.extra?.[name])])),
      points: integer(source.score) },
    pieces: Object.fromEntries(Object.values(pieceKeys).flatMap((key) => source[key] ?? [])
      .map((piece) => [String(piece.id), clone(piece)])) }];
  }));
  // 只重建放骰门槛所需的公开摆设；不为未知牌堆或完整动作生成训练状态。
  const gateConfig = clone(catalog);
  const slotsByRoom = { 'floor1-1': [-3, 3, 8], 'floor1-2': [-2, 4, 9], 'floor1-3': [-1, 5, 10],
    'floor2-1': [1, 6], 'floor2-2': [2, 7] };
  gateConfig.setup = { castleRooms: [['steward', 1, 3], ['diplomat', 2, 2]].flatMap(([family, floor, count]) =>
    Array.from({ length: count }, (_, i) => {
      const cards = data[`${family}Cards`]?.filter((card) => card.location === `main-board-${family}` && Number(card.locationArg) === i + 1);
      if (cards?.length !== 1) fail('BGA_AUDIT_ROOM_CONFIG');
      const id = `floor${floor}-${i + 1}`;
      const cardId = mapped(family, cards[0].typeArg);
      const card = catalog.cards.find((item) => item.id === cardId);
      const tiles = slotsByRoom[id].map((slot, j) => {
        const found = data.dieTiles?.filter((tile) => Number(tile.locationArg) === slot);
        if (found?.length !== 1 || found[0].side !== 'front' || !colors[found[0].type]) fail('BGA_AUDIT_DIE_TILE_CONFIG');
        return { fieldId: card.fields[j].id, color: colors[found[0].type] };
      });
      return { id, floor, cardId, tiles };
    })),
  };
  gateConfig.setup.placements = {
    ...Object.fromEntries(gateConfig.setup.castleRooms.map((room) =>
      [`castle:${room.id}`, { area: 'castle', comparisonValue: room.floor === 1 ? 3 : 4 }])),
    'outside:left': { area: 'outside', comparisonValue: 5 },
    'outside:right': { area: 'outside', comparisonValue: 5 },
  };
  const gateState = createPosition(gateConfig);
  const gateMatch = { phase: 'playing', config: gateConfig, state: gateState };
  const targetOf = (id) => {
    if (id === 'action-space-main-board-well') return { area: 'well' };
    const room = /^action-space-main-board-(steward|diplomat)-([1-3])$/.exec(id ?? '');
    if (room) return { area: 'castle', id: `floor${room[1] === 'steward' ? 1 : 2}-${room[2]}` };
    const outside = /^action-space-main-board-outside-the-walls-([12])$/.exec(id ?? '');
    if (outside) return { area: 'outside', id: outside[1] === '1' ? 'left' : 'right' };
    const personal = /^action-space-player-(\d+)-([123])$/.exec(id ?? '');
    if (personal) return { area: 'personal', row: { 1: 'courtier', 2: 'gardener', 3: 'warrior' }[personal[2]] };
    fail('BGA_AUDIT_TARGET_UNKNOWN');
  };
  let influence = clone(data.influenceMarkers);
  let herons = clone(data.herons);
  let bridge = clone(data.bridgeDice);
  let round = integer(data.roundNumber);
  let prefinal = null;
  let terminal = false;
  let breakdown = null;
  const finalScores = {};
  const currentDice = new Map((data.actionSpaceDice ?? []).map((die) => [String(die.id), clone(die)]));
  const effectivePlacements = new Map();
  const bridgeBeforePlacement = new Map();
  const pendingDieCoins = new Map();
  const timeline = [];
  const knownNoState = new Set(['gameLog', 'updateReflexionTime', 'simpleNote', 'simpleNode', 'revealScores',
    'endDraft', 'diceRoundNumberUpdated', 'newMainBoardCardRevealed', 'actionCardGained', 'lanternCardGained', 'wakeupPlayers']);
  const snapshot = () => ({ players: clone(players), influence: clone(influence), herons: clone(herons),
    round, placements: [...effectivePlacements.values()].map(clone) });
  const location = (piece) => {
    if (piece.location === 'main-board-gate') return 'gate';
    if (/^main-board-steward-\d+$/.test(piece.location)) return 'floor1';
    if (/^main-board-diplomat-\d+$/.test(piece.location)) return 'floor2';
    if (['main-board-daimyo', 'daimyo-card'].includes(piece.location)) return 'floor3';
    if (piece.location.startsWith('player-courtier-')) return 'personal';
    fail('BGA_AUDIT_COURTIER_LOCATION');
  };
  let index = 0;
  for (const packet of archive.replayData?.data ?? []) {
    if (String(packet.table_id) !== String(archive.source.table)) fail('BGA_AUDIT_PACKET_IDENTITY');
    for (const event of packet.data ?? []) {
      index += 1;
      const a = event.args ?? {};
      const context = { event: index, packet: String(packet.packet_id), type: event.type };
      const player = players[String(a.playerId)];
      if (a.isUndo) checks.undoNotifications += 1;
      if (event.type === 'gameStateChange') {
        if (a.name === 'gameSetup') {
          // 某些存档的 initialData 已含首位选牌收益，但通知仍从开局开始；R-SETUP-04 的开局事件是零资产边界。
          if (prefinal || checks.placements || Object.values(players).some((item) => Object.values(item.pieces)
            .some((piece) => !piece.location.startsWith('player-')))) fail('BGA_AUDIT_SETUP_BOUNDARY');
          checks.initialDraftResetFromSetupEvent = Object.values(players).some((item) => Object.values(item.resources).some((value) => value !== 0));
          for (const item of Object.values(players)) for (const key of [...assets, 'points']) item.resources[key] = 0;
        }
        if (Number(a.id) === 95) {
          if (prefinal) fail('BGA_AUDIT_DUPLICATE_SCORING');
          prefinal = snapshot();
        }
        if (Number(a.id) === 99) terminal = true;
      } else if (event.type === 'updateLiveScore') {
        if (prefinal) breakdown = clone(a.scoreBreakdown);
      } else if (event.type === 'setPlayerCounter') {
        if (a.name === 'player_score' && prefinal) finalScores[String(a.playerId)] = integer(a.value);
      } else if (event.type === 'scoreUpdated') {
        if (!player) fail('BGA_AUDIT_PLAYER');
        if (!prefinal) player.resources.points = integer(a.score);
        else finalScores[String(a.playerId)] = integer(a.score);
      } else if (/^(coin|seal|resource)(Gained|Paid)$/.test(event.type)) {
        if (!player || prefinal) fail('BGA_AUDIT_RESOURCE_PHASE');
        const kind = event.type.startsWith('resource') ? a.resource : event.type.startsWith('coin') ? 'coin' : 'seal';
        if (!assets.includes(kind)) fail('BGA_AUDIT_RESOURCE');
        const field = kind === 'coin' ? 'coinValue' : kind === 'seal' ? 'sealValue' : 'resourceValue';
        const quantity = integer(a[kind === 'coin' ? 'numberOfCoins' : kind === 'seal' ? 'numberOfSeals' : 'numberOfResources']);
        const value = integer(a[field]);
        const before = player.resources[kind];
        const limit = kind === 'coin' ? Infinity : kind === 'seal' ? 5 : 7;
        if (value < 0 || value > limit || quantity < 0) fail('BGA_AUDIT_RESOURCE_BOUNDS');
        if (!a.isUndo) {
          const expected = event.type.endsWith('Gained') ? Math.min(limit, before + quantity) : before - quantity;
          if (value !== expected) issue('BGA_AUDIT_RESOURCE_DELTA', { ...context, player: String(a.playerId), kind, before, quantity, expected, actual: value });
          checks.resourceTransitions += 1;
          if (kind === 'coin' && a.dieId !== null && a.dieId !== undefined) {
            const key = `${round}:${a.dieId}`;
            const payment = pendingDieCoins.get(key);
            const actual = event.type.endsWith('Gained') ? quantity : -quantity;
            if (!payment || payment.player !== String(a.playerId) || payment.delta !== actual) issue('BGA_AUDIT_DIE_COIN_DELTA', context);
            else checks.placementCoinSettlements += 1;
            pendingDieCoins.delete(key);
          }
        }
        player.resources[kind] = value;
      } else if (['courtierAssigned', 'courtierMovedUp', 'courtierPlacedOnDaimyoCard', 'warriorAssigned', 'gardenerAssigned'].includes(event.type)) {
        const piece = a.courtier ?? a.warrior ?? a.gardener;
        const previous = player?.pieces[String(piece?.id)];
        if (!piece || !previous || previous.type !== piece.type || String(piece.playerId) !== String(a.playerId)) fail('BGA_AUDIT_PIECE');
        player.pieces[String(piece.id)] = clone(piece);
      } else if (event.type === 'passageOfTimeMoved') {
        if (!Array.isArray(a.influenceMarkers)) fail('BGA_AUDIT_INFLUENCE');
        influence = clone(a.influenceMarkers);
      } else if (event.type === 'heronsUpdated') {
        herons = clone(a.herons);
      } else if (event.type === 'roundNumberUpdated') {
        round = integer(a.roundNumber);
      } else if (event.type === 'bridgeDiceUpdated') {
        bridge = clone(a.bridgeDice);
      } else if (event.type === 'diceRolled') {
        bridge = clone(a.dice);
        currentDice.clear();
      } else if (event.type === 'diePlaced') {
        const die = a.die;
        if (!die || !player) fail('BGA_AUDIT_DIE');
        const key = `${round}:${die.id}`;
        if (a.isUndo) {
          const previousBridge = bridgeBeforePlacement.get(key);
          if (!previousBridge) fail('BGA_AUDIT_UNDO_PLACEMENT');
          bridge = clone(previousBridge);
          bridgeBeforePlacement.delete(key);
          effectivePlacements.delete(key);
          pendingDieCoins.delete(key);
          currentDice.delete(String(die.id));
        } else {
          checks.placements += 1;
          const original = bridge.find((item) => String(item.id) === String(die.id));
          const target = a.actionSpace;
          if (!original || !['left', 'right'].includes(original.locationArg)
            || original.side !== die.side || original.type !== die.type) issue('BGA_AUDIT_BRIDGE_ENDPOINT', context);
          const expectedValue = target?.id === 'action-space-main-board-well' ? 1
            : target?.id?.includes('outside-the-walls') ? 5
              : target?.id?.includes('steward') ? 3 : target?.id?.includes('diplomat') ? 4
                : target?.id?.startsWith(`action-space-player-${a.playerId}-`) ? 6 : null;
          const tileSlots = { 1: [-3, 3, 8], 2: [-2, 4, 9], 3: [-1, 5, 10] };
          const roomMatch = /^action-space-main-board-(steward|diplomat)-(\d)$/.exec(target?.id ?? '');
          if (roomMatch) {
            const slots = roomMatch[1] === 'steward' ? tileSlots[roomMatch[2]] : Number(roomMatch[2]) === 1 ? [1, 6] : [2, 7];
            if (!data.dieTiles.some((tile) => slots.includes(Number(tile.locationArg)) && tile.type === die.type && tile.side === 'front')) {
              issue('BGA_AUDIT_CASTLE_COLOR', context);
            }
          }
          const occupied = [...currentDice.values()].filter((item) => item.location === target?.id).length;
          if (expectedValue === null || Number(target?.value) !== expectedValue
            || (expectedValue !== 1 && occupied >= 1)
            || (target?.type !== 'any' && target?.type !== die.type)) issue('BGA_AUDIT_TARGET', context);
          const delta = integer(die.side) - expectedValue;
          if (delta < 0 && player.resources.coin < -delta) issue('BGA_AUDIT_PLACEMENT_COINS', context);
          const seat = String(ids.indexOf(String(a.playerId)));
          gateState.activePlayer = seat;
          gateState.players[seat].resources = clone(player.resources);
          gateState.bridges = Object.entries(colors).map(([color, id]) => {
            const dice = bridge.filter((item) => item.type === color).sort((a, b) => a.side - b.side
              || ['left', 'center', 'right'].indexOf(a.locationArg) - ['left', 'center', 'right'].indexOf(b.locationArg));
            return { id, color: id, dice: dice.map((item) => ({ id: String(item.id), value: item.side })),
              singleDieEndpoint: dice.length === 1 ? dice[0].locationArg : null };
          });
          for (const value of Object.values(gateState.placements)) value.dice = [];
          for (const placed of currentDice.values()) {
            const target = targetOf(placed.location);
            const personal = /^action-space-player-(\d+)-/.exec(placed.location);
            const owner = personal ? String(ids.indexOf(personal[1])) : seat;
            const key = target.area === 'personal' ? `personal:${owner}:${target.row}`
              : target.area === 'well' ? 'well' : `${target.area}:${target.id}`;
            if (!gateState.placements[key]) fail('BGA_AUDIT_TARGET_UNKNOWN');
            gateState.placements[key].dice.push({ id: String(placed.id), value: placed.side });
          }
          const requestedTarget = targetOf(target?.id);
          if (!original || !placementOptions(gateMatch, colors[die.type], original.locationArg)
            .some((option) => equal(option.action.target, requestedTarget))) issue('BGA_AUDIT_LOCAL_PLACEMENT_REJECTED', context);
          checks.placementGateChecks += 1;
          const placement = { round, player: String(a.playerId), die: String(die.id), value: die.side,
            color: die.type, side: original?.locationArg, target: target?.id, event: index };
          if (effectivePlacements.has(key)) issue('BGA_AUDIT_DUPLICATE_PLACEMENT', context);
          bridgeBeforePlacement.set(key, clone(bridge));
          effectivePlacements.set(key, placement);
          if (delta !== 0) pendingDieCoins.set(key, { delta, player: String(a.playerId) });
          currentDice.set(String(die.id), clone(die));
        }
      } else if (!knownNoState.has(event.type)) {
        issue('BGA_AUDIT_UNKNOWN_EVENT', context);
      }
    }
  }
  if (!terminal || !prefinal || prefinal.round !== 3) fail('BGA_AUDIT_FINAL_MISSING');
  if (pendingDieCoins.size) issue('BGA_AUDIT_DIE_COIN_MISSING', { placements: [...pendingDieCoins.keys()] });
  if (!breakdown || ids.some((id) => !breakdown[id] || !Number.isSafeInteger(finalScores[id]))) fail('BGA_AUDIT_SCORE_EVIDENCE_MISSING');
  const order = [...prefinal.herons].sort((a, b) => Number(a.locationArg) - Number(b.locationArg)).map((item) => String(item.playerId));
  if (!equal([...order].sort(), [...ids].sort())) fail('BGA_AUDIT_ORDER');
  const config = clone(catalog);
  config.timeTrack = clone(VERIFIED_TIME_SCORES);
  const metrics = {};
  config.setup = { players: ids.map((id) => {
    const source = prefinal.players[id];
    const figures = { courtier: [], warrior: [], gardener: [] };
    for (const piece of Object.values(source.pieces)) {
      if (piece.type === 'courtier') {
        const value = location(piece);
        if (value !== 'personal') figures.courtier.push({ location: value });
      } else if (piece.type === 'warrior' && piece.location === 'yard') {
        const yard = yards.get(String(piece.locationArg));
        if (!yard) fail('BGA_AUDIT_YARD_LOCATION');
        figures.warrior.push({ yardId: yard.localId });
      } else if (piece.type === 'gardener' && piece.location === 'garden') {
        const garden = gardens.get(String(piece.locationArg));
        if (!garden) fail('BGA_AUDIT_GARDEN_LOCATION');
        figures.gardener.push({ cardId: garden.localId, bridgeId: colors[garden.locationArg] });
      } else if (piece.type !== 'courtier' && !piece.location.startsWith(`player-${piece.type}-`)) fail('BGA_AUDIT_PIECE_LOCATION');
    }
    const marker = prefinal.influence.filter((item) => String(item.playerId) === id);
    const position = /^influence-(\d+)$/.exec(marker[0]?.location ?? '');
    if (marker.length !== 1 || !position) fail('BGA_AUDIT_INFLUENCE');
    const ownPlacements = prefinal.placements.filter((item) => item.player === id);
    if (ownPlacements.length !== 9 || [1, 2, 3].some((r) => ownPlacements.filter((item) => item.round === r).length !== 3)) {
      issue('BGA_AUDIT_TURN_COUNT', { player: id, counts: [1, 2, 3].map((r) => ownPlacements.filter((item) => item.round === r).length) });
    }
    metrics[id] = { internalCourtiers: figures.courtier.filter((item) => item.location !== 'gate').length,
      courtierLocations: figures.courtier.map((item) => item.location),
      warriorValue: figures.warrior.reduce((sum, item) => sum + catalog.trainingZones.find((yard) => yard.id === item.yardId).value, 0),
      warriors: figures.warrior.length, gardeners: figures.gardener.length,
      leftDice: ownPlacements.filter((item) => item.side === 'left').length,
      timePosition: Number(position[1]), resources: clone(source.resources) };
    return { resources: source.resources, figures, timePosition: Number(position[1]) };
  }) };
  const state = createPosition(config);
  ids.forEach((id, seat) => { state.players[String(seat)].finalOrder = order.indexOf(id); });
  const result = score(state, config);
  if (!result.complete) fail('BGA_AUDIT_LOCAL_SCORE_INCOMPLETE');
  const resourceScores = (source) => Object.fromEntries(['food', 'iron', 'pearl'].map((name) => {
    const isolated = clone(state);
    const player = isolated.players['0'];
    player.resources = { food: 0, iron: 0, pearl: 0, coin: 0, seal: 0, points: 0, [name]: source.resources[name] };
    player.figures = { courtier: [], warrior: [], gardener: [] };
    player.timePosition = 0;
    return [name, score(isolated, config).players['0'].parts.resources];
  }));
  const comparisons = ids.map((id, seat) => {
    const local = result.players[String(seat)];
    const bga = breakdown[id];
    const expected = { points: bga.vpDuringTheGame, coinAndSeal: bga.coinsAndSeals,
      resources: bga.food + bga.iron + bga.pearl, time: bga.passageOfTime,
      courtier: bga.courtiers, warrior: bga.warriors, gardener: bga.gardeners };
    const differences = Object.keys(expected).filter((key) => local.parts[key] !== expected[key])
      .map((key) => ({ part: key, local: local.parts[key], bga: expected[key] }));
    const byResource = resourceScores(prefinal.players[id]);
    for (const key of ['food', 'iron', 'pearl']) {
      if (byResource[key] !== bga[key]) differences.push({ part: key, local: byResource[key], bga: bga[key] });
    }
    if (local.total !== finalScores[id] || local.total !== bga.score) {
      differences.push({ part: 'total', local: local.total, bga: finalScores[id], breakdown: bga.score });
    }
    const historyIds = archive.history?.players?.split(',');
    if (historyIds && archive.history?.scores) {
      const historyScore = Number(archive.history.scores.split(',')[historyIds.indexOf(id)]);
      if (historyScore !== local.total) differences.push({ part: 'historyScore', local: local.total, bga: historyScore });
    }
    return { player: id, local: { ...local, resourceParts: byResource }, bga: clone(bga),
      finalScore: finalScores[id], differences, metrics: metrics[id] };
  });
  timeline.push(...prefinal.placements.sort((a, b) => a.event - b.event));
  return { format: 'whitecastle-bga-rule-audit', version: 1, table: String(archive.source.table),
    scope: 'notification-projection-and-final-scoring', fullActionReplayVerified: false,
    executable: false, trainingEligible: false, checks, issues,
    scoreMatched: comparisons.every((item) => item.differences.length === 0),
    players: comparisons, placements: timeline,
    missing: ['full-engine-action-replay', 'effect-choice-and-cost-parity', 'round-end-chain-parity'] };
}
