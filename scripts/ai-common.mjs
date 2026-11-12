import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalCatalog, validateCatalog } from '../src/data/catalog.js';
import { FEATURE_VERSION } from '../src/ai/features.js';
import { ACTION_MODEL_VERSION } from '../src/ai/environment.js';
import { LOCAL_PROFILE_ID } from '../src/engine/localMatch.js';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const digest = (value) => createHash('sha256').update(canonicalCatalog(value)).digest('hex');
export function loadTrainingConfig(catalogPath, weightsPath) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath ?? path.join(projectRoot, 'data/whitecastle-2p.json'), 'utf8'));
  const weights = JSON.parse(fs.readFileSync(weightsPath ?? path.join(projectRoot, 'data/ai-heuristic.json'), 'utf8'));
  if (validateCatalog(catalog).length) throw new Error('AI_INVALID_CATALOG');
  if (!Array.isArray(weights.rounds) || weights.rounds.length !== 3 || !weights.effect) throw new Error('AI_INVALID_WEIGHTS');
  const walk = (value) => {
    for (const child of Object.values(value)) {
      if (typeof child === 'object' && child !== null) walk(child);
      else if (typeof child !== 'string' && !Number.isFinite(child)) throw new Error('AI_INVALID_WEIGHTS');
    }
  };
  walk(weights);
  return {
    catalog, weights,
    meta: { profile: LOCAL_PROFILE_ID, featureVersion: FEATURE_VERSION, actionModelVersion: ACTION_MODEL_VERSION,
      setupVersion: 'room-colors-v2',
      catalogHash: digest(catalog), heuristicHash: digest(weights),
      encoderHash: createHash('sha256').update(fs.readFileSync(path.join(projectRoot, 'src/ai/features.js')))
        .update(fs.readFileSync(path.join(projectRoot, 'src/ai/environment.js'))).digest('hex') },
  };
}
