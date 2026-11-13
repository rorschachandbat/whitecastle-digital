import { canonicalCatalog } from '../data/catalog.js';
import { getPlayingSession, setPlayingSession, preparePlayingAdvice, publicObservations } from './bgaLivePlaying.js';

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const signature = (value) => canonicalCatalog(value);

/** 展示已有引擎选择的语义，不把网络权重解释成胜率。 */
export function describeLiveChoice(env, option, position) {
  const request = env.probe?.request;
  const value = option.value;
  if (option.orderIndex !== undefined) return { type: 'effectOrder', effect: request.effects[option.orderIndex] };
  if (typeof value === 'string') return { type: 'chooseResource', resource: value };
  const result = { ...value, type: value?.type ?? request?.type };
  if (value?.cardId) {
    const garden = env.match.config.setup.gardens.find((item) => item.cardId === value.cardId);
    const visible = position.cards.find((card) => card.localId === value.cardId && card.family === 'garden');
    result.bridgeId = garden?.bridgeId;
    result.slot = visible?.slot;
    result.cost = env.match.config.cards.find((card) => card.id === value.cardId)?.foodCost;
  }
  if (value?.fieldId) result.effects = request?.field?.effects
    ?? env.match.config.cards.find((card) => card.id === request?.state?.castleRooms
      ?.find((room) => room.id === value.roomId)?.cardId)?.fields.find((field) => field.id === value.fieldId)?.effects;
  if (request?.type === 'field') result.effects = request.field.effects;
  if (value?.faceOrder) result.faceEffects = value.faceOrder.map((id) =>
    env.match.config.yardFaces.find((face) => face.id === id)?.effects ?? []);
  if (value?.promote) result.from = request.player.figures.courtier[value.promote.figureIndex];
  return result;
}

export function advancePublic(env, index) {
  if (env.getLegalActions()[index].next?.status === 'public-chance') return false;
  env.step(index);
  return true;
}

/** 从已读取的根局面试走用户真实放骰；只在公开状态和可见选择同时吻合时接通连锁。 */
export function prepareChainAdvice(latest, parameters) {
  const root = parameters.context?.root;
  const ui = latest.observation.decision;
  if (!root || !ui) fail('BGA_ADVICE_CHAIN_CONTEXT');
  const context = { ...parameters.context, faces: parameters.context.rootFaces ?? {},
    seenAt: Date.parse(root.changedAt ?? root.receivedAt) };
  const prepared = preparePlayingAdvice(root, { ...parameters, context });
  const session = getPlayingSession(prepared);
  const p = latest.archive.publicPosition;
  const previous = root.archive.publicPosition;
  if (p.roundText !== previous.roundText) fail('BGA_ADVICE_CHAIN_CONTEXT');
  if (previous.dice.some((old) => !p.dice.some((die) => die.instance === old.instance
    && die.color === old.color && die.value === old.value
    && (/^(red|black|white)-(left|center|right)$/.test(old.slot) || die.slot === old.slot)))) {
    fail('BGA_ADVICE_CHAIN_CONTEXT');
  }
  const placed = p.dice.filter((die) => previous.dice.some((old) => old.instance === die.instance
    && /^(red|black|white)-(left|center|right)$/.test(old.slot)
    && !/^(red|black|white)-(left|center|right)$/.test(die.slot)));
  if (placed.length !== 1) fail('BGA_ADVICE_CHAIN_CONTEXT');
  const die = placed[0];
  const source = previous.dice.find((item) => item.instance === die.instance);
  const rootIndex = prepared.candidates.findIndex((candidate) => {
    if (candidate.kind !== 'placeDie' || candidate.color !== source.color || candidate.action.side !== source.slot.split('-')[1]) return false;
    const t = candidate.target;
    const room = /action-space-main-board-(steward|diplomat)-([123])$/.exec(die.slot);
    if (room) return t.area === 'castle' && t.id === `floor${room[1] === 'steward' ? 1 : 2}-${room[2]}`;
    const outside = /outside-the-walls-([12])$/.exec(die.slot);
    if (outside) return t.area === 'outside' && t.id === (outside[1] === '1' ? 'left' : 'right');
    if (die.slot.endsWith('-well')) return t.area === 'well';
    const personal = /action-space-player-(?:board-)?(\d+)-(courtier|warrior|gardener|[123])$/.exec(die.slot);
    return personal && t.area === 'personal'
      && t.row === ({ 1: 'courtier', 2: 'gardener', 3: 'warrior' }[personal[2]] ?? personal[2])
      && personal[1] === prepared.actor;
  });
  if (rootIndex < 0 || !advancePublic(session.env, rootIndex) || !session.env.pending) fail('BGA_ADVICE_CHAIN_CONTEXT');
  const buttons = ui.buttons.filter((button) => !button.disabled);
  const resourceButton = buttons.some((button) => /^twc-perform-action-(food|iron|pearl)$/.test(button.id));
  if (resourceButton && ui.buttons.find((button) => button.id === 'twc-perform-action-confirm')
    ?.icons.some((icon) => ['food', 'iron', 'pearl'].includes(icon))) fail('BGA_ADVICE_RESOURCE_PARTIAL');
  const gardenTargets = ui.targets.filter((id) => /^twc-garden-card-\d+$/.test(id));
  const yardTargets = ui.targets.filter((id) => /^twc-training-yard-[123]$/.test(id));
  const type = resourceButton ? 'chooseResource' : gardenTargets.length ? 'gardener' : yardTargets.length ? 'warrior' : null;
  if (!type) fail('BGA_ADVICE_CHAIN_CONTEXT');
  const matches = [];
  const queue = [{ env: session.env, depth: 0 }];
  let visited = 0;
  const deadline = Date.now() + 6000;
  const seen = new Set();
  while (queue.length && visited++ < 320 && Date.now() < deadline) {
    const { env, depth } = queue.shift();
    if (!env.pending || depth > 20) continue;
    const key = signature([env.pending, env.orderPrefix]);
    if (seen.has(key)) continue;
    seen.add(key);
    const request = env.probe.request;
    if (request.type === type && matchesPublicState(env, p)) {
      const options = env.getLegalActions().filter((option) => {
        if (type === 'chooseResource') return buttons.some((button) => button.id === `twc-perform-action-${option.value}`);
        if (option.value?.skip) return buttons.some((button) => button.id === 'jj-perform-skip');
        if (type === 'gardener') return p.cards.some((card) => card.localId === option.value?.cardId && gardenTargets.includes(card.instance));
        return yardTargets.includes(`twc-training-yard-${{ 'yard-cost-5': 1, 'yard-cost-3': 2, 'yard-cost-1': 3 }[option.value?.yardId]}`);
      });
      if (options.length) {
        env.options = options;
        matches.push(env);
        continue;
      }
    }
    for (let index = 0; index < env.getLegalActions().length; index += 1) {
      // 自动兑换不是已观察到的操作；只重建当前主行动，不额外枚举所有可兑换历史。
      if (env.getLegalActions()[index].value?.type === 'exchangeSeal') continue;
      const copy = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
        match: structuredClone(env.match), pending: structuredClone(env.pending), probe: structuredClone(env.probe),
        orderPrefix: [...env.orderPrefix], options: env.options, witnesses: new Map(env.witnesses),
      });
      if (advancePublic(copy, index) && copy.pending) queue.push({ env: copy, depth: depth + 1 });
    }
  }
  // 多条未解行动栈不能因当前资源相同就合并，宁可等待下一份可核验快照。
  if (queue.length || matches.length !== 1) fail('BGA_ADVICE_CHAIN_CONTEXT');
  const env = matches[0];
  const observations = publicObservations(env, session.uncertainPriority);
  const result = { observation: observations[0], observations, actor: prepared.actor, scope: 'live-chain',
    uncertainties: prepared.uncertainties,
    candidates: env.getLegalActions().map((option) => describeLiveChoice(env, option, p)) };
  setPlayingSession(result, { env, uncertainPriority: session.uncertainPriority });
  return result;
}

