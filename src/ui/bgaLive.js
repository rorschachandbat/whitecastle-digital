import { text } from './StringTable.js';

const el = (tag, value, className) => {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
};
document.title = text('live.title');
const root = document.querySelector('#bga-live');
const heading = el('header');
heading.append(el('p', text('live.eyebrow'), 'eyebrow'), el('h1', text('live.title')),
  el('p', text('live.description'), 'subtitle'));
const status = el('div', text('live.waiting'), 'connection');
status.setAttribute('role', 'status');
const meta = el('p', '', 'muted');
const setup = el('details');
setup.open = true;
setup.append(el('summary', text('live.setup')), el('p', text('live.steps'), 'steps'));
const dashboard = el('section');
dashboard.append(el('p', text('live.empty'), 'empty'));
const advice = el('section', undefined, 'panel advice');
advice.append(el('h2', text('live.next')), el('p', text('live.nextDescription')));
root.append(heading, status, meta, setup, dashboard, advice);
let current = null;
let rendered = null;
let supported = null;
const unknown = (value) => value ?? text('live.unknown');
const labeledCopy = (key, value) => {
  const row = el('div', undefined, 'copy-row');
  const label = el('label', text(key));
  const input = el('input');
  if (key === 'live.pair') input.type = 'password';
  input.value = value;
  input.readOnly = true;
  label.append(input);
  const button = el('button', text('live.copy'));
  button.onclick = async () => {
    try { await navigator.clipboard.writeText(value); button.textContent = text('live.copied'); }
    catch { button.textContent = text('live.copyFailed'); input.select(); }
  };
  row.append(label, button);
  return row;
};
const list = (parent, title, rows) => {
  const section = el('section', undefined, 'panel');
  section.append(el('h2', title));
  const ul = el('ul');
  rows.forEach((row) => ul.append(el('li', row)));
  section.append(ul);
  parent.append(section);
};
function render(latest) {
  dashboard.replaceChildren();
  if (!latest) { dashboard.append(el('p', text('live.empty'), 'empty')); return; }
  const { observation, archive, source, issues } = latest;
  dashboard.append(el('h2', text('live.session')),
    el('p', text('live.round', { round: unknown(observation.roundText), progress: unknown(observation.progress) })),
    el('p', text('live.action'), 'eyebrow'), el('p', unknown(observation.title), 'action'));
  const players = el('div', undefined, 'players');
  for (const player of observation.players) {
    const panel = el('section', undefined, 'panel');
    panel.append(el('h2', text('live.player', { name: player.name ?? player.id, score: unknown(player.score) })));
    const resources = el('dl');
    for (const key of ['coin', 'seal', 'food', 'iron', 'pearl']) {
      resources.append(el('dt', text(`editor.effect.${key}`)), el('dd', unknown(player.resources[key])));
    }
    panel.append(resources);
    players.append(panel);
  }
  dashboard.append(players);
  list(dashboard, text('live.dice'), observation.dice.map((die) => text('live.die', {
    color: ['red', 'black', 'white'].includes(die.data.type) ? text(`live.${die.data.type}`) : text('live.unknown'),
    value: unknown(die.data.value),
    slot: die.ancestors.find((ancestor) => ancestor.slot)?.slot ?? die.ancestors.find((ancestor) => ancestor.id)?.id ?? text('live.unknown'),
  })));
  const details = el('details');
  details.append(el('summary', text('live.cards')));
  const mappedCards = new Map(archive?.publicPosition.cards.map((card) => [card.instance, card]) ?? []);
  list(details, text('live.cards'), observation.cards.map((card) => {
    const mapped = mappedCards.get(card.id);
    return `${card.id} → ${mapped?.localId ?? text(card.data.side === 'back' ? 'bga.hidden' : 'bga.unmapped')}`;
  }));
  list(details, text('live.yards'), (archive?.publicPosition.training ?? []).map((tile) => `${tile.slot} → ${tile.localId ?? text('bga.unmapped')}`));
  dashboard.append(details);
  const check = el('section', undefined, 'panel');
  check.append(el('h2', text('live.mapping')), el('p', text(issues.length ? 'live.mappingIssue' : 'live.mappingOk')),
    el('p', text('live.invalidVersion', { version: unknown(source.gameAssetVersion), supported }), 'muted'));
  issues.forEach((issue) => check.append(el('code', JSON.stringify(issue))));
  const download = el('button', text('live.export'));
  download.onclick = () => {
    const value = { format: 'whitecastle-bga-live-snapshot', version: 1,
      receivedAt: current.watch.receivedAt, ...current.latest };
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = el('a');
    link.href = url;
    link.download = `bga-live-${source.table}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  check.append(download, el('p', text('live.exportNote'), 'muted'));
  dashboard.append(check);
}
async function refresh() {
  try {
    const response = await fetch('/api/live/state');
    if (!response.ok) throw new Error('NETWORK');
    current = await response.json();
    const { watch, latest, updates } = current;
    const seconds = watch?.receivedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(watch.receivedAt)) / 1000)) : null;
    const state = !watch ? 'live.waiting' : !watch.active ? 'live.stopped'
      : seconds === null ? 'live.loading' : seconds > 6 ? 'live.stale' : 'live.connected';
    status.textContent = text(state);
    status.dataset.connected = String(state === 'live.connected');
    meta.textContent = watch ? text('live.updated', { table: watch.table, seconds: unknown(seconds), updates }) : '';
    const version = JSON.stringify([watch?.id, updates]);
    if (rendered !== version) { render(latest); rendered = version; }
    if (latest && setup.open && state === 'live.connected') setup.open = false;
  } catch {
    status.textContent = text('live.disconnected');
    status.dataset.connected = 'false';
  }
}
try {
  const response = await fetch('/api/live/config');
  if (!response.ok) throw new Error('NETWORK');
  const config = await response.json();
  supported = config.assetVersion;
  setup.append(labeledCopy('live.folder', config.extensionPath), labeledCopy('live.pair', config.token));
  await refresh();
  setInterval(refresh, 1000);
} catch { status.textContent = text('live.disconnected'); }
