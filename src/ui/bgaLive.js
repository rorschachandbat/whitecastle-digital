import { text, StringTable } from './StringTable.js';

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
const training = el('section', undefined, 'panel');
const snapshotControls = el('section', undefined, 'panel');
const snapshotLabel = el('label', text('live.snapshotImport'));
const snapshotFile = el('input');
snapshotFile.type = 'file';
snapshotFile.accept = '.json,application/json';
snapshotLabel.append(snapshotFile);
const returnLive = el('button', text('live.returnLive'));
snapshotControls.append(snapshotLabel, returnLive);
root.append(heading, status, meta, setup, snapshotControls, training, advice, dashboard);
let current = null;
let rendered = null;
let supported = null;
let adviceVersion = null;
let checkedTraining = 0;
let pairToken = null;
let importedSnapshot = null;
let importing = false;
snapshotFile.onchange = async () => {
  const file = snapshotFile.files[0];
  if (!file) return;
  importing = true;
  status.textContent = text('live.snapshotPending');
  try {
    if (file.size > 2_000_000) throw new Error();
    const response = await fetch('/api/live/analyze-snapshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pairToken}` },
      body: await file.text(),
    });
    if (!response.ok) throw new Error();
    importedSnapshot = (await response.json()).latest;
    render(importedSnapshot);
  } catch { status.textContent = text('live.snapshotFailed'); }
  finally { importing = false; }
};
returnLive.onclick = () => { importedSnapshot = null; snapshotFile.value = ''; rendered = null; void refresh(); };
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
const adviceErrors = {
  BGA_ADVICE_MAPPING: 'live.adviceMapping',
  BGA_ADVICE_PHASE: 'live.advicePhase',
  BGA_ADVICE_PAIRS: 'live.advicePairs',
  BGA_ADVICE_SETUP: 'live.adviceSetup',
  BGA_ADVICE_DRAFT_INCOMPLETE: 'live.adviceIncomplete',
  BGA_ADVICE_CONTEXT: 'live.adviceContext',
  BGA_ADVICE_TIME_ORDER: 'live.adviceTimeOrder',
  BGA_ADVICE_CHAIN_CONTEXT: 'live.adviceChainContext',
  BGA_ADVICE_RESOURCE_PARTIAL: 'live.adviceResourcePartial',
  BGA_ADVICE_FIGURES: 'live.adviceFigures',
  BGA_ADVICE_DICE_SLOT: 'live.adviceDiceSlot',
  BGA_ADVICE_TURN: 'live.adviceTurn',
  AI_MODEL_CONFIG_MISMATCH: 'live.adviceMismatch',
  AI_PYTHON_UNAVAILABLE: 'live.advicePython',
  AI_INFERENCE_TIMEOUT: 'live.adviceTimeout',
};
function chainText(choice) {
  const effect = (value) => text('live.effect', { amount: value.amount, effect: text(`editor.effect.${value.type}`) });
  if (choice.skip) return text('live.chainSkip');
  if (choice.type === 'chooseResource') return text('live.chainResource', { resource: text(`editor.effect.${choice.resource}`) });
  if (choice.type === 'gardener') return text('live.chainGardener', {
    color: text(`live.bridge.${choice.bridgeId}`),
    kind: text(choice.slot?.endsWith('-rock') ? 'live.gardenRock' : 'live.gardenPlant'), cost: choice.cost, card: choice.cardId,
  });
  if (choice.type === 'warrior') return text('live.chainWarrior', {
    cost: choice.yardId?.replace('yard-cost-', ''),
    order: choice.faceEffects?.map((effects) => effects.map(effect).join('、')).join(' → ') ?? '',
  });
  if (choice.type === 'effectOrder') return text('live.chainEffect', { effect: effect(choice.effect) });
  if (choice.type === 'field') return text('live.chainField', { effects: (choice.effects ?? []).map(effect).join('、') });
  if (choice.type === 'outside') return text('live.chainOutside', { action: text(`editor.effect.${choice.action}`) });
  if (choice.type === 'domain') return text('live.targetPersonal', { row: text(`editor.effect.${choice.row}`) });
  if (choice.type === 'exchangeSeal') return text('live.chainExchange', { amount: choice.amount,
    resource: text(`editor.effect.${choice.resource ?? 'coin'}`) });
  if (choice.type === 'castleOrder') return text('live.chainCastleOrder', {
    order: choice.fieldIds.map((id) => text(`play.field.${id}`)).join(' → '),
  });
  if (choice.type === 'courtier') return text('live.chainCourtier', {
    audience: text(choice.audience ? 'live.chainAudience' : 'live.chainNoAudience'),
    destination: choice.promote ? text('live.chainPromotion', { from: choice.from?.roomId ?? text('live.chainGate'),
      steps: choice.promote.steps, room: choice.promote.roomId ?? choice.promote.slotId }) : text('live.chainNoPromotion'),
    order: choice.audience && choice.promote ? text(choice.order?.[0] === 'promote'
      ? 'play.orderPromoteFirst' : 'play.orderAudienceFirst') : '',
  });
  if (choice.type === 'influence') return text(choice.pay ? 'live.chainPayGate' : 'live.chainDeclineGate');
  return text('live.chainNamed', { action: `editor.effect.${choice.type}` in StringTable
    ? text(`editor.effect.${choice.type}`) : text('live.chainOther'),
    target: [choice.roomId, choice.fieldId].filter(Boolean).join(' / ') });
}
function renderAdvice(latest, connected) {
  advice.replaceChildren(el('h2', text('live.next')));
  if (!adviceVersion) { advice.append(el('p', text('live.restart'))); return; }
  if (!connected || !latest) { advice.append(el('p', text('live.adviceWaiting'))); return; }
  const result = latest.recommendations;
  if (!result || result.status === 'pending') { advice.append(el('p', text('live.advicePending'))); return; }
  if (result.status !== 'ready') {
    advice.append(el('p', text(adviceErrors[result.code] ?? 'live.adviceError')),
      el('p', text('live.adviceBoundary'), 'muted'));
    return;
  }
  const name = latest.observation.players.find((player) => player.id === result.actor)?.name ?? result.actor;
  advice.append(el('p', text('live.adviceActor', { name }), 'action'),
    el('p', text('live.adviceModel', { generation: Number(result.model.replace('generation-', '')) }), 'muted'));
  const effect = (gain) => text('live.effect', { amount: gain.amount, effect: text(`editor.effect.${gain.type}`) });
  const candidates = el('ol', undefined, 'candidates');
  for (const candidate of result.candidates.slice(0, result.scope === 'placement-root-only' ? 5 : undefined)) {
    const item = el('li');
    if (result.scope === 'live-chain') {
      item.append(el('strong', chainText(candidate)), el('p', text('live.chainWeight', {
        weight: (candidate.policyWeight * 100).toFixed(1),
      }), 'muted'));
      candidates.append(item);
      continue;
    }
    if (result.scope === 'placement-root-only') {
      const weight = (candidate.policyWeight * 100).toFixed(1);
      if (candidate.kind === 'exchangeSeal') {
        item.append(el('strong', text('live.adviceExchange', { amount: candidate.action.amount,
          resource: candidate.action.resource ? text('live.exchangeResource', {
            resource: text(`editor.effect.${candidate.action.resource}`) }) : '', weight })));
      } else {
        const target = candidate.target;
        const room = /^floor([12])-([123])$/.exec(target.id ?? '');
        const targetName = target.area === 'castle' ? text('live.targetCastle', { floor: room[1], room: room[2] })
          : target.area === 'personal' ? text('live.targetPersonal', { row: text(`editor.effect.${target.row}`) })
            : target.area === 'outside' ? text('live.targetOutside', { side: text(target.id === 'left' ? 'live.leftEnd' : 'live.rightEnd') })
              : text('live.targetWell');
        item.append(el('strong', text('live.advicePlacement', {
          color: text(`live.${candidate.color === 'coral' ? 'red' : candidate.color}`),
          side: text(candidate.action.side === 'left' ? 'live.leftEnd' : 'live.rightEnd'),
          value: candidate.dieValue, target: targetName, weight })),
        el('p', text('live.placementCost', { delta: candidate.coinDelta >= 0 ? `+${candidate.coinDelta}` : candidate.coinDelta,
          lantern: text(candidate.lantern ? 'live.withLantern' : 'live.withoutLantern') }), 'muted'));
      }
      candidates.append(item);
      continue;
    }
    item.append(el('strong', text('live.adviceCandidate', { column: candidate.column,
      action: text(`editor.effect.${candidate.action}`), weight: (candidate.policyWeight * 100).toFixed(1) })),
    el('p', text('live.adviceGains', { gains: candidate.gains.map(effect).join('、') })),
    el('p', text('live.adviceLantern', { gains: candidate.lantern.map(effect).join('、') }), 'muted'),
    el('code', `${candidate.resourceId} + ${candidate.actionId}`));
    candidates.append(item);
  }
  advice.append(candidates);
  if (result.plan?.steps.length) {
    const steps = el('ol');
    result.plan.steps.forEach((step) => steps.append(el('li', chainText(step))));
    advice.append(el('h3', text('live.chainPlan')), el('p', text('live.chainConditional'), 'muted'), steps);
  }
  if (result.plan?.boundary === 'unknown-reveal') advice.append(el('p', text('live.chainReveal'), 'muted'));
  if (result.plan?.boundary === 'decision-limit') advice.append(el('p', text('live.chainLimit'), 'muted'));
  if (result.uncertainties?.includes('time-arrival-order')) advice.append(el('p', text('live.timeUncertainty'), 'muted'));
  advice.append(el('p', text(result.scope === 'starting-draft-only'
    ? 'live.adviceNotice' : 'live.placementNotice'), 'muted'));
}
async function refreshTraining() {
  if (!adviceVersion || Date.now() - checkedTraining < 10_000) return;
  checkedTraining = Date.now();
  training.replaceChildren(el('h2', text('live.training')));
  try {
    const response = await fetch('/api/live/training');
    if (!response.ok) throw new Error();
    const value = await response.json();
    if (value.status !== 'available') {
      training.append(el('p', text(value.status === 'incompatible' ? 'live.adviceMismatch' : 'live.trainingMissing')));
      return;
    }
    training.append(el('p', text('live.trainingProgress', { generation: value.generation,
      games: value.completedSelfplayGames, phase: text(phaseKeys[value.phase] ?? 'live.phase.other') })),
    el('p', text('live.trainingChampion', { generation: Number(value.champion?.replace('generation-', '')),
      state: text(value.running ? 'live.trainingRunning' : 'live.trainingIdle') })));
    if (value.guideEvaluation) training.append(el('p', text('live.trainingEvaluation', {
      wins: value.guideEvaluation.wins, games: value.guideEvaluation.games,
      margin: value.guideEvaluation.averageMargin.toFixed(2),
    }), 'muted'));
    training.append(el('p', text('live.trainingScope'), 'muted'));
  } catch { training.append(el('p', text('live.trainingMissing'))); }
}
const phaseKeys = {
  selfplay: 'live.phase.selfplay', evaluation: 'live.phase.evaluation',
  warmup: 'live.phase.warmup', stopped: 'live.phase.stopped',
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
      receivedAt: latest.changedAt, ...latest };
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
  if (importing) return;
  try {
    const response = await fetch('/api/live/state');
    if (!response.ok) throw new Error('NETWORK');
    current = await response.json();
    if (importedSnapshot) {
      status.textContent = text('live.snapshotMode', { time: importedSnapshot.changedAt });
      status.dataset.connected = 'false';
      meta.textContent = text('live.updated', { table: importedSnapshot.source.table, seconds: '—', updates: 1 });
      renderAdvice(importedSnapshot, true);
      void refreshTraining();
      return;
    }
    const { watch, latest, updates } = current;
    const seconds = watch?.receivedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(watch.receivedAt)) / 1000)) : null;
    const state = !watch ? 'live.waiting' : !watch.active ? 'live.stopped'
      : seconds === null ? 'live.loading' : seconds > 6 ? 'live.stale' : 'live.connected';
    status.textContent = text(state);
    status.dataset.connected = String(state === 'live.connected');
    meta.textContent = watch ? text('live.updated', { table: watch.table, seconds: unknown(seconds), updates }) : '';
    const version = JSON.stringify([watch?.id, updates]);
    if (rendered !== version) { render(latest); rendered = version; }
    renderAdvice(latest, state === 'live.connected');
    void refreshTraining();
    if (latest && setup.open && state === 'live.connected') setup.open = false;
  } catch {
    status.textContent = text('live.disconnected');
    status.dataset.connected = 'false';
    renderAdvice(null, false);
  }
}
try {
  const response = await fetch('/api/live/config');
  if (!response.ok) throw new Error('NETWORK');
  const config = await response.json();
  supported = config.assetVersion;
  adviceVersion = config.adviceVersion;
  pairToken = config.token;
  if (adviceVersion >= 3) {
    const saved = await fetch('/api/live/snapshot');
    if (saved.ok) {
      importedSnapshot = (await saved.json()).latest;
      if (importedSnapshot) render(importedSnapshot);
    }
  }
  setup.append(labeledCopy('live.address', location.origin),
    labeledCopy('live.folder', config.extensionPath), labeledCopy('live.pair', config.token));
  await refresh();
  setInterval(refresh, 1000);
} catch { status.textContent = text('live.disconnected'); }
