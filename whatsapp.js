require('dotenv').config();

// Integração com a WhatsApp Cloud API oficial da Meta (graph.facebook.com) — substitui a
// Evolution API (não-oficial/Baileys, usada de 31/07 a 11/08/2026). Ver CLAUDE.MD/HISTORICO-COMPLETO.md
// seção 14 pro contexto da migração.
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GRAPH_API_URL = `https://graph.facebook.com/${WHATSAPP_API_VERSION}`;

// Limite documentado da Cloud API pro corpo de uma mensagem de texto. Resumo/DRE de cliente com
// muitos lançamentos pode passar disso — sem quebrar, a Meta responde erro 400 e a mensagem inteira
// não sai. `enviarMensagemWhatsApp` quebra em partes automaticamente (ver `quebrarEmPartes`).
const LIMITE_CARACTERES_MENSAGEM = 4000;

// ── Números: o webhook da Cloud API manda "from" já em dígitos com DDI ("5541991234567" —
// sem "@s.whatsapp.net" nem "whatsapp:"). A planilha guarda "whatsapp:+55XXXXXXXXXXX" (formato
// herdado do Twilio/Evolution) — converte nas bordas pra não precisar migrar o que já tá cadastrado.
function jidParaFormatoPlanilha(waId) {
  const numero = (waId || '').replace(/\D/g, '');
  return `whatsapp:+${numero}`;
}

function formatoPlanilhaParaNumero(numeroPlanilha) {
  return (numeroPlanilha || '').replace('whatsapp:', '').replace('+', '');
}

async function chamarGraphAPI(caminho, corpo, method = 'POST') {
  const init = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
    },
  };

  if (method === 'POST') {
    init.body = JSON.stringify(corpo);
  }

  const resposta = await fetch(`${GRAPH_API_URL}${caminho}`, init);
  const json = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    const detalhe = (json.error && json.error.message) || JSON.stringify(json);
    throw new Error(`WhatsApp Cloud API respondeu ${resposta.status}: ${detalhe}`);
  }

  return json;
}

// Corta um texto longo em pedaços dentro do limite, preferindo cortar numa quebra de linha
// (pra não partir uma frase/linha da DRE/resumo no meio) quando existe uma "perto o bastante"
// do limite; senão corta seco mesmo.
function quebrarEmPartes(texto, limite) {
  if (texto.length <= limite) return [texto];

  const partes = [];
  let resto = texto;

  while (resto.length > limite) {
    let corte = resto.lastIndexOf('\n', limite);
    if (corte < limite * 0.5) corte = limite;
    partes.push(resto.slice(0, corte));
    resto = resto.slice(corte).replace(/^\n/, '');
  }
  if (resto) partes.push(resto);

  return partes;
}

async function enviarMensagemWhatsApp(numeroDestinoPlanilha, texto) {
  const to = formatoPlanilhaParaNumero(numeroDestinoPlanilha);
  const partes = quebrarEmPartes(texto || '', LIMITE_CARACTERES_MENSAGEM);

  let ultimaResposta;
  for (const parte of partes) {
    ultimaResposta = await chamarGraphAPI(`/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: parte },
    });
  }
  return ultimaResposta;
}

// A Meta proíbe quebra de linha, tab e mais de 4 espaços seguidos DENTRO do valor de uma
// variável de template (o texto fixo do corpo pode ter `\n` à vontade, só o valor da variável
// não pode) — sem isso o envio é rejeitado. Aplicado automaticamente em todo `enviarTemplateWhatsApp`
// pra quem chama não precisar lembrar disso toda vez (ex.: `error.message` às vezes vem com quebra).
function sanitizarParametroTemplate(texto) {
  return String(texto ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {5,}/g, '    ').trim();
}

// Manda mensagem de TEMPLATE — obrigatório pra falar primeiro com alguém que nunca mandou
// mensagem pro número, ou fora da janela de 24h de atendimento (texto livre é rejeitado pela
// Cloud API nesses casos; só template pré-aprovado pode "abrir" a conversa). `parametros` é um
// array de strings, na MESMA ORDEM das variáveis {{1}}, {{2}}... do corpo do template aprovado
// no WhatsApp Manager — precisa bater exatamente, senão a Meta rejeita o envio.
async function enviarTemplateWhatsApp(numeroDestinoPlanilha, nomeTemplate, idioma, parametros = []) {
  const to = formatoPlanilhaParaNumero(numeroDestinoPlanilha);

  const template = {
    name: nomeTemplate,
    language: { code: idioma },
  };

  if (parametros.length > 0) {
    template.components = [{
      type: 'body',
      parameters: parametros.map((texto) => ({ type: 'text', text: sanitizarParametroTemplate(texto) })),
    }];
  }

  return chamarGraphAPI(`/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template,
  });
}

