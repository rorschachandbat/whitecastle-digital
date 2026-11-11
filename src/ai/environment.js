import { createLocalMatch, activeLocalPlayer, remainingRoundGardens } from '../engine/localMatch.js';
import { placementOptions, probeLocalAction, chooseActionOption } from '../engine/actionOptions.js';
import { encodeState, encodeOption, FEATURE_VERSION } from './features.js';
import { heuristicScore } from './heuristicPolicy.js';

export const ACTION_MODEL_VERSION = 'factored-engine-v1';

/** 逐项决策避免完整回合动作的组合爆炸；已提交动作仍由同一纯规则引擎执行。 */
export class TrainingEnvironment {
  constructor(catalog, weights, { maxDecisions = 1500 } = {}) {
    this.catalog = catalog;
    this.weights = weights;
    this.maxDecisions = maxDecisions;
    this.witnesses = new Map();
  }

  reset(seed, playOrder) {
    this.match = createLocalMatch(this.catalog, { seed, ...(playOrder ? { playOrder } : {}) });
    this.pending = null;
    this.probe = null;
    this.orderPrefix = [];
    this.decisions = 0;
    this.options = null;
    this.witnesses.clear();
    return this.observe();
  }

  get actor() { return activeLocalPlayer(this.match); }

  choiceValues(probe) {
    const values = probe.options.map((option) => option.value);
    if (!['chooseResource', 'effectOrder'].includes(probe.request.type)) {
      for (const exchange of [{ amount: 1 }, ...['food', 'iron', 'pearl'].map((resource) => ({ amount: 2, resource }))]) {
        values.push({ type: 'exchangeSeal', ...exchange });
      }
    }
    return values;
  }

  probeChoice(probe, value) {
    if (value?.type !== 'exchangeSeal') return probeLocalAction(this.match, chooseActionOption(probe, value));
    const action = structuredClone(probe.action);
    action.decisions.splice(probe.request.index, 0, value);
    return probeLocalAction(this.match, action);
  }

  /** 只验证当前原子动作能否结束，不做跨回合搜索，也不把试走后的状态提供给网络。 */
  canComplete(probe, budget = { remaining: 4000 }, prefix = []) {
    if (--budget.remaining < 0) throw new Error('AI_LEGALITY_SEARCH_LIMIT');
    if (probe.status === 'invalid') return false;
    if (probe.status === 'ready') return true;
    const key = JSON.stringify([probe.action, prefix]);
    if (this.witnesses.has(key)) return this.witnesses.get(key);
    let possible = false;
    if (probe.request.type === 'effectOrder') {
      for (let index = 0; index < probe.request.effects.length; index += 1) {
        if (prefix.includes(index)) continue;
        const order = [...prefix, index];
        const result = order.length === probe.request.effects.length
          ? this.canComplete(probeLocalAction(this.match, chooseActionOption(probe, order)), budget)
          : this.canComplete(probe, budget, order);
        if (result) { possible = true; break; }
      }
    } else {
      // 先试放弃字段作为结束见证；探索顺序不会改变可选集合或玩家实际选择。
      const values = this.choiceValues(probe).sort((left, right) => Number(Boolean(right?.skip)) - Number(Boolean(left?.skip)));
      for (const value of values) {
        if (this.canComplete(this.probeChoice(probe, value), budget)) { possible = true; break; }
      }
    }
    this.witnesses.set(key, possible);
    return possible;
  }

  rootActions() {
    const actor = this.actor;
    if (this.match.phase === 'draft') return this.match.draft.pairs.filter((pair) => pair.chosenBy === null)
      .map((pair) => ({ type: 'chooseStartingPair', actor, pairId: pair.id }));
    const exchanges = [{ type: 'exchangeSeal', actor, amount: 1 },
      ...['food', 'iron', 'pearl'].map((resource) => ({ type: 'exchangeSeal', actor, amount: 2, resource }))];
    if (this.match.phase === 'round-gardens') return [
      ...remainingRoundGardens(this.match).map((cardId) => ({ type: 'roundGarden', actor, cardId })), ...exchanges,
    ];
    return [...this.match.state.bridges.flatMap((bridge) =>
      (bridge.dice.length === 1 ? [bridge.singleDieEndpoint] : ['left', 'right']).flatMap((side) =>
        placementOptions(this.match, bridge.id, side).map((item) => item.action))), ...exchanges];
  }

  /** 返回当前步骤可接受的选择；效果排序逐个选择下一项，不截断完整排列。 */
  getLegalActions() {
    if (this.options) return this.options;
    if (this.match.phase === 'finished') return [];
    let options;
    if (!this.pending) {
      options = this.rootActions().map((action) => ({ action, next: probeLocalAction(this.match, action) }));
    } else if (this.probe.request.type === 'effectOrder') {
      options = this.probe.request.effects.flatMap((_, orderIndex) => {
        if (this.orderPrefix.includes(orderIndex)) return [];
        const prefix = [...this.orderPrefix, orderIndex];
        const complete = prefix.length === this.probe.request.effects.length;
        const action = complete ? chooseActionOption(this.probe, prefix) : null;
        return [{ orderIndex, value: orderIndex, prefix, next: complete ? probeLocalAction(this.match, action) : null }];
      });
    } else {
      options = this.choiceValues(this.probe).map((value) => ({ value, next: this.probeChoice(this.probe, value) }));
    }
    this.options = options.filter((option) => option.next
      ? this.canComplete(option.next) : this.canComplete(this.probe, undefined, option.prefix));
    if (!this.options.length) throw new Error(`AI_NO_OPTIONS:${this.probe?.request?.type ?? this.match.phase}`);
    return this.options;
  }

  observe() {
    if (this.match.phase === 'finished') return {
      done: true, score: this.match.state.score, decisions: this.decisions,
      placements: this.match.actions.filter((action) => action.type === 'placeDie').length,
    };
    const options = this.getLegalActions();
    const state = encodeState(this);
    const candidates = options.map((option) => encodeOption(this, option));
    const heuristic = options.map((option) => heuristicScore(this, option, this.weights));
    if (![...state, ...candidates.flat(), ...heuristic].every(Number.isFinite)) throw new Error('AI_NONFINITE_FEATURE');
    return {
      done: false, actor: this.actor, state, candidates, heuristic,
      request: this.probe?.request?.type ?? 'root',
      featureVersion: FEATURE_VERSION, actionModelVersion: ACTION_MODEL_VERSION,
    };
  }

  step(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.getLegalActions().length) throw new Error('AI_INVALID_INDEX');
    if (++this.decisions > this.maxDecisions) throw new Error('AI_DECISION_LIMIT');
    const option = this.options[index];
    if (option.prefix && !option.next) this.orderPrefix = option.prefix;
    else {
      const next = option.next;
      this.orderPrefix = [];
      if (next.status === 'ready') {
        this.match = next.preview;
        this.pending = null;
        this.probe = null;
        this.witnesses.clear();
      } else {
        this.pending = next.action;
        this.probe = next;
      }
    }
    this.options = null;
    return this.observe();
  }
}
