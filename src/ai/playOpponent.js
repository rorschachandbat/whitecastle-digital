import { activeLocalPlayer } from '../engine/localMatch.js';

export const OPPONENT_DECISION_BATCH = 80;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

/** 并列时取最小下标，保证同一策略重复对局时选择稳定。 */
export function policyChoice(policy, count) {
  if (!Array.isArray(policy) || policy.length !== count || count < 1) fail('AI_INVALID_POLICY');
  let best = 0;
  let bestValue = -Infinity;
  let sum = 0;
  for (let index = 0; index < policy.length; index += 1) {
    const value = policy[index];
    if (!Number.isFinite(value) || value < -1e-6 || value > 1 + 1e-6) fail('AI_INVALID_POLICY');
    sum += value;
    if (value > bestValue) {
      bestValue = value;
      best = index;
    }
  }
  if (Math.abs(sum - 1) > 1e-3) fail('AI_INVALID_POLICY');
  return best;
}

function acceptInference(result, count, generation) {
  if (result?.source !== 'continuous-champion' || result.method !== 'policy-only'
    || !/^generation-\d{5}$/.test(result.model ?? '')) fail('AI_INVALID_POLICY');
  if (generation && result.model !== generation) fail('AI_CHAMPION_CHANGED');
  return { index: policyChoice(result.policy, count), model: result.model };
}

/**
 * 只替指定席位走完当前连续决策，停在另一席或终局。
 * 网络只接收公开特征；试走结果不回传给模型，也不读取未来骰子。
 */
export async function playOpponentSeat(environment, infer, {
  seat, maxDecisions = OPPONENT_DECISION_BATCH, generation,
} = {}) {
  if (seat !== '0' && seat !== '1') fail('AI_SEAT_INVALID');
  if (typeof infer !== 'function') fail('AI_INFERENCE_FAILED');
  const played = [];
  let model = generation ?? null;
  let decisions = 0;
  let bounded = false;
  while (environment.match.phase !== 'finished' && environment.actor === seat) {
    if (decisions >= maxDecisions) {
      bounded = true;
      break;
    }
    let observation;
    try {
      observation = environment.observe();
    } catch (error) {
      const code = String(error.code ?? error.message).startsWith('AI_NO_OPTIONS') ? 'AI_NO_OPTIONS' : (error.code ?? 'AI_INFERENCE_FAILED');
      fail(code);
    }
    if (observation.done || observation.actor !== seat) break;
    const choice = acceptInference(await infer(observation), observation.candidates.length, model);
    model = choice.model;
    const before = environment.match.actions.length;
    try {
      environment.step(choice.index);
    } catch (error) {
      const code = error.code ?? (String(error.message).startsWith('AI_') ? String(error.message).split(':')[0] : 'AI_INFERENCE_FAILED');
      fail(code);
    }
    decisions += 1;
    if (environment.match.actions.length > before) played.push(structuredClone(environment.match.actions.at(-1)));
    if (activeLocalPlayer(environment.match) !== seat) break;
  }
  return {
    actions: played, decisions, bounded, model, method: 'policy-only',
    done: environment.match.phase === 'finished',
    actor: activeLocalPlayer(environment.match),
  };
}