// Baixa o binário (imagem/PDF) de uma mídia recebida, a partir do id que vem no webhook — a Cloud
// API não manda o arquivo direto no payload, só o id. É preciso 2 passos: 1) pedir a URL temporária
// de download (expira em poucos minutos), 2) baixar o binário dessa URL, com o mesmo token Bearer.
async function buscarMidiaBase64(mediaId) {
  const info = await chamarGraphAPI(`/${mediaId}`, undefined, 'GET');

  const respostaBinario = await fetch(info.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
  });

  if (!respostaBinario.ok) {
    throw new Error(`Falha ao baixar mídia da WhatsApp Cloud API: ${respostaBinario.status}`);
  }

  const arrayBuffer = await respostaBinario.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: info.mime_type };
}

// Confirma que as credenciais estão certas e o número tá acessível — usado no /health.
async function testarConexaoWhatsApp() {
  return chamarGraphAPI(`/${WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`, undefined, 'GET');
}

// Puxa a mensagem recebida (se houver) de dentro do corpo bruto do webhook — formato fixo da
// Cloud API: entry[0].changes[0].value.messages[0]. Retorna null quando não é evento de mensagem
// (ex.: "statuses" — confirmação de entrega/leitura de algo que o próprio bot mandou).
function extrairMensagemDoWebhook(body) {
  const value = body && body.entry && body.entry[0] && body.entry[0].changes && body.entry[0].changes[0] && body.entry[0].changes[0].value;
  const msg = value && Array.isArray(value.messages) && value.messages[0];
  return msg || null;
}

// Extrai texto simples e dados de mídia de uma mensagem já isolada pelo `extrairMensagemDoWebhook`
// — cada tipo de mensagem vem num campo próprio, nomeado igual ao "type" (msg.image, msg.document,
// msg.text...). Áudio/vídeo/figurinha não são tratados (igual antes, na Evolution) — caem no fluxo
// de texto vazio → mensagem de boas-vindas.
function interpretarMensagem(msg) {
  if (msg.type === 'image') {
    return { tipoMidia: 'image', mimeType: msg.image.mime_type, legenda: (msg.image.caption || '').toLowerCase(), mediaId: msg.image.id };
  }
  if (msg.type === 'document') {
    return { tipoMidia: 'document', mimeType: msg.document.mime_type, legenda: (msg.document.caption || '').toLowerCase(), mediaId: msg.document.id };
  }

  const texto = (msg.type === 'text' && msg.text && msg.text.body) || '';
  return { tipoMidia: null, texto: texto.trim() };
}

// Confere a verificação do webhook exigida pela Meta (GET com hub.mode=subscribe e
// hub.verify_token) contra o token configurado. Devolve o hub.challenge a ecoar quando bate,
// ou null quando deve recusar (server.js decide o status HTTP de cada caso).
function verificarWebhook(query) {
  const bateu = query['hub.mode'] === 'subscribe' && query['hub.verify_token'] && query['hub.verify_token'] === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  return bateu ? query['hub.challenge'] : null;
}

module.exports = {
  jidParaFormatoPlanilha,
  formatoPlanilhaParaNumero,
  chamarGraphAPI,
  enviarMensagemWhatsApp,
  enviarTemplateWhatsApp,
  buscarMidiaBase64,
  testarConexaoWhatsApp,
  extrairMensagemDoWebhook,
  interpretarMensagem,
  verificarWebhook,
};
