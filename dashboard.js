require('dotenv').config();
const { montarDreAnual } = require('./dre-anual');
const { porChave } = require('./dre');
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
// RESET DE SENHA POR WHATSAPP (23/08/2026, pedido do Aroldo — "olhinho + reset, o cliente
// recebe e muda a senha, o padrão que todos têm"). Decisão: reset chega por WHATSAPP, não e-mail —
// o projeto não tem serviço de e-mail configurado, e o WhatsApp já é o canal que todo cliente usa
// e já funciona 100%. Mesmo padrão de token único de uso, curto prazo, das outras memórias em Map
// deste projeto (ver SESSOES acima).
// ---------------------------------------------------------------------------------------------

const TOKENS_RESET_SENHA = new Map(); // token -> { numeroWhatsapp, criadoEm }
const TTL_TOKEN_RESET_MS = 30 * 60 * 1000; // 30 minutos — link de reset expira rápido por segurança

function criarTokenReset(numeroWhatsapp) {
  const token = crypto.randomBytes(24).toString('hex');
  TOKENS_RESET_SENHA.set(token, { numeroWhatsapp, criadoEm: Date.now() });
  return token;
}

function obterTokenReset(token) {
  if (!token) return null;
  const entrada = TOKENS_RESET_SENHA.get(token);
  if (!entrada) return null;
  if (Date.now() - entrada.criadoEm > TTL_TOKEN_RESET_MS) {
    TOKENS_RESET_SENHA.delete(token);
    return null;
  }
  return entrada;
}

// Token é de USO ÚNICO — consumido tanto quando a senha é trocada com sucesso quanto (por quem
// chama) se o link já tiver sido usado uma vez, evitando reuso do mesmo link depois.
function consumirTokenReset(token) {
  if (token) TOKENS_RESET_SENHA.delete(token);
}

// ---------------------------------------------------------------------------------------------
// DADOS DO DASHBOARD — adaptado por cliente.tipo (mesmo princípio já usado no roteamento de
// mídia: "o Pocket identifica e adere à planilha conforme a necessidade de cada cliente").
// ---------------------------------------------------------------------------------------------

