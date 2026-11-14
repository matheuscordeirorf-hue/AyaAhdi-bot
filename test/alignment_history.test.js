const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapHeaders, makeRow, mergeKnownFields } = require('../alignment_history');

test('completa campos desconhecidos sem sobrescrever dados e sinaliza divergências', () => {
  const merged = mergeKnownFields({ vessel: 'BRAM Atlas', equipment: 'não informado', axial: '0,02' },
    { vessel: 'BRAM Atlas', equipment: 'MCP1', axial: '0,03', date: null });
  assert.deepEqual(merged.fields, { vessel: 'BRAM Atlas', equipment: 'MCP1', axial: '0,02' });
  assert.deepEqual(merged.conflicts, ['axial']);
});

test('mapeia títulos por nomes e distingue colunas repetidas pelo grupo', () => {
  const mapped = mapHeaders([
    ['', 'Drive Machine', '', '', '', '', 'Histórico', '', '', '', '', '', '', '', 'Pés de fixação', 'Tolerâncias', '', '', 'Coupling', 'Máquina Estacionária', '', '', '', 'Reference'],
    ['', 'Vessel', 'Equipment / Tag', 'Equipment Class', 'Maker', 'Model', 'Data', 'Motivação', 'Executor', 'Método', 'Axial Vertical', 'Axial Horizontal', 'Radial Vertical', 'Radial Horizontal', 'Coupling GAP', 'Padrão', 'Axial Tolerance', 'Radial Tolerance', 'Coupling GAP Tolerance', 'Maker/Model', 'Equipment Class', 'Maker', 'Model', 'Document', 'Comments']
  ]);
  assert.equal(mapped.cols.vessel, 1);
  assert.equal(mapped.cols.maker, 4);
  assert.equal(mapped.cols.comments, 24);
  const row = makeRow(25, mapped.cols, { vessel: 'V', equipment: 'DG1' }, 'abc');
  assert.equal(row[1], 'V');
  assert.equal(row[2], 'DG1');
  assert.equal(row[24], 'session:abc');
});


