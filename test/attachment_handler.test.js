const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('recebe PDF no grupo e entrega o conteúdo ao rastreador', async () => {
  let inspected;
  let tracked;
  const gemini = { inspectAttachment: async input => { inspected = input; return 'DG1 resultado 0,02 mm'; } };
  const mocks = {
    '@whiskeysockets/baileys': { downloadMediaMessage: async () => Buffer.from('pdf') },
    'qrcode-terminal': {}, pino: () => ({}),
    googleapis: { google: { options() {}, auth: { GoogleAuth: class {} }, sheets: () => ({}) } },
    fs: { readFileSync() { throw new Error('no state'); }, writeFileSync() {} },
    './gemini_conversation': {
      createTracker: () => ({ process: async msg => { tracked = msg; return 'aberta'; } }),
      fileStore: () => ({ load() {}, save() {} }), makeGeminiFunctions: () => gemini
    },
    './alignment_config': { loadAlignmentConfig: async () => ({}) },
    './alignment_history': {}
  };
  const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
  const start = source.indexOf("process.on('SIGINT'");
  assert.ok(start > 0);
  const context = { require: name => mocks[name] || require(name), __dirname: '/tmp', Buffer,
    process: { env: { SPREADSHEET_ID: 'test', CONFIG_SPREADSHEET_ID: 'test', GEMINI_API_KEY: 'test', GEMINI_CONVERSATION_ENABLED: 'true' } },
    console, fetch, setInterval: () => ({ unref() {} }), setTimeout, Date };
  vm.runInNewContext(source.slice(0, start) + '\nthis.handle = handleMessage;', context);
  await context.handle({ groupMetadata: async () => ({ subject: 'BRAM Breeze' }) }, {
    key: { remoteJid: 'grupo@g.us', id: 'test' },
    message: { documentMessage: { mimetype: 'application/pdf', fileName: 'relatorio.pdf' } }
  });
  assert.equal(inspected.fileName, 'relatorio.pdf');
  assert.equal(inspected.groupName, 'BRAM Breeze');
  assert.match(tracked.text, /DG1 resultado 0,02 mm/);
});