function matchesPublicState(env, p) {
  const state = env.probe.request.state;
  if (!state) return false;
  for (const player of p.players) {
    const actual = player.seat === env.actor ? env.probe.request.player : state.players[player.seat];
    if (!actual || ['coin', 'seal', 'food', 'iron', 'pearl'].some((key) => actual.resources[key] !== player.resources[key])
      || actual.resources.points !== player.displayedScore) return false;
    const influence = p.pieces.find((piece) => piece.owner === player.seat && piece.type === 'influence');
    if (influence?.slot !== `influence-${actual.timePosition}`) return false;
    for (const type of ['courtier', 'warrior', 'gardener']) {
      const row = { courtier: 'courtiers', warrior: 'warriors', gardener: 'gardeners' }[type];
      const deployed = p.pieces.filter((piece) => piece.owner === player.seat && piece.type === type
        && !piece.containers.includes(`twc-player-board-${row}-${player.platformId}`));
      if (deployed.length !== actual.figures[type].length) return false;
      const normalize = (figure) => type === 'gardener' ? figure.cardId : type === 'warrior' ? figure.yardId
        : `${figure.location}:${figure.roomId ?? figure.slotId ?? ''}`;
      const observed = deployed.map((piece) => {
        if (type === 'gardener') return p.cards.find((card) => card.family === 'garden'
          && piece.containers.includes(card.instance))?.localId;
        if (type === 'warrior') {
          const yard = piece.containers.map((id) => /^twc-training-yard-([123])$/.exec(id)).find(Boolean);
          return yard ? `yard-cost-${{ 1: 5, 2: 3, 3: 1 }[yard[1]]}` : null;
        }
        const room = piece.containers.map((id) => /^twc-castle-room-main-board-(steward|diplomat)-([123])(?:-courtier-stock)?$/.exec(id)).find(Boolean);
        if (room) return `floor${room[1] === 'steward' ? 1 : 2}:floor${room[1] === 'steward' ? 1 : 2}-${room[2]}`;
        if (piece.containers.includes('twc-daimyo-courtier-stock')) {
          const top = env.match.config.cards.find((card) => card.id === state.topCardId);
          return `floor3:${top?.fields[Number(piece.slot) - 1]?.id}`;
        }
        return piece.containers.some((id) => id.includes('-gate')) ? 'gate:' : null;
      });
      if (signature(actual.figures[type].map(normalize).sort()) !== signature(observed.sort())) return false;
    }
    const current = p.cards.find((card) => card.containers.includes(`twc-action-card-stock-${player.platformId}`));
    if (current?.localId !== actual.currentCard) return false;
  }
  return state.castleRooms.every((room) => p.cards.some((card) => card.localId === room.cardId
    && card.slot === room.id.split('-')[1]
    && card.containers.includes(`twc-${room.floor === 1 ? 'steward' : 'diplomat'}-card-slots`)));
}
