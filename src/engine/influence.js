// 时间轨参数由当前局面的版本化配置提供，不从第三方实现推测。
import { EngineError } from './engine.js';

function fail(code, details) {
  throw new EngineError(code, code, details);
}

export function applyInfluence(player, amount, config, context) {
  const track = config.influenceTrack;
  if (!track || !['local-time-track-v1', 'verified-time-track-v1'].includes(track.fixtureVersion)
    || !Number.isSafeInteger(track.max) || track.max < 1 || !Array.isArray(track.gates)) {
    fail('DATA_UNVERIFIED');
  }
  if (!context || !Number.isSafeInteger(amount) || amount < 1
    || !Number.isSafeInteger(player.timePosition) || player.timePosition < 0 || player.timePosition > track.max) {
    fail('INVALID_STATE');
  }
  const next = structuredClone(player);
  const target = Math.min(track.max, next.timePosition + amount);
  const gates = [...track.gates].sort((a, b) => a.at - b.at);
  if (gates.some((gate, index) => !Number.isSafeInteger(gate.at) || gate.at < 1 || gate.at > track.max
    || !Number.isSafeInteger(gate.cost) || gate.cost < 1 || gate.cost > 5
    || index > 0 && gates[index - 1].at === gate.at)) fail('INVALID_STATE');
  let destination = target;
  for (const gate of gates) {
    if (gate.at <= next.timePosition || gate.at > target) continue;
    const index = context.decisionIndex++;
    const decision = context.decisions[index];
    if (!decision) {
      fail('CHOICE_REQUIRED', {
        type: 'influence', index, player: next, state: context.state, gate,
        options: [
          ...(next.resources.seal >= gate.cost ? [{ type: 'influence', gate: gate.at, pay: true }] : []),
          { type: 'influence', gate: gate.at, pay: false },
        ],
      });
    }
    if (decision.type !== 'influence' || decision.gate !== gate.at || typeof decision.pay !== 'boolean') {
      fail('INVALID_ACTION');
    }
    if (!decision.pay) {
      destination = gate.at - 1;
      break;
    }
    if (next.resources.seal < gate.cost) fail('INSUFFICIENT_SEALS');
    next.resources.seal -= gate.cost;
  }
  if (destination > next.timePosition) {
    context.state.timeSequence = (context.state.timeSequence ?? 0) + 1;
    next.timePriority = context.state.timeSequence;
    next.timePosition = destination;
  }
  return next;
}
