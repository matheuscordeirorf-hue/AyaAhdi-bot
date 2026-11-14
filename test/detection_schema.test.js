const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTracker, makeGeminiFunctions } = require('../gemini_conversation');
const { getRecordSchema } = require('../alignment_history');

test('inicia sessão com detecção contextual e ignora conversa sem relação', async () => {
  const tracker = createTracker({ detect: async m => m.text.includes('alinhar o eixo'), classify: async () => 'related',
    finish: async () => {}, save: async () => {} });
  assert.equal(await tracker.process({group:'a', text:'Vamos almoçar?'}), 'ignorada');
  assert.equal(await tracker.process({group:'a', text:'Vamos alinhar o eixo da bomba'}), 'aberta');
  assert.equal(tracker.snapshot().a.messages.length, 2);
});

test('lê títulos atuais com grupos e informa ao Gemini o esquema', async () => {
  const sheets = { spreadsheets: { values: { get: async () => ({data:{values:[['', 'Drive Machine'], ['', 'Vessel', 'Equipment / Tag', 'Maker', 'Comments']]}}) } } };
  const schema = await getRecordSchema(sheets, 'test');
  assert.equal(schema[0].title, 'Vessel');
  assert.deepEqual(schema.find(c => c.title === 'Maker').mappedAs, ['maker']);
  const original = global.fetch;
  let prompt;
  global.fetch = async (_url, options) => {
    prompt = JSON.parse(options.body).contents[0].parts[0].text;
    return {ok:true, json:async () => ({candidates:[{content:{parts:[{text:'{"known":[],"missing":["Vessel"],"question":"Embarcação?"}'}]}}]})};
  };
  try {
    const gemini = makeGeminiFunctions({apiKey:'test', config:{}, getRecordSchema:async () => schema});
    await gemini.ask({messages:[]});
    assert.match(prompt, /Drive Machine/);
    assert.match(prompt, /Vessel/);
    assert.match(prompt, /mappedAs/);
  } finally { global.fetch = original; }
});

test('compara a extração final com os cabeçalhos reais da planilha', async () => {
  const original = global.fetch;
  let prompt;
  global.fetch = async (_url, options) => {
    prompt = JSON.parse(options.body).contents[0].parts[0].text;
    return {ok:true, json:async () => ({candidates:[{content:{parts:[{text:'{"status":"incomplete","vessel":null,"equipment":null,"fields":{}}'}]}}]})};
  };
  try {
    const schema = [{group:'drive machine', title:'Axial Vertical', mappedAs:['axial_vertical']}];
    const gemini = makeGeminiFunctions({apiKey:'test', config:{}, getRecordSchema:async () => schema, onExtract:async () => {}});
    await gemini.finish({messages:[{text:'resultado'}]}, 'sincronização periódica');
    assert.match(prompt, /Axial Vertical/);
    assert.match(prompt, /Compare a conversa com os cabeçalhos reais/);
  } finally { global.fetch = original; }
});

test('envia anexo ao Gemini junto do nome do grupo, legenda e esquema da planilha', async () => {
  const original = global.fetch;
  let payload;
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({candidates:[{content:{parts:[{text:'{"summary":"DG1; medição axial horizontal 0,02 mm"}'}]}}]}) };
  };
  try {
    const gemini = makeGeminiFunctions({apiKey:'test', config:{}, getRecordSchema:async () => [{title:'Axial Horizontal'}]});
    const summary = await gemini.inspectAttachment({caption:'Relatório final', groupName:'BRAM Atlas', fileName:'relatorio.pdf', mimeType:'application/pdf', data:Buffer.from('pdf')});
    assert.match(summary, /DG1/);
    assert.equal(payload.contents[0].parts[1].inline_data.mime_type, 'application/pdf');
    assert.match(payload.contents[0].parts[0].text, /BRAM Atlas/);
    assert.match(payload.contents[0].parts[0].text, /Axial Horizontal/);
  } finally { global.fetch = original; }
});


