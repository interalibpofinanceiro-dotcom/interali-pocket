const { GRUPOS_DRE, ROTULO_BLOCO, porChave } = require('./dre');

const TOLERANCIA_DIAS = 3;
const TOLERANCIA_VALOR = 0.01;

// "Regra de ouro" da conciliação, com folga pra divergência: às vezes o valor do comprovante não
// bate 100% com o que saiu de fato no extrato (desconto aplicado, juro, arredondamento). Em vez de
// tratar como "não conciliado", casa mesmo assim dentro dessa tolerância e sinaliza a diferença —
// só entra em jogo quando o valor EXATO não encontrou par nenhum (ver reconciliar() abaixo).
const TOLERANCIA_DIVERGENCIA_PERCENTUAL = 0.15;
const TOLERANCIA_DIVERGENCIA_MINIMA = 5;

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

// Cruza os comprovantes fotografados (lançamentos) com o extrato bancário real, por proximidade
// de data + mesmo valor, já que descrições nunca batem exatamente. Duas passadas por lançamento:
// 1) valor exato (tolerância de 1 centavo) — o caso comum; 2) só pra quem sobrou sem par, valor
// aproximado (até 15%/R$5, o que for maior) — cobre desconto/juro/arredondamento entre o que o
// comprovante mostra e o que efetivamente saiu do banco. Quando cai na 2ª passada, o par vem
// marcado com `divergencia` (extrato − lançamento) em vez de ficar "não conciliado" à toa.
//
// Também detecta AMBIGUIDADE genuína (14/08/2026): se mais de UMA transação do extrato é candidata
// válida pro mesmo lançamento (ex.: duas saídas de R$50 no mesmo dia), escolher a "melhor" por
// pontuação seria um palpite, não uma conciliação de verdade — o par vem marcado com `ambiguo: true`
// pra virar PENDENTE_DUVIDA em vez de CONCILIADO_OK (ver sincronizarConciliacao).
function reconciliar(lancamentos, extrato) {
  const extratoDisponivel = extrato.map((transacao) => ({ ...transacao, usado: false }));
  const conciliados = [];
  const somenteNosComprovantes = [];

  // Devolve TODOS os candidatos válidos (não só o melhor), ordenados por pontuação — quem chama
  // decide se usa o 1º (melhor par) e se há empate suficiente pra marcar ambiguidade.
  const encontrarCandidatos = (lancamento, comDivergencia) => {
    const dataLancamento = paraData(lancamento.data);
    const candidatos = [];

    extratoDisponivel.forEach((transacao, indice) => {
      if (transacao.usado) return;
      if (transacao.tipo !== lancamento.tipo_movimentacao) return;

      const diferencaValor = Math.abs(transacao.valor - lancamento.valor);
      const toleranciaValor = comDivergencia
        ? Math.max(TOLERANCIA_DIVERGENCIA_MINIMA, lancamento.valor * TOLERANCIA_DIVERGENCIA_PERCENTUAL)
        : TOLERANCIA_VALOR;
      if (diferencaValor > toleranciaValor) return;

      const dataTransacao = paraData(transacao.data);
      if (!dataLancamento || !dataTransacao) return;

      const diferencaDias = diferencaEmDias(dataLancamento, dataTransacao);
      if (diferencaDias > TOLERANCIA_DIAS) return;

      // Desempate: menor diferença de valor primeiro (par mais provável), depois menor diferença de data.
      const pontuacao = diferencaValor * 1000 + diferencaDias;
      candidatos.push({ indice, pontuacao });
    });

    candidatos.sort((a, b) => a.pontuacao - b.pontuacao);
    return candidatos;
  };

  for (const lancamento of lancamentos) {
    let candidatos = encontrarCandidatos(lancamento, false);
    let divergencia = null;

    if (candidatos.length === 0) {
      candidatos = encontrarCandidatos(lancamento, true);
      if (candidatos.length > 0) divergencia = extratoDisponivel[candidatos[0].indice].valor - lancamento.valor;
    }

    if (candidatos.length > 0) {
      const indice = candidatos[0].indice;
      // Ambíguo = existe mais de 1 candidato válido, ou seja, a escolha do "melhor" seria um
      // palpite — não conta como empate se só sobrou 1 opção mesmo com pontuações parecidas.
      const ambiguo = candidatos.length > 1;
      extratoDisponivel[indice].usado = true;
      conciliados.push({ lancamento, transacao: extratoDisponivel[indice], divergencia, ambiguo });
    } else {
      somenteNosComprovantes.push(lancamento);
    }
  }

  const somenteNoExtrato = extratoDisponivel.filter((transacao) => !transacao.usado);

  return { conciliados, somenteNoExtrato, somenteNosComprovantes };
}

