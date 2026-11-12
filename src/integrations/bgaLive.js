import { importBgaObservation } from './bgaReplay.js';

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const cleanText = (value, length = 300) => typeof value === 'string' ? value.slice(0, length) : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => typeof value?.[key] === 'string')
  .map((key) => [key, value[key].slice(0, 180)]));

/** 接收端再做字段白名单；实时快照不保留日志、请求头或网页运行时对象。 */
export function sanitizeLiveCapture(payload) {
  const { source, observation, watchId, sequence } = payload ?? {};
  if (!/^[\da-f-]{36}$/.test(watchId ?? '') || !Number.isSafeInteger(sequence) || sequence < 1
    || !/^\d+$/.test(source?.table ?? '') || typeof source?.host !== 'string'
    || !/^(?:[a-z0-9-]+\.)*boardgamearena\.com$/.test(source.host)
    || observation?.format !== 'whitecastle-bga-observation' || observation.version !== 1) fail('BGA_LIVE_INVALID');
  for (const key of ['players', 'cards', 'tiles', 'dice', 'pieces', 'decks']) {
    if (!Array.isArray(observation[key]) || observation[key].length > (key === 'players' ? 4 : 500)) fail('BGA_LIVE_INVALID');
  }
  if (observation.players.length < 2 || new Set(observation.players.map((player) => player.id)).size !== observation.players.length) fail('BGA_LIVE_INVALID');
  const items = (key) => observation[key].map((item) => {
    if (typeof item?.id !== 'string' || !Array.isArray(item.ancestors) || item.ancestors.length > 80) fail('BGA_LIVE_INVALID');
    return {
      id: cleanText(item.id, 180), data: pick(item.data, ['side', 'type', 'value']),
      face: item.face ? pick(item.face, ['type', 'typeArg', 'color']) : null,
      ancestors: item.ancestors.map((ancestor) => pick(ancestor, ['id', 'slot'])),
    };
  });
  const players = observation.players.map((player) => {
    if (typeof player?.id !== 'string' || !/^\d+$/.test(player.id)) fail('BGA_LIVE_INVALID');
    return { id: player.id, name: cleanText(player.name, 100), color: cleanText(player.color, 50),
      score: count(player.score), resources: Object.fromEntries(['coin', 'seal', 'food', 'iron', 'pearl', 'vp', 'heron']
        .filter((key) => Object.hasOwn(player.resources ?? {}, key)).map((key) => [key, count(player.resources[key])])) };
  });
  return {
    watchId, sequence,
    source: { table: source.table, host: source.host,
      gameAssetVersion: /^\d{6}-\d{4}$/.test(source.gameAssetVersion ?? '') ? source.gameAssetVersion : null },
    observation: { format: observation.format, version: 1, cursor: count(observation.cursor),
      progress: count(observation.progress), title: cleanText(observation.title),
      draftPairs: Array.isArray(observation.draftPairs) && observation.draftPairs.length <= 3
        ? observation.draftPairs.map((pair) => pick(pair, ['resource', 'action'])) : [],
      roundText: cleanText(observation.roundText, 100), players, cards: items('cards'),
      tiles: items('tiles'), dice: items('dice'), pieces: items('pieces'),
      decks: observation.decks.map((deck) => ({ kind: cleanText(deck.kind, 30), count: count(deck.count) })), logs: [] },
  };
}

export function mapLiveCapture(capture, catalog, mapping) {
  if (capture.source.gameAssetVersion !== mapping.gameAssetVersion) {
    return { archive: null, issues: [{ code: 'BGA_ASSET_VERSION_MISMATCH' }] };
  }
  if (capture.observation.players.length !== 2) {
    return { archive: null, issues: [{ code: 'BGA_LIVE_TWO_PLAYERS_REQUIRED' }] };
  }
  try {
    const seatMap = Object.fromEntries(capture.observation.players.map((player, index) => [player.id, String(index)]));
    const archive = importBgaObservation(capture.observation, {
      catalog, mapping, source: capture.source, seatMap, mode: 'live',
    });
    return { archive, issues: archive.status.issues };
  } catch (error) {
    return { archive: null, issues: [{ code: error.code ?? 'BGA_LIVE_MAPPING_FAILED' }] };
  }
}
