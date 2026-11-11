import { Client } from 'boardgame.io/client';
import { WhiteCastle } from './game/game.js';
import { text } from './ui/StringTable.js';
import rules from '../docs/RULES.md?raw';
import guide from '../docs/boardgameio-guide.md?raw';
import plan from '../docs/implementation-plan.md?raw';
import workflow from '../docs/development-workflow.md?raw';
import changelog from '../CHANGELOG.md?raw';
import './ui/styles.css';

document.title = text('app.title');

function element(tag, key, className) {
  const node = document.createElement(tag);
  if (key) node.textContent = text(key);
  if (className) node.className = className;
  return node;
}

const app = document.querySelector('#app');
const header = element('header', null, 'hero');
header.append(
  element('p', 'app.brand', 'eyebrow'),
  element('h1', 'app.title'),
  element('p', 'app.tagline', 'tagline'),
  element('p', 'app.intro', 'intro'),
);
app.append(header);

const status = element('section', null, 'status');
status.append(
  element('span', 'status.label', 'eyebrow'),
  element('h2', 'status.value'),
  element('p', 'status.notice'),
);
app.append(status);
const editorLink = element('a', 'editor.open', 'editor-link');
editorLink.href = './config-editor.html';
app.append(editorLink);

const grid = element('div', null, 'grid');
const framework = element('section', null, 'panel');
const connection = element('p', 'framework.loading', 'connection');
const stateView = element('pre', null, 'state');
const exportButton = element('button', 'framework.export');
exportButton.disabled = true;
framework.append(
  element('h2', 'framework.title'),
  connection,
  element('p', 'framework.version', 'muted'),
  element('h3', 'framework.state'),
  stateView,
  exportButton,
  element('p', 'framework.exportNotice', 'muted'),
);
grid.append(framework);

const docs = element('section', null, 'panel');
docs.append(element('h2', 'rules.title'), element('p', 'rules.body'));
const docList = element('nav', null, 'doc-list');
const docView = element('pre', null, 'document');
const docSection = element('section', null, 'document-panel');
docSection.id = 'document';
const docTitle = element('h2', 'rules.link');
docSection.append(docTitle, docView);
const documents = [
  ['rules.link', rules],
  ['guide.link', guide],
  ['plan.link', plan],
  ['workflow.link', workflow],
  ['changelog.link', changelog],
];
for (const [key, content] of documents) {
  const link = element('a', key);
  link.href = '#document';
  link.addEventListener('click', () => {
    docTitle.textContent = text(key);
    docView.textContent = content;
  });
  docList.append(link);
}
docView.textContent = rules;
docs.append(docList);
grid.append(docs);
app.append(grid);

const roadmap = element('section', null, 'panel roadmap');
roadmap.append(element('h2', 'roadmap.title'));
const steps = element('ol');
for (const key of ['roadmap.engine', 'roadmap.actions', 'roadmap.web', 'roadmap.replay', 'roadmap.ai']) {
  steps.append(element('li', key));
}
roadmap.append(steps, element('p', 'roadmap.note', 'muted'));
app.append(roadmap, docSection, element('footer', 'footer.text'));

try {
  const client = Client({ game: WhiteCastle, numPlayers: 2, debug: false });
  client.start();
  const state = client.getState();
  if (!state?.G || state.G.mode !== 'scaffold') {
    throw new Error('框架未返回预期的骨架状态');
  }
  stateView.textContent = JSON.stringify(state.G, null, 2);
  connection.textContent = text('framework.ready');
  exportButton.disabled = false;
  exportButton.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.G, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const download = document.createElement('a');
    download.href = url;
    download.download = 'whitecastle-scaffold-state.json';
    download.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
} catch (error) {
  connection.textContent = text('framework.failed');
  console.error(error);
}
