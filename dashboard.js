require('dotenv').config();
const crypto = require('crypto');
const { buscarTodosLancamentos, buscarExtrato, buscarContasAPagar } = require('./sheets');
const { gerarResumo, obterSaldoAtual, filtrarContasEmAberto } = require('./reconciliacao');
const { buscarResumoComercio } = require('./comercio-matriz');

// ============================================================================================
// Dashboard web privado por cliente (23/08/2026, pedido do Aroldo — "apresentar já pro cliente").
// Cada cliente entra com WhatsApp + senha (ver clientes.js: hashSenhaDashboard/verificarSenhaDashboard)
// e vê só os NÚMEROS JÁ PROCESSADOS da própria planilha — a planilha bruta em si nunca é exposta
// (nem link, nem compartilhamento de Sheets). O servidor lê a planilha nos bastidores com a mesma
// conta de serviço que já usa pro WhatsApp, monta um resumo, e devolve só esse resumo pro navegador.
//
// Sessão em memória (mesmo padrão de Map já usado no resto do projeto, ex.: PENDENCIAS_DUPLICIDADE
// em server.js) — reseta a cada deploy, aceitável no volume atual (poucos clientes, login não é
// frequente). Cookie HTTP simples, sem lib nova (sem express-session/cookie-parser).
// ============================================================================================

const SESSOES = new Map(); // token -> { numeroWhatsapp, sheetId, nome, tipo, criadoEm }
const TTL_SESSAO_MS = 24 * 60 * 60 * 1000; // 24h — cliente precisa logar de novo no dia seguinte
const NOME_COOKIE = 'pocket_dashboard_sessao';

function criarSessao(cliente) {
  const token = crypto.randomBytes(24).toString('hex');
  SESSOES.set(token, {
    numeroWhatsapp: cliente.numeroWhatsapp,
    sheetId: cliente.sheetId,
    nome: cliente.nome,
    tipo: cliente.tipo,
    criadoEm: Date.now(),
  });
  return token;
}

function obterSessao(token) {
  if (!token) return null;
  const sessao = SESSOES.get(token);
  if (!sessao) return null;
  if (Date.now() - sessao.criadoEm > TTL_SESSAO_MS) {
    SESSOES.delete(token);
    return null;
  }
  return sessao;
}

function encerrarSessao(token) {
  if (token) SESSOES.delete(token);
}

// Lê o cookie de sessão sem precisar de cookie-parser (o projeto não tem essa dependência —
// parsing manual de um único cookie é simples o bastante pra não justificar adicionar uma lib nova).
function extrairTokenDoCookie(req) {
  const cru = req.headers.cookie || '';
  const match = cru.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${NOME_COOKIE}=`));
  return match ? match.slice(NOME_COOKIE.length + 1) : null;
}

// ---------------------------------------------------------------------------------------------
// SENHA — hash com scrypt nativo do Node (módulo `crypto`, sem dependência nova tipo bcrypt).
// Formato armazenado numa única célula: "saltHex:hashHex".
// ---------------------------------------------------------------------------------------------

function hashSenhaDashboard(senhaPlano) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senhaPlano, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verificarSenhaDashboard(senhaPlano, saltHashArmazenado) {
  if (!senhaPlano || !saltHashArmazenado || !saltHashArmazenado.includes(':')) return false;
  const [salt, hashArmazenado] = saltHashArmazenado.split(':');
  try {
    const hashCalculado = crypto.scryptSync(senhaPlano, salt, 64).toString('hex');
    const bufArmazenado = Buffer.from(hashArmazenado, 'hex');
    const bufCalculado = Buffer.from(hashCalculado, 'hex');
    // timingSafeEqual evita vazar, pelo tempo de resposta, quantos caracteres do hash bateram —
    // proteção básica padrão pra comparação de senha/hash.
    return bufArmazenado.length === bufCalculado.length && crypto.timingSafeEqual(bufArmazenado, bufCalculado);
  } catch {
    return false; // hash armazenado em formato inesperado (ex.: cliente sem senha definida ainda)
  }
}

// ---------------------------------------------------------------------------------------------
// DADOS DO DASHBOARD — adaptado por cliente.tipo (mesmo princípio já usado no roteamento de
// mídia: "o Pocket identifica e adere à planilha conforme a necessidade de cada cliente").
// ---------------------------------------------------------------------------------------------

async function montarDadosDashboardPadrao(cliente) {
  const [lancamentos, extrato, contasAPagar] = await Promise.all([
    buscarTodosLancamentos(cliente.sheetId),
    buscarExtrato(cliente.sheetId),
    buscarContasAPagar(cliente.sheetId),
  ]);

  const resumoMes = gerarResumo(lancamentos, extrato, { periodo: 'mes' });
  const saldoAtual = obterSaldoAtual(extrato);
  const contasEmAberto = filtrarContasEmAberto(contasAPagar, lancamentos).slice(0, 10);

  // Série diária dos últimos 30 dias (entradas/saídas) — direto dos lançamentos (sempre
  // disponíveis; o extrato é opcional, nem todo cliente manda com frequência).
  const serieMap = new Map();
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    serieMap.set(d.toISOString().slice(0, 10), { entradas: 0, saidas: 0 });
  }
  for (const l of lancamentos) {
    const ponto = serieMap.get(l.data);
    if (!ponto) continue;
    if (l.tipo_movimentacao === 'entrada') ponto.entradas += Number(l.valor) || 0;
    else if (l.tipo_movimentacao === 'saida') ponto.saidas += Number(l.valor) || 0;
  }
  const serieDiaria = [...serieMap.entries()].map(([data, v]) => ({ data, ...v }));

  return {
    tipo: 'PADRAO',
    nome: cliente.nome,
    saldoAtual,
    resumoMes: resumoMes.totaisAtuais,
    comparacaoMesAnterior: resumoMes.comparacao,
    topCategorias: resumoMes.topCategorias,
    contasEmAberto,
    serieDiaria,
  };
}

async function montarDadosDashboard(cliente) {
  if (cliente.tipo === 'COMERCIO_MATRIZ') {
    const resumoComercio = await buscarResumoComercio(cliente.sheetId, { dias: 30 });
    return { tipo: 'COMERCIO_MATRIZ', nome: cliente.nome, ...resumoComercio };
  }
  return montarDadosDashboardPadrao(cliente);
}

module.exports = {
  criarSessao,
  obterSessao,
  encerrarSessao,
  extrairTokenDoCookie,
  hashSenhaDashboard,
  verificarSenhaDashboard,
  montarDadosDashboard,
  NOME_COOKIE,
};
