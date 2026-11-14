const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapHeaders, makeRow, mergeKnownFields, recordHistory } = require('../alignment_history');

test('completa campos desconhecidos sem sobrescrever dados e sinaliza divergências', () => {
  const merged = mergeKnownFields({ vessel: 'BRAM Atlas', equipment: 'não informado', axial: '0,02' },
    { vessel: 'BRAM Atlas', equipment: 'MCP1', axial: '0,03', date: null });
  assert.deepEqual(merged.fields, { vessel: 'BRAM Atlas', equipment: 'MCP1', axial: '0,02' });
  assert.deepEqual(merged.conflicts, ['axial']);
});

test('atualiza os campos desconhecidos na mesma linha da sessão', async () => {
  const rows = [
    ['Drive Machine', '', 'Histórico', 'Reference'],
    ['Vessel', 'Equipment / Tag', 'Data', 'Comments']
  ];
  let updated;
  const sheets = { spreadsheets: { values: {
    get: async () => ({ data: { values: rows } }),
    append: async ({ requestBody }) => {
      rows.push(requestBody.values[0]);
      return { data: { updates: { updatedRange: "'Modelo alinhamento'!A3:D3" } } };
    },
    update: async ({ requestBody }) => {
      updated = requestBody.values[0];
      rows[2] = updated;
      return { data: { updatedRange: "'Modelo alinhamento'!A3:D3" } };
    }
  } } };
  await recordHistory(sheets, 'test', { vessel: 'BRAM Atlas', equipment: null, date: null }, 'session-1');
  const result = await recordHistory(sheets, 'test', { vessel: 'BRAM Atlas', equipment: 'DG1', date: '2026-11-14' }, 'session-1');
  assert.equal(result.status, 'updated');
  assert.deepEqual(updated.slice(0, 3), ['BRAM Atlas', 'DG1', '2026-11-14']);
  assert.match(updated[3], /session:session-1/);
});

test('preenche outros campos vazios e preserva o conhecido quando há conflito', async () => {
  const rows = [
    ['Drive Machine', '', 'Histórico', 'Reference'],
    ['Vessel', 'Equipment / Tag', 'Data', 'Comments'],
    ['BRAM Atlas', 'DG1', 'não informado', 'session:session-conflict']
  ];
  let updated;
  const sheets = { spreadsheets: { values: {
    get: async () => ({ data: { values: rows } }),
    update: async ({ requestBody }) => {
      updated = requestBody.values[0];
      rows[2] = updated;
      return { data: { updatedRange: "'Modelo alinhamento'!A3:D3" } };
    }
  } } };

  const result = await recordHistory(sheets, 'test', {
    vessel: 'BRAM Brasil', equipment: 'DG2', date: '2026-11-14'
  }, 'session-conflict');

  assert.equal(result.status, 'conflict');
  assert.deepEqual(updated.slice(0, 3), ['BRAM Atlas', 'DG1', '2026-11-14']);
  assert.match(updated[3], /Conflito para revisão: Vessel, Equipment \/ Tag/);
});

test('mapeia títulos por nomes e distingue colunas repetidas pelo grupo', () => {
  const mapped = mapHeaders([
    ['Drive Machine', '', '', '', '', 'Histórico', '', '', '', '', '', '', '', '', 'Pés de fixação', 'Tolerâncias', '', '', 'Coupling', 'Máquina Estacionária', '', '', '', 'Reference'],
    ['Vessel', 'Equipment / Tag', 'Equipment Class', 'Maker', 'Model', 'Data', 'Motivação', 'Executor', 'Método', 'Axial Vertical', 'Axial Horizontal', 'Radial Vertical', 'Radial Horizontal', 'Coupling GAP', 'Padrão', 'Axial Tolerance', 'Radial Tolerance', 'Coupling GAP Tolerance', 'Maker/Model', 'Equipment Class', 'Maker', 'Model', 'Document', 'Comments']
  ]);
  assert.equal(mapped.cols.vessel, 0);
  assert.equal(mapped.cols.maker, 3);
  assert.equal(mapped.cols.stationary_maker, 20);
  assert.equal(mapped.cols.comments, 23);
  const row = makeRow(24, mapped.cols, { vessel: 'V', equipment: 'DG1' }, 'abc');
  assert.equal(row[0], 'V');
  assert.equal(row[1], 'DG1');
  assert.equal(row[5], 'não informado');
  assert.equal(row[23], 'session:abc');
});


