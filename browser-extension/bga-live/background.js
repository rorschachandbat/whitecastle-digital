const bgaUrl = (value) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !(url.hostname === 'boardgamearena.com'
    || url.hostname.endsWith('.boardgamearena.com'))) throw new Error('BGA_PAGE_REQUIRED');
  const table = url.searchParams.get('table');
  if (!/^\d+$/.test(table ?? '')) throw new Error('BGA_TABLE_REQUIRED');
  return { table, host: url.hostname };
};
const localAddress = (value) => {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('LOCAL_ADDRESS_INVALID');
  return url.origin;
};
async function request(settings, route, data) {
  const response = await fetch(`${localAddress(settings.address)}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.token}` },
    body: JSON.stringify(data), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`LOCAL_HTTP_${response.status}`);
}
async function stopCurrent() {
  const { watch, settings } = await chrome.storage.session.get(['watch', 'settings']);
  await chrome.storage.session.remove(['watch', 'lastStatus']);
  if (watch) {
    try { await chrome.tabs.sendMessage(watch.tab, { type: 'WATCH_STOP' }); } catch { /* 关闭的页面无需再停止。 */ }
    if (settings) {
      try { await request(settings, '/api/live/stop', { watchId: watch.id }); } catch { /* 本机服务可能已关闭。 */ }
    }
  }
}
async function handle(message, sender) {
  if (message.type === 'CAPTURE') {
    const { settings, watch } = await chrome.storage.session.get(['settings', 'watch']);
    if (!watch || sender.tab?.id !== watch.tab || message.watchId !== watch.id) return { ok: false };
    const frameSource = bgaUrl(sender.url);
    if (frameSource.table !== watch.table) return { ok: false };
    await request(settings, '/api/live/capture', {
      watchId: watch.id, sequence: message.sequence, observation: message.observation,
      source: { table: watch.table, host: frameSource.host, gameAssetVersion: message.gameAssetVersion },
    });
    await chrome.storage.session.set({ lastStatus: { table: watch.table, time: new Date().toLocaleTimeString() } });
    return { ok: true };
  }
  // 启停消息只能来自扩展弹窗；网页内容脚本只能上报观察。
  if (sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) throw new Error('SENDER_REJECTED');
  if (message.type === 'STOP') {
    await stopCurrent();
    return { ok: true };
  }
  if (message.type !== 'START') throw new Error('MESSAGE_REJECTED');
  const address = localAddress(message.address);
  if (!/^[a-f0-9]{48}$/.test(message.token ?? '')) throw new Error('PAIR_CODE_INVALID');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const source = bgaUrl(tab.url);
  await stopCurrent();
  const settings = { address, token: message.token };
  const watch = { id: crypto.randomUUID(), tab: tab.id, table: source.table };
  await request(settings, '/api/live/connect', { watchId: watch.id, table: watch.table });
  await chrome.storage.session.set({ settings, watch });
  try {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true }, files: ['capture.js', 'watcher.js'],
      });
    } catch {
      // 个别页面含无权访问的第三方iframe，仍允许读取已授权的顶层实际对局。
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, files: ['capture.js', 'watcher.js'],
      });
    }
    await chrome.tabs.sendMessage(tab.id, { type: 'WATCH_START', watchId: watch.id, table: watch.table });
  } catch (error) {
    await stopCurrent();
    throw error;
  }
  return { ok: true };
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(reply).catch(async (error) => {
    const code = /^(?:BGA_|LOCAL_|PAIR_|SENDER_|MESSAGE_)/.test(error.message)
      ? error.message : 'CONNECTION_FAILED';
    await chrome.storage.session.set({ lastStatus: { code } });
    reply({ ok: false, code });
  });
  return true;
});
chrome.tabs.onRemoved.addListener(async (tab) => {
  const { watch } = await chrome.storage.session.get('watch');
  if (watch?.tab === tab) await stopCurrent();
});
