// 脚本在隔离世界中运行，只使用DOM；重新启动不会叠加监听器或计时器。
if (!globalThis.whitecastleWatcherInstalled) {
  globalThis.whitecastleWatcherInstalled = true;
  let timer = null;
  let busy = false;
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (!['WATCH_START', 'WATCH_STOP'].includes(message.type)) return;
    clearInterval(timer);
    timer = null;
    if (message.type === 'WATCH_STOP') { reply({ ok: true }); return; }
    let previous = '';
    let sequence = 0;
    const sample = async () => {
      if (busy) return;
      const root = document.body;
      if (!root?.querySelector('[id^="twc-player-panel-resources-"]')) return;
      const observation = globalThis.whitecastleCaptureBgaDocument(root, { live: true });
      if (observation.players.length < 2) return;
      const current = JSON.stringify(observation);
      const stable = current === previous;
      previous = current;
      if (!stable) return;
      const assetVersions = new Set([...document.querySelectorAll('script[src],img[src]')]
        .map((node) => /\/thewhitecastle\/(\d{6}-\d{4})\//.exec(node.src)?.[1]).filter(Boolean));
      busy = true;
      try {
        await chrome.runtime.sendMessage({
          type: 'CAPTURE', watchId: message.watchId, sequence: ++sequence, observation,
          gameAssetVersion: assetVersions.size === 1 ? [...assetVersions][0] : null,
        });
      } catch { clearInterval(timer); }
      finally { busy = false; }
    };
    timer = setInterval(sample, 1000);
    sample();
    reply({ ok: true });
  });
}
