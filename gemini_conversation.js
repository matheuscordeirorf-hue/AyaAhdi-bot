const fs = require('fs');

const DECISIONS = new Set(['related', 'unrelated', 'new_activity', 'uncertain']);
const FIELD_LABELS = {
  equipment_class: 'Equipment Class',
  maker: 'Maker',
  model: 'Model',
  stationary_equipment_class: 'Stationary Equipment Class',
  stationary_maker: 'Stationary Maker',
  stationary_model: 'Stationary Model',
  date: 'Data',
  motivation: 'Motivacao',
  executor: 'Executor',
  method: 'Metodo',
  axial_vertical: 'Axial vertical',
  axial_horizontal: 'Axial horizontal',
  radial_vertical: 'Radial vertical',
  radial_horizontal: 'Radial horizontal',
  coupling_gap: 'Coupling gap',
  standard: 'Padrão',
  document: 'Document',
  axial_tolerance: 'Axial tolerance',
  radial_tolerance: 'Radial tolerance',
  coupling_gap_tolerance: 'Coupling gap tolerance',
  measurement_unit: 'Unidade das medições',
  axial_vertical_before: 'Axial vertical antes do ajuste',
  axial_horizontal_before: 'Axial horizontal antes do ajuste',
  radial_vertical_before: 'Radial vertical antes do ajuste',
  radial_horizontal_before: 'Radial horizontal antes do ajuste'
};

function createTracker({
  classify,
  detect = async msg => /\b(?:alinhamento|alignment)\b/i.test(msg.text),
  finish,
  onMessage = async () => {},
  onTick = async () => {},
  save,
  load = () => ({}),
  now = Date.now,
  timeoutMs = 15 * 60 * 1000,
  maxMessages = 80
}) {
  let sessions = load() || {};
  const recentContext = {};
  let queue = Promise.resolve();

  const enqueue = (fn) => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };

  async function persist() {
    await save(sessions);
  }

  async function close(group, reason) {
    const session = sessions[group];
    if (!session) return;
    await finish(session, reason);
    delete sessions[group];
    await persist();
  }

  async function expire(t) {
    for (const [group, session] of Object.entries(sessions)) {
      if (t - session.lastRelated >= timeoutMs) await close(group, 'inatividade');
    }
  }

  function newSession(msg, t) {
    return {
      group: msg.group,
      startedAt: msg.timestamp || new Date(t).toISOString(),
      lastRelated: t,
      messages: [msg]
    };
  }

  return {
    process: (msg) => enqueue(async () => {
      if (!msg?.group || !String(msg.text || '').trim()) return 'ignorada';
      const t = now();
      await expire(t);

      const session = sessions[msg.group];
      if (!session) {
        const context = recentContext[msg.group] || [];
        const detected = await detect(msg, context);
        recentContext[msg.group] = [...context, msg].slice(-20);
        if (!detected) return 'ignorada';
        sessions[msg.group] = newSession(msg, t);
        sessions[msg.group].messages = [...context, msg];
        delete recentContext[msg.group];
        await onMessage(sessions[msg.group]);
        await persist();
        return 'aberta';
      }

      if (msg.id && session.messages.some((item) => item.id === msg.id)) return 'duplicada';
      if (session.messages.length >= maxMessages) {
        await close(msg.group, 'limite de mensagens');
        if (await detect(msg)) {
          sessions[msg.group] = newSession(msg, t);
          await onMessage(sessions[msg.group]);
          await persist();
          return 'aberta';
        }
        return 'limite atingido';
      }

      const decision = await classify(session.messages, msg);
      if (!DECISIONS.has(decision)) throw new Error('Classificação inválida do Gemini');
      if (decision === 'unrelated') return decision;

      if (decision === 'new_activity') {
        await close(msg.group, 'novo equipamento');
        sessions[msg.group] = newSession(msg, t);
      } else {
        session.messages.push(msg);
        if (decision === 'related') session.lastRelated = t;
      }
      if (decision !== 'unrelated') await onMessage(sessions[msg.group]);
      await persist();
      return decision;
    }),
    tick: () => enqueue(async () => {
      await expire(now());
      for (const session of Object.values(sessions)) await onTick(session);
      await persist();
    }),
    snapshot: () => JSON.parse(JSON.stringify(sessions))
  };
}

function fileStore(file) {
  return {
    load: () => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
      }
    },
    save: (state) => {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
    }
  };
}

