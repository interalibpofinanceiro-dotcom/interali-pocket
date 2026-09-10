// Script único de manutenção (09/09/2026) — versão generalizada de corrigir-conciliacao-sirlene.js,
// rodando contra TODOS os clientes ativos (deduplicado por Sheet_ID, já que mais de um número de
// WhatsApp pode apontar pra mesma planilha — ver clientes.js) depois da correção do bug de
// falso-positivo na conciliação por divergência (reconciliacao.js, textoPossivelmenteRelacionado).
// Objetivo: registrar as transações do extrato que ficaram escondidas por engano (casadas com
// lançamento errado) e recalcular o Status_Conciliacao de toda a planilha de cada cliente com a
// lógica corrigida. Rodar uma vez, não faz parte do fluxo normal do webhook. Clientes com `ativo:
// false` (ex.: Mysael, desativado em 01/09/2026) são pulados de propósito.
require('dotenv').config();
const sheets = require('../sheets');
const { reconciliar, sincronizarConciliacao } = require('../reconciliacao');
const { listarClientesAtivos } = require('../clientes');

const RE_TARIFA = /\btarifa|cesta\s+de\s+servi[çc]|pacote\s+de\s+servi[çc]|manuten[çc][ãa]o\s+de\s+conta|tar\s+(ted|doc|pix|pacote)|\biof\b|anuidade|taxa\s+de\s+manuten|c\/c\s+tarifa/i;
const RE_RENDIMENTO = /rendimento|rend\s+pago|remunera[çc][ãa]o|juros\s+s\/?\s*saldo|juros\s+sobre\s+saldo|aplica[çc][ãa]o\s+autom.*rendiment|resgate.*rendiment/i;
const RE_TRANSF_MESMO_TITULAR = /transf(er[êe]ncia)?\s+entre\s+contas|mesma\s+titularidade|entre\s+contas\s+propri|aplica[çc][ãa]o\s+autom(?!.*rendiment)|resgate\s+autom(?!.*rendiment)|aplica[çc][ãa]o\s+financeira|resgate\s+de\s+aplica/i;

function classificarTransacaoBancaria(transacao) {
  const desc = transacao.descricao || '';
  if (RE_TRANSF_MESMO_TITULAR.test(desc)) {
    return { categoria: 'Transferência entre Contas', subcategoria: 'Mesmo titular', grupo_dre: 'transferencia_entre_contas' };
  }
  if (transacao.tipo === 'saida' && RE_TARIFA.test(desc)) {
    return { categoria: 'Tarifas Bancárias', subcategoria: 'Tarifa de conta', grupo_dre: 'financeiro_tarifas' };
  }
  if (transacao.tipo === 'entrada' && RE_RENDIMENTO.test(desc)) {
    return { categoria: 'Rendimentos de Aplicações', subcategoria: 'Rendimento de conta', grupo_dre: 'financeiro_rendimentos' };
  }
  return null;
}

async function registrarOrfaos(sheetId, lancamentos, extratoTotal) {
  const { somenteNoExtrato } = reconciliar(lancamentos, extratoTotal);

  const mesmaTransacaoBasica = (a, b) => (
    (a.data || '') === (b.data || '') &&
    Math.abs((a.valor || 0) - (b.valor || 0)) < 0.01 &&
    (a.tipo || '') === (b.tipo || '')
  );
  const jaRegistrados = [];
  const orfasUnicas = somenteNoExtrato.filter((t) => {
    const chave = { data: t.data, valor: t.valor, tipo: t.tipo };
    if (lancamentos.some((l) => mesmaTransacaoBasica({ data: l.data, valor: l.valor, tipo: l.tipo_movimentacao }, chave))) return false;
    if (jaRegistrados.some((j) => mesmaTransacaoBasica(j, chave))) return false;
    jaRegistrados.push(chave);
    return true;
  });

  const registrados = [];
  for (const transacao of orfasUnicas) {
    const auto = classificarTransacaoBancaria(transacao);
    const ref = await sheets.salvarComprovante(sheetId, {
      data: transacao.data,
      hora: '',
      valor: transacao.valor,
      tipo_movimentacao: transacao.tipo,
      descricao: transacao.descricao || '',
      estabelecimento_ou_pessoa: transacao.descricao || '',
      categoria: auto ? auto.categoria : 'Não Classificado',
      subcategoria: auto ? auto.subcategoria : '',
      grupo_dre: auto ? auto.grupo_dre : 'nao_classificado',
      conta_bancaria: transacao.conta_bancaria || '',
      status_conciliacao: auto ? 'CONCILIADO_OK' : 'PENDENTE_COMPROVANTE',
      observacao_conciliacao: auto
        ? 'Tarifa/rendimento do próprio banco — classificado automaticamente, sem comprovante a receber.'
        : 'Lançado via extrato/fatura. Comprovante original pendente.',
    });
    registrados.push({ transacao, ref, auto: !!auto });
  }
  return registrados;
}

