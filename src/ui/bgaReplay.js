import { text } from './StringTable.js';

const root = document.querySelector('#bga-replay');
document.title = text('bga.title');
const el = (tag, content) => {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  return node;
};
const title = el('h1', text('bga.title'));
const explanation = el('p', text('bga.description'));
const input = el('input');
input.type = 'file';
input.accept = '.json,application/json';
input.setAttribute('aria-label', text('bga.choose'));
const output = el('section');
root.append(title, explanation, input, output);
const list = (heading, rows) => {
  output.append(el('h2', heading));
  const ul = el('ul');
  rows.forEach((row) => ul.append(el('li', row)));
  output.append(ul);
};
input.addEventListener('change', async () => {
  output.replaceChildren();
  try {
    if (!input.files[0] || input.files[0].size > 10_000_000) throw new Error('FILE');
    const archive = JSON.parse(await input.files[0].text());
    if (archive.format !== 'whitecastle-bga-archive' || archive.version !== 1
      || !archive.publicPosition || !Array.isArray(archive.history)
      || !Array.isArray(archive.status?.issues)) throw new Error('FORMAT');
    const position = archive.publicPosition;
    output.append(el('p', text('bga.source', { table: archive.source.table, cursor: position.cursor })));
    output.append(el('p', text('bga.imported', { groups: archive.historySummary.groups, entries: archive.historySummary.entries })));
    output.append(el('p', text('bga.notExecutable')));
    const checkedScore = archive.validation?.terminalScore;
    if (checkedScore) output.append(el('p', text('bga.scoreCheck', {
      scores: Object.values(checkedScore.result.players).map((player) => player.total).join(' / '),
      result: text(checkedScore.matchesDisplayedScores ? 'bga.scoreMatch' : 'bga.scoreMismatch'),
    })));
    list(text('bga.players'), position.players.map((player) => text('bga.player', {
      n: Number(player.seat) + 1, score: player.displayedScore,
      resources: Object.entries(player.resources).map(([type, value]) => `${text(`editor.effect.${type}`)} ${value}`).join(' · '),
    })));
    list(text('bga.cards'), position.cards.map((card) => `${card.instance} → ${card.localId ?? text(card.faceDown ? 'bga.hidden' : 'bga.unmapped')} · ${card.slot ?? ''}`));
    list(text('bga.training'), position.training.map((tile) => `${tile.slot}: ${tile.localId ?? text('bga.unmapped')}`));
    list(text('bga.issues'), archive.status.issues.map((issue) => JSON.stringify(issue)));
    list(text('bga.undo'), archive.historySummary.undoMoves.map(String));
    output.append(el('h2', text('bga.logs')));
    for (const group of archive.history) {
      const details = el('details');
      details.append(el('summary', text('bga.move', { n: group.move })));
      for (const entry of group.entries) {
        details.append(el('p', entry.text));
        if (entry.icons?.length) details.append(el('code', JSON.stringify(entry.icons)));
      }
      output.append(details);
    }
  } catch {
    output.replaceChildren(el('p', text('bga.invalid')));
  }
});