// Recalcula o Status_Conciliacao de CADA lançamento (histórico inteiro, não só o período de um
// resumo) — usado depois de salvar um comprovante ou um extrato novo, pra manter a coluna
// Status_Conciliacao da planilha sempre correta. Retorna um Map linha → { status, observacao }
// (só as linhas que mudaram precisam ser reescritas — quem chama compara com o status atual antes
// de gravar). Vocabulário (14/08/2026, padronizado a pedido do Aroldo):
//   - CONCILIADO_OK       — bateu com o extrato (exato ou com pequena divergência de valor).
//   - PENDENTE_DUVIDA     — bateu, mas havia MAIS de uma transação candidata no extrato (ambíguo de
//                           verdade, não dá pra escolher sozinho qual é a certa).
//   - PENDENTE_COMPROVANTE — lançamento nasceu do EXTRATO (sem comprovante nenhum ainda, ver
//                           processarExtratoOrfaos em server.js) — "congelado": mesmo que bata com
//                           o próprio extrato que o originou, o status só muda pra CONCILIADO_OK
//                           quando o comprovante de verdade chegar e completar a linha (ver
//                           classificarESalvarLancamento em server.js), nunca por este sincronismo
//                           genérico — senão perderia o sentido de "ainda falta o comprovante".
//   - Pendente            — comprovante normal, ainda não apareceu no extrato (o estado do dia a
//                           dia, não é problema nenhum — só espera o próximo extrato confirmar).
function sincronizarConciliacao(lancamentos, extrato) {
  const { conciliados, somenteNosComprovantes } = reconciliar(lancamentos, extrato);
  const statusPorLinha = new Map();

  for (const { lancamento, divergencia, ambiguo } of conciliados) {
    if (lancamento.status_conciliacao === 'PENDENTE_COMPROVANTE') {
      statusPorLinha.set(lancamento.linha, { status: 'PENDENTE_COMPROVANTE', observacao: lancamento.observacao_conciliacao || 'Lançado via extrato/fatura. Comprovante original pendente.' });
    } else if (ambiguo) {
      statusPorLinha.set(lancamento.linha, { status: 'PENDENTE_DUVIDA', observacao: `Mais de uma transação do extrato com valor parecido (${formatarMoeda(lancamento.valor)}) nessa data — confirme qual é a correta.` });
    } else {
      const observacao = divergencia !== null
        ? `Conciliado com divergência de ${formatarMoeda(Math.abs(divergencia))} (desconto/juros/arredondamento).`
        : '';
      statusPorLinha.set(lancamento.linha, { status: 'CONCILIADO_OK', observacao });
    }
  }
  for (const lancamento of somenteNosComprovantes) {
    if (lancamento.status_conciliacao === 'PENDENTE_COMPROVANTE') {
      statusPorLinha.set(lancamento.linha, { status: 'PENDENTE_COMPROVANTE', observacao: lancamento.observacao_conciliacao || 'Lançado via extrato/fatura. Comprovante original pendente.' });
    } else {
      statusPorLinha.set(lancamento.linha, { status: 'Pendente', observacao: '' });
    }
  }

  return statusPorLinha;
}

