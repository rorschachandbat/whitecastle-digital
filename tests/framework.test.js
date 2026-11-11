import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { WhiteCastle, STATE_SCHEMA_VERSION } from '../src/game/game.js';
import { StringTable, text } from '../src/ui/StringTable.js';

// Node 直接加载已发布包的 CommonJS 入口，不经过 Vite、转译器或项目构建。
const require = createRequire(import.meta.url);
const { Client } = require('boardgame.io/client');

test('真实 boardgame.io Client 可以初始化两人骨架并保持状态可序列化', () => {
  const client = Client({ game: WhiteCastle, numPlayers: 2, debug: false });
  client.start();
  try {
    const { G, ctx } = client.getState();
    assert.equal(ctx.numPlayers, 2);
    assert.equal(G.schemaVersion, STATE_SCHEMA_VERSION);
    assert.equal(G.mode, 'scaffold');
    assert.equal(G.players.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(G)), G);
    assert.deepEqual(Object.keys(client.moves), []);
  } finally {
    client.stop();
  }
});

test('规则待实现时不暴露可跳过回合或结束游戏的客户端事件', () => {
  const client = Client({ game: WhiteCastle, numPlayers: 2, debug: false });
  assert.deepEqual(Object.keys(client.events), []);
});

test('StringTable 为未知键明确报错，防止玩家界面静默显示缺失文案', () => {
  assert.equal(text('app.title'), StringTable['app.title']);
  assert.throws(() => text('missing.key'), /StringTable/);
});
