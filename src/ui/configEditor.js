import { EFFECT_TYPES, parseCatalog, validateCatalog, catalogFingerprint } from '../data/catalog.js';
import { text } from './StringTable.js';

document.title = text('editor.title');
const root = document.querySelector('#editor');
const STORAGE_KEY = 'whitecastle.catalog.v1';
let data;
let defaults;
let current;
let dirty = false;
let hashRequest = 0;
const clone = (value) => structuredClone(value);
const el = (tag, key, className) => {
  const node = document.createElement(tag);
  if (key) node.textContent = text(key);
  if (className) node.className = className;
  return node;
};
const message = el('p', 'editor.loading', 'editor-message');
message.setAttribute('role', 'status');
const title = el('h1', 'editor.title');
const toolbar = el('div', null, 'editor-toolbar');
const list = el('div', null, 'component-list');
const detail = el('section', null, 'panel component-detail');
const filter = document.createElement('select');
filter.setAttribute('aria-label', text('editor.filter'));
for (const kind of ['all', 'plant', 'stone', 'row', 'face', 'token']) {
  const option = el('option', kind === 'all' ? 'editor.all' : `editor.kind.${kind}`);
  option.value = kind;
  filter.append(option);
}
const search = document.createElement('input');
search.type = 'search';
search.placeholder = text('editor.search');
search.setAttribute('aria-label', text('editor.search'));
const revision = document.createElement('input');
revision.type = 'number';
revision.min = '1';
revision.max = '1000000';
revision.setAttribute('aria-label', text('editor.revision'));
const hash = el('code');
const advanced = el('textarea');
advanced.className = 'config-json';
advanced.setAttribute('aria-label', text('editor.advanced'));
advanced.spellcheck = false;
let advancedDirty = false;
advanced.addEventListener('input', () => { advancedDirty = true; });

function button(key, handler, parent = toolbar) {
  const node = el('button', key);
  node.type = 'button';
  node.addEventListener('click', handler);
  parent.append(node);
  return node;
}

function blocked() {
  if (dirty || advancedDirty) {
    message.textContent = text('editor.dirty');
    return true;
  }
  return false;
}

function setMessage(key, suffix = '') {
  message.textContent = text(key) + (suffix ? `\n${suffix}` : '');
}

function allEntries() {
  return [
    ...data.personalDomainRows.map((item, i) => ({ item, kind: 'row', path: ['personalDomainRows', i] })),
    ...data.cards.map((item, i) => ({ item, kind: item.kind, path: ['cards', i] })),
    ...data.yardFaces.map((item, i) => ({ item, kind: 'face', path: ['yardFaces', i] })),
    ...data.tokens.map((item, i) => ({ item, kind: 'token', path: ['tokens', i] })),
  ];
}

function renderList() {
  list.replaceChildren();
  const entries = allEntries().filter(({ item, kind }) => (filter.value === 'all' || filter.value === kind) && item.id.includes(search.value.trim()));
  if (!entries.length) list.append(el('p', 'editor.noResults'));
  for (const entry of entries) {
    const node = el('button', null, `component-choice ${entry.item.verification}`);
    node.type = 'button';
    node.textContent = `${text(`editor.kind.${entry.kind}`)} · ${entry.item.id}\n${text(`editor.${entry.item.verification}`)}`;
    node.setAttribute('aria-pressed', String(current?.item.id === entry.item.id));
    node.addEventListener('click', () => {
      if (blocked()) return;
      current = entry;
      renderDetail();
      renderList();
    });
    list.append(node);
  }
}

function field(parent, key, control) {
  const label = el('label', null, 'editor-field');
  label.append(el('span', key), control);
  parent.append(label);
}

function number(parent, key, value, update) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.max = '99';
  input.value = String(value ?? '');
  input.addEventListener('input', () => {
    dirty = true;
    update(input.value === '' ? null : Number(input.value));
  });
  field(parent, key, input);
}

function gains(parent, key, items, update, cost = false, fixed = false) {
  const group = el('fieldset', null, 'effect-group');
  group.append(el('legend', key));
  const rows = el('div');
  const renderRows = () => {
    rows.replaceChildren();
    items.forEach((gain, index) => {
      const row = el('div', null, 'effect-row');
      const type = document.createElement('select');
      type.setAttribute('aria-label', text('editor.effectType'));
      for (const value of cost ? ['food', 'iron', 'pearl', 'coin', 'seal'] : EFFECT_TYPES) {
        const option = el('option', `editor.effect.${value}`);
        option.value = value;
        type.append(option);
      }
      type.value = gain.type;
      type.addEventListener('change', () => { gain.type = type.value; dirty = true; update(items); });
      const amount = document.createElement('input');
      amount.type = 'number';
      amount.min = '1';
      amount.max = '99';
      amount.value = gain.amount;
      amount.setAttribute('aria-label', text('editor.amount'));
      amount.addEventListener('input', () => { gain.amount = Number(amount.value); dirty = true; update(items); });
      row.append(type, amount);
      if (!fixed) {
        button('editor.remove', () => {
          items.splice(index, 1);
          dirty = true;
          update(items);
          renderRows();
        }, row);
      }
      rows.append(row);
    });
  };
  group.append(rows);
  if (!fixed) {
    button('editor.add', () => {
      items.push({ type: 'food', amount: 1 });
      dirty = true;
      update(items);
      renderRows();
    }, group);
  }
  renderRows();
  parent.append(group);
}

