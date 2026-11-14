const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
google.options({ fetchImplementation: fetch });
const fs = require('fs');
const path = require('path');
const P = require('pino');

const spreadsheetId = process.env.SPREADSHEET_ID;
const geminiEnabled = process.env.GEMINI_CONVERSATION_ENABLED === 'true';

if (!spreadsheetId) {
  throw new Error('Configure SPREADSHEET_ID no ambiente antes de iniciar.');
}
if (geminiEnabled && !process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_CONVERSATION_ENABLED requer GEMINI_API_KEY.');
}
if (geminiEnabled && !process.env.CONFIG_SPREADSHEET_ID) {
  throw new Error('GEMINI_CONVERSATION_ENABLED requer CONFIG_SPREADSHEET_ID.');
}
if (geminiEnabled) {
  console.log('Gemini ativo em todos os grupos dos quais o bot participa; sessões isoladas por grupo.');
}

// ADC uses the VM's attached service account on Compute Engine.
// No downloaded service-account private key is needed.
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

const seenFile = path.join(__dirname, 'processed-message-ids.json');
const sessionsFile = path.join(__dirname, 'alignment-sessions.json');
const pendingFile = path.join(__dirname, 'pending-alignment.jsonl');
let seenIds = new Set();
try {
  seenIds = new Set(JSON.parse(fs.readFileSync(seenFile, 'utf8')));
} catch {
  // Primeira execução: ainda não há IDs processados.
}

function saveSeenIds() {
  fs.writeFileSync(seenFile, JSON.stringify([...seenIds].slice(-10000), null, 2));
}

