import { personalField } from '../engine/cardRules.js';

export const GAIN_TYPES = Object.freeze(['food', 'iron', 'pearl', 'coin', 'seal', 'points', 'influence', 'lantern', 'chooseResource']);
export const ACTION_TYPES = Object.freeze(['courtier', 'gardener', 'warrior', 'well', 'domain', 'castleAny', 'castleLight', 'castleCoral', 'castleBlack', 'castleWhite']);
export const EFFECT_TYPES = Object.freeze([...GAIN_TYPES, ...ACTION_TYPES]);
export const CARD_KINDS = Object.freeze(['plant', 'stone', 'startingResource', 'startingAction', 'steward', 'diplomat', 'top', 'decree']);
const TYPES = new Set(EFFECT_TYPES);
const STATUS = new Set(['confirmed', 'pending']);

// 校验负责结构和取值范围；confirmed 是资料核对声明，不是自动证明规则正确。
export function validateCatalog(data) {
  const errors = [];
  const check = (condition, path, code = 'invalid') => {
    if (!condition) errors.push({ path, code });
  };
  const integer = (value, min = 0, max = 99) => Number.isInteger(value) && value >= min && value <= max;
  const id = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
  const array = (value, path, max = 200) => {
    check(Array.isArray(value) && value.length <= max, path, 'array');
    return Array.isArray(value) ? value.slice(0, max) : [];
  };
  const effect = (item, path, cost = false) => {
    check(item && TYPES.has(item.type), `${path}.type`, 'effect');
    check(integer(item?.amount, 1), `${path}.amount`, 'amount');
    if (cost) check(['food', 'iron', 'pearl', 'coin', 'seal'].includes(item?.type), `${path}.type`, 'cost');
    if (ACTION_TYPES.includes(item?.type)) check(item.amount === 1, `${path}.amount`, 'actionAmount');
  };
  const effects = (items, path, cost = false) => array(items, path, 20).forEach((item, index) => effect(item, `${path}[${index}]`, cost));
  const images = new Map();
  const validSourceRef = (ref) => typeof ref === 'string' && (
    /^https:\/\/[^/\s]+(?:\/[^\s]*)?$/.test(ref)
    || /^image:([a-z][a-z0-9-]*)(?:#r[1-9]\d*c[1-9]\d*)?$/.test(ref)
      && images.has(ref.slice(6).split('#')[0])
  );
  const source = (item, path) => {
    check(typeof item.sourceRef === 'string' && item.sourceRef.length <= 2048, `${path}.sourceRef`, 'source');
    check(STATUS.has(item.verification), `${path}.verification`, 'status');
    if (item.verification === 'confirmed') check(validSourceRef(item.sourceRef), `${path}.sourceRef`, 'sourceRequired');
  };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [{ path: '$', code: 'object' }];
  check(data.schemaVersion === 1, 'schemaVersion', 'version');
  check(data.playerCount === 2, 'playerCount', 'twoPlayers');
  check(integer(data.revision, 1, 1000000), 'revision', 'revision');
  check(data.status === 'partial', 'status', 'partialOnly');
  if (data.imageSources !== undefined) {
    array(data.imageSources, 'imageSources', 200).forEach((image, index) => {
      const ip = `imageSources[${index}]`;
      check(id(image?.id) && !images.has(image?.id), `${ip}.id`, 'id');
      check(typeof image?.path === 'string' && image.path.startsWith('src/原始图片/')
        && !image.path.includes('..') && !image.path.includes('\\'), `${ip}.path`, 'imagePath');
      check(typeof image?.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(image.sha256), `${ip}.sha256`, 'imageHash');
      if (image?.id) images.set(image.id, image);
    });
  }
  check(data.limits?.resource === 7 && data.limits?.seal === 5, 'limits', 'rulesLimits');
  check([null, 'left', 'right', 'physical'].includes(data.policy?.singleDieEndpoint), 'policy.singleDieEndpoint', 'endpoint');
  const ids = new Set();
  const unique = (item, path) => {
    check(id(item?.id), `${path}.id`, 'id');
    check(!ids.has(item?.id), `${path}.id`, 'duplicate');
    ids.add(item?.id);
  };
  const rows = array(data.personalDomainRows, 'personalDomainRows', 3);
  check(rows.length === 3, 'personalDomainRows', 'threeRows');
  rows.forEach((row, i) => {
    const path = `personalDomainRows[${i}]`;
    if (!row || typeof row !== 'object') return check(false, path, 'object');
    unique(row, path);
    const expected = { courtier: 'coral', gardener: 'black', warrior: 'white' };
    check(Object.hasOwn(expected, row.figureType) && expected[row.figureType] === row.dieColor
      && row.id === row.figureType, path, 'rowMapping');
    check(row.compareValue === 6, `${path}.compareValue`, 'compareValue');
    source(row, path);
    effect(row.baseGain, `${path}.baseGain`);
    const revealed = array(row.revealedGains, `${path}.revealedGains`, 5);
    check(revealed.length === 5, `${path}.revealedGains`, 'fiveSpots');
    revealed.forEach((item, j) => effect(item, `${path}.revealedGains[${j}]`));
  });
  array(data.cards, 'cards').forEach((card, i) => {
    const path = `cards[${i}]`;
    if (!card || typeof card !== 'object') return check(false, path, 'object');
    unique(card, path);
    source(card, path);
    check(CARD_KINDS.includes(card.kind), `${path}.kind`, 'kind');
    if (card.playerCounts !== undefined) {
      check(Array.isArray(card.playerCounts) && card.playerCounts.length === 1
        && card.playerCounts[0] === 2, `${path}.playerCounts`, 'twoPlayers');
    }
    if (card.backSourceRef !== undefined) check(validSourceRef(card.backSourceRef), `${path}.backSourceRef`, 'sourceRequired');
    if (card.excludedInTwoPlayers !== undefined) check(card.excludedInTwoPlayers === false, `${path}.excludedInTwoPlayers`, 'excludedCard');
    if (['plant', 'stone'].includes(card.kind)) {
      check(integer(card.foodCost) && integer(card.victoryPoints), path, 'gardenValues');
    }
    const fields = array(card.fields, `${path}.fields`, 10);
    check(fields.length > 0 || ['startingResource', 'decree'].includes(card.kind), `${path}.fields`, 'empty');
    const fieldIds = new Set();
    fields.forEach((field, j) => {
      const fp = `${path}.fields[${j}]`;
      if (!field || typeof field !== 'object') return check(false, fp, 'object');
      check(id(field.id) && !fieldIds.has(field.id), `${fp}.id`, 'id');
      fieldIds.add(field.id);
      check(['light', 'dark', 'none'].includes(field.tone), `${fp}.tone`, 'tone');
      effects(field.cost, `${fp}.cost`, true);
      effects(field.effects, `${fp}.effects`);
    });
    effects(card.back, `${path}.back`);
    if (['startingAction', 'steward', 'diplomat'].includes(card.kind)) {
      try {
        for (const row of ['courtier', 'gardener', 'warrior']) personalField(card, row);
      } catch { check(false, `${path}.fields`, 'personalLayout'); }
    }
    if (card.kind === 'startingResource') {
      const initial = array(card.initialGains, `${path}.initialGains`, 20);
      check(initial.length > 0, `${path}.initialGains`, 'empty');
      initial.forEach((item, index) => {
        effect(item, `${path}.initialGains[${index}]`);
        check(['food', 'iron', 'pearl', 'coin', 'seal', 'chooseResource'].includes(item?.type),
          `${path}.initialGains[${index}].type`, 'initialGain');
      });
      if (card.grantDecreeId !== undefined) {
        check(Array.isArray(data.cards) && data.cards.some((other) => other?.id === card.grantDecreeId
          && other.kind === 'decree' && other.verification === 'confirmed'), `${path}.grantDecreeId`, 'decreeReference');
      }
    }
    if (card.kind === 'decree') check(fields.length === 0 && Array.isArray(card.back) && card.back.length === 1
      && ['coin', 'seal', 'points'].includes(card.back[0]?.type), path, 'decree');
    if (card.kind === 'top') check(fields.length === 3 && card.selection === 'oneEmptySlot'
      && ['left', 'middle', 'right'].every((slot) => fields.some((item) => item?.id === slot && item.capacity === 1)),
    `${path}.fields`, 'topSlots');
  });
  const faceIds = new Set();
  const faceTones = new Map();
  array(data.yardFaces, 'yardFaces', 32).forEach((face, i) => {
    const path = `yardFaces[${i}]`;
    if (!face || typeof face !== 'object') return check(false, path, 'object');
    unique(face, path);
    faceIds.add(face.id);
    faceTones.set(face.id, face.tone);
    source(face, path);
    if (face.additionalSourceRef !== undefined) check(validSourceRef(face.additionalSourceRef), `${path}.additionalSourceRef`, 'sourceRequired');
    check(['resource', 'action'].includes(face.tone), `${path}.tone`, 'tone');
    effects(face.cost, `${path}.cost`, true);
    effects(face.effects, `${path}.effects`);
  });
  const usedFaces = new Set();
  array(data.tokens, 'tokens', 8).forEach((token, i) => {
    const path = `tokens[${i}]`;
    if (!token || typeof token !== 'object') return check(false, path, 'object');
    unique(token, path);
    source(token, path);
    const faces = array(token.faceIds, `${path}.faceIds`, 2);
    check(faces.length === 0 || faces.length === 2, `${path}.faceIds`, 'pair');
    if (token.verification === 'confirmed') check(faces.length === 2, `${path}.faceIds`, 'pairRequired');
    for (const face of faces) {
      check(faceIds.has(face) && !usedFaces.has(face), `${path}.faceIds`, 'faceReference');
      usedFaces.add(face);
    }
    if (faces.length === 2) {
      const tones = faces.map((faceId) => faceTones.get(faceId));
      check(tones.includes('action') && tones.includes('resource'), `${path}.faceIds`, 'faceSides');
    }
  });
  if (data.trainingPools !== undefined) {
    const pools = array(data.trainingPools, 'trainingPools', 2);
    check(pools.length === 2, 'trainingPools', 'twoPools');
    check((data.tokens ?? []).length === 0, 'tokens', 'independentPools');
    const pooled = new Set();
    pools.forEach((pool, i) => {
      const pp = `trainingPools[${i}]`;
      if (!pool || typeof pool !== 'object') return check(false, pp, 'object');
      unique(pool, pp);
      source(pool, pp);
      check((pool.id === 'gold' && pool.tone === 'resource')
        || (pool.id === 'silver' && pool.tone === 'action'), pp, 'poolTone');
      const members = array(pool.faceIds, `${pp}.faceIds`, 32);
      check(members.length >= 2, `${pp}.faceIds`, 'poolSize');
      for (const member of members) {
        check(faceIds.has(member) && !pooled.has(member) && faceTones.get(member) === pool.tone,
          `${pp}.faceIds`, 'poolReference');
        pooled.add(member);
      }
    });
    check(pooled.size === faceIds.size, 'trainingPools', 'poolCoverage');
  }
  if (data.trainingZones !== undefined) {
    const zones = array(data.trainingZones, 'trainingZones', 3);
    check(zones.length === 3, 'trainingZones', 'threeZones');
    zones.forEach((zone, i) => {
      const zp = `trainingZones[${i}]`;
      if (!zone || typeof zone !== 'object') return check(false, zp, 'object');
      unique(zone, zp);
      source(zone, zp);
      check(integer(zone.ironCost, 1, 7) && integer(zone.value, 1, 7), zp, 'zoneValues');
      check(Array.isArray(zone.faceTones) && zone.faceTones.length >= 1 && zone.faceTones.length <= 2
        && new Set(zone.faceTones).size === zone.faceTones.length
        && zone.faceTones.every((tone) => ['action', 'resource'].includes(tone)), `${zp}.faceTones`, 'zoneFaces');
    });
  }
  if (data.unclassifiedAssets !== undefined) {
    array(data.unclassifiedAssets, 'unclassifiedAssets', 32).forEach((asset, i) => {
      const ap = `unclassifiedAssets[${i}]`;
      if (!asset || typeof asset !== 'object') return check(false, ap, 'object');
      unique(asset, ap);
      check(asset.enabled === false && asset.verification === 'pending', ap, 'unclassifiedDisabled');
      check(validSourceRef(asset.sourceRef), `${ap}.sourceRef`, 'sourceRequired');
      // observedEffects 是图片观察记录，不能作为基础版效果交给引擎执行。
      check(Array.isArray(asset.observedEffects) && asset.observedEffects.length > 0,
        `${ap}.observedEffects`, 'observedEffects');
    });
  }
  return errors;
}

export function parseCatalog(json) {
  if (typeof json !== 'string' || json.length > 1000000) throw new Error('CATALOG_SIZE');
  const data = JSON.parse(json);
  const errors = validateCatalog(data);
  if (errors.length) {
    const error = new Error('CATALOG_INVALID');
    error.issues = errors;
    throw error;
  }
  return data;
}

// 规范化序列化为配置指纹提供稳定输入，避免属性排列影响结果。
export function canonicalCatalog(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalCatalog).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalCatalog(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function catalogFingerprint(data) {
  const input = new TextEncoder().encode(canonicalCatalog(data));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