// "Lançamento órfão": entrada que apareceu AGORA num extrato recém-enviado (transacoesNovas) e não
// tem nenhum comprovante correspondente ainda — motiva o "identificamos um recebimento sem nota,
// o que é isso?" logo na resposta do WhatsApp. Só olha as transações novas desta mensagem (não o
// histórico inteiro) de propósito, pra não repetir o mesmo aviso a cada extrato seguinte enviado.
function encontrarTransacoesOrfas(transacoesNovas, lancamentos) {
  return transacoesNovas.filter((transacao) => {
    if (transacao.tipo !== 'entrada') return false;
    const dataTransacao = paraData(transacao.data);

    return !lancamentos.some((lancamento) => {
      if (lancamento.tipo_movimentacao !== 'entrada') return false;

      const diferencaValor = Math.abs(lancamento.valor - transacao.valor);
      const tolerancia = Math.max(TOLERANCIA_DIVERGENCIA_MINIMA, transacao.valor * TOLERANCIA_DIVERGENCIA_PERCENTUAL);
      if (diferencaValor > tolerancia) return false;

      const dataLancamento = paraData(lancamento.data);
      if (!dataLancamento || !dataTransacao) return false;
      return diferencaEmDias(dataLancamento, dataTransacao) <= TOLERANCIA_DIAS;
    });
  });
}

function calcularPeriodo(tipo, referencia) {
  const fim = new Date(referencia);
  let inicio;

  if (tipo === 'dia') {
    inicio = new Date(referencia);
  } else if (tipo === 'semana') {
    inicio = new Date(referencia);
    inicio.setDate(inicio.getDate() - 6);
  } else {
    inicio = new Date(referencia.getFullYear(), referencia.getMonth(), 1);
  }

  return { inicio, fim };
}

