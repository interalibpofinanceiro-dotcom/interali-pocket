// ⚠️ SUPERADO em 13/08/2026 — ninguém mais importa este arquivo (server.js e os CLIs agora usam
// `whatsapp.js`, que fala com a WhatsApp Cloud API oficial da Meta). Mantido só de referência
// (Evolution API/Baileys, não-oficial) caso precise voltar a usar no futuro. Ver
// CLAUDE.MD/HISTORICO-COMPLETO.md seção 14 pro contexto da migração.
require('dotenv').config();

const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;

// ── Números: a planilha guarda "whatsapp:+55XXXXXXXXXXX" (formato herdado do Twilio).
// A Evolution API usa só dígitos ("55XXXXXXXXXXX") pra enviar e JID ("55XXXXXXXXXXX@s.whatsapp.net")
// pra identificar quem mandou. Converte nas bordas pra não precisar migrar o que já tá cadastrado.
function jidParaFormatoPlanilha(remoteJid) {
  const numero = (remoteJid || '').split('@')[0];
  return `whatsapp:+${numero}`;
}

function formatoPlanilhaParaNumeroEvolution(numeroPlanilha) {
  return (numeroPlanilha || '').replace('whatsapp:', '').replace('+', '');
}

async function chamarEvolutionAPI(caminho, corpo, method = 'POST') {
  const init = {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: EVOLUTION_API_KEY,
    },
  };

  if (method === 'POST') {
    init.body = JSON.stringify(corpo);
  }

  const resposta = await fetch(`${EVOLUTION_API_URL}${caminho}`, init);

  if (!resposta.ok) {
    const textoErro = await resposta.text().catch(() => '');
    throw new Error(`Evolution API respondeu ${resposta.status}: ${textoErro}`);
  }

  return resposta.json();
}

async function testarConexaoEvolution() {
  return chamarEvolutionAPI('/instance/fetchInstances', undefined, 'GET');
}

async function enviarMensagemWhatsApp(numeroDestinoPlanilha, texto) {
  const number = formatoPlanilhaParaNumeroEvolution(numeroDestinoPlanilha);
  // encodeURIComponent porque o nome real da instância na Evolution tem espaço ("interali pocket") —
  // sem isso, o espaço quebraria a URL da requisição.
  return chamarEvolutionAPI(`/message/sendText/${encodeURIComponent(EVOLUTION_INSTANCE)}`, { number, text: texto });
}

// Busca o binário (imagem/PDF) de uma mensagem recebida, pelo id da mensagem —
// a Evolution não manda o arquivo direto no webhook, só os metadados.
async function buscarMidiaBase64(messageId) {
  const resultado = await chamarEvolutionAPI(`/chat/getBase64FromMediaMessage/${encodeURIComponent(EVOLUTION_INSTANCE)}`, {
    message: { key: { id: messageId } },
    convertToMp4: false,
  });

  return {
    buffer: Buffer.from(resultado.base64, 'base64'),
    mimeType: resultado.mimetype,
  };
}

module.exports = {
  jidParaFormatoPlanilha,
  formatoPlanilhaParaNumeroEvolution,
  chamarEvolutionAPI,
  enviarMensagemWhatsApp,
  buscarMidiaBase64,
  testarConexaoEvolution,
};
