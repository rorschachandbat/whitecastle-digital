import { text } from './StringTable.js';

const el = (tag, value) => {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  return node;
};
document.title = text('title');
const root = document.querySelector('#popup');
root.append(el('h1', text('title')), el('p', text('description')));
const address = el('input');
address.value = 'http://127.0.0.1:4180';
const token = el('input');
token.type = 'password';
for (const [key, input] of [['address', address], ['token', token]]) {
  const label = el('label', text(key));
  label.append(input);
  root.append(label);
}
const start = el('button', text('start'));
const stop = el('button', text('stop'));
const open = el('a', text('open'));
open.href = address.value;
open.target = '_blank';
open.rel = 'noreferrer';
const status = el('p', text('waiting'));
status.setAttribute('role', 'status');
root.append(start, stop, open, status);
const saved = await chrome.storage.session.get(['settings', 'lastStatus']);
const persistent = await chrome.storage.local.get('lastAddress');
if (saved.settings) {
  address.value = saved.settings.address;
  token.value = saved.settings.token;
} else if (persistent.lastAddress) address.value = persistent.lastAddress;
open.href = address.value;
if (saved.lastStatus?.code) status.textContent = text('error', saved.lastStatus);
else if (saved.lastStatus?.table) status.textContent = text('updated', saved.lastStatus);
start.onclick = async () => {
  start.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'START', address: address.value, token: token.value });
    status.textContent = result.ok ? text('connected') : text('error', { code: result.code });
    if (result.ok) open.href = address.value;
  } catch { status.textContent = text('error', { code: 'EXTENSION_CONNECTION_FAILED' }); }
  finally { start.disabled = false; }
};
stop.onclick = async () => {
  const result = await chrome.runtime.sendMessage({ type: 'STOP' });
  status.textContent = result?.ok ? text('stopped') : text('error', { code: result?.code ?? 'STOP_FAILED' });
};
