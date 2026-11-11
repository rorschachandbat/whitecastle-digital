export const STATE_SCHEMA_VERSION = 1;

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
