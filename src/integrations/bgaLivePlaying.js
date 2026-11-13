import { canonicalCatalog } from '../data/catalog.js';
import { createPosition } from '../engine/engine.js';
import { TrainingEnvironment } from '../ai/environment.js';
import { encodeState } from '../ai/features.js';
import { buildLiveBoard, prepareLiveAdvice } from './bgaLiveAdvice.js';

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const one = (items, code = 'BGA_ADVICE_SETUP') => {
  if (items.length !== 1) fail(code);
  return items[0];
};
const inside = (item, container) => item.containers.includes(container);
const equal = (a, b) => canonicalCatalog(a) === canonicalCatalog(b);
const colors = { red: 'coral', black: 'black', white: 'white' };
const rows = { courtier: 'courtiers', gardener: 'gardeners', warrior: 'warriors' };
const timestamp = (latest) => Date.parse(latest.changedAt ?? latest.receivedAt ?? '');
const identity = (latest) => JSON.stringify([latest.source.table, latest.source.gameAssetVersion,
  latest.archive.publicPosition.players.map((player) => player.platformId).sort()]);
const sessions = new WeakMap();
const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
export const isPlacementTitle = (title, subject) => [
  `${subject} 必须从桥上选择一个骰子并将它放在一个行动位置上`,
  `${subject} 必须从桥中选择一个骰子，并将其放置在一个行动上`,
].includes(title?.trim());
export const getPlayingSession = (prepared) => sessions.get(prepared);
export const setPlayingSession = (prepared, session) => sessions.set(prepared, session);

/** 缺少历史到达次序时，对两种时间优先关系平均；不把任意关系当作已知事实。 */
export function publicObservations(env, uncertainPriority) {
  const observation = env.observe();
  const original = env.match.draft.pairs;
  const state = env.probe?.request?.state ?? env.match.state;
  const players = [state.players['0'], state.players['1']];
  const priorities = players.map((player) => player.timePriority);
  const requestPlayer = env.probe?.request?.player;
  const requestPriority = requestPlayer?.timePriority;
  const observations = [];
  const unresolved = uncertainPriority && [...priorities, requestPriority ?? 0].every((priority) => priority <= 2);
  for (const order of unresolved ? [[1, 2], [2, 1]] : [priorities]) {
    players.forEach((player, index) => { player.timePriority = order[index]; });
    if (requestPlayer && unresolved) requestPlayer.timePriority = order[Number(env.actor)];
    for (const indices of permutations) {
      env.match.draft.pairs = indices.map((index) => original[index]);
      observations.push({ ...observation, state: encodeState(env) });
    }
  }
  env.match.draft.pairs = original;
  players.forEach((player, index) => { player.timePriority = priorities[index]; });
  if (requestPlayer) requestPlayer.timePriority = requestPriority;
  return observations;
}

