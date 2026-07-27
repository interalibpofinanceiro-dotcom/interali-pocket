const TOLERANCIA_DIAS = 3;
const TOLERANCIA_VALOR = 0.01;

function paraData(strData) {
  if (!strData) return null;
  const data = new Date(`${strData}T00:00:00`);
  return Number.isNaN(data.getTime()) ? null : data;
}

function diferencaEmDias(dataA, dataB) {
  return Math.abs((dataA.getTime() - dataB.getTime()) / (1000 * 60 * 60 * 24));
}

function formatarMoeda(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarDataBR(strData) {
  const data = paraData(strData);
  if (!data) return strData || '';
  return data.toLocaleDateString('pt-BR');
}

// Cruza os comprovantes fotografados (lançamentos) com o extrato bancário real,
// por proximidade de data + mesmo valor, já que descrições nunca batem exatamente.
function reconciliar(lancamentos, extrato) {
  const extratoDisponivel = extrato.map((transacao) => ({ ...transacao, usado: false }));
  const conciliados = [];
  const somenteNosComprovantes = [];

  for (const lancamento of lancamentos) {
    const dataLancamento = paraData(lancamento.data);
    let melhorIndice = -1;
    let melhorDiferenca = Infinity;

    extratoDisponivel.forEach((transacao, indice) => {
      if (transacao.usado) return;
      if (transacao.tipo !== lancamento.tipo_movimentacao) return;
      if (Math.abs(transacao.valor - lancamento.valor) > TOLERANCIA_VALOR) return;

      const dataTransacao = paraData(transacao.data);
      if (!dataLancamento || !dataTransacao) return;

      const diferenca = diferencaEmDias(dataLancamento, dataTransacao);
      if (diferenca <= TOLERANCIA_DIAS && diferenca < melhorDiferenca) {
        melhorDiferenca = diferenca;
        melhorIndice = indice;
      }
    });

    if (melhorIndice >= 0) {
      extratoDisponivel[melhorIndice].usado = true;
      conciliados.push({ lancamento, transacao: extratoDisponivel[melhorIndice] });
    } else {
      somenteNosComprovantes.push(lancamento);
    }
  }

  const somenteNoExtrato = extratoDisponivel.filter((transacao) => !transacao.usado);

  return { conciliados, somenteNoExtrato, somenteNosComprovantes };
}

function calcularPeriodo(tipo, referencia) {
  const fim = new Date(referencia);
  let inicio;

  if (tipo === 'semana') {
    inicio = new Date(referencia);
    inicio.setDate(inicio.getDate() - 6);
  } else {
    inicio = new Date(referencia.getFullYear(), referencia.getMonth(), 1);
  }

  return { inicio, fim };
}

function calcularPeriodoAnterior(tipo, referencia) {
  if (tipo === 'semana') {
    const fim = new Date(referencia);
    fim.setDate(fim.getDate() - 7);
    const inicio = new Date(fim);
    inicio.setDate(inicio.getDate() - 6);
    return { inicio, fim };
  }

  const inicio = new Date(referencia.getFullYear(), referencia.getMonth() - 1, 1);
  const fim = new Date(referencia.getFullYear(), referencia.getMonth(), 0);
  return { inicio, fim };
}

function filtrarPorPeriodo(lista, campoData, inicio, fim) {
  return lista.filter((item) => {
    const data = paraData(item[campoData]);
    return data && data >= inicio && data <= fim;
  });
}

function calcularTotais(lista, campoTipo) {
  let entradas = 0;
  let saidas = 0;

  for (const item of lista) {
    if (item[campoTipo] === 'entrada') entradas += item.valor || 0;
    else if (item[campoTipo] === 'saida') saidas += item.valor || 0;
  }

  return { entradas, saidas, resultado: entradas - saidas };
}

function calcularTopCategorias(lancamentosPeriodo, limite = 3) {
  const totaisPorCategoria = {};

  for (const lancamento of lancamentosPeriodo) {
    if (lancamento.tipo_movimentacao !== 'saida') continue;
    const categoria = lancamento.categoria || 'Não Classificado';
    totaisPorCategoria[categoria] = (totaisPorCategoria[categoria] || 0) + (lancamento.valor || 0);
  }

  return Object.entries(totaisPorCategoria)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limite);
}

