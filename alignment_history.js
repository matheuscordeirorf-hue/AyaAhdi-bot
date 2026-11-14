const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();

// Preserva dados conhecidos e retorna conflitos para revisão humana.
function mergeKnownFields(existing, incoming) {
  const result = { ...existing };
  const conflicts = [];
  const missing = value => value == null || String(value).trim() === '' || normalize(value) === 'nao informado';
  for (const [key, value] of Object.entries(incoming)) {
    if (missing(value)) continue;
    if (missing(result[key])) result[key] = value;
    else if (normalize(result[key]) !== normalize(value)) conflicts.push(key);
  }
  return { fields: result, conflicts };
}

const HEADER_KEYS = {
  vessel: ['vessel', 'embarcacao', 'navio'], equipment: ['equipment / tag', 'equipment/tag', 'tag do equipamento', 'equipment id'],
  class: ['equipment class', 'classe do equipamento'], maker: ['maker', 'fabricante'], model: ['model', 'modelo'],
  stationary_class: ['equipment class'], stationary_maker: ['maker'], stationary_model: ['model'],
  date: ['data', 'date'], motivation: ['motivacao', 'motivation', 'motivo'], executor: ['executor', 'responsavel'],
  method: ['metodo', 'method'], axial_vertical: ['axial vertical'], axial_horizontal: ['axial horizontal'],
  radial_vertical: ['radial vertical'], radial_horizontal: ['radial horizontal'], comments: ['comments', 'observacoes', 'observações'],
  coupling_gap: ['coupling gap'], standard: ['padrao', 'padrão'], document: ['document', 'documento'],
  axial_tolerance: ['axial tolerance'], radial_tolerance: ['radial tolerance'], gap_tolerance: ['coupling gap tolerance']
};

function mapHeaders(rows) {
  const groups = rows[0] || [];
  const headers = rows[1] || [];
  const groupAt = [];
  let activeGroup = '';
  for (const [i, value] of groups.entries()) {
    if (String(value || '').trim()) activeGroup = normalize(value);
    groupAt[i] = activeGroup;
  }
  const cols = {};
  for (const [key, aliases] of Object.entries(HEADER_KEYS)) {
    const matches = headers.map((h, i) => aliases.includes(normalize(h)) ? i : -1).filter(i => i >= 0);
    if (matches.length === 1 && ['stationary_class','stationary_maker','stationary_model'].includes(key)) {
      if ((groupAt[matches[0]] || '').includes('maquina estacionaria')) cols[key] = matches[0];
    } else if (matches.length === 1) cols[key] = matches[0];
    else if (matches.length > 1 && ['maker', 'model', 'class'].includes(key)) {
      const drive = matches.find(i => groupAt[i].includes('drive machine'));
      if (drive !== undefined) cols[key] = drive;
    } else if (matches.length > 1 && ['stationary_class','stationary_maker','stationary_model'].includes(key)) {
      const stationary = matches.find(i => groupAt[i].includes('maquina estacionaria') || groupAt[i].includes('máquina estacionária'));
      if (stationary !== undefined) cols[key] = stationary;
    }
  }
  return { groups, headers, cols };
}

function makeRow(width, cols, data, sessionId) {
  const row = Array(width).fill('não informado');
  const set = (key, value) => { if (cols[key] !== undefined) row[cols[key]] = value == null || String(value).trim() === '' ? 'não informado' : String(value); };
  for (const key of Object.keys(cols)) if (key !== 'comments') set(key, data[key]);
  set('comments', [data.observations, `session:${sessionId}`].filter(Boolean).join(' | ') || `session:${sessionId}`);
  return row;
}

async function getRecordSchema(sheets, spreadsheetId) {
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: "'Modelo alinhamento'!A1:ZZ2" });
  const { groups, headers, cols } = mapHeaders(data.values || []);
  if (!headers.length) throw new Error('Cabeçalhos da planilha de registros ausentes');
  const populated = new Set(Object.keys(cols));
  let group = '';
  return headers.map((title, index) => {
    if (groups[index]) group = groups[index];
    return { group, title, mappedAs: Object.keys(cols).filter(key => populated.has(key) && cols[key] === index) };
  }).filter(column => column.title);
}

async function recordHistory(sheets, spreadsheetId, data, sessionId, { dryRun = false } = {}) {
  const range = "'Modelo alinhamento'!A1:ZZ1001";
  const { data: result } = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = result.values || [];
  const { headers, cols } = mapHeaders(values);
  if (!headers.length || cols.vessel === undefined || cols.equipment === undefined || cols.comments === undefined) {
    throw new Error('Cabeçalhos necessários ausentes ou ambíguos; nenhuma linha foi gravada');
  }
  if (dryRun) return { status: 'validated', columns: Object.keys(cols) };
  const existingIndex = values.findIndex((row, index) => index >= 2 && String(row[cols.comments] || '').includes(`session:${sessionId}`));
  const row = makeRow(headers.length, cols, data, sessionId);
  if (existingIndex >= 2) {
    const existing = values[existingIndex] || [];
    const merged = [...existing];
    while (merged.length < headers.length) merged.push('');
    const conflicts = [];
    for (const [key, col] of Object.entries(cols)) {
      if (key === 'comments') continue;
      const oldValue = String(existing[col] || '').trim();
      const newValue = String(row[col] || '').trim();
      if (!oldValue || normalize(oldValue) === 'nao informado') merged[col] = newValue || 'não informado';
      else if (newValue && normalize(newValue) !== 'nao informado' && normalize(oldValue) !== normalize(newValue)) conflicts.push(headers[col]);
    }
    if (conflicts.length) {
      const oldComments = String(existing[cols.comments] || '');
      const note = `Conflito para revisão: ${conflicts.join(', ')}`;
      if (!oldComments.includes(note)) merged[cols.comments] = `${oldComments} | ${note}`.trim();
    }
    const { data: updated } = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'Modelo alinhamento'!A${existingIndex + 1}:${columnLetter(headers.length)}${existingIndex + 1}`,
      valueInputOption: 'RAW', requestBody: { values: [merged] }
    });
    if (conflicts.length) return { status: 'conflict', row: existingIndex + 1, fields: conflicts, updatedRange: updated.updatedRange };
    return { status: 'updated', updatedRange: updated.updatedRange };
  }
  const { data: appended } = await sheets.spreadsheets.values.append({
    spreadsheetId, range: "'Modelo alinhamento'!A:ZZ", valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
  return { status: 'appended', updatedRange: appended.updates?.updatedRange };
}

function columnLetter(number) {
  let value = number;
  let result = '';
  while (value > 0) { const remainder = (value - 1) % 26; result = String.fromCharCode(65 + remainder) + result; value = Math.floor((value - 1) / 26); }
  return result;
}

module.exports = { mapHeaders, makeRow, getRecordSchema, recordHistory, mergeKnownFields };