function effectSummary(items) {
  return items.length ? items.map((gain) => `${text(`editor.effect.${gain.type}`)} ×${gain.amount}`).join(' · ') : text('editor.none');
}

function preview(item, kind) {
  const card = el('article', null, `component-preview preview-${kind}`);
  card.append(el('h3', 'editor.preview'));
  const id = el('p');
  id.textContent = item.id;
  card.append(id);
  const line = (key, value) => {
    const node = el('p');
    node.textContent = `${text(key)}：${value}`;
    card.append(node);
  };
  if (kind === 'row') {
    line('editor.base', effectSummary([item.baseGain]));
    item.revealedGains.forEach((gain, i) => {
      const node = el('p');
      node.textContent = `${text('editor.spot', { n: i + 1 })}：${effectSummary([gain])}`;
      card.append(node);
    });
  } else if (kind === 'token') {
    line('editor.faceIds', item.faceIds.join(' / ') || text('editor.pending'));
  } else {
    if (['plant', 'stone'].includes(kind)) {
      line('editor.foodCost', item.foodCost);
      line('editor.victoryPoints', item.victoryPoints);
    }
    for (const field of item.fields ?? [item]) {
      line(`editor.tone.${field.tone}`, effectSummary(field.effects));
      if (field.cost.length) line('editor.cost', effectSummary(field.cost));
    }
    if (item.back?.length) line('editor.back', effectSummary(item.back));
  }
  line('editor.status', text(`editor.${item.verification}`));
  return card;
}

function renderDetail() {
  detail.replaceChildren();
  if (!current) return;
  const draft = clone(current.item);
  const heading = el('h2');
  heading.textContent = `${text(`editor.kind.${current.kind}`)} · ${draft.id}`;
  detail.append(heading, preview(draft, current.kind));
  const status = document.createElement('select');
  for (const value of ['confirmed', 'pending']) {
    const option = el('option', `editor.${value}`);
    option.value = value;
    status.append(option);
  }
  status.value = draft.verification;
  status.addEventListener('change', () => { draft.verification = status.value; dirty = true; });
  field(detail, 'editor.status', status);
  const source = document.createElement('input');
  source.value = draft.sourceRef;
  source.type = 'url';
  source.addEventListener('input', () => { draft.sourceRef = source.value; dirty = true; });
  field(detail, 'editor.source', source);
  if (current.kind === 'row') {
    gains(detail, 'editor.base', [draft.baseGain], (values) => { draft.baseGain = values[0]; }, false, true);
    draft.revealedGains.forEach((gain, i) => {
      const group = el('div');
      const label = el('p');
      label.textContent = text('editor.spot', { n: i + 1 });
      group.append(label);
      gains(group, 'editor.effects', [gain], (values) => { draft.revealedGains[i] = values[0]; }, false, true);
      detail.append(group);
    });
  } else if (current.kind === 'token') {
    detail.append(el('p', 'editor.pairNotice'));
    const chosen = [draft.faceIds[0] ?? '', draft.faceIds[1] ?? ''];
    for (let i = 0; i < 2; i += 1) {
      const select = document.createElement('select');
      const none = el('option', 'editor.pending');
      none.value = '';
      select.append(none);
      for (const face of data.yardFaces) {
        const option = el('option');
        option.value = face.id;
        option.textContent = `${face.id} · ${effectSummary(face.effects)}`;
        select.append(option);
      }
      select.value = chosen[i];
      select.addEventListener('change', () => {
        chosen[i] = select.value;
        draft.faceIds = chosen.filter(Boolean);
        dirty = true;
      });
      field(detail, 'editor.faceIds', select);
    }
  } else {
    if (['plant', 'stone'].includes(current.kind)) {
      number(detail, 'editor.foodCost', draft.foodCost, (value) => { draft.foodCost = value; });
      number(detail, 'editor.victoryPoints', draft.victoryPoints, (value) => { draft.victoryPoints = value; });
    }
    for (const action of draft.fields ?? [draft]) {
      detail.append(el('h3', `editor.tone.${action.tone}`));
      gains(detail, 'editor.cost', action.cost, (items) => { action.cost = items; }, true);
      gains(detail, 'editor.effects', action.effects, (items) => { action.effects = items; });
    }
    if (draft.back) gains(detail, 'editor.back', draft.back, (items) => { draft.back = items; });
  }
  const actions = el('div', null, 'editor-toolbar');
  button('editor.apply', () => {
    if (advancedDirty) return setMessage('editor.dirty');
    const candidate = clone(data);
    candidate[current.path[0]][current.path[1]] = draft;
    const errors = validateCatalog(candidate);
    if (errors.length) return setMessage('editor.invalid', errors.map(({ path, code }) => `${path}: ${code}`).join('\n'));
    data = candidate;
    dirty = false;
    refresh(current.item.id);
    setMessage('editor.applied');
  }, actions);
  button('editor.undo', () => { dirty = false; renderDetail(); }, actions);
  detail.append(actions);
}