function formatarMoedaSimples(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// "Linha de leitura" (09/09/2026, inspirado no padrão visual do Dashboard Gerencial do curso "Seu
// financeiro no Claude") — uma frase curta de insight, calculada a partir dos mesmos números que já
// vão pro dashboard, pra o dono ler antes de olhar os gráficos.
function gerarLinhaDeLeitura(resumoMes, comparacaoMesAnterior) {
  if (!resumoMes) return '';
  const positivo = resumoMes.resultado >= 0;
  // "Caixa", não "resultado" (14/10/2026): é entradas − saídas da conta, inclui aporte e transferência;
  // o resultado do negócio é o card da DRE — os dois não podem ter o mesmo nome na mesma tela.
  let texto = `Caixa do mês ${positivo ? 'positivo' : 'negativo'} em ${formatarMoedaSimples(resumoMes.resultado)}`;

  if (comparacaoMesAnterior && Math.abs(comparacaoMesAnterior.diferenca) > 0.01) {
    const { diferenca, percentual } = comparacaoMesAnterior;
    const pct = percentual !== null ? ` (${percentual >= 0 ? '+' : ''}${percentual.toFixed(0)}%)` : '';
    texto += `, ${diferenca >= 0 ? 'acima' : 'abaixo'} do mês anterior em ${formatarMoedaSimples(Math.abs(diferenca))}${pct}`;
  }

  return `${texto}.`;
}

// Checagem de sanidade ANTES de mostrar os números (09/09/2026, mesmo princípio do padrão do
// Dashboard Gerencial: "faça a conta primeiro e confira"). Aqui é uma checagem estrutural — entradas
// menos saídas precisa bater com o resultado — que deveria ser sempre verdadeira por construção;
// serve como rede de segurança caso um refactor futuro quebre essa invariante sem querer, não muda
// nada no cálculo em si.
function verificarConsistenciaDashboard(resumoMes) {
  if (!resumoMes) return { consistente: true };
  const esperado = resumoMes.entradas - resumoMes.saidas;
  const diferenca = Math.abs(esperado - resumoMes.resultado);
  return { consistente: diferenca <= 0.02, diferenca };
}

// `mes` = "AAAA-MM" opcional (14/10/2026 — seletor de mês do painel, pra revisar um mês já
// passado/fechado; antes os cards mostravam sempre o mês corrente e confundiam a revisão do
// fechamento). Mês passado usa o último dia dele como referência; mês corrente usa hoje.
function referenciaDoMes(mes) {
  const m = /^(\d{4})-(\d{2})$/.exec(mes || '');
  if (!m) return new Date();
  const fimDoMes = new Date(Number(m[1]), Number(m[2]), 0);
  const hoje = new Date();
  return fimDoMes < hoje ? fimDoMes : hoje;
}

// "De onde veio e pra onde foi o dinheiro" (14/10/2026, pedido do Aroldo: "14 mil é um valor total,
// preciso enxergar o que foi de cliente, o que foi aporte, o que era de terceiros — o cliente precisa
// enxergar isso, sendo PF ou PJ"). Agrupa os lançamentos do mês por NATUREZA (a partir do grupo_dre)
// com a lista de cada um. Mesma fonte da DRE: o lançamento classificado.
const NATUREZA_ENTRADA = [
  { id: 'receitas', rotulo: 'Receitas (clientes e vendas)', teste: (g) => g.startsWith('receita_') },
  { id: 'aportes', rotulo: 'Aportes do titular (dinheiro próprio)', teste: (g) => g === 'aporte_titular' },
  { id: 'transferencias', rotulo: 'Transferências entre suas contas', teste: (g) => g === 'transferencia_entre_contas' },
  { id: 'terceiros', rotulo: 'Dinheiro de terceiros (não é seu)', teste: (g) => g === 'repasse_terceiros_entrada' },
  { id: 'rendimentos', rotulo: 'Rendimentos de aplicações', teste: (g) => g === 'financeiro_rendimentos' },
];
const NATUREZA_SAIDA = [
  { id: 'retiradas', rotulo: 'Retiradas e gastos pessoais do titular', teste: (g) => g === 'pessoal_prolabore' },
  { id: 'fatura', rotulo: 'Pagamento de fatura de cartão', teste: (g) => g === 'admin_fatura_cartao_consolidada' },
  { id: 'terceiros', rotulo: 'Repasses a terceiros (dinheiro deles)', teste: (g) => g === 'repasse_terceiros_saida' },
  { id: 'transferencias', rotulo: 'Transferências entre suas contas', teste: (g) => g === 'transferencia_entre_contas' },
  { id: 'investimentos', rotulo: 'Investimentos (equipamentos, reformas)', teste: (g) => g === 'investimento_imobilizado' },
  { id: 'despesas', rotulo: 'Despesas do negócio', teste: (g) => !!porChave(g) && g !== 'nao_classificado' },
];

function montarComposicaoDoMes(lancamentos, referencia) {
  const ano = referencia.getFullYear();
  const mes = String(referencia.getMonth() + 1).padStart(2, '0');
  const doMes = lancamentos.filter((l) => String(l.data || '').startsWith(`${ano}-${mes}`));
  const item = (l) => ({
    data: l.data,
    descricao: l.categoria && l.categoria !== 'Não Classificado' ? l.categoria : (l.descricao || l.estabelecimento_ou_pessoa || ''),
    detalhe: l.estabelecimento_ou_pessoa && l.estabelecimento_ou_pessoa !== l.descricao ? l.estabelecimento_ou_pessoa : (l.descricao || ''),
    valor: Math.round((Number(l.valor) || 0) * 100) / 100,
    banco: l.conta_bancaria ? String(l.conta_bancaria).split(' - ')[0].replace(/\s+SCFI.*$/, '') : '',
    credito: /credito|crédito/i.test(l.forma_pagamento || ''),
  });
  const montar = (lista, naturezas) => {
    const grupos = naturezas.map((n) => ({ id: n.id, rotulo: n.rotulo, total: 0, itens: [] }));
    const aClassificar = { id: 'a_classificar', rotulo: 'A classificar', total: 0, itens: [] };
    for (const l of lista) {
      const g = l.grupo_dre && porChave(l.grupo_dre) ? l.grupo_dre : 'nao_classificado';
      const idx = naturezas.findIndex((n) => n.teste(g));
      const destino = idx === -1 ? aClassificar : grupos[idx];
      const it = item(l);
      it.linhaDre = porChave(g) ? porChave(g).rotulo : '';
      destino.itens.push(it);
      destino.total += it.valor;
    }
    const todos = [...grupos, aClassificar].filter((g) => g.itens.length);
    const totalGeral = todos.reduce((s, g) => s + g.total, 0);
    todos.forEach((g) => {
      g.total = Math.round(g.total * 100) / 100;
      g.percentual = totalGeral ? Math.round((g.total / totalGeral) * 1000) / 10 : 0;
      g.itens.sort((a, b) => String(a.data).localeCompare(String(b.data)));
    });
    return { total: Math.round(totalGeral * 100) / 100, grupos: todos };
  };
  return {
    entradas: montar(doMes.filter((l) => l.tipo_movimentacao === 'entrada'), NATUREZA_ENTRADA),
    saidas: montar(doMes.filter((l) => l.tipo_movimentacao !== 'entrada'), NATUREZA_SAIDA),
  };
}

async function montarDadosDashboardPadrao(cliente, { mes } = {}) {
  const [lancamentos, extrato, contasAPagar] = await Promise.all([
    buscarTodosLancamentos(cliente.sheetId),
    buscarExtrato(cliente.sheetId),
    buscarContasAPagar(cliente.sheetId),
  ]);

  const referencia = referenciaDoMes(mes);
  const resumoMes = gerarResumo(lancamentos, extrato, { periodo: 'mes', referencia });
  const saldoAtual = obterSaldoAtual(extrato);
  const contasEmAberto = filtrarContasEmAberto(contasAPagar, lancamentos).slice(0, 10);

  // Série diária dos últimos 30 dias (entradas/saídas) — direto dos lançamentos (sempre
  // disponíveis; o extrato é opcional, nem todo cliente manda com frequência).
  const serieMap = new Map();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(referencia);
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
    mesReferencia: `${referencia.getFullYear()}-${String(referencia.getMonth() + 1).padStart(2, '0')}`,
    saldoAtual,
    resumoMes: resumoMes.totaisAtuais,
    comparacaoMesAnterior: resumoMes.comparacao,
    topCategorias: resumoMes.topCategorias,
    contasEmAberto,
    serieDiaria,
    linhaDeLeitura: gerarLinhaDeLeitura(resumoMes.totaisAtuais, resumoMes.comparacao),
    consistencia: verificarConsistenciaDashboard(resumoMes.totaisAtuais),
    // 14/10/2026 — DRE do ano no padrão OMIE (mesma fonte da aba "DRE <ano>" da planilha).
    dreAnual: montarDreAnual(lancamentos, referencia.getFullYear()),
    composicao: montarComposicaoDoMes(lancamentos, referencia),
  };
}

async function montarDadosDashboard(cliente, opcoes = {}) {
  if (cliente.tipo === 'COMERCIO_MATRIZ') {
    const resumoComercio = await buscarResumoComercio(cliente.sheetId, { dias: 30 });
    return { tipo: 'COMERCIO_MATRIZ', nome: cliente.nome, ...resumoComercio };
  }
  return montarDadosDashboardPadrao(cliente, opcoes);
}

module.exports = {
  criarSessao,
  obterSessao,
  encerrarSessao,
  extrairTokenDoCookie,
  hashSenhaDashboard,
  verificarSenhaDashboard,
  criarTokenReset,
  obterTokenReset,
  consumirTokenReset,
  montarDadosDashboard,
  NOME_COOKIE,
};