function calcularPeriodoAnterior(tipo, referencia) {
  if (tipo === 'dia') {
    const dia = new Date(referencia);
    dia.setDate(dia.getDate() - 1);
    return { inicio: dia, fim: dia };
  }

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
  const tipoPeriodo = ['dia', 'semana', 'mes'].includes(opcoes.periodo) ? opcoes.periodo : 'mes';

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
  const nomesPeriodo = { dia: 'dia', semana: 'semana', mes: 'mês' };
  const nomePeriodo = nomesPeriodo[resumo.tipoPeriodo] || 'mês';
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
  const comDivergencia = resumo.conciliacao.conciliados.filter((c) => c.divergencia !== null);
  const sufixoDivergencia = comDivergencia.length > 0
    ? ` (${comDivergencia.length} com pequena diferença de valor — desconto/juros/arredondamento)`
    : '';
  linhas.push(`✅ ${resumo.conciliacao.conciliados.length} lançamento(s) batem com o extrato${sufixoDivergencia}`);

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

// Usa o saldo_apos da transação mais recente do extrato como melhor estimativa do saldo atual em conta.
function obterSaldoAtual(extrato) {
  const comSaldo = extrato.filter((transacao) => transacao.saldo_apos !== null && transacao.saldo_apos !== undefined);
  if (comSaldo.length === 0) return null;

  const maisRecente = comSaldo.reduce((maisNova, atual) => {
    const dataAtual = paraData(atual.data);
    const dataMaisNova = paraData(maisNova.data);
    if (!dataAtual) return maisNova;
    if (!dataMaisNova || dataAtual > dataMaisNova) return atual;
    return maisNova;
  }, comSaldo[0]);

  return maisRecente.saldo_apos;
}

// Remove da lista de "contas a pagar" as que já têm um comprovante de pagamento
// correspondente (mesmo valor, pago perto do vencimento) — evita duplicar na projeção.
function filtrarContasEmAberto(contasAPagar, lancamentos) {
  const saidas = lancamentos.filter((lancamento) => lancamento.tipo_movimentacao === 'saida');

  return contasAPagar.filter((conta) => {
    const vencimento = paraData(conta.vencimento);
    const jaPaga = saidas.some((lancamento) => {
      if (Math.abs(lancamento.valor - conta.valor) > TOLERANCIA_VALOR) return false;
      const dataPagamento = paraData(lancamento.data);
      if (!vencimento || !dataPagamento) return false;
      const diferenca = (dataPagamento.getTime() - vencimento.getTime()) / (1000 * 60 * 60 * 24);
      return diferenca >= -10 && diferenca <= 10;
    });
    return !jaPaga;
  });
}

// Espelho de filtrarContasEmAberto, sentido inverso (14/08/2026) — remove da lista de "contas a
// receber" as que já têm um lançamento de ENTRADA correspondente (mesmo valor, recebido perto do
// vencimento), pra não contar de novo na projeção depois que o dinheiro já caiu de verdade.
function filtrarContasEmAbertoReceber(contasAReceber, lancamentos) {
  const entradas = lancamentos.filter((lancamento) => lancamento.tipo_movimentacao === 'entrada');

  return contasAReceber.filter((conta) => {
    const vencimento = paraData(conta.vencimento);
    const jaRecebida = entradas.some((lancamento) => {
      if (Math.abs(lancamento.valor - conta.valor) > TOLERANCIA_VALOR) return false;
      const dataRecebimento = paraData(lancamento.data);
      if (!vencimento || !dataRecebimento) return false;
      const diferenca = (dataRecebimento.getTime() - vencimento.getTime()) / (1000 * 60 * 60 * 24);
      return diferenca >= -10 && diferenca <= 10;
    });
    return !jaRecebida;
  });
}

// Projeta o saldo disponível somando o saldo atual (do extrato) + contas a RECEBER em aberto e
// subtraindo as contas a PAGAR em aberto, tudo dentro da janela de dias informada. Contas a
// receber é opcional (array vazio por padrão) — quem chama sem elas continua funcionando igual
// antes de 14/08/2026, só sem a parte de "a receber" na conta.
function projetarFluxoDeCaixa(saldoAtual, contasAPagarEmAberto, contasAReceberEmAberto = [], dias = 30, referencia = new Date()) {
  const limite = new Date(referencia);
  limite.setDate(limite.getDate() + dias);

  const noPeriodo = (contas) => contas
    .filter((conta) => {
      const vencimento = paraData(conta.vencimento);
      return vencimento && vencimento >= referencia && vencimento <= limite;
    })
    .sort((a, b) => paraData(a.vencimento) - paraData(b.vencimento));

  const contasNoPeriodo = noPeriodo(contasAPagarEmAberto);
  const contasReceberNoPeriodo = noPeriodo(contasAReceberEmAberto);

  const totalAPagar = contasNoPeriodo.reduce((soma, conta) => soma + (conta.valor || 0), 0);
  const totalAReceber = contasReceberNoPeriodo.reduce((soma, conta) => soma + (conta.valor || 0), 0);
  const saldoProjetado = saldoAtual !== null ? saldoAtual + totalAReceber - totalAPagar : null;

  return { saldoAtual, dias, contasNoPeriodo, totalAPagar, contasReceberNoPeriodo, totalAReceber, saldoProjetado };
}

function formatarProjecao(projecao) {
  const linhas = [];

  linhas.push(`🔮 Previsão para os próximos ${projecao.dias} dias`);
  linhas.push('');

  if (projecao.saldoAtual === null) {
    linhas.push('⚠️ Ainda não tenho um saldo atual confiável (preciso que você mande um extrato recente com o saldo visível).');
  } else {
    linhas.push(`💰 Saldo atual (último extrato): ${formatarMoeda(projecao.saldoAtual)}`);
  }

  linhas.push(`🔴 Total a pagar no período: ${formatarMoeda(projecao.totalAPagar)}`);
  if (projecao.totalAReceber) {
    linhas.push(`🟢 Total a receber no período: ${formatarMoeda(projecao.totalAReceber)}`);
  }

  if (projecao.saldoProjetado !== null) {
    const alerta = projecao.saldoProjetado < 0 ? '⚠️ Atenção: saldo pode ficar negativo!' : '✅';
    linhas.push(`📈 Saldo projetado: ${formatarMoeda(projecao.saldoProjetado)} ${alerta}`);
  }

  if (projecao.contasNoPeriodo.length > 0) {
    linhas.push('');
    linhas.push('📋 Contas a pagar:');
    projecao.contasNoPeriodo.slice(0, 10).forEach((conta) => {
      const parcela = conta.parcela_atual && conta.parcela_total ? ` (${conta.parcela_atual}/${conta.parcela_total})` : '';
      const cartao = conta.cartao ? `[${conta.cartao}] ` : '';
      linhas.push(`   • ${cartao}${formatarDataBR(conta.vencimento)} — ${formatarMoeda(conta.valor)} — ${conta.beneficiario || conta.descricao || 'sem descrição'}${parcela}`);
    });
    if (projecao.contasNoPeriodo.length > 10) {
      linhas.push(`   ... e mais ${projecao.contasNoPeriodo.length - 10} conta(s).`);
    }
  } else {
    linhas.push('');
    linhas.push('Nenhuma conta a pagar registrada para esse período. 🎉');
  }

  if (projecao.contasReceberNoPeriodo && projecao.contasReceberNoPeriodo.length > 0) {
    linhas.push('');
    linhas.push('📋 Contas a receber:');
    projecao.contasReceberNoPeriodo.slice(0, 10).forEach((conta) => {
      const parcela = conta.parcela_atual && conta.parcela_total ? ` (${conta.parcela_atual}/${conta.parcela_total})` : '';
      linhas.push(`   • ${formatarDataBR(conta.vencimento)} — ${formatarMoeda(conta.valor)} — ${conta.cliente_devedor || conta.descricao || 'sem descrição'}${parcela}`);
    });
    if (projecao.contasReceberNoPeriodo.length > 10) {
      linhas.push(`   ... e mais ${projecao.contasReceberNoPeriodo.length - 10} conta(s).`);
    }
  }

  return linhas.join('\n');
}

// Upsell do Plano com Especialista, anexado ao final do resumo MENSAL — só pra clientes que
// ainda não têm o upgrade (Plano_Especialista=FALSE na planilha mestre). Usa os mesmos totais
// já calculados no resumo, sem reprocessar nada.
function formatarUpsellEspecialista(resumo) {
  return (
    `\n\n💰 Sua empresa faturou ${formatarMoeda(resumo.totaisAtuais.entradas)} e teve ${formatarMoeda(resumo.totaisAtuais.saidas)} em custos este mês.\n\n` +
    'Que tal fazermos uma reunião rápida de 30 minutos via Google Meet para analisar sua margem e definir metas para o próximo mês?\n\n' +
    '👉 Faça o upgrade para o Plano com Especialista por apenas +R$ 200,00/mês. Responda esta mensagem para ativar!'
  );
}

// Monta a DRE Gerencial do período a partir dos LANÇAMENTOS já categorizados (campo Grupo_DRE,
// preenchido pelo Claude na extração — ver prompts.js/dre.js). Regime de caixa, igual ao resto do
// sistema: usa o que já foi pago/recebido (lancamentos), não o extrato bruto (não tem categoria)
// nem contas a pagar (ainda não pagas). Lançamentos sem Grupo_DRE reconhecível — dado antigo, de
// antes de 07/08/2026, ou que o Claude não conseguiu classificar — caem em "Outras Receitas/
// Despesas (Não Classificado)" pra nunca sumir do total, mesmo sem entrar numa linha específica.
function gerarDRE(lancamentos, opcoes = {}) {
  const referencia = opcoes.referencia || new Date();
  const tipoPeriodo = ['dia', 'semana', 'mes'].includes(opcoes.periodo) ? opcoes.periodo : 'mes';
  const { inicio, fim } = calcularPeriodo(tipoPeriodo, referencia);
  const lancamentosPeriodo = filtrarPorPeriodo(lancamentos, 'data', inicio, fim);

  const totalPorChave = {};
  let outrasReceitas = 0;
  let outrasDespesas = 0;

  for (const lancamento of lancamentosPeriodo) {
    const valor = lancamento.valor || 0;
    const grupo = lancamento.grupo_dre && porChave(lancamento.grupo_dre) ? lancamento.grupo_dre : null;

    if (!grupo || grupo === 'nao_classificado') {
      if (lancamento.tipo_movimentacao === 'entrada') outrasReceitas += valor;
      else outrasDespesas += valor;
      continue;
    }

    totalPorChave[grupo] = (totalPorChave[grupo] || 0) + valor;
  }

  const linhasBloco = (bloco) => GRUPOS_DRE
    .filter((g) => g.bloco === bloco)
    .map((g) => ({ rotulo: g.rotulo, valor: totalPorChave[g.chave] || 0 }))
    .filter((l) => l.valor !== 0);

  const somarBloco = (bloco) => GRUPOS_DRE
    .filter((g) => g.bloco === bloco)
    .reduce((soma, g) => soma + (totalPorChave[g.chave] || 0), 0);

  const receitaBrutaTotal = somarBloco('RECEITA_BRUTA') + outrasReceitas;
  const deducoesTotal = somarBloco('DEDUCOES');
  const receitaLiquida = receitaBrutaTotal - deducoesTotal;
  const custosTotal = somarBloco('CUSTOS');
  const lucroBruto = receitaLiquida - custosTotal;

  const despesasPessoalTotal = somarBloco('DESPESAS_PESSOAL');
  const despesasAdminTotal = somarBloco('DESPESAS_ADMIN') + outrasDespesas;
  const despesasVendasTotal = somarBloco('DESPESAS_VENDAS');
  const despesasOperacionaisTotal = despesasPessoalTotal + despesasAdminTotal + despesasVendasTotal;

  const resultadoOperacional = lucroBruto - despesasOperacionaisTotal;

  const rendimentos = totalPorChave.financeiro_rendimentos || 0;
  const tarifas = totalPorChave.financeiro_tarifas || 0;
  const jurosEmprestimos = totalPorChave.financeiro_juros_emprestimos || 0;
  const multasAtraso = totalPorChave.financeiro_multas_atraso || 0;
  const resultadoFinanceiro = rendimentos - tarifas - jurosEmprestimos - multasAtraso;

  const lucroLiquido = resultadoOperacional + resultadoFinanceiro;

  return {
    tipoPeriodo,
    inicio,
    fim,
    receitaBruta: { linhas: linhasBloco('RECEITA_BRUTA'), outrasReceitas, total: receitaBrutaTotal },
    deducoes: { linhas: linhasBloco('DEDUCOES'), total: deducoesTotal },
    receitaLiquida,
    custos: { linhas: linhasBloco('CUSTOS'), total: custosTotal },
    lucroBruto,
    despesasOperacionais: {
      pessoal: { linhas: linhasBloco('DESPESAS_PESSOAL'), total: despesasPessoalTotal },
      administrativas: { linhas: linhasBloco('DESPESAS_ADMIN'), outrasDespesas, total: despesasAdminTotal },
      vendas: { linhas: linhasBloco('DESPESAS_VENDAS'), total: despesasVendasTotal },
      total: despesasOperacionaisTotal,
    },
    resultadoOperacional,
    financeiro: { rendimentos, tarifas, jurosEmprestimos, multasAtraso, total: resultadoFinanceiro },
    lucroLiquido,
  };
}

// Formata uma linha "(+)/(-) Rótulo ......... R$ valor" alinhada num bloco monoespaçado.
function linhaDRE(sinal, rotulo, valor, largura = 50) {
  const texto = `   (${sinal}) ${rotulo}`;
  const valorTexto = formatarMoeda(valor);
  const espacos = Math.max(1, largura - texto.length - valorTexto.length);
  return `${texto}${' '.repeat(espacos)}${valorTexto}`;
}

function totalDRE(numero, rotulo, valor, largura = 50) {
  const texto = `(=) ${numero}. ${rotulo}`;
  const valorTexto = formatarMoeda(valor);
  const espacos = Math.max(1, largura - texto.length - valorTexto.length);
  return `${texto}${' '.repeat(espacos)}${valorTexto}`;
}

// Renderiza a DRE no formato de tabela do contador, dentro de um bloco ``` (monoespaçado no
// WhatsApp) pra manter o alinhamento dos valores.
function formatarDRE(dre, nomeCliente) {
  const nomesPeriodo = { dia: 'Dia', semana: 'Semana', mes: 'Mês' };
  const separador = '='.repeat(50);
  const linhas = ['```', separador];

  linhas.push('DEMONSTRAÇÃO DO RESULTADO DO EXERCÍCIO (DRE GERENCIAL)');
  linhas.push(`Empresa: ${nomeCliente || ''}`);
  linhas.push(`Período: ${nomesPeriodo[dre.tipoPeriodo] || 'Mês'} (${dre.inicio.toLocaleDateString('pt-BR')} a ${dre.fim.toLocaleDateString('pt-BR')})`);
  linhas.push(separador, '');

  linhas.push('1. RECEITA BRUTA TOTAL');
  dre.receitaBruta.linhas.forEach((l) => linhas.push(linhaDRE('+', l.rotulo, l.valor)));
  if (dre.receitaBruta.outrasReceitas) linhas.push(linhaDRE('+', 'Outras Receitas (Não Classificado)', dre.receitaBruta.outrasReceitas));
  linhas.push('-'.repeat(50));
  linhas.push(totalDRE(2, 'RECEITA BRUTA OPERACIONAL', dre.receitaBruta.total), '');

  linhas.push('3. (-) DEDUÇÕES DA RECEITA BRUTA');
  dre.deducoes.linhas.forEach((l) => linhas.push(linhaDRE('-', l.rotulo, l.valor)));
  linhas.push('-'.repeat(50));
  linhas.push(totalDRE(4, 'RECEITA LÍQUIDA OPERACIONAL', dre.receitaLiquida), '');

  linhas.push('5. (-) CUSTOS DOS PRODUTOS E SERVIÇOS VENDIDOS (CPV/CMV/CSP)');
  dre.custos.linhas.forEach((l) => linhas.push(linhaDRE('-', l.rotulo, l.valor)));
  linhas.push('-'.repeat(50));
  linhas.push(totalDRE(6, 'LUCRO BRUTO', dre.lucroBruto), '');

  linhas.push('7. (-) DESPESAS OPERACIONAIS', '');
  linhas.push(`   ${ROTULO_BLOCO.DESPESAS_PESSOAL}`);
  dre.despesasOperacionais.pessoal.linhas.forEach((l) => linhas.push(linhaDRE('-', l.rotulo, l.valor)));
  linhas.push('');
  linhas.push(`   ${ROTULO_BLOCO.DESPESAS_ADMIN}`);
  dre.despesasOperacionais.administrativas.linhas.forEach((l) => linhas.push(linhaDRE('-', l.rotulo, l.valor)));
  if (dre.despesasOperacionais.administrativas.outrasDespesas) {
    linhas.push(linhaDRE('-', 'Outras Despesas (Não Classificado)', dre.despesasOperacionais.administrativas.outrasDespesas));
  }
  linhas.push('');
  linhas.push(`   ${ROTULO_BLOCO.DESPESAS_VENDAS}`);
  dre.despesasOperacionais.vendas.linhas.forEach((l) => linhas.push(linhaDRE('-', l.rotulo, l.valor)));
  linhas.push('-'.repeat(50));
  linhas.push(totalDRE(8, 'RESULTADO OPERACIONAL (EBITDA)', dre.resultadoOperacional), '');

  linhas.push('9. RESULTADO FINANCEIRO');
  if (dre.financeiro.rendimentos) linhas.push(linhaDRE('+', 'Rendimentos de Aplicações Financeiras', dre.financeiro.rendimentos));
  if (dre.financeiro.tarifas) linhas.push(linhaDRE('-', 'Tarifas Bancárias e Manutenção de Conta', dre.financeiro.tarifas));
  if (dre.financeiro.jurosEmprestimos) linhas.push(linhaDRE('-', 'Juros Pagos sobre Empréstimos Bancários', dre.financeiro.jurosEmprestimos));
  if (dre.financeiro.multasAtraso) linhas.push(linhaDRE('-', 'Multas e Juros por Atraso de Contas', dre.financeiro.multasAtraso));
  linhas.push('-'.repeat(50));
  linhas.push(totalDRE(10, 'LUCRO LÍQUIDO DO EXERCÍCIO', dre.lucroLiquido));
  linhas.push(separador, '```');

  if (dre.lucroBruto === 0 && dre.receitaBruta.total === 0 && dre.despesasOperacionais.total === 0) {
    return `Ainda não tenho lançamentos categorizados suficientes nesse período pra montar a DRE. Manda alguns comprovantes e tenta de novo. 📊`;
  }

  return linhas.join('\n');
}

module.exports = {
  reconciliar,
  sincronizarConciliacao,
  encontrarTransacoesOrfas,
  gerarResumo,
  formatarResumo,
  formatarDataBR,
  formatarUpsellEspecialista,
  obterSaldoAtual,
  filtrarContasEmAberto,
  filtrarContasEmAbertoReceber,
  projetarFluxoDeCaixa,
  formatarProjecao,
  gerarDRE,
  formatarDRE,
};
