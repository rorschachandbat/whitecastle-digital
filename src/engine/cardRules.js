const ROWS = Object.freeze(['courtier', 'gardener', 'warrior']);
const COLORS = new Set(['coral', 'black', 'white']);

function invalid() {
  const error = new Error('CARD_FIELD_INVALID');
  error.code = 'CARD_FIELD_INVALID';
  throw error;
}

function fieldsOf(card) {
  if (!card || !Array.isArray(card.fields) || card.fields.length === 0) invalid();
  const ids = new Set();
  for (const field of card.fields) {
    if (!field || typeof field.id !== 'string' || !field.id || ids.has(field.id)
      || !['light', 'dark', 'none'].includes(field.tone)) invalid();
    ids.add(field.id);
  }
  return card.fields;
}

function orderedFields(fields, ids) {
  if (fields.length !== ids.length) invalid();
  return ids.map((id) => fields.find((field) => field.id === id) ?? invalid());
}

function checkedLayout(fields) {
  const covered = new Set();
  for (const field of fields) {
    if (!Array.isArray(field.layoutRows) || field.layoutRows.length === 0) invalid();
    for (const row of field.layoutRows) {
      if (!ROWS.includes(row) || covered.has(row)) invalid();
      covered.add(row);
    }
  }
  if (covered.size !== ROWS.length) invalid();
  return fields.map((field) => field.layoutRows);
}

function personalLayout(card, fields) {
  if (card.kind === 'startingAction') {
    const ordered = orderedFields(fields, ['action']);
    if (ordered[0].layoutRows !== undefined) {
      const layout = checkedLayout(ordered);
      if (layout[0].some((row, index) => row !== ROWS[index])) invalid();
    }
    return { fields: ordered, rows: [ROWS] };
  }
  if (card.kind === 'steward') {
    const ordered = orderedFields(fields, ['top', 'middle', 'bottom']);
    if (ordered.some((field) => field.layoutRows !== undefined)) {
      const layout = checkedLayout(ordered);
      if (layout.some((rows, index) => rows.length !== 1 || rows[0] !== ROWS[index])) invalid();
    }
    return { fields: ordered, rows: ROWS.map((row) => [row]) };
  }
  if (card.kind !== 'diplomat') invalid();
  const ordered = orderedFields(fields, ['upper', 'lower']);
  let rows;
  if (ordered.some((field) => field.layoutRows !== undefined)) {
    rows = checkedLayout(ordered);
    // 使节牌只能在第一、二行之间或第二、三行之间分区，不按浅深色推测位置。
    const spans = rows.map((item) => item.length);
    if (!((spans[0] === 1 && spans[1] === 2) || (spans[0] === 2 && spans[1] === 1))
      || rows.flat().some((row, index) => row !== ROWS[index])) invalid();
    if (card.rowSpan !== undefined
      && (!Array.isArray(card.rowSpan) || card.rowSpan.length !== 2
        || card.rowSpan.some((span, index) => span !== spans[index]))) invalid();
  } else {
    const spans = card.rowSpan;
    if (!Array.isArray(spans) || spans.length !== 2
      || !((spans[0] === 1 && spans[1] === 2) || (spans[0] === 2 && spans[1] === 1))) invalid();
    rows = [ROWS.slice(0, spans[0]), ROWS.slice(spans[0])];
  }
  return { fields: ordered, rows };
}

/**
 * 返回当前个人行动牌与人员排对应的字段引用，不发放收益、不修改牌面。
 * 起始行动牌的单一图标适用于任意排；城堡牌保留实际印刷布局。
 */
export function personalField(card, row) {
  if (!ROWS.includes(row)) invalid();
  const layout = personalLayout(card, fieldsOf(card));
  return layout.fields[layout.rows.findIndex((rows) => rows.includes(row))] ?? invalid();
}

/**
 * 解析已配置的骰色板块引用，保留匹配输入的顺序和次数。
 * 房间配置合法性由调用方校验；重复引用不证明实体规则允许该摆法。
 */
export function castleFields(card, colorTiles, dieColor) {
  const fields = fieldsOf(card);
  if (!['steward', 'diplomat'].includes(card.kind) || !COLORS.has(dieColor)
    || !Array.isArray(colorTiles)) invalid();
  const byId = new Map(fields.map((field) => [field.id, field]));
  for (const tile of colorTiles) {
    if (!tile || !COLORS.has(tile.color) || !byId.has(tile.fieldId)) invalid();
  }
  return colorTiles.filter((tile) => tile.color === dieColor).map((tile) => byId.get(tile.fieldId));
}

// 家臣到达奖励只允许浅色区域；组合收益仍保留为同一个字段。
export function lightFields(card) {
  return fieldsOf(card).filter((field) => field.tone === 'light');
}
