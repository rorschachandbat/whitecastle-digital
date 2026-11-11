import { createRequire } from 'node:module';
import { createLocalGame } from './game.js';
import { applyLocalAction, exportLocalMatch, importLocalMatch, activeLocalPlayer } from '../engine/localMatch.js';

// 使用npm已发布的公共Client入口；本地HTTP服务不转译或构建项目。
const require = createRequire(import.meta.url);
const { Client } = require('boardgame.io/client');

export function createLocalClient(catalog, options = {}, actions = []) {
  const client = Client({ game: createLocalGame(catalog, options), numPlayers: 2, debug: false });
  client.start();
  try {
    for (const action of actions) submitLocalAction(client, action);
    return client;
  } catch (error) {
    client.stop();
    throw error;
  }
}

export function submitLocalAction(client, action) {
  const previous = client.getState();
  const actor = activeLocalPlayer(previous.G);
  // 先拿到结构化规则错误，框架move中的INVALID_MOVE只用于第二道验证。
  const expected = applyLocalAction(previous.G, action);
  client.updatePlayerID(actor);
  client.moves.act(action);
  const current = client.getState();
  if (current._stateID <= previous._stateID || current.G.actions.length !== expected.actions.length) {
    const error = new Error('FRAMEWORK_REJECTED');
    error.code = 'FRAMEWORK_REJECTED';
    throw error;
  }
  return current.G;
}

export function restoreLocalClient(save) {
  const match = importLocalMatch(save);
  const validated = exportLocalMatch(match);
  return createLocalClient(validated.catalog, validated.options, validated.actions);
}