async function sincronizarConciliacaoNaPlanilha(sheetId) {
  const [lancamentos, extrato] = await Promise.all([
    sheets.buscarTodosLancamentos(sheetId),
    sheets.buscarExtrato(sheetId),
  ]);
  const statusPorLinha = sincronizarConciliacao(lancamentos, extrato);
  const atualizacoes = lancamentos
    .map((lancamento) => {
      const novo = statusPorLinha.get(lancamento.chave || lancamento.linha) || { status: 'Pendente', observacao: '' };
      return { aba: lancamento.aba, linha: lancamento.linha, status: novo.status, observacao: novo.observacao, statusAnterior: lancamento.status_conciliacao };
    })
    .filter(({ status, statusAnterior }) => status !== statusAnterior)
    .map(({ aba, linha, status, observacao }) => ({ aba, linha, status, observacao }));

  await sheets.atualizarStatusConciliacaoEmLote(sheetId, atualizacoes);
  return atualizacoes;
}

async function corrigirPlanilha(sheetId, rotulo) {
  console.log(`\n=== ${rotulo} (${sheetId}) ===`);
  const [lancamentosAntes, extrato] = await Promise.all([
    sheets.buscarTodosLancamentos(sheetId),
    sheets.buscarExtrato(sheetId),
  ]);
  console.log(`Antes: ${lancamentosAntes.length} lançamentos, ${extrato.length} transações no extrato.`);

  if (lancamentosAntes.length === 0 && extrato.length === 0) {
    console.log('Sem lançamentos nem extrato — nada a fazer.');
    return { orfaos: 0, statusCorrigidos: 0 };
  }

  const registrados = await registrarOrfaos(sheetId, lancamentosAntes, extrato);
  console.log(`${registrados.length} lançamento(s) órfão(s) registrado(s):`);
  registrados.forEach((r) => console.log(`  ${r.transacao.data} | ${r.transacao.valor} | ${r.transacao.tipo} | ${r.transacao.descricao} | auto=${r.auto}`));

  const mudancas = await sincronizarConciliacaoNaPlanilha(sheetId);
  console.log(`${mudancas.length} status de conciliação corrigido(s):`);
  mudancas.forEach((m) => console.log(`  ${m.aba}!${m.linha} -> ${m.status} (${m.observacao})`));

  return { orfaos: registrados.length, statusCorrigidos: mudancas.length };
}

(async () => {
  const clientes = await listarClientesAtivos();
  const porSheetId = new Map();
  for (const c of clientes) {
    if (!c.ativo) continue; // pula desativado (ex.: Mysael) de propósito
    if (!porSheetId.has(c.sheetId)) porSheetId.set(c.sheetId, c.nome);
  }

  console.log(`${porSheetId.size} planilha(s) única(s) de cliente ativo a processar.`);

  const resumo = [];
  for (const [sheetId, nome] of porSheetId) {
    try {
      const resultado = await corrigirPlanilha(sheetId, nome);
      resumo.push({ nome, sheetId, ...resultado, erro: null });
    } catch (erro) {
      console.error(`ERRO em ${nome} (${sheetId}):`, erro.message);
      resumo.push({ nome, sheetId, orfaos: 0, statusCorrigidos: 0, erro: erro.message });
    }
  }

  console.log('\n=== RESUMO FINAL ===');
  resumo.forEach((r) => {
    if (r.erro) {
      console.log(`${r.nome}: ERRO — ${r.erro}`);
    } else {
      console.log(`${r.nome}: ${r.orfaos} órfão(s) registrado(s), ${r.statusCorrigidos} status corrigido(s).`);
    }
  });
})().catch((erro) => {
  console.error('ERRO GERAL:', erro.message);
  process.exit(1);
});