async function geminiJson(apiKey, prompt, model = 'gemini-3.1-flash-lite', media = []) {
  if (!apiKey) throw new Error('GEMINI_API_KEY ausente');

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent';
  const timeoutMs = 50000;
  const maxAttempts = 2;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }, ...media.map(item => ({
            inline_data: { mime_type: item.mimeType, data: Buffer.from(item.data).toString('base64') }
          }))] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const error = new Error('Gemini HTTP ' + response.status);
        error.status = response.status;
        throw error;
      }

      const json = await response.json();
      const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('');
      if (!text) throw new Error('Gemini retornou resposta vazia');
      return JSON.parse(text);
    } catch (error) {
      lastError = error.name === 'AbortError'
        ? new Error('Tempo limite do Gemini após ' + Math.round(timeoutMs / 1000) + ' segundos')
        : error;
      const retryable = error.name === 'AbortError' ||
        error.name === 'TypeError' ||
        [408, 429, 500, 502, 503, 504].includes(error.status);

      if (!retryable || attempt + 1 >= maxAttempts) throw lastError;
    } finally {
      clearTimeout(timer);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }

  throw lastError;
}

function makeGeminiFunctions({ apiKey, model, onExtract, config, getRecordSchema = async () => ({}) }) {
  const configContext = async () => JSON.stringify(await config || {});
  async function detect(message, context = []) {
    const result = await geminiJson(apiKey, [
      'Identifique pelo contexto se a conversa descreve uma atividade de alinhamento de máquinas ou eixos, mesmo sem usar a palavra alinhamento.',
      'Considere português, inglês, flexões, sinônimos e contexto técnico; não inicie coleta por conversa genérica ou ambígua.',
      'Use o nome do grupo como contexto possível da embarcação, mas não conclua atividade de alinhamento apenas pelo título.',
      'GRUPO: ' + JSON.stringify(message.groupName || ''),
      'MENSAGENS RECENTES DO GRUPO: ' + JSON.stringify(context.map(item => ({sender:item.sender,text:item.text}))),
      'Responda somente JSON: {"alignment":true|false}.',
      'MENSAGEM: ' + JSON.stringify(message.text)
    ].join('\n'), model);
    return result?.alignment === true;
  }
  async function inspectAttachment({ caption, groupName, fileName, mimeType, data }) {
    const result = await geminiJson(apiKey, [
      'Leia o anexo técnico e extraia fielmente informações de alinhamento de máquinas/eixos que possam preencher a planilha.',
      'Compare o conteúdo com os cabeçalhos informados no esquema: identifique embarcação, equipamento/tag, classe, fabricante, modelo, data, motivação, executor, método, medições, tolerâncias, folga e observações quando presentes.',
      'Preserve números e unidades. Separe tolerâncias de medições. Não calcule, complete nem invente fatos. Retorne JSON {"summary":"texto conciso com os dados legíveis"}; se não houver dado de alinhamento, summary vazio.',
      'NOME DO GRUPO: ' + JSON.stringify(groupName || ''),
      'ARQUIVO: ' + JSON.stringify(fileName || ''),
      'LEGENDA: ' + JSON.stringify(caption || ''),
      'CABEÇALHOS DA PLANILHA: ' + JSON.stringify(await getRecordSchema())
    ].join('\n'), model, [{ mimeType, data }]);
    return typeof result?.summary === 'string' ? result.summary.trim() : '';
  }
  async function classify(previousMessages, currentMessage) {
    const transcript = [...previousMessages, currentMessage].map((message, index) => ({
      n: index + 1,
      time: message.timestamp,
      sender: message.sender,
      text: message.text
    }));
    const result = await geminiJson(apiKey, [
      'Você classifica mensagens de um grupo de manutenção para registrar UMA atividade de alinhamento de eixo.',
      'Analise a conversa inteira e classifique a mensagem atual em relação à atividade ativa.',
      'Responda somente JSON: {"decision":"related|unrelated|new_activity|uncertain"}.',
      'related: acrescenta, confirma ou corrige informação da mesma atividade/equipamento.',
      'unrelated: conversa paralela claramente sem relação com o alinhamento ativo.',
      'new_activity: há evidência clara de novo alinhamento ou equipamento distinto (por exemplo, troca explícita de DG2 para DG4).',
      'uncertain: não é seguro decidir. Não misture equipamentos, não deduza nem use conhecimento externo.',
      'Se ainda não foi identificado equipamento, dados de alinhamento podem ser related. Uma mensagem ambígua deve ser uncertain.',
      'CONVERSA: ' + JSON.stringify(transcript)
    ].join('\n'), model);
    return result?.decision;
  }

  async function finish(session, reason) {
    const transcript = session.messages.map((message, index) => ({
      n: index + 1,
      time: message.timestamp,
      sender: message.sender,
      text: message.text
    }));
    const result = await geminiJson(apiKey, [
      'Extraia um único registro de alinhamento de eixo a partir destas mensagens de um grupo de manutenção.',
      'Responda somente JSON no formato: {"status":"ready|ambiguous|incomplete","vessel":{"value":"texto literal","message":1,"quote":"trecho literal"},"equipment":{"value":"texto literal","message":1,"quote":"trecho literal"},"fields":{"equipment_class":null,"maker":null,"model":null,"stationary_equipment_class":null,"stationary_maker":null,"stationary_model":null,"date":null,"motivation":null,"executor":null,"method":null,"axial_vertical":null,"axial_horizontal":null,"radial_vertical":null,"radial_horizontal":null,"coupling_gap":null,"standard":null,"axial_tolerance":null,"radial_tolerance":null,"coupling_gap_tolerance":null,"document":null,"measurement_unit":null,"axial_vertical_before":null,"axial_horizontal_before":null,"radial_vertical_before":null,"radial_horizontal_before":null}}.',
      'Use o título do grupo como evidência contextual da embarcação. Use a configuração online (taxonomia, glossário e combinações) para reconhecer nomes alternativos. equipment é a identificação do conjunto alinhado, não uma classe genérica.',
      'Extraia apenas valores que as mensagens afirmam explicitamente. Mantenha tolerâncias separadas de medições. Registre medições após ajuste nas quatro direções apenas quando isso estiver explícito; medições anteriores ficam nos campos *_before. Não calcule, converta, complete, atribua autoria nem adivinhe dados ausentes.',
      'Cada valor não nulo precisa apontar para o número da mensagem e conter uma quote literal daquela mensagem que inclua o valor. Se houver dois equipamentos, conflito, troca incerta ou evidência insuficiente, marque ambiguous ou incomplete.',
      'Use status ready somente quando vessel, equipment e ao menos um campo de histórico estiverem claros. Use as grafias e unidades originais.',
      'MOTIVO DE FECHAMENTO: ' + reason,
      'CONFIGURAÇÃO ONLINE (referência para identificar valores canônicos; nunca invente): ' + await configContext(),
      'MENSAGENS: ' + JSON.stringify(transcript)
    ].join('\n'), model);
    await onExtract(session, reason, result, transcript);
  }

  async function ask(session) {
    const result = await geminiJson(apiKey, [
      'Você acompanha uma coleta de alinhamento em um grupo. Leia a conversa e a configuração online.',
      'Use os cabeçalhos reais e os campos que o registrador preenche para determinar o que falta ou está ambíguo. Identifique o grupo dos títulos repetidos. Não afirme que campos não mapeados serão preenchidos.',
      'ESQUEMA DA PLANILHA E CAMPOS GRAVADOS: ' + JSON.stringify(await getRecordSchema()),
      'Diferencie sempre tolerância especificada de medição. Não declare aceitabilidade sem comparação correspondente.',
      'Use a configuração para reconhecer nomes canônicos. Se houver mais de uma correspondência plausível, inclua a escolha na pergunta.',
      'Retorne JSON: {"known":["campos já informados claramente"],"missing":["nomes curtos dos campos"],"question":"uma única mensagem curta pedindo de uma vez todos os campos ainda faltantes, no estilo Preciso desses dados: Embarcação, tolerância...; string vazia se nenhum"}.',
      'Faça a pergunta em português ou inglês conforme o idioma mais recente do grupo. Não pergunte campos já informados claramente.',
      'CONFIGURAÇÃO: ' + await configContext(),
      'CONVERSA: ' + JSON.stringify(session.messages.map(m => ({sender:m.sender,text:m.text})))
    ].join('\n'), model);
    const missing = Array.isArray(result?.missing) ? result.missing.map(String).sort() : [];
    const known = Array.isArray(result?.known) ? result.known.map(String).sort() : [];
    const question = typeof result?.question === 'string' ? result.question.trim() : '';
    return { missing, known, question };
  }

  return { detect, classify, finish, ask, inspectAttachment };
}

function verifyExtraction(result, transcript) {
  if (!result || !['ready', 'incomplete'].includes(result.status)) return { ok: false, reason: 'extração ambígua' };
  const verifiedValue = (item) => {
    if (!item || typeof item.value !== 'string' || !item.value.trim() ||
        !Number.isInteger(item.message) || item.message < 1 || item.message > transcript.length ||
        typeof item.quote !== 'string' || !item.quote.trim()) return null;
    const source = transcript[item.message - 1].text;
    const fold = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
    if (!source.includes(item.quote) || !fold(item.quote).includes(fold(item.value))) return null;
    return item.value.trim();
  };

  const vessel = verifiedValue(result.vessel) || 'não informado';
  const equipment = verifiedValue(result.equipment) || 'não informado';

  const fields = {};
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    const value = verifiedValue(result.fields?.[key]);
    if (value) fields[label] = value;
  }
  const input = [`Vessel: ${vessel}`, `Equipment: ${equipment}`];
  for (const [label, value] of Object.entries(fields)) input.push(`${label}: ${value}`);
  return { ok: true, text: input.join('\n'), vessel, equipment, fields };
}

module.exports = { createTracker, fileStore, geminiJson, makeGeminiFunctions, verifyExtraction };


