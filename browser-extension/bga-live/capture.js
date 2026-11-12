/**
 * 只读取当前文档中可见的盘面 DOM；调用方负责选择 iframe 及保存到本地。
 * 此函数不访问网页运行时变量、Cookie、网络或未显示的牌堆正面。
 */
function captureBgaDocument(root, { live = false } = {}) {
  const visible = (element) => !live || element.getClientRects().length > 0;
  const number = (element) => element && /^\d+$/.test(element.textContent.trim())
    ? Number(element.textContent.trim()) : null;
  const ancestry = (element) => {
    const result = [];
    for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (parent.id || parent.dataset.slotId) result.push({ id: parent.id, slot: parent.dataset.slotId });
    }
    return result;
  };
  const items = (selector) => [...root.querySelectorAll(selector)].filter(visible).map((element) => {
    const side = element.dataset.side;
    const art = element.querySelector(`.card-side.${side === 'back' ? 'back' : 'front'}`);
    return {
      id: element.id, data: Object.fromEntries(['side', 'type', 'value']
        .filter((key) => element.dataset[key] !== undefined).map((key) => [key, element.dataset[key]])),
      face: art ? Object.fromEntries(['type', 'typeArg', 'color']
        .filter((key) => art.dataset[key] !== undefined).map((key) => [key, art.dataset[key]])) : null,
      ancestors: ancestry(element),
    };
  });
  // 起始选牌只在剩余牌组同时可见且布局稳定时记录配对，动画或换行时留空。
  const draftPairs = () => {
    if (!live) return [];
    const row = (kind) => [...root.querySelectorAll(`#twc-starting-${kind}-draft-stock .twc-main-card`)]
      .filter(visible).map((element) => ({ id: element.id, rect: element.getBoundingClientRect() }))
      .sort((a, b) => a.rect.left - b.rect.left);
    const resources = row('resource');
    const actions = row('action');
    if (![2, 3].includes(resources.length) || resources.length !== actions.length) return [];
    if ([resources, actions].some((cards) => cards.some((card, index) => card.rect.width <= 0 || card.rect.height <= 0
      || Math.abs(card.rect.top - cards[0].rect.top) > 5
      || (index > 0 && card.rect.left - cards[index - 1].rect.left < card.rect.width * 0.5)))) return [];
    const close = (a, b) => Math.abs(a.left + a.width / 2 - b.left - b.width / 2)
      <= Math.max(3, Math.min(a.width, b.width) * 0.2);
    return resources.every((card, index) => close(card.rect, actions[index].rect))
      ? resources.map((card, index) => ({ resource: card.id, action: actions[index].id })) : [];
  };
  return {
    format: 'whitecastle-bga-observation', version: 1,
    cursor: number(root.querySelector('#move_nbr')),
    progress: number(root.querySelector('#pr_gameprogression')),
    roundText: root.querySelector('#twc-main-game-panel-round-counter')?.textContent ?? null,
    title: root.querySelector('#pagemaintitletext')?.textContent ?? null,
    decision: live ? {
      description: root.querySelector('#twc-perform-action-additional-description')?.textContent ?? '',
      buttons: [...root.querySelectorAll('#generalactions .action-button,#generalactions .jj-choose-action-button')]
        .filter(visible).map((element) => ({
          id: element.id, text: element.textContent.trim(), disabled: element.classList.contains('disabled'),
          icons: [...element.querySelectorAll('[data-type]')].map((icon) => icon.dataset.type),
        })),
      targets: [...root.querySelectorAll('.bga-cards_selectable-card,.selectable')].filter(visible)
        .filter((element) => element.id.startsWith('twc-')).map((element) => element.id),
    } : null,
    draftPairs: draftPairs(),
    players: [...root.querySelectorAll('[id^="twc-player-panel-resources-"]')].filter(visible).map((element) => {
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
    logs: live ? [] : [...root.querySelectorAll('.replaylogs_move')].map((group) => ({
      move: Number(group.id.replace('replaylogs_move_', '')),
      entries: [...group.querySelectorAll('.gamelogreview')].map((entry) => ({
        text: entry.textContent.trim(),
        icons: [...entry.querySelectorAll('[data-type]')].map((icon) => ({ ...icon.dataset })),
      })),
    })),
  };
}

// 同一份读取器供扩展经典脚本与本地ES模块使用，避免两份选择器逐渐分歧。
globalThis.whitecastleCaptureBgaDocument = captureBgaDocument;
