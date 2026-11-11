import { canonicalCatalog, validateCatalog } from '../data/catalog.js';
import { createPosition, score } from '../engine/engine.js';
import { VERIFIED_TIME_SCORES } from '../engine/influence.js';

export const BGA_ARCHIVE_VERSION = 1;
const COLORS = Object.freeze({ red: 'coral', black: 'black', white: 'white' });
const ASSETS = Object.freeze({ coin: 'coin', seal: 'seal', food: 'food', iron: 'iron', pearl: 'pearl', vp: 'points', heron: 'influence' });
const clone = (value) => structuredClone(value);
const fail = (code, details) => { throw Object.assign(new Error(code), { code, details }); };
const slot = (item) => item.ancestors?.find((ancestor) => ancestor.slot !== undefined)?.slot ?? null;

export function mapBgaDefinition(mapping, family, definition, side) {
  if (family === 'yard') definition = `${side}:${definition}`;
  const group = Object.hasOwn(mapping.mappings, family) ? mapping.mappings[family] : null;
  const result = group && Object.hasOwn(group, definition) ? group[definition] : null;
  if (result) return clone(result);
  if (mapping.excluded?.[family]?.includes(Number(definition))) {
    return { excludedInTwoPlayers: true, family, definition: Number(definition) };
  }
  fail('BGA_MAPPING_MISSING', { family, definition, side });
}

function colorKey(value) {
  if (/^#[a-f0-9]{6}$/i.test(value ?? '')) return value.toLowerCase();
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value ?? '');
  return rgb ? `#${rgb.slice(1).map((part) => Number(part).toString(16).padStart(2, '0')).join('')}` : null;
}

/**
 * 导入观察档案，不伪造可操作引擎存档。后续日志只在 history 中保留，
 * publicPosition 只来自选定游标的 DOM，未知牌背不会借助终局信息补正面。
 */