// Monta o fechamento do período: fluxo de caixa, comparação com o período anterior,
// maiores categorias de despesa e status da conciliação com o extrato bancário.
function gerarResumo(lancamentos, extrato, opcoes = {}) {
  const referencia = opcoes.referencia || new Date();
  const tipoPeriodo = opcoes.periodo === 'semana' ? 'semana' : 'mes';

  const { inicio, fim } = calcularPeriodo(tipoPeriodo, referencia);
  const { inicio: inicioAnterior, fim: fimAnterior } = calcularPeriodoAnterior(tipoPeriodo, referencia);

  const extratoPeriodo = filtrarPorPeriodo(extrato, 'data', inicio, fim);
  const lancamentosPeriodo = filtrarPorPeriodo(lancamentos, 'data', inicio, fim);
  const extratoAnterior = filtrarPorPeriodo(extrato, 'data', inicioAnterior, fimAnterior);
  const lancamentosAnterior = filtrarPorPeriodo(lancamentos, 'data', inicioAnterior, fimAnterior);

  const usarExtratoAtual = extratoPeriodo.length > 0;
  const totaisAtuais = usarExtratoAtual
    ? calcularTotais(extratoPeriodo, 'tipo')
    : calcularTotais(lancamentosPeriodo, 'tipo_movimentacao');

  const usarExtratoAnterior = extratoAnterior.length > 0;
  const temDadosAnteriores = extratoAnterior.length > 0 || lancamentosAnterior.length > 0;
  const totaisAnteriores = usarExtratoAnterior
    ? calcularTotais(extratoAnterior, 'tipo')
    : calcularTotais(lancamentosAnterior, 'tipo_movimentacao');

  let comparacao = null;
  if (temDadosAnteriores) {
    const diferenca = totaisAtuais.resultado - totaisAnteriores.resultado;
    const percentual = totaisAnteriores.resultado !== 0
      ? (diferenca / Math.abs(totaisAnteriores.resultado)) * 100
      : null;
    comparacao = { diferenca, percentual };
  }

  const topCategorias = calcularTopCategorias(lancamentosPeriodo);
  const conciliacao = reconciliar(lancamentosPeriodo, extratoPeriodo);

  return {
    tipoPeriodo,
    inicio,
    fim,
    fonteAtual: usarExtratoAtual ? 'extrato bancário' : 'comprovantes (sem extrato enviado no período)',
    totaisAtuais,
    temDadosAnteriores,
    comparacao,
    topCategorias,
    conciliacao,
  };
}

function formatarResumo(resumo) {
  const nomePeriodo = resumo.tipoPeriodo === 'semana' ? 'semana' : 'mês';
  const linhas = [];

  linhas.push(`📊 Resumo do ${nomePeriodo} (${resumo.inicio.toLocaleDateString('pt-BR')} a ${resumo.fim.toLocaleDateString('pt-BR')})`);
  linhas.push('');
  linhas.push(`💰 Fluxo de caixa (fonte: ${resumo.fonteAtual})`);
  linhas.push(`🟢 Entradas: ${formatarMoeda(resumo.totaisAtuais.entradas)}`);
  linhas.push(`🔴 Saídas: ${formatarMoeda(resumo.totaisAtuais.saidas)}`);
  linhas.push(`📈 Resultado: ${formatarMoeda(resumo.totaisAtuais.resultado)}`);
  linhas.push('');

  if (resumo.temDadosAnteriores && resumo.comparacao) {
    const { diferenca, percentual } = resumo.comparacao;
    const sinal = diferenca >= 0 ? '📈 acima' : '📉 abaixo';
    const percentualTexto = percentual !== null ? ` (${percentual >= 0 ? '+' : ''}${percentual.toFixed(1)}%)` : '';
    linhas.push(`Comparado ao ${nomePeriodo} anterior: ${sinal} em ${formatarMoeda(Math.abs(diferenca))}${percentualTexto}`);
  } else {
    linhas.push(`Ainda não tenho dados do ${nomePeriodo} anterior para comparar — isso fica disponível a partir do segundo ${nomePeriodo} de uso.`);
  }

  if (resumo.topCategorias.length > 0) {
    linhas.push('');
    linhas.push('🏷️ Maiores despesas por categoria:');
    resumo.topCategorias.forEach(([categoria, valor], indice) => {
      linhas.push(`${indice + 1}. ${categoria} — ${formatarMoeda(valor)}`);
    });
  }

  linhas.push('');
  linhas.push('🔍 Conciliação com o banco:');
  linhas.push(`✅ ${resumo.conciliacao.conciliados.length} lançamento(s) batem com o extrato`);

  if (resumo.conciliacao.somenteNoExtrato.length > 0) {
    linhas.push(`⚠️ ${resumo.conciliacao.somenteNoExtrato.length} transação(ões) no extrato sem comprovante:`);
    resumo.conciliacao.somenteNoExtrato.slice(0, 5).forEach((transacao) => {
      linhas.push(`   • ${formatarDataBR(transacao.data)} — ${formatarMoeda(transacao.valor)} (${transacao.descricao || 'sem descrição'})`);
    });
  }

  if (resumo.conciliacao.somenteNosComprovantes.length > 0) {
    linhas.push(`⚠️ ${resumo.conciliacao.somenteNosComprovantes.length} comprovante(s) sem correspondência no extrato:`);
    resumo.conciliacao.somenteNosComprovantes.slice(0, 5).forEach((lancamento) => {
      linhas.push(`   • ${formatarDataBR(lancamento.data)} — ${formatarMoeda(lancamento.valor)} (${lancamento.estabelecimento_ou_pessoa || lancamento.descricao || 'sem descrição'})`);
    });
  }

  return linhas.join('\n');
}

module.exports = {
  reconciliar,
  gerarResumo,
  formatarResumo,
};