/** 按时间保存已经公开的事实。牌背不覆盖曾见正面，桌号及玩家变更后重新收集。 */
export function rememberLiveContext(previous, latest, parameters) {
  if (!latest?.archive || latest.issues?.length || !Number.isFinite(timestamp(latest))) return previous;
  const key = identity(latest);
  const context = previous?.identity === key ? structuredClone(previous)
    : { version: 1, identity: key, seenAt: 0, faces: {}, pairs: null };
  if (timestamp(latest) < context.seenAt) return context;
  const p = latest.archive.publicPosition;
  if (p.progress === 0 && !context.opening) context.opening = structuredClone(latest);
  for (const card of p.cards) {
    if (!card.faceDown && card.localId) context.faces[card.instance] = {
      instance: card.instance, family: card.family, definition: card.definition, localId: card.localId,
    };
  }
  try {
    // 已选资源只有在起始收益、法令和牌背唯一对账时才恢复，复用选牌适配器的检查。
    const prepared = prepareLiveAdvice(latest, parameters);
    const pairs = prepared.draftContext;
    for (const pair of pairs) {
      context.faces[pair.resource.instance] = pair.resource;
      context.faces[pair.action.instance] = pair.action;
    }
    context.pairs = pairs;
  } catch {}
  if (!context.pairs && context.opening && timestamp(latest) >= timestamp(context.opening)) {
    try {
      const opening = structuredClone(context.opening);
      const original = opening.archive.publicPosition;
      const resources = original.cards.filter((card) => inside(card, 'twc-starting-resource-draft-stock'));
      const actions = original.cards.filter((card) => inside(card, 'twc-starting-action-draft-stock'));
      const ownerOf = (instance) => {
        const found = p.cards.filter((card) => card.instance === instance);
        if (found.length === 0) return 'unpicked';
        const now = one(found, 'BGA_ADVICE_CONTEXT');
        return p.players.find((player) => ['action', 'lantern'].some((area) =>
          inside(now, `twc-${area}-card-stock-${player.platformId}`)))?.platformId ?? 'unpicked';
      };
      // 没有几何配对的旧采样，只在当前归属使所有剩余配对各自唯一时补齐过去公开事实。
      opening.observation.draftPairs = resources.map((resource) => ({
        resource: resource.instance,
        action: one(actions.filter((action) => ownerOf(action.instance) === ownerOf(resource.instance)),
          'BGA_ADVICE_CONTEXT').instance,
      }));
      const pairs = prepareLiveAdvice(opening, parameters).draftContext;
      context.pairs = pairs;
      for (const pair of pairs) {
        context.faces[pair.resource.instance] = pair.resource;
        context.faces[pair.action.instance] = pair.action;
      }
    } catch {}
  }
  context.seenAt = timestamp(latest);
  if (isPlacementTitle(latest.observation.title, '你')
    || latest.observation.players?.some((player) => isPlacementTitle(latest.observation.title, player.name))) {
    try {
      // 连锁只从已校验的放骰前状态重建，动画中标题残留不能覆盖有效根局面。
      preparePlayingAdvice(latest, { ...parameters, context });
      context.root = structuredClone(latest);
      delete context.root.recommendations;
      context.rootFaces = structuredClone(context.faces);
    } catch {}
  }
  return context;
}

/** 未知补牌是分析边界；不让合法性试走把目录排列当作实际揭牌。 */
class PublicRootEnvironment extends TrainingEnvironment {
  probeChoice(probe, value) {
    if (value?.promote) {
      const figure = probe.request.player.figures.courtier[value.promote.figureIndex];
      const floor = ['gate', 'floor1', 'floor2', 'floor3'].indexOf(figure?.location
        ?? (value.audience && value.promote.figureIndex === probe.request.player.figures.courtier.length ? 'gate' : null));
      const destination = floor + value.promote.steps;
      const family = destination === 1 ? 'steward' : 'diplomat';
      if (destination < 3 && probe.request.state.castleDecks[family]?.length) return { status: 'public-chance' };
    }
    return super.probeChoice(probe, value);
  }

  canComplete(probe, budget, prefix) {
    // 此处只证明根放骰存在可选子行动，未知牌面后的连锁不纳入网络输入。
    if (probe.status === 'public-chance') return true;
    return super.canComplete(probe, budget, prefix);
  }
}