export function importBgaObservation(observation, { catalog, mapping, source, seatMap, mode = 'replay' }) {
  if (mapping?.format !== 'whitecastle-bga-mapping' || mapping.version !== 1
    || validateCatalog(catalog).length || catalog.revision !== mapping.catalogRevision) fail('BGA_CATALOG_MISMATCH');
  if (mapping.gameAssetVersion !== source?.gameAssetVersion) fail('BGA_ASSET_VERSION_MISMATCH');
  const validCursor = Number.isSafeInteger(observation?.cursor) && observation.cursor >= 1;
  const validProgress = Number.isInteger(observation?.progress) && observation.progress >= 0 && observation.progress <= 100;
  if (!['replay', 'live'].includes(mode)
    || observation?.format !== 'whitecastle-bga-observation' || observation.version !== 1
    || !(validCursor || (mode === 'live' && observation.cursor === null))
    || !(validProgress || (mode === 'live' && observation.progress === null))
    || !Array.isArray(observation.players) || observation.players.length !== 2
    || new Set(observation.players.map((player) => player.id)).size !== 2
    || !['cards', 'tiles', 'pieces', 'dice', 'decks'].every((key) => Array.isArray(observation[key]))
    || Object.keys(seatMap ?? {}).length !== 2
    || new Set(Object.values(seatMap)).size !== 2
    || Object.values(seatMap).some((seat) => !['0', '1'].includes(seat))) fail('BGA_OBSERVATION_INVALID');
  const catalogIds = new Set([...catalog.cards, ...catalog.yardFaces].map((item) => item.id));
  const issues = [];
  const instances = new Map();
  const usedCopies = new Map();
  const mapped = (family, definition, side) => {
    try {
      const result = mapBgaDefinition(mapping, family, definition, side);
      if (Array.isArray(result)) {
        const key = `${family}:${definition}`;
        const index = usedCopies.get(key) ?? 0;
        usedCopies.set(key, index + 1);
        if (index >= result.length) fail('BGA_DUPLICATE_CARD', { key });
        return result[index];
      }
      if (typeof result !== 'string' || !catalogIds.has(result)) {
        issues.push({ code: 'BGA_CARD_EXCLUDED', family, definition });
        return null;
      }
      return result;
    } catch (error) {
      issues.push({ code: error.code ?? 'BGA_MAPPING_MISSING', family, definition, side });
      return null;
    }
  };
  const cards = observation.cards.map((item) => {
    if (instances.has(item.id)) fail('BGA_DUPLICATE_CARD', { instance: item.id });
    const family = item.id.startsWith('twc-garden-card-') ? 'garden'
      : item.id.startsWith('twc-daimyo-card-') ? 'daimyo' : item.face?.type;
    const definition = ['garden', 'daimyo'].includes(family) ? item.face?.type : item.face?.typeArg;
    const faceDown = item.data.side === 'back';
    let localId = null;
    let back = null;
    if (faceDown) {
      if (family === 'decree' && Object.hasOwn(mapping.mappings.decree, definition)) localId = mapped(family, definition);
      else if (family === 'steward') back = [{ type: 'coin', amount: 1 }];
      else if (family === 'diplomat') back = [{ type: 'points', amount: 1 }];
      else if (family === 'starting-action') back = [{ type: 'influence', amount: 1 }];
      else if (family === 'starting-resources' && ['food', 'iron', 'pearl'].includes(definition)) back = [{ type: definition, amount: 1 }];
      else issues.push({ code: 'BGA_UNKNOWN_BACK', instance: item.id, family, definition });
    } else localId = mapped(family, definition);
    const result = { instance: item.id, family, definition, localId, faceDown, back, slot: slot(item), containers: item.ancestors.map((parent) => parent.id).filter(Boolean) };
    instances.set(item.id, result);
    return result;
  });
  const players = observation.players.map((player) => {
    if (!Object.hasOwn(seatMap, player.id) || !Number.isInteger(player.score) || player.score < 0) fail('BGA_PLAYER_INVALID');
    for (const name of ['coin', 'seal', 'food', 'iron', 'pearl']) {
      const value = player.resources[name];
      if (!Number.isInteger(value) || value < 0 || (name === 'seal' && value > 5)
        || (['food', 'iron', 'pearl'].includes(name) && value > 7)) fail('BGA_RESOURCE_MISSING', { player: player.id, name });
    }
    if (!colorKey(player.color)) fail('BGA_PLAYER_COLOR_INVALID');
    return { seat: seatMap[player.id], platformId: player.id, color: colorKey(player.color),
      resources: clone(player.resources), displayedScore: player.score };
  });
  if (new Set(players.map((player) => player.color)).size !== 2) fail('BGA_PLAYER_COLOR_INVALID');
  const owner = (piece) => players.find((player) => player.color === colorKey(piece.face?.color))?.seat ?? null;
  const pieces = observation.pieces.map((piece) => {
    const result = { instance: piece.id, type: piece.face?.type, owner: owner(piece), slot: slot(piece),
      containers: piece.ancestors.map((parent) => parent.id).filter(Boolean) };
    if (result.owner === null) issues.push({ code: 'BGA_PIECE_OWNER_UNKNOWN', instance: piece.id });
    return result;
  });
  const dice = observation.dice.map((die) => {
    const color = COLORS[die.data.type];
    const value = Number(die.data.value);
    if (!color || !Number.isInteger(value) || value < 1 || value > 6 || !slot(die)) fail('BGA_DIE_INVALID', { instance: die.id });
    return { instance: die.id, color, value, slot: slot(die) };
  });
  if (new Set(dice.map((die) => die.instance)).size !== dice.length || dice.length !== 9) issues.push({ code: 'BGA_DICE_COUNT', actual: dice.length });
  const training = observation.tiles.filter((tile) => tile.id.startsWith('twc-yard-tile-')).map((tile) => ({
    instance: tile.id, slot: slot(tile), side: tile.data.side, definition: tile.face?.type,
    localId: mapped('yard', tile.face?.type, tile.data.side),
  }));
  const dieTiles = observation.tiles.filter((tile) => tile.id.startsWith('twc-die-tile-')).map((tile) => ({
    instance: tile.id, slot: slot(tile), side: tile.data.side,
    color: COLORS[tile.face?.type] ?? null,
    reward: tile.data.side === 'back' ? (tile.face?.type === 'resource' ? 'chooseResource' : ASSETS[tile.face?.type] ?? null) : null,
  }));
  const history = clone(observation.logs ?? []);
  if (history.some((group) => !Number.isSafeInteger(group.move) || !Array.isArray(group.entries))
    || new Set(history.map((group) => group.move)).size !== history.length) fail('BGA_LOG_INVALID');
  return {
    format: 'whitecastle-bga-archive', version: BGA_ARCHIVE_VERSION,
    source: clone(source), catalogRevision: catalog.revision,
    catalogSignature: canonicalCatalog(catalog), mappingSignature: canonicalCatalog(mapping),
    status: { observationImported: true, executable: false, trainingEligible: false, issues,
      missing: ['verified-action-transcript', 'undo-targets', 'step-by-step-state-parity'] },
    publicPosition: { cursor: observation.cursor, progress: observation.progress, roundText: observation.roundText,
      players, cards, pieces, dice, training, dieTiles, decks: clone(observation.decks) },
    history,
    historySummary: {
      groups: history.length, entries: history.reduce((sum, group) => sum + group.entries.length, 0),
      undoMoves: history.filter((group) => group.entries.some((entry) => /撤销|重新开始/.test(entry.text))).map((group) => group.move),
    },
  };
}

