// Script único de manutenção (09/09/2026) — reaproveita a mesma lógica de registrarOrfaosDoExtrato/
// sincronizarConciliacaoNaPlanilha do server.js (não exportadas de lá), pra rodar contra a planilha
// REAL da Sirlene depois da correção do bug de falso-positivo na conciliação por divergência (ver
// reconciliacao.js, textoPossivelmenteRelacionado). Objetivo: registrar as transações do extrato que
// ficaram escondidas por engano (casadas com lançamento errado) e recalcular o Status_Conciliacao de
// toda a planilha com a lógica corrigida. Rodar uma vez, não faz parte do fluxo normal do webhook.
require('dotenv').config();
const sheets = require('../sheets');
const { reconciliar, sincronizarConciliacao } = require('../reconciliacao');

const SHEET_ID_SIRLENE = '1yqUt2O5MFr9fvDyWmsQP0RNrnkRfjDtZ40HOOzkjfmM';

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

(async () => {
  const [lancamentosAntes, extrato] = await Promise.all([
    sheets.buscarTodosLancamentos(SHEET_ID_SIRLENE),
    sheets.buscarExtrato(SHEET_ID_SIRLENE),
  ]);

  console.log(`Antes: ${lancamentosAntes.length} lançamentos, ${extrato.length} transações no extrato.`);

  const registrados = await registrarOrfaos(SHEET_ID_SIRLENE, lancamentosAntes, extrato);
  console.log(`\n${registrados.length} lançamento(s) órfão(s) registrado(s):`);
  registrados.forEach((r) => console.log(`  ${r.transacao.data} | ${r.transacao.valor} | ${r.transacao.tipo} | ${r.transacao.descricao} | auto=${r.auto}`));

  console.log('\nRecalculando Status_Conciliacao de toda a planilha...');
  const mudancas = await sincronizarConciliacaoNaPlanilha(SHEET_ID_SIRLENE);
  console.log(`\n${mudancas.length} status mudaram:`);
  mudancas.forEach((m) => console.log(`  ${m.aba}!${m.linha} -> ${m.status} (${m.observacao})`));

  console.log('\nConcluído.');
})().catch((erro) => {
  console.error('ERRO:', erro.message);
  process.exit(1);
});
