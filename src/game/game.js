import { createLocalMatch, applyLocalAction, activeLocalPlayer } from '../engine/localMatch.js';

// 已发布0.50.2的公开INVALID_MOVE值；保持此纯模块可由Node原生ESM加载。
const INVALID_MOVE = 'INVALID_MOVE';

export const STATE_SCHEMA_VERSION = 1;

/** 框架承载本地轮流对局；规则状态只由同一纯引擎产生，ctx跟随其当前决策玩家。 */
export function createLocalGame(catalog, options = {}) {
  return {
    name: 'whitecastle-local',
    minPlayers: 2,
    maxPlayers: 2,
    setup: () => createLocalMatch(catalog, options),
    turn: {
      order: {
        first: ({ G }) => Number(activeLocalPlayer(G)),
        next: ({ G }) => Number(activeLocalPlayer(G) ?? '0'),
      },
    },
    moves: {
      act: ({ G, ctx, playerID, events }, action) => {
        if (action?.actor !== ctx.currentPlayer || (playerID !== null && playerID !== action.actor)) return INVALID_MOVE;
        try {
          // 框架传入Immer代理，跨纯规则边界时先恢复可序列化快照。
          const next = applyLocalAction(JSON.parse(JSON.stringify(G)), action);
          const actor = activeLocalPlayer(next);
          if (actor !== null && actor !== ctx.currentPlayer) events.endTurn({ next: actor });
          return next;
        } catch {
          return INVALID_MOVE;
        }
      },
    },
    endIf: ({ G }) => G.phase === 'finished' ? { winner: G.state.score.winner } : undefined,
    events: {
      endTurn: false, endPhase: false, setPhase: false, setStage: false,
      endStage: false, setActivePlayers: false, pass: false, endGame: false,
    },
    disableUndo: true,
  };
}

// 此配置只用于确认框架接通；未校准的规则不开放为可执行动作。
export const WhiteCastle = {
  name: 'whitecastle-digital',
  minPlayers: 2,
  maxPlayers: 2,
  setup: ({ ctx }) => ({
    schemaVersion: STATE_SCHEMA_VERSION,
    mode: 'scaffold',
    rulesDocument: 'docs/RULES.md',
    players: Array.from({ length: ctx.numPlayers }, (_, index) => ({
      id: String(index),
    })),
    pending: [],
  }),
  moves: {},
  events: {
    endTurn: false,
    endPhase: false,
    setPhase: false,
    setStage: false,
    endStage: false,
    setActivePlayers: false,
    pass: false,
    endGame: false,
  },
};