function appendPending(entry) {
  fs.appendFileSync(pendingFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
  fs.chmodSync(pendingFile, 0o600);
}

function unwrapMessage(message) {
  let current = message;
  while (current?.ephemeralMessage?.message || current?.viewOnceMessage?.message ||
         current?.viewOnceMessageV2?.message || current?.documentWithCaptionMessage?.message) {
    current = current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.documentWithCaptionMessage?.message;
  }
  return current || {};
}

function getMessageText(message) {
  const content = unwrapMessage(message);
  return content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    '';
}

let alignmentTracker = null;
let activeSock = null;
let alignmentConfigPromise = null;
const groupTitleCache = new Map();
if (geminiEnabled) {
  const { createTracker, fileStore, makeGeminiFunctions, verifyExtraction } = require('./gemini_conversation');
  const { loadAlignmentConfig } = require('./alignment_config');
  const history = require('./alignment_history');
  const store = fileStore(sessionsFile);
  alignmentConfigPromise = loadAlignmentConfig(sheets, process.env.CONFIG_SPREADSHEET_ID);
  const gemini = makeGeminiFunctions({
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    config: alignmentConfigPromise,
    getRecordSchema: () => history.getRecordSchema(sheets, spreadsheetId),
    onExtract: async (session, reason, extraction, transcript) => {
      const checked = verifyExtraction(extraction, transcript);
      if (!checked.ok) {
        appendPending({
          groupJid: session.group,
          startedAt: session.startedAt,
          closedAt: new Date().toISOString(),
          reason: checked.reason,
          messages: session.messages
        });
        console.log('Alinhamento mantido para revisão:', checked.reason);
        return;
      }

      const crypto = require('crypto');
      const sessionId = crypto.createHash('sha256').update(`${session.group}|${session.startedAt}`).digest('hex').slice(0, 24);
      const fields = checked.fields || {};
      const result = await history.recordHistory(sheets, spreadsheetId, {
        vessel: checked.vessel, equipment: checked.equipment,
        class: fields['Equipment Class'], maker: fields.Maker, model: fields.Model,
        stationary_class: fields['Stationary Equipment Class'], stationary_maker: fields['Stationary Maker'],
        stationary_model: fields['Stationary Model'], document: fields.Document,
        date: fields.Data, motivation: fields.Motivacao, executor: fields.Executor, method: fields.Metodo,
        axial_vertical: fields['Axial vertical'], axial_horizontal: fields['Axial horizontal'],
        radial_vertical: fields['Radial vertical'], radial_horizontal: fields['Radial horizontal'],
        coupling_gap: fields['Coupling gap'], standard: fields['Padrão'],
        axial_tolerance: fields['Axial tolerance'], radial_tolerance: fields['Radial tolerance'],
        gap_tolerance: fields['Coupling gap tolerance'],
        observations: Object.entries(fields).filter(([key]) => /antes do ajuste|unidade das medições|Coupling gap/i.test(key))
          .map(([key, value]) => `${key}: ${value}`).join('; ')
      }, sessionId);
      if (!['appended', 'updated', 'duplicate'].includes(result.status)) {
        appendPending({
          groupJid: session.group,
          startedAt: session.startedAt,
          closedAt: new Date().toISOString(),
          reason: result,
          messages: session.messages
        });
      }
      console.log('Registro de alinhamento:', result.status);
    }
  });

  alignmentTracker = createTracker({
    detect: async msg => {
      try { return await gemini.detect(msg); }
      catch { console.error('Falha ao identificar atividade com Gemini.'); return false; }
    },
    classify: async (previous, current) => {
      try {
        return await gemini.classify(previous, current);
      } catch (error) {
    console.error('Falha de classificação Gemini; mantendo mensagem pendente.');
        return 'uncertain';
      }
    },
    // Monitoramento silencioso; dados são sincronizados periodicamente.
    onMessage: async () => {},
    onTick: async (session) => {
      try { await gemini.finish(session, 'sincronização periódica'); }
      catch { console.error('Falha ao sincronizar dados de alinhamento.'); }
    },
    finish: async (session, reason) => {
      try {
        await gemini.finish(session, reason);
      } catch (error) {
        appendPending({
          groupJid: session.group,
          startedAt: session.startedAt,
          closedAt: new Date().toISOString(),
          reason: 'falha ao finalizar com Gemini',
          messages: session.messages
        });
        console.error('Sessão salva para revisão após falha do Gemini.');
      }
    },
    save: (state) => store.save(state),
    load: () => store.load(),
    timeoutMs: Number.MAX_SAFE_INTEGER,
    maxMessages: 5000
  });

  setInterval(() => {
    alignmentTracker.tick().catch((error) => {
      console.error('Falha ao sincronizar sessões de alinhamento:', error.message);
    });
  }, 5 * 60 * 1000).unref();
}

async function handleMessage(sock, msg) {
  const groupJid = msg.key.remoteJid || '';
  if (!groupJid.endsWith('@g.us') || msg.key.fromMe) return;

  let text = getMessageText(msg.message).trim();
  const content = unwrapMessage(msg.message);
  const image = content.imageMessage;
  const document = content.documentMessage;
  const attachment = image || document;
  if (!text && !attachment) return;

  const messageId = msg.key.id;
  if (messageId && seenIds.has(messageId)) return;

  if (geminiEnabled) {
    let groupName = groupTitleCache.get(groupJid)?.name || '';
    if (!groupName || Date.now() - groupTitleCache.get(groupJid).time > 60 * 60 * 1000) {
      try {
        groupName = (await sock.groupMetadata(groupJid)).subject || '';
        groupTitleCache.set(groupJid, { name: groupName, time: Date.now() });
      } catch { /* nome do grupo pode não estar disponível temporariamente */ }
    }
    if (attachment) {
      const mimeType = image?.mimetype || document?.mimetype || '';
      const fileName = document?.fileName || '';
      if (!/^image\/(jpeg|png|webp)$|^application\/pdf$/i.test(mimeType)) {
        text += `\n[Anexo ${fileName || mimeType || 'não identificado'}: formato não suportado para leitura]`;
      } else {
        try {
          const data = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }) });
          if (data.length > 20 * 1024 * 1024) throw new Error('Anexo excede 20 MB');
          const summary = await gemini.inspectAttachment({ caption: text, groupName, fileName, mimeType, data });
          text = [text, summary && `Conteúdo lido do anexo: ${summary}`].filter(Boolean).join('\n');
        } catch (error) {
          appendPending({ messageId: msg.key.id, groupJid, groupName, fileName, reason: `não foi possível ler o anexo: ${error.message}` });
          console.error('Não foi possível ler um anexo da conversa.');
          return;
        }
      }
    }
    if (!text.trim()) return;
    const timestamp = msg.messageTimestamp
      ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
      : new Date().toISOString();
    const outcome = await alignmentTracker.process({
      group: groupJid,
      id: messageId || '',
      timestamp,
      sender: msg.pushName || '',
      groupName,
      text: groupName ? `[Grupo: ${groupName}]\n${text}` : text
    });
    if (outcome !== 'ignorada' && messageId) {
      seenIds.add(messageId);
      saveSeenIds();
    }
    if (outcome !== 'ignorada') console.log('Coleta de alinhamento:', outcome, groupJid);
    return;
  }

  if (/\b(?:alinhamento|alignment)\b/i.test(text)) {
    appendPending({ messageId, groupJid, text, reason: 'modo Gemini desativado; coleta conversacional indisponível' });
    console.log('Mensagem de alinhamento colocada para revisão; Gemini está desativado.');
  }
}

async function startBot() {
  if (geminiEnabled) await alignmentConfigPromise;
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    browser: ['Alignment Collector', 'Chrome', '1.0.0'],
    syncFullHistory: false
  });
  activeSock = sock;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('Escaneie o QR Code com o WhatsApp que ficará conectado ao grupo:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') console.log(geminiEnabled
      ? 'Coletor conectado em modo silencioso.'
      : 'Coletor conectado em modo silencioso.');
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(startBot, 3000);
      else console.error('Sessão desconectada. Reinicie e escaneie um novo QR Code.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      try {
        await handleMessage(sock, msg);
      } catch (error) {
        console.error('Falha ao registrar mensagem:', error.message);
      }
    }
  });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

console.log('Iniciando coletor silencioso de mensagens de alinhamento...');
startBot().catch((error) => {
  console.error('Não foi possível iniciar o coletor:', error.message);
  process.exit(1);
});