/** 覆盖率只计算字典目标，不能视为规则兼容或整局重放通过。 */
export function bgaMappingCoverage(catalog, mapping) {
  const targets = new Set(Object.values(mapping.mappings).flatMap((family) => Object.values(family).flat()));
  return {
    cards: { mapped: catalog.cards.filter((card) => targets.has(card.id)).length, total: catalog.cards.length,
      missing: catalog.cards.filter((card) => !targets.has(card.id)).map((card) => card.id) },
    yardFaces: { mapped: catalog.yardFaces.filter((face) => targets.has(face.id)).length, total: catalog.yardFaces.length,
      missing: catalog.yardFaces.filter((face) => !targets.has(face.id)).map((face) => face.id) },
  };
}

/**
 * 只把计分前已公开的资源与棋子位置交给同一个计分器。
 * 这不是从开局执行动作得到的状态，不能据此开放续玩或生成策略样本。
 */
export function scoreBgaPublicPosition(archive, catalog, { scoreTiming } = {}) {
  if (archive?.format !== 'whitecastle-bga-archive' || scoreTiming !== 'before-final-scoring'
    || archive.publicPosition.progress === 100 || archive.catalogSignature !== canonicalCatalog(catalog)
    || archive.status.issues.length) fail('BGA_SCORE_INPUT_INVALID');
  const { players, pieces, cards } = archive.publicPosition;
  const cardInstances = new Map(cards.map((card) => [card.instance, card]));
  const yardIds = { 1: 'yard-cost-5', 2: 'yard-cost-3', 3: 'yard-cost-1' };
  const playerSetup = ['0', '1'].map((id) => {
    const player = players.find((entry) => entry.seat === id);
    if (!player) fail('BGA_PLAYER_INVALID');
    const figures = { courtier: [], warrior: [], gardener: [] };
    const own = pieces.filter((piece) => piece.owner === id);
    for (const piece of own) {
      if (piece.containers.some((container) => /^twc-player-board-/.test(container))) continue;
      if (piece.type === 'courtier') {
        const room = piece.containers.find((container) => /^twc-castle-room-main-board-/.test(container));
        const match = /^twc-castle-room-main-board-(steward|diplomat)-(\d+)(?:-courtier-stock)?$/.exec(room ?? '');
        if (match) figures.courtier.push({ location: match[1] === 'steward' ? 'floor1' : 'floor2', roomId: `${match[1] === 'steward' ? 'floor1' : 'floor2'}-${match[2]}` });
        else if (room?.includes('-gate')) figures.courtier.push({ location: 'gate' });
        else if (piece.containers.includes('twc-daimyo-courtier-stock')) figures.courtier.push({ location: 'floor3' });
        else fail('BGA_COURTIER_LOCATION_UNKNOWN', { instance: piece.instance });
      } else if (piece.type === 'warrior') {
        const yard = piece.containers.map((container) => /^twc-training-yard-(\d+)$/.exec(container)).find(Boolean);
        if (!yard || !yardIds[yard[1]]) fail('BGA_YARD_LOCATION_UNKNOWN');
        figures.warrior.push({ yardId: yardIds[yard[1]] });
      } else if (piece.type === 'gardener') {
        const garden = piece.containers.map((container) => cardInstances.get(container)).find((card) => card?.family === 'garden');
        if (!garden?.localId) fail('BGA_GARDEN_LOCATION_UNKNOWN');
        figures.gardener.push({ cardId: garden.localId, bridgeId: COLORS[garden.slot?.split('-')[0]] });
      }
    }
    const influence = own.find((piece) => piece.type === 'influence');
    const time = /^influence-(\d+)$/.exec(influence?.slot ?? '');
    if (!time) fail('BGA_INFLUENCE_UNKNOWN');
    return { resources: { ...player.resources, points: player.displayedScore }, figures, timePosition: Number(time[1]) };
  });
  const config = clone(catalog);
  config.timeTrack = clone(VERIFIED_TIME_SCORES);
  config.setup = { players: playerSetup };
  const state = createPosition(config);
  state.round = 3;
  state.phase = 'round-end';
  const order = [...players].sort((left, right) => (
    state.players[right.seat].timePosition - state.players[left.seat].timePosition
  ));
  if (state.players['0'].timePosition === state.players['1'].timePosition) fail('BGA_FINAL_ORDER_UNKNOWN');
  order.forEach((player, index) => { state.players[player.seat].finalOrder = index; });
  const result = score(state, config);
  return { method: 'public-prefinal-snapshot-score-only', actionReplayVerified: false,
    sourceCursor: archive.publicPosition.cursor, result };
}
