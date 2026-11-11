/**
 * 只读取当前回放文档的公开 DOM；调用方负责选择 iframe 及保存到本地。
 * 此函数不访问网页运行时变量、Cookie、网络或未显示的牌堆正面。
 */
export function captureBgaDocument(root) {
  const number = (element) => element && /^\d+$/.test(element.textContent.trim())
    ? Number(element.textContent.trim()) : null;
  const ancestry = (element) => {
    const result = [];
    for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (parent.id || parent.dataset.slotId) result.push({ id: parent.id, slot: parent.dataset.slotId });
    }
    return result;
  };
  const items = (selector) => [...root.querySelectorAll(selector)].map((element) => {
    const side = element.dataset.side;
    const art = element.querySelector(`.card-side.${side === 'back' ? 'back' : 'front'}`);
    return {
      id: element.id, data: { ...element.dataset },
      face: art ? { ...art.dataset } : null,
      ancestors: ancestry(element),
    };
  });
  return {
    format: 'whitecastle-bga-observation', version: 1,
    cursor: number(root.querySelector('#move_nbr')),
    progress: number(root.querySelector('#pr_gameprogression')),
    roundText: root.querySelector('#twc-main-game-panel-round-counter')?.textContent ?? null,
    title: root.querySelector('#pagemaintitletext')?.textContent ?? null,
    players: [...root.querySelectorAll('[id^="twc-player-panel-resources-"]')].map((element) => {
      const id = element.id.replace('twc-player-panel-resources-', '');
      return {
        id,
        name: root.querySelector(`#player_name_${id}`)?.textContent.trim() ?? null,
        color: root.querySelector(`#player_name_${id} a`)?.style.color ?? null,
        score: number(root.querySelector(`#player_score_${id}`)),
        resources: Object.fromEntries([...element.querySelectorAll('.jj-icon-stock[data-type]')].map((stock) => [
          stock.dataset.type,
          number(stock.querySelector('.icon-stock-counter-value')),
        ])),
      };
    }),
    cards: items('.twc-main-card,.twc-garden-card,.twc-daimyo-card'),
    tiles: items('.twc-yard-tile,.twc-die-tile'),
    dice: items('.twc-dice'),
    pieces: items('.twc-player-piece'),
    decks: ['steward', 'diplomat'].map((kind) => ({
      kind, count: number(root.querySelector(`#twc-${kind}-card-deck .bga-cards_deck-counter`)),
    })),
    logs: [...root.querySelectorAll('.replaylogs_move')].map((group) => ({
      move: Number(group.id.replace('replaylogs_move_', '')),
      entries: [...group.querySelectorAll('.gamelogreview')].map((entry) => ({
        text: entry.textContent.trim(),
        icons: [...entry.querySelectorAll('[data-type]')].map((icon) => ({ ...icon.dataset })),
      })),
    })),
  };
}
