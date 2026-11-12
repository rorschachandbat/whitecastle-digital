import { canonicalCatalog, validateCatalog } from '../data/catalog.js';
import { createPosition, applyAction, resolveGardenReward, score, EngineError } from './engine.js';
import { createStartingDraft, chooseStartingPair } from './startingDraft.js';
import { VERIFIED_TIME_SCORES } from './influence.js';

export const LOCAL_MATCH_VERSION = 1;
export const LOCAL_PROFILE_ID = 'local-practice-v1';
const COLORS = Object.freeze(['coral', 'black', 'white']);
const PLAYER_IDS = Object.freeze(['0', '1']);
const clone = (value) => structuredClone(value);
const fail = (code, details) => { throw new EngineError(code, code, details); };

function randomFromSeed(seed) {
  let state = 2166136261;
  for (const code of seed) state = Math.imul(state ^ code.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

/** 房间至少两种骰色。两格必须不同色；三格可以有两格同色，但不能三格同色。 */
function roomTileColors(count, random) {
  let colors;
  do {
    colors = Array.from({ length: count }, () => COLORS[Math.floor(random() * COLORS.length)]);
  } while (new Set(colors).size < 2);
  return colors;
}

function cardsOf(config, kind) {
  return config.cards.filter((card) => card.kind === kind && card.verification === 'confirmed'
    && (!card.playerCounts || card.playerCounts.includes(2)));
}

function darkAction(card) {
  return card.fields.filter((field) => field.tone === 'dark')
    .flatMap((field) => field.effects.map((effect) => effect.type)).join('|');
}

function optionsOf(options) {
  const seed = String(options.seed ?? 'whitecastle-local-v1');
  if (seed.length > 200) fail('INVALID_SEED');
  const playOrder = options.playOrder === undefined
    ? shuffled(PLAYER_IDS, randomFromSeed(`${seed}:order`))
    : clone(options.playOrder);
  if (!Array.isArray(playOrder) || playOrder.length !== 2
    || new Set(playOrder).size !== 2 || playOrder.some((id) => !PLAYER_IDS.includes(id))) fail('INVALID_STATE');
  return {
    seed, playOrder,
    ...(options.trainingYards === undefined ? {} : { trainingYards: clone(options.trainingYards) }),
  };
}

function trainingOf(config, proposed, random) {
  if (proposed === undefined) {
    const pools = ['gold', 'silver'].map((id) => {
      const pool = config.trainingPools?.find((item) => item.id === id);
      if (!pool || !Array.isArray(pool.faceIds) || pool.faceIds.length < 2) fail('DATA_UNVERIFIED');
      return shuffled(pool.faceIds, random);
    });
    proposed = [
      { id: 'yard-cost-1', faceIds: [pools[0][0]] },
      { id: 'yard-cost-3', faceIds: [pools[1][0]] },
      { id: 'yard-cost-5', faceIds: [pools[0][1], pools[1][1]] },
    ];
  }
  if (!Array.isArray(proposed) || proposed.length !== 3) fail('INVALID_STATE');
  const used = new Set();
  return config.trainingZones.map((zone) => {
    const yard = proposed.find((item) => item.id === zone.id);
    if (!yard || !Array.isArray(yard.faceIds) || yard.faceIds.length !== zone.faceTones.length) fail('INVALID_STATE');
    const tones = yard.faceIds.map((id) => {
      const face = config.yardFaces.find((item) => item.id === id && item.verification === 'confirmed');
      if (!face || used.has(id)) fail('INVALID_STATE');
      used.add(id);
      return face.tone;
    });
    if ([...tones].sort().join('|') !== [...zone.faceTones].sort().join('|')) fail('INVALID_STATE');
    return { id: zone.id, faceIds: [...yard.faceIds] };
  });
}

function positionConfig(catalog, options) {
  const config = clone(catalog);
  // 生成器不混用上次实验局面的顶层覆盖项，所有本局摆设集中到 setup。
  for (const key of ['players', 'bridges', 'placements', 'wellRewards', 'initialPlayer']) delete config[key];
  const random = randomFromSeed(`${options.seed}:board`);
  let stewards;
  let diplomats;
  let attempts = 0;
  do {
    stewards = shuffled(cardsOf(config, 'steward'), random);
    diplomats = shuffled(cardsOf(config, 'diplomat'), random);
    attempts += 1;
    if (attempts > 100) fail('DATA_UNVERIFIED');
  } while (new Set([...stewards.slice(0, 3), ...diplomats.slice(0, 2)].map(darkAction)).size < 2);
  if (stewards.length < 3 || diplomats.length < 2) fail('INSUFFICIENT_CARDS');
  const castleRooms = [
    ...stewards.slice(0, 3).map((card, index) => {
      const tileColors = roomTileColors(3, random);
      return {
        id: `floor1-${index + 1}`, floor: 1, cardId: card.id,
        tiles: ['top', 'middle', 'bottom'].map((fieldId, colorIndex) => ({
          fieldId, color: tileColors[colorIndex],
        })),
      };
    }),
    ...diplomats.slice(0, 2).map((card, index) => {
      const tileColors = roomTileColors(2, random);
      return {
        id: `floor2-${index + 1}`, floor: 2, cardId: card.id,
        tiles: ['upper', 'lower'].map((fieldId, colorIndex) => ({
          fieldId, color: tileColors[colorIndex],
        })),
      };
    }),
  ];
  const gardens = ['plant', 'stone'].flatMap((kind) => {
    const cards = shuffled(cardsOf(config, kind), random);
    if (cards.length < 3) fail('INSUFFICIENT_CARDS');
    return cards.slice(0, 3).map((card, index) => ({ cardId: card.id, bridgeId: COLORS[index] }));
  });
  const top = shuffled(cardsOf(config, 'top'), random)[0];
  if (!top) fail('INSUFFICIENT_CARDS');
  config.policy = { ...config.policy, singleDieEndpoint: 'physical' };
  config.practiceProfile = {
    id: LOCAL_PROFILE_ID,
    warnings: [
      'CASTLE_LAYOUT_EXPERIMENTAL', 'WELL_TILES_EXPERIMENTAL',
      'TIME_GATE_PARTIAL_EXPERIMENTAL',
      'ROUND_GARDEN_ELIGIBILITY_EXPERIMENTAL',
    ],
  };
  // 格值和跨季费用来自出版方主棋盘；拒付时的部分移动仍使用明确标记的练习处理。
  config.influenceTrack = {
    fixtureVersion: 'verified-time-track-v1', max: 20,
    gates: [{ at: 6, cost: 1 }, { at: 11, cost: 2 }, { at: 15, cost: 3 }],
  };
  config.timeTrack = clone(VERIFIED_TIME_SCORES);
  config.setup = {
    playOrder: [...options.playOrder], initialPlayer: options.playOrder[0],
    gardens, castleRooms,
    castleDecks: { steward: stewards.slice(3).map((card) => card.id), diplomat: diplomats.slice(2).map((card) => card.id) },
    topCardId: top.id, topSlots: {},
    trainingMode: options.trainingYards === undefined ? 'separate-pools' : 'manual-visible-faces',
    trainingYards: trainingOf(config, options.trainingYards, random),
    fixtureVersion: 'well-rewards-v1',
    wellRewards: [{ type: 'food', amount: 1 }, { type: 'iron', amount: 1 }],
    placements: {
      ...Object.fromEntries(castleRooms.map((room) => [`castle:${room.id}`, {
        area: 'castle', comparisonValue: room.floor === 1 ? 3 : 4,
      }])),
      'outside:left': { area: 'outside', comparisonValue: 5 },
      'outside:right': { area: 'outside', comparisonValue: 5 },
    },
  };
  return config;
}

/**
 * 创建可重放的两人本地练习。起始选牌后才创建引擎状态；
 * 存档始终携带完整目录和实验配置标记，不伪装为已核验的正式随机开局。
 */
export function createLocalMatch(catalog, options = {}) {
  if (validateCatalog(catalog).length) fail('INVALID_CATALOG');
  const normalized = optionsOf(options);
  const config = positionConfig(catalog, normalized);
  return {
    schemaVersion: LOCAL_MATCH_VERSION, mode: 'local-practice', phase: 'draft',
    seed: normalized.seed, options: normalized, catalog: clone(catalog), config,
    profile: clone(config.practiceProfile),
    draft: createStartingDraft(config, { seed: `${normalized.seed}:draft`, playOrder: normalized.playOrder }),
    state: null, roundGardens: null, actions: [],
  };
}

export function activeLocalPlayer(match) {
  if (match?.phase === 'draft') return match.draft.nextPlayerId;
  if (match?.phase === 'round-gardens') return match.roundGardens.order[match.roundGardens.playerIndex] ?? null;
  if (match?.phase === 'playing') return match.state.activePlayer;
  return null;
}

export function remainingRoundGardens(match) {
  if (match?.phase !== 'round-gardens') return [];
  const actor = activeLocalPlayer(match);
  return [...(match.roundGardens.remaining[actor] ?? [])];
}

function orderByInfluence(state) {
  return [...state.playOrder].sort((left, right) => (
    state.players[right].timePosition - state.players[left].timePosition
    || (state.players[right].timePriority ?? 0) - (state.players[left].timePriority ?? 0)
    || state.playOrder.indexOf(left) - state.playOrder.indexOf(right)
  ));
}

function beginNextRound(match) {
  const state = match.state;
  const nextRound = state.round + 1;
  // 利用相同创建器生成下一轮九骰；只清理骰子，不重建牌堆、人员或卡牌。
  const rolled = createPosition(match.config, { seed: `${match.seed}:round:${nextRound}` });
  state.bridges = rolled.bridges;
  for (const placement of Object.values(state.placements)) placement.dice = [];
  state.round = nextRound;
  state.turnsUsed = { '0': 0, '1': 0 };
  state.phase = 'action';
  state.activePlayer = state.playOrder[0];
  match.phase = 'playing';
  match.roundGardens = null;
}

function advanceGardenPlayer(match) {
  while (match.roundGardens.playerIndex < 2) {
    const actor = activeLocalPlayer(match);
    if (match.roundGardens.remaining[actor].length) {
      match.state.activePlayer = actor;
      return;
    }
    match.roundGardens.playerIndex += 1;
  }
  beginNextRound(match);
}

function endRound(match) {
  const state = match.state;
  state.playOrder = orderByInfluence(state);
  state.playOrder.forEach((id, index) => { state.players[id].finalOrder = index; });
  if (state.round === 3) {
    state.score = score(state, match.config);
    state.phase = 'finished';
    match.phase = 'finished';
    return;
  }
  const bridges = new Set(state.bridges.filter((bridge) => bridge.dice.length > 0).map((bridge) => bridge.id));
  match.phase = 'round-gardens';
  state.phase = 'round-end';
  match.roundGardens = {
    order: [...state.playOrder], playerIndex: 0,
    remaining: Object.fromEntries(state.playOrder.map((id) => [
      id, state.players[id].figures.gardener.filter((figure) => bridges.has(figure.bridgeId)).map((figure) => figure.cardId),
    ])),
  };
  advanceGardenPlayer(match);
}

function assertMatch(match) {
  if (!match || match.schemaVersion !== LOCAL_MATCH_VERSION || match.mode !== 'local-practice'
    || !Array.isArray(match.actions) || !['draft', 'playing', 'round-gardens', 'finished'].includes(match.phase)) {
    fail('INVALID_STATE');
  }
}

/** 每个动作均返回独立新对象；出错时不修改原对局，也不把半完成动作写入记录。 */
export function applyLocalAction(match, action) {
  assertMatch(match);
  if (!action || typeof action !== 'object') fail('INVALID_ACTION');
  if (match.phase === 'finished') fail('GAME_FINISHED');
  const actor = activeLocalPlayer(match);
  if (action.actor !== actor) fail('NOT_ACTIVE_PLAYER');
  const next = clone(match);
  if (next.phase === 'draft') {
    if (action.type !== 'chooseStartingPair') fail('INVALID_ACTION');
    next.draft = chooseStartingPair(next.draft, actor, action.pairId, next.config, { choices: action.choices ?? [] });
    if (next.draft.phase === 'complete') {
      next.config.setup.players = PLAYER_IDS.map((id) => next.draft.players[id]);
      next.state = createPosition(next.config, { seed: `${next.seed}:round:1` });
      next.state.mode = 'local-practice';
      next.state.timeSequence = 2;
      next.state.playOrder.forEach((id, index) => { next.state.players[id].timePriority = 2 - index; });
      next.phase = 'playing';
    }
  } else if (next.phase === 'round-gardens') {
    if (action.type === 'exchangeSeal') {
      // 轮末花园之间仍允许当前结算玩家先兑换；不消耗花园奖励或常规回合。
      const phase = next.state.phase;
      next.state = applyAction({ ...next.state, phase: 'action' }, action, next.config);
      next.state.phase = phase;
    } else {
      if (action.type !== 'roundGarden' || !remainingRoundGardens(next).includes(action.cardId)) fail('INVALID_ACTION');
      next.state = resolveGardenReward(next.state, actor, action.cardId, action, next.config);
      next.roundGardens.remaining[actor] = next.roundGardens.remaining[actor].filter((id) => id !== action.cardId);
      advanceGardenPlayer(next);
    }
  } else {
    next.state = applyAction(next.state, action, next.config);
    if (next.state.phase === 'round-end') endRound(next);
  }
  next.actions.push(clone(action));
  return next;
}

/** 存档只接受可重放的动作记录，导入时不信任外部提供的局面对象。 */
export function exportLocalMatch(match) {
  assertMatch(match);
  return {
    format: 'whitecastle-local-replay', version: LOCAL_MATCH_VERSION,
    catalog: clone(match.catalog), options: clone(match.options), actions: clone(match.actions),
  };
}

export function importLocalMatch(save) {
  if (!save || save.format !== 'whitecastle-local-replay' || save.version !== LOCAL_MATCH_VERSION
    || !Array.isArray(save.actions) || save.actions.length > 2000) fail('INVALID_SAVE');
  let match = createLocalMatch(save.catalog, save.options);
  for (const action of save.actions) match = applyLocalAction(match, action);
  return match;
}

/** 用于撤销或试走后回到历史节点；不能修改记录后附带的伪造状态。 */
export function replayLocalMatch(match, actionCount) {
  assertMatch(match);
  if (!Number.isSafeInteger(actionCount) || actionCount < 0 || actionCount > match.actions.length) fail('INVALID_AMOUNT');
  const save = exportLocalMatch(match);
  save.actions = save.actions.slice(0, actionCount);
  return importLocalMatch(save);
}

export function localMatchSignature(match) {
  return canonicalCatalog(exportLocalMatch(match));
}
