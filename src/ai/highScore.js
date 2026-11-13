import { score } from '../engine/engine.js';

export const SCORE_PARTS = ['points', 'coinAndSeal', 'resources', 'courtier', 'warrior', 'gardener', 'time'];
export const EVALUATOR_VERSION = 'public-high-score-potential-v1';

/** 所有输入均来自公开状态；潜力只是搜索先验，不计入实际分数或训练终局奖励。 */
export function highScoreStructure(player, config) {
  const figures = player?.figures ?? { courtier: [], warrior: [], gardener: [] };
  const internal = figures.courtier.filter((figure) => ['floor1', 'floor2', 'floor3'].includes(figure.location)).length;
  const warriorValue = figures.warrior.reduce((sum, figure) =>
    sum + (config.trainingZones.find((zone) => zone.id === figure.yardId)?.value ?? 0), 0);
  const resources = player?.resources ?? {};
  return {
    internal, warriorValue, synergy: internal * warriorValue,
    courtier: figures.courtier.length, warrior: figures.warrior.length, gardener: figures.gardener.length,
    gates: figures.courtier.filter((figure) => figure.location === 'gate').length,
    promotionReady: Number((resources.pearl ?? 0) >= 2),
    audienceReady: Number((resources.coin ?? 0) >= 2),
    resources: { food: resources.food ?? 0, iron: resources.iron ?? 0, pearl: resources.pearl ?? 0,
      coin: resources.coin ?? 0, seal: resources.seal ?? 0 },
  };
}

export function encodeHighScoreStructure(player, config) {
  const value = highScoreStructure(player, config);
  return [value.internal / 5, value.warriorValue / 10, value.synergy / 50,
    value.gates / 5, value.promotionReady, value.audienceReady];
}

/** 截断估值只在完整原子动作边界读取；终局严格退化为实际分数。 */
export function evaluateHighScore(match, actor, weights) {
  if (!match.state) return { committed: 0, potential: 0, total: 0, version: EVALUATOR_VERSION };
  const state = match.state;
  const player = state.players[actor];
  const committed = score(state, match.config).players[actor].total;
  if (match.phase === 'finished') return { committed, potential: 0, total: committed, version: EVALUATOR_VERSION };
  const structure = highScoreStructure(player, match.config);
  const turnsLeft = Math.max(0, (3 - state.round) * 3 + 3 - state.turnsUsed[actor]);
  const horizon = Math.min(1, turnsLeft / 6);
  const prior = weights.highScore ?? {};
  const expectedCourtiers = Math.min(5 - structure.internal, turnsLeft * (prior.courtiersPerTurn ?? 0.35));
  const expectedWarriorValue = Math.min(10 - structure.warriorValue, turnsLeft * (prior.warriorValuePerTurn ?? 0.45));
  // 只计当前人员与未来部署的交叉贡献，避免把双方均未部署的人员凭空相乘。
  const synergy = (structure.warriorValue * expectedCourtiers + structure.internal * expectedWarriorValue)
    * (prior.synergyPotential ?? 0.5);
  const reserve = (Math.min(structure.resources.pearl, 5) * (structure.courtier < 5 || structure.internal > 0 ? 0.65 : 0)
    + Math.min(structure.resources.iron, 5) * (structure.warrior < 5 ? 0.5 : 0)
    + Math.min(structure.resources.food, 5) * (structure.gardener < 5 ? 0.4 : 0)
    + Math.min(structure.resources.coin, 4) * 0.3 + structure.resources.seal * 0.35) * horizon;
  const potential = synergy + reserve;
  return { committed, potential, total: committed + potential, turnsLeft, structure, version: EVALUATOR_VERSION };
}

/** 每个动作边界写入可解释状态，便于检查分数来源和部署进度。 */
export function publicScoreDiagnostics(match) {
  if (!match.state) return { phase: match.phase };
  const result = score(match.state, match.config);
  return { phase: match.phase, round: match.state.round, turnsUsed: { ...match.state.turnsUsed },
    players: Object.fromEntries(['0', '1'].map((actor) => [actor, {
      ...highScoreStructure(match.state.players[actor], match.config),
      timePosition: match.state.players[actor].timePosition, committed: result.players[actor],
    }])) };
}
