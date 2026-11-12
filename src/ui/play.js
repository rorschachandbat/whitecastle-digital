import { text, StringTable } from './StringTable.js';
import { activeLocalPlayer, exportLocalMatch } from '../engine/localMatch.js';
import { placementOptions, chooseActionOption, roundGardenOptions } from '../engine/actionOptions.js';
import { personalField } from '../engine/cardRules.js';
import { parseCatalog } from '../data/catalog.js';

const root = document.querySelector('#play');
const STORAGE = 'whitecastle.local.play.v1';
const SESSION = 'whitecastle.local.session.v1';
const AI_KEY = 'whitecastle.local.ai.v1';
let session;
let selectedDie;
let probe;
let wizardHistory = [];
let defaultCatalog;
let customCatalog;
let busy = false;
let message = '';
let seed = 'himeji-2026';
let order = [];
let aiSeat = null;
let aiPaused = false;
let aiAvailability = null;
let humanSeat = '0';
document.title = text('play.title');

const el = (tag, content, className = '') => {
  const node = document.createElement(tag);
  if (content !== undefined && content !== null) node.textContent = content;
  if (className) node.className = className;
  return node;
};
const label = (key, params) => text(key, params);
const playerName = (id) => text('play.player', { n: Number(id) + 1 });
const effectName = (type) => text(`editor.effect.${type}`);
const effects = (items = []) => items.length ? items.map((item) => `${effectName(item.type)} ×${item.amount}`).join(' · ') : text('play.none');
const byCard = (id) => session?.match.config.cards.find((card) => card.id === id);
const roomName = (id) => {
  const room = session?.match.state?.castleRooms.find((item) => item.id === id);
  return room ? text('play.room', { floor: room.floor, n: id.split('-').at(-1) }) : id;
};
const fieldName = (id) => StringTable[`play.field.${id}`] ? text(`play.field.${id}`) : id;
const errorText = (code) => StringTable[`play.error.${code}`] ? text(`play.error.${code}`) : text('play.error.other', { code });
const button = (title, action, className = '', options = {}) => {
  const node = el('button', title, className);
  node.type = 'button';
  node.disabled = busy || (opponentTurn() && !options.allowDuringOpponent);
  node.addEventListener('click', () => run(action));
  return node;
};
function readAiPreference() {
  try {
    const value = JSON.parse(localStorage.getItem(AI_KEY) ?? 'null');
    return value?.seat === '0' || value?.seat === '1' ? value.seat : null;
  } catch { return null; }
}
function generationLabel(generation) {
  const value = Number(String(generation ?? '').replace('generation-', ''));
  return Number.isInteger(value) && value >= 0 ? String(value) : text('play.none');
}
function opponentTurn() {
  return Boolean(session && aiSeat && activeLocalPlayer(session.match) === aiSeat);
}
function adopt(next) {
  session = next;
  aiSeat = next?.ai?.seat ?? null;
  aiPaused = Boolean(next?.ai?.paused);
  return next;
}
function assertHumanTurn() {
  if (opponentTurn()) throw Object.assign(new Error('AI_TURN'), { code: 'AI_TURN' });
}
async function refreshAiAvailability() {
  try {
    aiAvailability = await api(session ? `ai-status?id=${encodeURIComponent(session.id)}` : 'ai-status');
  } catch {
    aiAvailability = { status: 'unavailable', code: 'AI_NOT_AVAILABLE' };
  }
}
async function playAiIfNeeded() {
  let guard = 0;
  while (session && aiSeat && !aiPaused && session.match.phase !== 'finished' && activeLocalPlayer(session.match) === aiSeat) {
    if (++guard > 12) throw Object.assign(new Error('AI_DECISION_LIMIT'), { code: 'AI_DECISION_LIMIT' });
    message = text('play.ai.thinking');
    render();
    const result = adopt(await api('ai-move', { id: session.id }));
    resetWizard();
    const played = result.ai?.played ?? 0;
    if (played > 0) message = text('play.ai.moved', { n: played, generation: generationLabel(result.ai.generation) });
    if (!result.ai?.bounded) break;
  }
  autosave();
}
async function applyStoredAi() {
  const seat = readAiPreference();
  if (!session || !seat) return;
  adopt(await api('ai-seat', { id: session.id, seat }));
}
async function api(route, body) {
  const response = await fetch(`/api/${route}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => { throw Object.assign(new Error('NETWORK'), { code: 'NETWORK' }); });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.code), data);
  return data;
}
async function run(action) {
  if (busy) return;
  busy = true;
  root.setAttribute('aria-busy', 'true');
  try { await action(); } catch (error) {
    message = text('play.failed', { reason: errorText(error.code ?? 'NETWORK') });
  } finally {
    busy = false;
    root.removeAttribute('aria-busy');
    render();
  }
}
function autosave() {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(exportLocalMatch(session.match)));
    localStorage.setItem(SESSION, session.id);
  } catch { message = errorText('STORAGE'); }
}
function resetWizard() {
  probe = null;
  selectedDie = null;
  wizardHistory = [];
}
async function newSession(body) {
  const previous = session?.id;
  adopt(await api('session', body));
  resetWizard();
  message = '';
  try {
    await applyStoredAi();
  } catch (error) {
    localStorage.removeItem(AI_KEY);
    aiSeat = null;
    aiPaused = false;
    message = text('play.failed', { reason: errorText(error.code ?? 'NETWORK') });
  }
  await refreshAiAvailability();
  autosave();
  if (previous && previous !== session.id) await api('delete', { id: previous }).catch(() => {});
  if (!message) await playAiIfNeeded();
}
async function beginAction(action, remember = false) {
  assertHumanTurn();
  if (remember && probe) wizardHistory.push(structuredClone(probe.action));
  probe = await api('probe', { id: session.id, action });
  order = probe.request?.effects?.map((_, index) => index) ?? [];
}
async function commitAction(action) {
  assertHumanTurn();
  adopt(await api('action', { id: session.id, action }));
  resetWizard();
  autosave();
  message = '';
  await playAiIfNeeded();
}
function download(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = el('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function fileButton(title, callback) {
  const input = el('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.hidden = true;
  input.addEventListener('change', () => run(async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 5_000_000) throw Object.assign(new Error('FILE_TOO_LARGE'), { code: 'FILE_TOO_LARGE' });
    await callback(await file.text());
    input.value = '';
  }));
  const container = el('span');
  container.append(button(title, () => input.click(), 'quiet'), input);
  return container;
}
function resourceView(player) {
  const group = el('div', null, 'resources');
  for (const type of ['food', 'iron', 'pearl', 'coin', 'seal', 'points']) {
    const badge = el('span', null, `resource ${type}`);
    badge.append(el('small', effectName(type)), el('strong', String(player.resources[type])));
    group.append(badge);
  }
  return group;
}
function cardView(card, compact = false, tiles = []) {
  const node = el('article', null, `card ${card.kind ?? card.tone} ${compact ? 'compact' : ''}`);
  node.append(el('div', card.id, 'card-id'));
  if (card.initialGains) node.append(el('p', `${text('play.initial')} · ${effects(card.initialGains)}`));
  for (const field of card.fields ?? [card]) {
    const line = el('div', null, `card-field ${field.tone}`);
    const colors = tiles.filter((tile) => tile.fieldId === field.id).map((tile) => tile.color);
    for (const color of colors) line.append(el('i', '●', `tile-dot ${color}`));
    if (card.kind === 'top') {
      line.append(el('small', text('play.slot', { slot: text(`play.slot.${field.id}`) })));
      const occupant = session?.match.state?.topSlots?.[field.id];
      line.append(el('small', occupant ? text('play.occupied', { n: Number(occupant.actor) + 1 }) : text('play.available')));
    } else if (field.id && card.fields?.length > 1) {
      line.append(el('small', fieldName(field.id)));
    }
    line.append(el('span', effects(field.effects)));
    if (field.cost?.length) line.append(el('small', `${text('editor.cost')} · ${effects(field.cost)}`, 'cost'));
    node.append(line);
  }
  if (card.back?.length) node.append(el('div', `${text('play.lanternBack')} · ${effects(card.back)}`, 'card-back'));
  if (card.grantDecreeId) {
    const decree = byCard(card.grantDecreeId);
    node.append(el('div', `${text('editor.grantDecree')} · ${effects(decree?.back)}`, 'card-back'));
  }
  return node;
}
function setupControls() {
  const details = el('details', null, 'setup-panel');
  details.open = !session;
  details.append(el('summary', text('play.new')));
  const controls = el('div', null, 'toolbar');
  const field = el('label');
  field.append(el('span', text('play.seed')));
  const input = el('input');
  input.value = seed;
  input.maxLength = 200;
  input.addEventListener('input', () => { seed = input.value; });
  field.append(input);
  controls.append(field, button(text('play.start'), () => newSession({ seed, ...(customCatalog ? { catalog: customCatalog } : {}) })));
  controls.append(fileButton(text('play.configImport'), async (body) => {
    try { customCatalog = parseCatalog(body); } catch { throw Object.assign(new Error('INVALID_CATALOG'), { code: 'INVALID_CATALOG' }); }
    message = text('play.configReady', { revision: customCatalog.revision });
  }), button(text('play.configDefault'), () => { customCatalog = null; }, 'quiet'));
  details.append(controls, el('p', text('play.seedHint'), 'muted'));
  return details;
}
function header() {
  const head = el('header', null, 'masthead');
  const brand = el('div');
  brand.append(el('div', text('play.brand'), 'eyebrow'), el('h1', text('play.title')), el('p', text('play.subtitle'), 'muted'));
  const links = el('div', null, 'toolbar');
  const editor = el('a', text('play.editor'));
  editor.href = './config-editor.html';
  editor.target = '_blank';
  editor.rel = 'noopener';
  links.append(el('span', text(aiSeat ? 'play.ai.pill' : 'play.practice'), 'pill'), editor);
  head.append(brand, links);
  root.append(head, setupControls());
  if (!session) return;
  const tools = el('div', null, 'toolbar savebar');
  const undo = button(text(aiSeat ? 'play.ai.undo' : 'play.undo'), async () => {
    adopt(await api('undo', { id: session.id }));
    resetWizard();
    autosave();
    if (aiPaused) message = text('play.ai.paused');
  }, 'quiet', { allowDuringOpponent: true });
  undo.disabled = busy || session.match.actions.length === 0;
  tools.append(undo, button(text('play.save'), () => { autosave(); message = text('play.saved'); }, 'quiet'),
    button(text('play.load'), async () => {
      const saved = localStorage.getItem(STORAGE);
      if (!saved) throw Object.assign(new Error('NO_SAVE'), { code: 'NO_SAVE' });
      await newSession({ save: JSON.parse(saved) });
    }, 'quiet'),
    button(text('play.export'), () => download(exportLocalMatch(session.match), 'whitecastle-local-save.json'), 'quiet'),
    fileButton(text('play.import'), async (body) => newSession({ save: JSON.parse(body) })));
  root.append(tools);
  const notice = el('details', null, 'practice-note');
  notice.append(el('summary', text('play.warnings')), el('p', text('play.practiceNotice')));
  for (const warning of session.match.profile.warnings) notice.append(el('p', text(`play.warning.${warning}`)));
  if (aiSeat) notice.append(el('p', text('play.ai.undoHint')));
  root.append(notice);
  if (message) {
    const alert = el('p', message, 'message');
    alert.setAttribute('role', 'status');
    root.append(alert);
  }
}
function statusBar() {
  const { match } = session;
  const bar = el('div', null, 'roundbar');
  const actor = activeLocalPlayer(match);
  bar.append(el('strong', match.phase === 'draft' ? text('play.draft') : text('play.round', { round: match.state.round })));
  if (actor !== null) bar.append(el('span', `${text('play.current')} · ${playerName(actor)}`, `player-color p${actor}`));
  const playOrder = match.state?.playOrder ?? match.options.playOrder;
  bar.append(el('span', `${text('play.order')} · ${playOrder.map(playerName).join(' → ')}`, 'muted'));
  root.append(bar);
}
function draftView() {
  const match = session.match;
  const section = el('section', null, 'draft');
  section.append(el('h2', text('play.draft')), el('p', text('play.draftHint'), 'muted'));
  const grid = el('div', null, 'draft-grid');
  for (const pair of match.draft.pairs) {
    const item = el('div', null, 'draft-pair');
    item.append(cardView(byCard(pair.resourceId)), cardView(byCard(pair.actionId)));
    const choice = button(pair.chosenBy !== null ? text('play.chosen', { n: Number(pair.chosenBy) + 1 }) : text('play.choosePair'),
      () => beginAction({ type: 'chooseStartingPair', actor: activeLocalPlayer(match), pairId: pair.id }));
    choice.disabled = busy || opponentTurn() || pair.chosenBy !== null;
    item.append(choice);
    grid.append(item);
  }
  section.append(grid);
  return section;
}
function targetButton(parent, id) {
  if (!selectedDie || probe) return;
  const candidate = placementOptions(session.match, selectedDie.bridgeId, selectedDie.side).find((item) => item.placementId === id);
  if (candidate) {
    parent.classList.add('can-place');
    parent.append(button(text('play.placeHere', { delta: candidate.delta >= 0 ? `+${candidate.delta}` : candidate.delta }),
      () => beginAction(candidate.action), 'target-button'));
  }
}
function diceOn(parent, id) {
  for (const die of session.match.state.placements[id]?.dice ?? []) {
    parent.append(el('span', text('play.placedDie', { n: Number(die.actor) + 1, value: die.value }), `placed-die p${die.actor}`));
  }
}
function castleView() {
  const { state, config } = session.match;
  const castle = el('section', null, 'castle section-panel');
  castle.append(el('h2', text('play.castle')));
  const top = el('div', null, 'top-room');
  top.append(el('h3', text('play.top')), cardView(byCard(state.topCardId), true));
  castle.append(top);
  for (const floor of [2, 1]) {
    const grid = el('div', null, `floor-grid floor-${floor}`);
    for (const room of state.castleRooms.filter((room) => room.floor === floor)) {
      const node = el('article', null, 'room');
      node.append(el('h3', roomName(room.id)), el('small', text('play.compare', { n: state.placements[`castle:${room.id}`].comparisonValue })));
      node.append(cardView(config.cards.find((item) => item.id === room.cardId), true, room.tiles));
      diceOn(node, `castle:${room.id}`);
      targetButton(node, `castle:${room.id}`);
      const persons = Object.entries(state.players).flatMap(([id, player]) => player.figures.courtier
        .filter((figure) => figure.roomId === room.id).map(() => playerName(id)));
      if (persons.length) node.append(el('p', text('play.figuresOn', { players: persons.join(' · ') }), 'figures'));
      grid.append(node);
    }
    castle.append(grid, el('p', `${text('play.floor', { n: floor })} · ${text('play.deck', { n: state.castleDecks[floor === 1 ? 'steward' : 'diplomat'].length })}`, 'deck'));
  }
  return castle;
}
function bridgesView() {
  const match = session.match;
  const section = el('section', null, 'section-panel bridges');
  section.append(el('h2', text('play.bridges')));
  const grid = el('div', null, 'bridge-grid');
  for (const bridge of match.state.bridges) {
    const lane = el('article', null, `bridge-lane ${bridge.color}`);
    lane.append(el('h3', text(`play.color.${bridge.color}`)));
    const dice = el('div', null, 'dice-line');
    for (const [index, die] of bridge.dice.entries()) {
      const side = bridge.dice.length === 1 ? bridge.singleDieEndpoint
        : index === 0 ? 'left' : index === bridge.dice.length - 1 ? 'right' : null;
      const holder = el('div', null, 'die-holder');
      const node = button(String(die.value), () => {
        selectedDie = { bridgeId: bridge.id, side, value: die.value, color: bridge.color };
        probe = null;
        message = '';
      }, `die ${bridge.color} ${selectedDie?.bridgeId === bridge.id && selectedDie?.side === side ? 'selected' : ''}`);
      node.setAttribute('aria-label', `${text(`play.color.${bridge.color}`)} · ${side ? text(`play.${side}`) : text('play.middle')} · ${text('play.die', { value: die.value })}`);
      node.disabled = busy || opponentTurn() || side === null || match.phase !== 'playing' || Boolean(probe);
      holder.append(node, el('small', side ? text(`play.${side}`) : text('play.middle')));
      dice.append(holder);
    }
    if (!bridge.dice.length) dice.append(el('p', text('play.emptyBridge'), 'muted'));
    lane.append(dice);
    for (const garden of match.config.setup.gardens.filter((item) => item.bridgeId === bridge.id)) {
      const card = byCard(garden.cardId);
      const node = cardView(card, true);
      node.append(el('small', text('play.gardenCost', { cost: card.foodCost, points: card.victoryPoints })));
      const people = Object.entries(match.state.players).filter(([, player]) => player.figures.gardener.some((figure) => figure.cardId === card.id)).map(([id]) => playerName(id));
      if (people.length) node.append(el('p', text('play.figuresOn', { players: people.join(' · ') }), 'figures'));
      lane.append(node);
    }
    grid.append(lane);
  }
  section.append(grid);
  return section;
}
function yardsView() {
  const { state, config } = session.match;
  const section = el('section', null, 'section-panel');
  section.append(el('h2', text('play.yards')));
  const grid = el('div', null, 'yard-grid');
  for (const yard of config.setup.trainingYards) {
    const zone = config.trainingZones.find((item) => item.id === yard.id);
    const node = el('article', null, 'yard');
    node.append(el('h3', text('play.yard', { cost: zone.ironCost })), el('small', text('play.yardValue', { n: zone.value })));
    for (const id of yard.faceIds) {
      const tile = config.yardFaces.find((item) => item.id === id);
      node.append(el('small', text(tile.tone === 'resource' ? 'play.gold' : 'play.silver')), cardView(tile, true));
    }
    const figures = Object.entries(state.players).flatMap(([id, player]) => player.figures.warrior.filter((figure) => figure.yardId === yard.id).map(() => playerName(id)));
    if (figures.length) node.append(el('p', text('play.figuresOn', { players: figures.join(' · ') }), 'figures'));
    grid.append(node);
  }
  section.append(grid);
  const utilities = el('div', null, 'utility-grid');
  for (const id of ['outside:left', 'well', 'outside:right']) {
    const node = el('article', null, 'utility');
    const key = id === 'well' ? 'play.well' : `play.outside.${id.split(':')[1]}`;
    node.append(el('h3', text(key)), el('small', text('play.compare', { n: state.placements[id].comparisonValue })));
    if (id === 'well') node.append(el('p', effects([{ type: 'seal', amount: 1 }, ...config.setup.wellRewards])));
    diceOn(node, id);
    targetButton(node, id);
    utilities.append(node);
  }
  section.append(utilities);
  return section;
}
function playersView() {
  const { state, config } = session.match;
  const grid = el('section', null, 'players-grid');
  for (const [id, player] of Object.entries(state.players)) {
    const node = el('article', null, `player-panel p${id} ${activeLocalPlayer(session.match) === id ? 'active' : ''}`);
    node.append(el('h2', playerName(id)), resourceView(player), el('p', `${text('play.time', { n: player.timePosition })} · ${text('play.turns', { count: state.turnsUsed[id] })}`, 'muted'));
    for (const row of config.personalDomainRows) {
      const n = player.figures[row.figureType].length;
      const field = personalField(byCard(player.currentCard), row.id);
      const line = el('div', null, 'personal-row');
      line.append(el('h3', text('play.row', { name: effectName(row.figureType), n })),
        el('p', text('play.rowGains', { effects: effects([row.baseGain, ...row.revealedGains.slice(0, n)]) })),
        el('p', text('play.rowAction', { effects: effects(field.effects) }), 'muted'));
      diceOn(line, `personal:${id}:${row.id}`);
      targetButton(line, `personal:${id}:${row.id}`);
      node.append(line);
    }
    if (player.figures.courtier.length) node.append(el('p', player.figures.courtier.map((figure, index) => text('play.courtierAt', { n: index + 1, location: text(`play.location.${figure.location}`) })).join(' · '), 'muted'));
    const cards = el('details');
    cards.append(el('summary', text('play.currentCard')), cardView(byCard(player.currentCard), true));
    const lanterns = el('details');
    lanterns.append(el('summary', `${text('play.lanternCards')} · ${player.lanternCards.length}`));
    for (const cardId of player.lanternCards) lanterns.append(el('p', `${cardId} · ${effects(byCard(cardId).back)}`));
    node.append(cards, lanterns);
    grid.append(node);
  }
  return grid;
}
function optionLabel(item, request) {
  const value = item.value;
  if (request.type === 'chooseResource') return effectName(value);
  if (value.skip === true) return text(request.type === 'field' ? 'play.skipField' : 'play.skip');
  if (value.type === 'field') return text('play.executeField', { cost: request.field.cost.length ? effects(request.field.cost) : text('play.free') });
  if (value.type === 'influence') return value.pay ? text('play.payGate', { cost: request.gate.cost }) : text('play.stopGate');
  if (value.type === 'outside') return effectName(value.action);
  if (value.type === 'gardener') return `${value.cardId} · ${text('play.gardenCost', { cost: byCard(value.cardId).foodCost, points: byCard(value.cardId).victoryPoints })} · ${effects(byCard(value.cardId).fields[0].effects)}`;
  if (value.type === 'warrior') {
    const zone = session.match.config.trainingZones.find((zone) => zone.id === value.yardId);
    return `${text('play.yard', { cost: zone.ironCost })} · ${value.faceOrder.map((id) => effects(session.match.config.yardFaces.find((face) => face.id === id).effects)).join(' → ')}`;
  }
  if (value.type === 'domain') return `${effectName(value.row)} · ${effects(personalField(byCard(request.player.currentCard), value.row).effects)}`;
  if (value.type === 'castleOrder') return value.fieldIds.map(fieldName).join(' → ');
  if (value.type === 'courtier') {
    const parts = [];
    if (value.audience) parts.push(text('play.audience'));
    if (value.promote) {
      const p = value.promote;
      const target = p.roomId ? `${roomName(p.roomId)} · ${fieldName(p.fieldId)}` : text('play.slot', { slot: p.slotId ? text(`play.slot.${p.slotId}`) : text('play.none') });
      parts.push(text('play.promote', { n: p.figureIndex + 1, steps: p.steps, target }));
      if (value.audience) parts.push(text(value.order?.[0] === 'promote' ? 'play.orderPromoteFirst' : 'play.orderAudienceFirst'));
    }
    return parts.join(' / ');
  }
  if (value.roomId) {
    const room = request.state.castleRooms.find((room) => room.id === value.roomId);
    const card = byCard(room.cardId);
    const field = card.fields.find((field) => field.id === value.fieldId);
    return `${text('play.chooseField', { room: roomName(value.roomId), field: fieldName(value.fieldId) })} · ${effects(field.effects)}`;
  }
  return JSON.stringify(value);
}
function exchanges(parent, actor, player, chained = false) {
  const title = chained ? 'play.inChainExchange' : 'play.exchange';
  const group = el('details', null, 'exchanges');
  group.append(el('summary', text(title)));
  const buttons = el('div', null, 'exchange-buttons');
  const make = (amount, resource) => {
    const action = { type: 'exchangeSeal', actor, amount, ...(resource ? { resource } : {}) };
    const btn = button(text(resource ? 'play.exchangeResource' : 'play.exchangeCoin', resource ? { name: effectName(resource) } : {}), async () => {
      if (chained) {
        const actionDraft = structuredClone(probe.action);
        actionDraft.decisions.splice(probe.request.index, 0, action);
        await beginAction(actionDraft, true);
      } else await commitAction(action);
    }, 'quiet');
    btn.disabled = busy || opponentTurn() || player.resources.seal < amount;
    buttons.append(btn);
  };
  make(1);
  for (const resource of ['food', 'iron', 'pearl']) make(2, resource);
  group.append(buttons);
  parent.append(group);
}
function aiPanel() {
  const panel = el('section', null, 'ai-panel');
  panel.append(el('h3', text('play.ai.title')), el('p', text('play.ai.notice'), 'muted'));
  const status = aiAvailability?.status;
  if (status === 'available' && aiAvailability.generation) {
    panel.append(el('p', text('play.ai.champion', { generation: generationLabel(aiAvailability.generation) }), 'muted'));
  } else if (status === 'incompatible') panel.append(el('p', text('play.ai.incompatible'), 'error'));
  else if (status === 'catalog-mismatch') panel.append(el('p', text('play.ai.catalog'), 'error'));
  else panel.append(el('p', text('play.ai.unavailable'), 'error'));
  if (aiSeat) {
    panel.append(el('p', text(opponentTurn() ? 'play.ai.turn' : 'play.ai.seated', { generation: generationLabel(session.ai?.generation), player: playerName(aiSeat) })));
    panel.append(el('p', text('play.ai.method'), 'muted'));
    if (aiPaused) panel.append(el('p', text('play.ai.paused')));
    const actions = el('div', null, 'toolbar');
    if (opponentTurn()) actions.append(button(text('play.ai.resume'), async () => {
      adopt(await api('ai-pause', { id: session.id, paused: false }));
      message = '';
      await playAiIfNeeded();
    }, '', { allowDuringOpponent: true }));
    actions.append(button(text('play.ai.disable'), async () => {
      localStorage.removeItem(AI_KEY);
      adopt(await api('ai-seat', { id: session.id, seat: null }));
      message = text('play.ai.off');
    }, 'quiet', { allowDuringOpponent: true }));
    panel.append(actions);
  } else {
    const select = el('select');
    for (const seat of ['0', '1']) {
      const option = el('option', text(seat === '0' ? 'play.ai.human0' : 'play.ai.human1'));
      option.value = seat;
      if (seat === humanSeat) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', () => { humanSeat = select.value; });
    const confirm = button(text('play.ai.confirm'), async () => {
      const seat = humanSeat === '0' ? '1' : '0';
      localStorage.setItem(AI_KEY, JSON.stringify({ seat }));
      adopt(await api('ai-seat', { id: session.id, seat }));
      message = text('play.ai.confirmed', {
        generation: generationLabel(session.ai?.generation), human: playerName(humanSeat), ai: playerName(seat),
      });
      await playAiIfNeeded();
    }, 'confirm', { allowDuringOpponent: true });
    confirm.disabled = busy || status !== 'available';
    panel.append(select, confirm);
    if (status === 'catalog-mismatch') {
      panel.append(button(text('play.ai.useDefault'), async () => {
        const seat = humanSeat === '0' ? '1' : '0';
        customCatalog = null;
        localStorage.setItem(AI_KEY, JSON.stringify({ seat }));
        await newSession({ seed, catalog: defaultCatalog });
        if (!message) message = text('play.ai.confirmed', {
          generation: generationLabel(session.ai?.generation), human: playerName(humanSeat), ai: playerName(seat),
        });
      }, 'confirm', { allowDuringOpponent: true }));
    }
  }
  return panel;
}
function wizardView() {
  const aside = el('aside', null, 'action-tray');
  aside.append(el('div', text(aiSeat ? 'play.ai.connected' : 'play.connected'), 'eyebrow'), el('h2', text('play.actionTitle')), aiPanel());
  const actor = activeLocalPlayer(session.match);
  if (opponentTurn()) {
    aside.append(el('p', text(aiPaused ? 'play.ai.paused' : 'play.ai.turn', {
      generation: generationLabel(session.ai?.generation), player: playerName(actor),
    }), aiPaused ? '' : 'ai-thinking'));
    return aside;
  }
  if (probe) {
    if (probe.status === 'choice') {
      const request = probe.request;
      aside.append(el('h3', text(`play.prompt.${request.type}`)));
      if (request.player) aside.append(resourceView(request.player), el('p', text('play.selectedPreview'), 'muted'));
      if (request.type === 'field') {
        aside.append(el('p', effects(request.field.effects), 'field-description'));
      }
      if (request.type === 'effectOrder') {
        const list = el('ol', null, 'effect-order');
        order.forEach((index, position) => {
          const row = el('li');
          row.append(el('span', effects([request.effects[index]])));
          const up = button('↑', () => { [order[position - 1], order[position]] = [order[position], order[position - 1]]; });
          up.setAttribute('aria-label', text('play.moveUp'));
          up.disabled = busy || opponentTurn() || position === 0;
          const down = button('↓', () => { [order[position + 1], order[position]] = [order[position], order[position + 1]]; });
          down.setAttribute('aria-label', text('play.moveDown'));
          down.disabled = busy || opponentTurn() || position === order.length - 1;
          row.append(up, down);
          list.append(row);
        });
        aside.append(list, button(text('play.orderConfirm'), () => beginAction(chooseActionOption(probe, order), true)));
      } else {
        const choices = el('div', null, 'action-choices');
        for (const item of probe.options) choices.append(button(optionLabel(item, request), () => beginAction(chooseActionOption(probe, item.value), true), item.value?.skip ? 'quiet' : 'choice'));
        aside.append(choices);
      }
      if (request.player && !['effectOrder', 'chooseResource'].includes(request.type)) exchanges(aside, actor, request.player, true);
    } else if (probe.status === 'ready') {
      aside.append(el('h3', text('play.preview')), el('p', text('play.previewHint'), 'muted'));
      const player = probe.preview.state?.players[probe.action.actor] ?? probe.preview.draft.players[probe.action.actor];
      aside.append(resourceView(player));
      if (player.figures) for (const type of ['courtier', 'gardener', 'warrior']) aside.append(el('p', `${effectName(type)} · ${5 - player.figures[type].length}/5`, 'muted'));
      aside.append(button(text('play.confirm'), () => commitAction(probe.action), 'confirm'));
    } else aside.append(el('p', errorText(probe.code), 'error'));
    const actions = el('div', null, 'toolbar');
    if (wizardHistory.length) actions.append(button(text('play.back'), async () => {
      const previous = wizardHistory.pop();
      await beginAction(previous);
    }, 'quiet'));
    actions.append(button(text('play.cancel'), () => { resetWizard(); }, 'quiet'));
    aside.append(actions);
  } else if (session.match.phase === 'round-gardens') {
    aside.append(el('h3', text('play.roundGarden')), el('p', text('play.roundGardenHint')));
    for (const action of roundGardenOptions(session.match)) aside.append(button(text('play.activateGarden', { id: action.cardId }), () => beginAction(action), 'choice'));
    exchanges(aside, actor, session.match.state.players[actor]);
  } else if (selectedDie) {
    aside.append(el('p', text('play.dieSelected', { color: text(`play.color.${selectedDie.color}`), side: text(`play.${selectedDie.side}`), value: selectedDie.value })));
    if (!placementOptions(session.match, selectedDie.bridgeId, selectedDie.side).length) aside.append(el('p', text('play.noTargets'), 'error'));
    aside.append(button(text('play.cancel'), () => { selectedDie = null; }, 'quiet'));
    exchanges(aside, actor, session.match.state.players[actor]);
  } else if (session.match.phase === 'playing') {
    aside.append(el('h3', text('play.selectDie')), el('p', text('play.selectHint'), 'muted'));
    exchanges(aside, actor, session.match.state.players[actor]);
  } else if (session.match.phase === 'draft') aside.append(el('p', text('play.draftHint'), 'muted'));
  const help = el('p', text('play.testGuide'), 'test-guide');
  aside.append(help);
  return aside;
}
function scoreView() {
  const result = session.match.state.score;
  const node = el('section', null, 'score-panel section-panel');
  node.append(el('h2', text('play.finished')), el('p', text('play.winner', { n: Number(result.winner) + 1, points: result.players[result.winner].total }), 'winner'));
  const table = el('table');
  const head = el('tr');
  head.append(el('th', text('play.score')), ...['0', '1'].map((id) => el('th', playerName(id))));
  table.append(head);
  for (const part of Object.keys(result.players['0'].parts)) {
    const row = el('tr');
    row.append(el('th', text(`play.score.${part}`)), ...['0', '1'].map((id) => el('td', String(result.players[id].parts[part]))));
    table.append(row);
  }
  const total = el('tr', null, 'total');
  total.append(el('th', text('play.total')), ...['0', '1'].map((id) => el('td', String(result.players[id].total))));
  table.append(total);
  node.append(table);
  return node;
}
function logView() {
  const details = el('details', null, 'log');
  details.append(el('summary', `${text('play.log')} · ${session.match.actions.length}`));
  for (const [index, action] of session.match.actions.entries()) {
    const line = el('details');
    line.append(el('summary', text('play.logEntry', { n: index + 1, player: Number(action.actor) + 1, action: text(`play.log.${action.type}`) })),
      el('pre', JSON.stringify(action, null, 2)));
    details.append(line);
  }
  return details;
}
function render() {
  root.replaceChildren();
  header();
  if (!session) {
    root.append(el('p', message || text('play.loading'), 'message'));
    return;
  }
  statusBar();
  const layout = el('div', null, 'table-layout');
  const board = el('div', null, 'board');
  if (session.match.phase === 'draft') board.append(draftView());
  else {
    if (session.match.phase === 'finished') board.append(scoreView());
    board.append(castleView(), bridgesView(), yardsView(), playersView());
  }
  layout.append(board, wizardView());
  root.append(layout, logView(), el('footer', text('play.autosaved')));
}
render();
await run(async () => {
  const response = await fetch('/data/whitecastle-2p.json');
  defaultCatalog = parseCatalog(await response.text());
  await refreshAiAvailability();
  const id = localStorage.getItem(SESSION);
  if (id) {
    try {
      adopt(await api(`state?id=${encodeURIComponent(id)}`));
    } catch {
      session = null;
    }
    if (session) {
      try {
        await applyStoredAi();
        await refreshAiAvailability();
        if (!message) await playAiIfNeeded();
      } catch (error) {
        localStorage.removeItem(AI_KEY);
        aiSeat = null;
        aiPaused = false;
        message = text('play.failed', { reason: errorText(error.code ?? 'NETWORK') });
      }
      return;
    }
  }
  const saved = localStorage.getItem(STORAGE);
  if (saved) {
    try { await newSession({ save: JSON.parse(saved) }); return; } catch { /* 不覆盖错误存档，回到新局入口。 */ }
  }
  await newSession({ seed, catalog: defaultCatalog });
});