async function refresh(id = current?.item.id) {
  current = allEntries().find((entry) => entry.item.id === id) ?? allEntries()[0];
  revision.value = data.revision;
  advanced.value = JSON.stringify(data, null, 2);
  advancedDirty = false;
  renderList();
  renderDetail();
  const request = ++hashRequest;
  try {
    const result = await catalogFingerprint(data);
    if (request === hashRequest) hash.textContent = result;
  } catch {
    if (request === hashRequest) hash.textContent = text('editor.hashFailed');
  }
}

function download() {
  if (blocked()) return;
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'whitecastle-2p.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

button('editor.default', () => {
  if (blocked()) return;
  data = clone(defaults);
  refresh();
  setMessage('editor.defaultRestored');
});
button('editor.save', () => {
  if (blocked()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    setMessage('editor.saved');
  } catch { setMessage('editor.storageFailed'); }
});
button('editor.restore', () => {
  if (blocked()) return;
  try {
    const candidate = parseCatalog(localStorage.getItem(STORAGE_KEY));
    data = candidate;
    refresh();
    setMessage('editor.restored');
  } catch { setMessage('editor.restoreFailed'); }
});
button('editor.export', download);
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.json,application/json';
fileInput.setAttribute('aria-label', text('editor.import'));
fileInput.addEventListener('change', async () => {
  if (blocked()) { fileInput.value = ''; return; }
  const file = fileInput.files[0];
  if (!file) return;
  try {
    if (file.size > 1000000) throw new Error('FILE_SIZE');
    const candidate = parseCatalog(await file.text());
    if (blocked()) return;
    data = candidate;
    refresh();
    setMessage('editor.applied');
  } catch { setMessage('editor.fileFailed'); }
  finally { fileInput.value = ''; }
});
field(toolbar, 'editor.import', fileInput);
filter.addEventListener('change', renderList);
search.addEventListener('input', renderList);
revision.addEventListener('change', () => {
  if (blocked()) { revision.value = data.revision; return; }
  const candidate = clone(data);
  candidate.revision = Number(revision.value);
  if (validateCatalog(candidate).length) { revision.value = data.revision; return setMessage('editor.invalid', 'revision'); }
  data = candidate;
  refresh();
});
const side = el('aside', null, 'panel component-browser');
side.append(el('h2', 'editor.catalog'), filter, search, list);
const layout = el('div', null, 'editor-layout');
layout.append(side, detail);
const details = el('details', null, 'panel editor-advanced');
details.append(el('summary', 'editor.advanced'), advanced);
button('editor.applyJson', () => {
  if (dirty) return setMessage('editor.dirty');
  try {
    const candidate = parseCatalog(advanced.value);
    data = candidate;
    advancedDirty = false;
    refresh();
    setMessage('editor.applied');
  } catch (error) {
    setMessage('editor.invalid', error.issues?.map(({ path, code }) => `${path}: ${code}`).join('\n') ?? error.message);
  }
}, details);
button('editor.undo', () => { advanced.value = JSON.stringify(data, null, 2); advancedDirty = false; }, details);
root.append(title, el('p', 'editor.intro'), el('p', 'editor.scope'), message);
const revField = el('div');
field(revField, 'editor.revision', revision);
revField.append(el('p', 'editor.revisionHint'), el('p', 'editor.fingerprint'), hash);
root.append(toolbar, revField, layout, details);
window.addEventListener('beforeunload', (event) => {
  if (dirty || advancedDirty) { event.preventDefault(); event.returnValue = ''; }
});

try {
  const response = await fetch(new URL('../../data/whitecastle-2p.json', import.meta.url));
  if (!response.ok) throw new Error('FETCH_FAILED');
  data = parseCatalog(await response.text());
  defaults = clone(data);
  refresh();
  setMessage('editor.ready');
} catch (error) {
  for (const control of root.querySelectorAll('button,input,select,textarea')) control.disabled = true;
  setMessage('editor.failed');
  console.error(error);
}
