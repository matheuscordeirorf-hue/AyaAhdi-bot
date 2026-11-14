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
  date: ['data', 'date'], motivation: ['motivacao', 'motivation', 'motivo'], executor: ['executor', 'responsavel'],
  method: ['metodo', 'method'], axial_vertical: ['axial vertical'], axial_horizontal: ['axial horizontal'],
  radial_vertical: ['radial vertical'], radial_horizontal: ['radial horizontal'], comments: ['comments', 'observacoes', 'observações'],
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
    if (matches.length === 1) cols[key] = matches[0];
    else if (matches.length > 1 && ['maker', 'model', 'class'].includes(key)) {
      const drive = matches.find(i => groupAt[i].includes('drive machine'));
      if (drive !== undefined) cols[key] = drive;
    }
  }
  return { groups, headers, cols };
}

function makeRow(width, cols, data, sessionId) {
  const row = Array(width).fill('');
  const set = (key, value) => { if (cols[key] !== undefined && value !== undefined && value !== null) row[cols[key]] = String(value); };
  for (const key of ['vessel','equipment','class','maker','model','date','motivation','executor','method',
    'axial_vertical','axial_horizontal','radial_vertical','radial_horizontal','axial_tolerance','radial_tolerance','gap_tolerance']) set(key, data[key]);
  set('comments', [data.observations, `session:${sessionId}`].filter(Boolean).join(' | '));
  return row;
}

async function getRecordSchema(sheets, spreadsheetId) {
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: "'Modelo alinhamento'!A1:ZZ2" });
  const { groups, headers, cols } = mapHeaders(data.values || []);
  if (!headers.length) throw new Error('Cabeçalhos da planilha de registros ausentes');
  const populated = new Set(['vessel', 'equipment', 'date', 'motivation', 'executor', 'method', 'axial_vertical', 'axial_horizontal', 'radial_vertical', 'radial_horizontal', 'axial_tolerance', 'radial_tolerance', 'gap_tolerance', 'comments']);
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
  if (values.slice(2).some(row => String(row[cols.comments] || '').includes(`session:${sessionId}`))) return { status: 'duplicate' };
  if (dryRun) return { status: 'validated', columns: Object.keys(cols) };
  const row = makeRow(headers.length, cols, data, sessionId);
  const { data: appended } = await sheets.spreadsheets.values.append({
    spreadsheetId, range: "'Modelo alinhamento'!A:ZZ", valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
  return { status: 'appended', updatedRange: appended.updates?.updatedRange };
}

module.exports = { mapHeaders, makeRow, getRecordSchema, recordHistory, mergeKnownFields };