/** R-DIE-01/02/03/04：普通取放骰根节点，只导入可核验的公开状态，禁止直接用作训练或续玩存档。 */
export function preparePlayingAdvice(latest, { catalog, mapping, weights, context }) {
  if (!latest?.archive || latest.issues?.length || latest.source.gameAssetVersion !== mapping.gameAssetVersion
    || catalog.revision !== mapping.catalogRevision) fail('BGA_ADVICE_MAPPING');
  const p = latest.archive.publicPosition;
  const round = /^(?:第\s*)?([123])\s*\/\s*3\s*轮次$/.exec(p.roundText ?? '');
  const rootTitle = (subject) => isPlacementTitle(latest.observation.title, subject);
  let actors = latest.observation.players.filter((player) => rootTitle(player.name));
  if (!round || (!rootTitle('你') && actors.length !== 1) || p.players.length !== 2 || p.progress === 100) {
    fail('BGA_ADVICE_PHASE');
  }
  if (!Number.isFinite(timestamp(latest)) || !context?.pairs
    || context.identity !== identity(latest) || context.seenAt > timestamp(latest)) {
    fail('BGA_ADVICE_CONTEXT');
  }
  const herons = p.pieces.filter((piece) => piece.type === 'heron').sort((a, b) => Number(a.slot) - Number(b.slot));
  if (herons.length !== 2 || herons.some((piece, index) => piece.slot !== String(index + 1))
    || new Set(herons.map((piece) => piece.owner)).size !== 2) fail('BGA_ADVICE_SETUP');
  const playOrder = herons.map((piece) => piece.owner);
  if (rootTitle('你')) {
    const used = p.dice.filter((die) => !/^(red|black|white)-(left|center|right)$/.test(die.slot)).length;
    const player = one(p.players.filter((item) => item.seat === playOrder[used % 2]));
    actors = latest.observation.players.filter((item) => item.id === player.platformId);
  }
  const actor = one(p.players.filter((player) => player.platformId === actors[0].id)).seat;
  const pairs = context.pairs.map((pair) => ({
    resource: { ...pair.resource }, action: { ...pair.action },
  }));
  const own = (player, area) => p.cards.filter((card) => inside(card, `twc-${area}-card-stock-${player.platformId}`));
  const owners = new Set();
  const chosenBy = pairs.map((pair) => {
    const ownersOfPair = p.players.filter((player) => own(player, 'lantern').some((card) => card.instance === pair.resource.instance));
    if (!ownersOfPair.length) {
      if (p.cards.some((card) => card.instance === pair.resource.instance
        && !inside(card, 'twc-starting-resource-draft-stock'))
        || p.cards.some((card) => card.instance === pair.action.instance
          && !inside(card, 'twc-starting-action-draft-stock'))) fail('BGA_ADVICE_CONTEXT');
      return null;
    }
    const player = one(ownersOfPair);
    if (owners.has(player.seat) || ![...own(player, 'action'), ...own(player, 'lantern')]
      .some((card) => card.instance === pair.action.instance)) fail('BGA_ADVICE_CONTEXT');
    owners.add(player.seat);
    return player.seat;
  });
  if (owners.size !== 2) fail('BGA_ADVICE_CONTEXT');
  const publicRemovedCards = [...new Set(p.players.flatMap((player) =>
    [...own(player, 'action'), ...own(player, 'lantern')].map((card) =>
      card.localId ?? context.faces[card.instance]?.localId)).filter(Boolean))];
  const match = buildLiveBoard(latest, pairs, { catalog, mapping, playOrder, publicRemovedCards });
  match.draft.pairs.forEach((pair, index) => { pair.chosenBy = chosenBy[index]; });
  match.draft.phase = 'complete';
  match.draft.nextPickIndex = 2;
  match.draft.nextPlayerId = null;
  const localCard = (card) => {
    if (card.localId) return card.localId;
    const known = context.faces[card.instance];
    if (known) {
      const definition = catalog.cards.find((item) => item.id === known.localId);
      if (!definition || !equal(definition.back, card.back)) fail('BGA_ADVICE_CONTEXT');
      return known.localId;
    }
    if (!card.faceDown || !card.back) fail('BGA_ADVICE_SETUP');
    // 只加入已公开牌背的匿名效果，不赋予未知正面任何设计身份。
    const id = `public-back:${card.instance}`;
    match.config.cards.push({ id, verification: 'confirmed', back: card.back });
    return id;
  };
  const players = ['0', '1'].map((seat) => {
    const player = one(p.players.filter((item) => item.seat === seat));
    const figures = { courtier: [], warrior: [], gardener: [] };
    for (const type of Object.keys(rows)) {
      const pieces = p.pieces.filter((piece) => piece.type === type && piece.owner === seat);
      if (pieces.length !== 5) fail('BGA_ADVICE_SETUP');
      for (const piece of pieces) {
        if (inside(piece, `twc-player-board-${rows[type]}-${player.platformId}`)) continue;
        if (type === 'courtier') {
          const room = piece.containers.map((container) =>
            /^twc-castle-room-main-board-(steward|diplomat)-([123])(?:-courtier-stock)?$/.exec(container)).find(Boolean);
          if (room) {
            const roomId = `floor${room[1] === 'steward' ? 1 : 2}-${room[2]}`;
            if (!match.config.setup.castleRooms.some((item) => item.id === roomId)) fail('BGA_ADVICE_FIGURES');
            figures.courtier.push({ location: room[1] === 'steward' ? 'floor1' : 'floor2', roomId });
          } else if (inside(piece, 'twc-daimyo-courtier-stock') && /^[123]$/.test(piece.slot)) {
            const top = match.config.cards.find((card) => card.id === match.config.setup.topCardId);
            figures.courtier.push({ location: 'floor3', slotId: top.fields[Number(piece.slot) - 1].id });
          } else if (piece.containers.some((container) => container.includes('-gate'))) figures.courtier.push({ location: 'gate' });
          else fail('BGA_ADVICE_FIGURES');
        } else if (type === 'warrior') {
          const yard = piece.containers.map((container) => /^twc-training-yard-([123])$/.exec(container)).find(Boolean);
          if (!yard) fail('BGA_ADVICE_FIGURES');
          figures.warrior.push({ yardId: `yard-cost-${{ 1: 5, 2: 3, 3: 1 }[yard[1]]}` });
        } else {
          const garden = one(p.cards.filter((card) => card.family === 'garden' && piece.containers.includes(card.instance)));
          figures.gardener.push({ cardId: garden.localId, bridgeId: colors[garden.slot.split('-')[0]] });
        }
      }
    }
    const influence = one(p.pieces.filter((piece) => piece.owner === seat && piece.type === 'influence'));
    const time = /^influence-(\d+)$/.exec(influence.slot);
    if (!time || Number(time[1]) > 20) fail('BGA_ADVICE_TIME_ORDER');
    const current = one(own(player, 'action'));
    if (current.faceDown || !current.localId) fail('BGA_ADVICE_SETUP');
    return { resources: { ...player.resources, points: player.displayedScore }, figures,
      currentCard: localCard(current), lanternCards: own(player, 'lantern').map(localCard),
      timePosition: Number(time[1]), timePriority: 2 - playOrder.indexOf(seat),
      ...(Number(round[1]) > 1 ? { finalOrder: playOrder.indexOf(seat) } : {}) };
  });
  match.config.setup.players = players;
  for (const family of ['steward', 'diplomat']) {
    match.config.setup.castleDecks[family] = match.config.setup.castleDecks[family]
      .map((_, index) => `unknown-public-deck:${family}:${index}`);
  }
  match.state = createPosition(match.config);
  match.phase = 'playing';
  const state = match.state;
  state.round = Number(round[1]);
  for (const [seat, player] of Object.entries(state.players)) {
    for (const [figureIndex, figure] of player.figures.courtier.entries()) {
      if (figure.location !== 'floor3') continue;
      if (state.topSlots[figure.slotId]) fail('BGA_ADVICE_FIGURES');
      state.topSlots[figure.slotId] = { actor: seat, figureIndex };
    }
  }
  state.activePlayer = actor;
  state.mode = 'local-practice';
  state.timeSequence = 2;
  if (p.dice.length !== 9 || new Set(p.dice.map((die) => die.instance)).size !== 9) fail('BGA_ADVICE_SETUP');
  const remaining = new Set();
  state.bridges = Object.entries(colors).map(([bgaColor, color]) => {
    const dice = ['left', 'center', 'right'].flatMap((side) => {
      const found = p.dice.filter((die) => die.slot === `${bgaColor}-${side}`);
      if (found.length > 1 || found.some((die) => die.color !== color)) fail('BGA_ADVICE_SETUP');
      if (!found.length) return [];
      remaining.add(found[0].instance);
      return [{ id: found[0].instance, value: found[0].value, side }];
    });
    if (dice.some((die, index) => index && die.value < dice[index - 1].value)
      || dice.length === 1 && dice[0].side === 'center'
      || dice.length === 2 && (dice[0].side !== 'left' || dice[1].side !== 'right')) fail('BGA_ADVICE_SETUP');
    return { id: color, color, singleDieEndpoint: dice.length === 1 ? dice[0].side : null,
      dice: dice.map(({ id, value }) => ({ id, value })) };
  });
  for (const die of p.dice.filter((item) => !remaining.has(item.instance))) {
    let id;
    const castle = /^action-space-main-board-(steward|diplomat)-([123])$/.exec(die.slot);
    const personal = /^action-space-player-(?:board-)?(\d+)-(courtier|warrior|gardener|[123])$/.exec(die.slot);
    if (castle) id = `castle:floor${castle[1] === 'steward' ? 1 : 2}-${castle[2]}`;
    else if (personal) id = `personal:${one(p.players.filter((player) => player.platformId === personal[1])).seat}:${{
      1: 'courtier', 2: 'gardener', 3: 'warrior',
    }[personal[2]] ?? personal[2]}`;
    else if (die.slot === 'action-space-main-board-well') id = 'well';
    else {
      const outside = /^action-space-main-board-outside-(left|right)$/.exec(die.slot);
      const numbered = /^action-space-main-board-outside-the-walls-([12])$/.exec(die.slot);
      if (outside) id = `outside:${outside[1]}`;
      if (numbered) id = `outside:${numbered[1] === '1' ? 'left' : 'right'}`;
    }
    const place = state.placements[id];
    if (!place || place.capacity !== null && place.dice.length >= place.capacity) fail('BGA_ADVICE_DICE_SLOT');
    place.dice.push({ id: die.instance, value: die.value, color: die.color, sourceBridge: die.color });
  }
  const used = 9 - remaining.size;
  if (used >= 6 || playOrder[used % 2] !== actor) fail('BGA_ADVICE_TURN');
  state.turnsUsed = Object.fromEntries(playOrder.map((seat, index) => [seat, Math.floor((used + 1 - index) / 2)]));
  // 公开快照不是重放动作记录；不虚构历史动作，亦不提供训练导出接口。
  state.configSignature = canonicalCatalog(match.config);
  const env = new PublicRootEnvironment(catalog, weights);
  const observation = env.initialize(match);
  const uncertainPriority = state.round > 1 || players.some((player) => player.timePosition > 0);
  const observations = publicObservations(env, uncertainPriority);
  const result = { observation, observations, actor: actors[0].id, scope: 'placement-root-only',
    uncertainties: uncertainPriority ? ['time-arrival-order'] : [],
    candidates: env.getLegalActions().map((option) => {
      const action = option.action;
      if (action.type !== 'placeDie') return { action, kind: 'exchangeSeal' };
      const bridge = state.bridges.find((item) => item.id === action.bridgeId);
      const die = bridge.dice[action.side === 'left' ? 0 : bridge.dice.length - 1];
      const placeId = action.target.area === 'personal' ? `personal:${actor}:${action.target.row}`
        : action.target.area === 'well' ? 'well' : `${action.target.area}:${action.target.id}`;
      return { action, kind: 'placeDie', color: bridge.color, dieValue: die.value,
        coinDelta: die.value - state.placements[placeId].comparisonValue,
        lantern: action.side === 'left', target: action.target };
    }) };
  sessions.set(result, { env, uncertainPriority });
  return result;
}
