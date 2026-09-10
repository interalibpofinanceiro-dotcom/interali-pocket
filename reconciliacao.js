const { GRUPOS_DRE, ROTULO_BLOCO, porChave, chaveForaDoResultado } = require('./dre');

// Descrições de extrato que são claramente movimentação entre contas do próprio titular /
// aplicação / resgate — não entram no fluxo de caixa de resultado (mesma ideia da chave
// `transferencia_entre_contas` do lado dos lançamentos). Usado só quando o total é calculado
// direto do extrato bruto, que não tem grupo_dre.
const RE_EXTRATO_FORA_RESULTADO = /transf(er[êe]ncia)?\s+entre\s+contas|mesma\s+titularidade|aplica[çc][ãa]o\s+autom|resgate\s+autom|aplica[çc][ãa]o\s+financeira|resgate\s+de\s+aplica/i;

const TOLERANCIA_DIAS = 3;
const TOLERANCIA_VALOR = 0.01;

// "Regra de ouro" da conciliação, com folga pra divergência: às vezes o valor do comprovante não
// bate 100% com o que saiu de fato no extrato (desconto aplicado, juro, arredondamento). Em vez de
// tratar como "não conciliado", casa mesmo assim dentro dessa tolerância e sinaliza a diferença —
// só entra em jogo quando o valor EXATO não encontrou par nenhum (ver reconciliar() abaixo).
const TOLERANCIA_DIVERGENCIA_PERCENTUAL = 0.15;
const TOLERANCIA_DIVERGENCIA_MINIMA = 5;

// Guarda contra falso positivo na passada de DIVERGÊNCIA (09/09/2026, caso real: cliente Sirlene,
// "Pagto Energia Elétrica COPEL" R$155,45 em 02/09 foi casado por engano com "Auto Posto Jacaranda
// Ltda" R$145,93 em 04/09 — só porque ficou dentro de 15%/3 dias, sem nenhuma checagem de quem é o
// estabelecimento. Isso escondeu a COPEL como se já tivesse comprovante (nunca virou órfã) e marcou
// um posto de gasolina como "conciliado" com uma conta de luz. A passada EXATA (1 centavo) não
// precisa disso — valor praticamente idêntico já é prova forte por si só; só a passada de tolerância
// (mais frouxa) ganha essa checagem extra. Compara palavras significativas (4+ letras) em comum
// entre o nome do lançamento e a descrição do extrato — normalizado (sem acento, minúsculo, sem
// sufixo de razão social). Quando não dá pra comparar nada (descrição vazia de um dos lados),
// permanece permissivo (mesmo comportamento de antes) — só bloqueia quando há palavras dos dois
// lados e elas não têm nada em comum.
function normalizarTexto(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acento
    .replace(/\b(ltda|me|eireli|sa|s\/a|s\.a|epp|cia|comercio|comercial)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ');
}

function textoPossivelmenteRelacionado(descricaoLancamento, descricaoTransacao) {
  const palavrasA = new Set(normalizarTexto(descricaoLancamento).split(/\s+/).filter((p) => p.length >= 4));
  const palavrasB = new Set(normalizarTexto(descricaoTransacao).split(/\s+/).filter((p) => p.length >= 4));
  if (palavrasA.size === 0 || palavrasB.size === 0) return true; // nada pra comparar — não bloqueia
  for (const palavra of palavrasA) {
    if (palavrasB.has(palavra)) return true;
  }
  return false;
}

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

      // Só na passada de DIVERGÊNCIA (valor exato já é prova forte o bastante sozinho) — ver
      // textoPossivelmenteRelacionado acima, caso real COPEL x Auto Posto.
      if (comDivergencia && !textoPossivelmenteRelacionado(lancamento.estabelecimento_ou_pessoa || lancamento.descricao, transacao.descricao)) return;

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

  // Agrupamento (09/09/2026) roda por ÚLTIMO, só com quem sobrou das duas passadas acima — nunca
  // disputa com um casamento 1-para-1 que já bateu.
  const agrupamento = encontrarAgrupamentos(somenteNosComprovantes, somenteNoExtrato);

  return {
    conciliados,
    somenteNoExtrato: agrupamento.extratoRestante,
    somenteNosComprovantes: agrupamento.comprovantesRestantes,
    agrupamentosPorTransacao: agrupamento.agrupamentosPorTransacao,
    agrupamentosPorComprovante: agrupamento.agrupamentosPorComprovante,
  };
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
// Retorna Map cuja CHAVE é `lancamento.chave` (identificador único entre abas mensais, ver
// mapearLancamento em sheets.js) com fallback pra `lancamento.linha` (dado que não veio do
// buscarTodosLancamentos novo). Quem grava de volta (sincronizarConciliacaoNaPlanilha em
// server.js) traduz a chave -> { aba, linha } real.
function sincronizarConciliacao(lancamentos, extrato) {
  const { conciliados, somenteNosComprovantes, agrupamentosPorTransacao, agrupamentosPorComprovante } = reconciliar(lancamentos, extrato);
  const statusPorLinha = new Map();
  const chaveDe = (l) => l.chave || l.linha;

  // Agrupamento (09/09/2026): cada lançamento envolvido também vira CONCILIADO_OK, com a observação
  // explicando o grupo — mesmo vocabulário fixo de status, só muda o texto da observação.
  for (const { transacao, lancamentos: doGrupo } of agrupamentosPorTransacao) {
    const obs = `Conciliado por agrupamento — soma de ${doGrupo.length} lançamento(s) bate com 1 transação do extrato de ${formatarMoeda(transacao.valor)} em ${formatarDataBR(transacao.data)}.`;
    doGrupo.forEach((l) => statusPorLinha.set(chaveDe(l), { status: 'CONCILIADO_OK', observacao: obs }));
  }
  for (const { lancamento, transacoes } of agrupamentosPorComprovante) {
    statusPorLinha.set(chaveDe(lancamento), { status: 'CONCILIADO_OK', observacao: `Conciliado por agrupamento — este lançamento bate com a soma de ${transacoes.length} transação(ões) do extrato.` });
  }

  for (const { lancamento, divergencia, ambiguo } of conciliados) {
    if (lancamento.status_conciliacao === 'PENDENTE_COMPROVANTE') {
      statusPorLinha.set(chaveDe(lancamento), { status: 'PENDENTE_COMPROVANTE', observacao: lancamento.observacao_conciliacao || 'Lançado via extrato/fatura. Comprovante original pendente.' });
    } else if (ambiguo) {
      statusPorLinha.set(chaveDe(lancamento), { status: 'PENDENTE_DUVIDA', observacao: `Mais de uma transação do extrato com valor parecido (${formatarMoeda(lancamento.valor)}) nessa data — confirme qual é a correta.` });
    } else {
      const observacao = divergencia !== null
        ? `Conciliado com divergência de ${formatarMoeda(Math.abs(divergencia))} (desconto/juros/arredondamento).`
        : '';
      statusPorLinha.set(chaveDe(lancamento), { status: 'CONCILIADO_OK', observacao });
    }
  }
  for (const lancamento of somenteNosComprovantes) {
    if (lancamento.status_conciliacao === 'PENDENTE_COMPROVANTE') {
      statusPorLinha.set(chaveDe(lancamento), { status: 'PENDENTE_COMPROVANTE', observacao: lancamento.observacao_conciliacao || 'Lançado via extrato/fatura. Comprovante original pendente.' });
    } else {
      statusPorLinha.set(chaveDe(lancamento), { status: 'Pendente', observacao: '' });
    }
  }

  return statusPorLinha;
}

// "Lançamento órfão": entrada que apareceu AGORA num extrato recém-enviado (transacoesNovas) e não
// tem nenhum comprovante correspondente ainda — motiva o "identificamos um recebimento sem nota,
// o que é isso?" logo na resposta do WhatsApp. Só olha as transações novas desta mensagem (não o
// histórico inteiro) de propósito, pra não repetir o mesmo aviso a cada extrato seguinte enviado.
// Rendimento de aplicação / juros sobre saldo — entrada que vem do próprio banco, classificada
// sozinha (ver classificarTransacaoBancaria em server.js). Não é "recebimento sem nota", não
// pergunta nada ao cliente.
const RE_RENDIMENTO_BANCARIO = /rendimento|rend\s+pago|remunera[çc][ãa]o|juros\s+s\/?\s*saldo|juros\s+sobre\s+saldo/i;

function encontrarTransacoesOrfas(transacoesNovas, lancamentos) {
  return transacoesNovas.filter((transacao) => {
    if (transacao.tipo !== 'entrada') return false;
    if (RE_RENDIMENTO_BANCARIO.test(transacao.descricao || '')) return false;
    if (RE_EXTRATO_FORA_RESULTADO.test(transacao.descricao || '')) return false;
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

// "Conciliado por agrupamento" (09/09/2026, inspirado no projeto de Conciliação Bancária do curso
// "Seu financeiro no Claude") — cobre o caso em que 1 transação do extrato bate com a SOMA de
// vários comprovantes lançados (ex.: cliente recebe várias vendas num Pix só) ou o inverso (1
// comprovante/fatura bate com a soma de várias transações do extrato — ex.: parcelamento que
// aparece separado no banco). Só entra em jogo com quem SOBROU depois das duas passadas normais de
// reconciliar() (exata + divergência) — nunca compete com um casamento 1-para-1 que já bateu, e
// nunca reduz a confiança de nada que já conciliava antes desta mudança (09/09/2026).
const LIMITE_ITENS_AGRUPAMENTO = 15; // 2^15 combinações no pior caso — rápido e seguro (<1s)
const JANELA_DIAS_AGRUPAMENTO = 10; // batelada de pagamento costuma sair até ~10 dias depois da compra

// Busca por bitmask o subconjunto de `itens` (já pré-filtrado e limitado a LIMITE_ITENS_AGRUPAMENTO
// antes de chamar) cuja soma bate com `alvo` dentro da tolerância. Exige 2+ itens (1 item sozinho já
// seria pego pelo casamento normal 1-para-1, não é "agrupamento"). Em caso de mais de um subconjunto
// bater, prefere o de MENOS itens (agrupamento mais simples/crível).
function encontrarSubconjuntoComSoma(itens, alvo, tolerancia) {
  let melhor = null;
  const n = itens.length;
  for (let mascara = 3; mascara < (1 << n); mascara++) { // começa em 3 (0b11) — pula os de 0 e 1 item
    let soma = 0;
    let qtd = 0;
    for (let i = 0; i < n; i++) {
      if (mascara & (1 << i)) { soma += itens[i].valor; qtd += 1; }
    }
    if (qtd < 2) continue;
    if (Math.abs(soma - alvo) > tolerancia) continue;
    if (!melhor || qtd < melhor.qtd) {
      const selecionados = [];
      for (let i = 0; i < n; i++) if (mascara & (1 << i)) selecionados.push(itens[i]);
      melhor = { qtd, selecionados, soma };
    }
  }
  return melhor;
}

function encontrarAgrupamentos(somenteNosComprovantes, somenteNoExtrato) {
  const comprovantesLivres = somenteNosComprovantes.map((l, indice) => ({ ...l, _indice: indice, tipo: l.tipo_movimentacao }));
  const extratoLivre = somenteNoExtrato.map((t, indice) => ({ ...t, _indice: indice }));

  const usadoComprovante = new Set();
  const usadoExtrato = new Set();
  const agrupamentosPorTransacao = []; // 1 transação do extrato = soma de N comprovantes
  const agrupamentosPorComprovante = []; // 1 comprovante = soma de N transações do extrato

  const dentroDaJanela = (dataAlvo, dataItem) => {
    if (!dataAlvo || !dataItem) return false;
    const diffDias = (dataAlvo.getTime() - dataItem.getTime()) / (1000 * 60 * 60 * 24);
    return diffDias >= 0 && diffDias <= JANELA_DIAS_AGRUPAMENTO;
  };

  // Passada 1: 1 transação do extrato <- soma de vários comprovantes de mesmo tipo (entrada/saída).
  for (const transacao of extratoLivre) {
    const dataTransacao = paraData(transacao.data);
    if (!dataTransacao) continue;

    const candidatos = comprovantesLivres.filter((l) => (
      !usadoComprovante.has(l._indice) && l.tipo === transacao.tipo && dentroDaJanela(dataTransacao, paraData(l.data))
    )).slice(0, LIMITE_ITENS_AGRUPAMENTO);

    if (candidatos.length < 2) continue;
    const achado = encontrarSubconjuntoComSoma(candidatos, transacao.valor, TOLERANCIA_VALOR);
    if (achado) {
      achado.selecionados.forEach((l) => usadoComprovante.add(l._indice));
      usadoExtrato.add(transacao._indice);
      agrupamentosPorTransacao.push({ transacao, lancamentos: achado.selecionados });
    }
  }

  // Passada 2: 1 comprovante <- soma de várias transações do extrato (o que sobrou da passada 1).
  for (const lancamento of comprovantesLivres) {
    if (usadoComprovante.has(lancamento._indice)) continue;
    const dataLancamento = paraData(lancamento.data);
    if (!dataLancamento) continue;

    const candidatos = extratoLivre.filter((t) => (
      !usadoExtrato.has(t._indice) && t.tipo === lancamento.tipo && dentroDaJanela(paraData(t.data), dataLancamento)
    )).slice(0, LIMITE_ITENS_AGRUPAMENTO);

    if (candidatos.length < 2) continue;
    const achado = encontrarSubconjuntoComSoma(candidatos, lancamento.valor, TOLERANCIA_VALOR);
    if (achado) {
      achado.selecionados.forEach((t) => usadoExtrato.add(t._indice));
      usadoComprovante.add(lancamento._indice);
      agrupamentosPorComprovante.push({ lancamento, transacoes: achado.selecionados });
    }
  }

  return {
    agrupamentosPorTransacao,
    agrupamentosPorComprovante,
    comprovantesRestantes: somenteNosComprovantes.filter((_, indice) => !usadoComprovante.has(indice)),
    extratoRestante: somenteNoExtrato.filter((_, indice) => !usadoExtrato.has(indice)),
  };
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

function foraDoResultado(item) {
  if (item.grupo_dre) return chaveForaDoResultado(item.grupo_dre);
  return RE_EXTRATO_FORA_RESULTADO.test(item.descricao || '');
}

function calcularTotais(lista, campoTipo) {
  let entradas = 0;
  let saidas = 0;

  for (const item of lista) {
    if (foraDoResultado(item)) continue; // transferência entre contas / repasse / investimento
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

// Detecção automática de recorrência (09/09/2026, inspirado no projeto Fluxo de Caixa e Projeção do
// curso "Seu financeiro no Claude") — diferente do cadastro manual via "recorrente:" (que já existia
// e continua funcionando igual), isso olha o HISTÓRICO de lançamentos já salvos e identifica sozinho
// o que se repete: mesmo grupo_dre + mesmo tipo aparecendo em 2+ competências diferentes vira
// "recorrente detectado", com valor = média das ocorrências. Não escreve nada na planilha, só
// alimenta a projeção semanal (projetarFluxoSemanal) — puramente informativo/aditivo.
function detectarRecorrenciaAutomatica(lancamentosHistorico, mesesMinimo = 2) {
  const porChaveMesGrupo = {};
  for (const l of lancamentosHistorico) {
    if (!l.grupo_dre || !l.data || chaveForaDoResultado(l.grupo_dre)) continue;
    const chave = `${l.grupo_dre}|${l.tipo_movimentacao}`;
    const competencia = String(l.data).slice(0, 7);
    if (!porChaveMesGrupo[chave]) porChaveMesGrupo[chave] = {};
    if (!porChaveMesGrupo[chave][competencia]) porChaveMesGrupo[chave][competencia] = [];
    porChaveMesGrupo[chave][competencia].push(l.valor || 0);
  }

  const recorrentes = [];
  for (const [chave, porCompetencia] of Object.entries(porChaveMesGrupo)) {
    const competencias = Object.keys(porCompetencia);
    if (competencias.length < mesesMinimo) continue;
    const [grupoDre, tipo] = chave.split('|');
    const todosValores = competencias.flatMap((c) => porCompetencia[c]);
    const valorMedio = todosValores.reduce((s, v) => s + v, 0) / todosValores.length;
    const def = porChave(grupoDre);
    recorrentes.push({ grupoDre, tipo, valorMedio, ocorrencias: competencias.length, rotulo: def ? def.rotulo : grupoDre });
  }
  return recorrentes;
}

// Alertas de sazonalidade (09/09/2026) — avisa mesmo SEM histórico prévio, calendário fixo (mesma
// lista do curso): 13º/férias em nov-jan, IPTU/IPVA em janeiro, IRPJ/CSLL trimestral no presumido.
function alertasSazonalidade(referencia) {
  const mes = referencia.getMonth() + 1;
  const alertas = [];
  if (mes === 11 || mes === 12) alertas.push('13º salário (1ª e 2ª parcela) costuma pesar no caixa em novembro/dezembro.');
  if (mes === 12 || mes === 1) alertas.push('Férias coletivas e provisão de férias costumam concentrar em dezembro/janeiro.');
  if (mes === 1) alertas.push('IPTU, IPVA, licenciamentos e seguros anuais costumam vencer em janeiro.');
  if ([3, 6, 9, 12].includes(mes)) alertas.push('Se você é Lucro Presumido, IRPJ e CSLL trimestral costumam vencer nesse mês.');
  return alertas;
}

// Projeção SEMANAL com "semanas de aperto" (09/09/2026) — complementa projetarFluxoDeCaixa (que
// continua existindo e funcionando exatamente igual, usado pelo comando "previsão" de sempre). Aqui
// a projeção é semana a semana, somando contas a pagar/receber JÁ CADASTRADAS (mesmo dado de sempre)
// + o valor médio dos recorrentes DETECTADOS automaticamente no histórico (distribuído 1/4,33 por
// semana) — cobre entrada/saída que se repete mas o cliente nunca cadastrou via "recorrente:".
// Mínimo de caixa: se não informado, usa 1 semana de saída operacional média (mesma régua do curso:
// "um mês de saída média" ÷ 4,33). Semana com saldo projetado abaixo desse mínimo (ou abaixo de
// zero) entra em "aperto".
function projetarFluxoSemanal(saldoAtual, contasAPagarEmAberto, contasAReceberEmAberto, lancamentosHistorico, opcoes = {}) {
  const numSemanas = opcoes.semanas || 12;
  const referencia = opcoes.referencia || new Date();
  const recorrentes = detectarRecorrenciaAutomatica(lancamentosHistorico);

  const saidasHistoricas = lancamentosHistorico.filter((l) => l.tipo_movimentacao === 'saida' && !chaveForaDoResultado(l.grupo_dre));
  const competenciasComSaida = new Set(saidasHistoricas.map((l) => String(l.data).slice(0, 7)));
  const saidaMediaMensal = competenciasComSaida.size > 0
    ? saidasHistoricas.reduce((s, l) => s + (l.valor || 0), 0) / competenciasComSaida.size
    : 0;
  const minimoCaixa = opcoes.minimoCaixa !== undefined ? opcoes.minimoCaixa : saidaMediaMensal / 4.33;

  const totalRecorrenteEntradaSemana = recorrentes.filter((r) => r.tipo === 'entrada').reduce((s, r) => s + r.valorMedio, 0) / 4.33;
  const totalRecorrenteSaidaSemana = recorrentes.filter((r) => r.tipo === 'saida').reduce((s, r) => s + r.valorMedio, 0) / 4.33;

  let saldoCorrente = saldoAtual;
  const semanas = [];

  for (let i = 0; i < numSemanas; i++) {
    const inicioSemana = new Date(referencia);
    inicioSemana.setDate(inicioSemana.getDate() + i * 7);
    const fimSemana = new Date(inicioSemana);
    fimSemana.setDate(fimSemana.getDate() + 6);

    const noPeriodo = (contas) => contas.filter((c) => { const v = paraData(c.vencimento); return v && v >= inicioSemana && v <= fimSemana; });
    const contasPagarSemana = noPeriodo(contasAPagarEmAberto);
    const contasReceberSemana = noPeriodo(contasAReceberEmAberto);

    const entradas = contasReceberSemana.reduce((s, c) => s + (c.valor || 0), 0) + totalRecorrenteEntradaSemana;
    const saidas = contasPagarSemana.reduce((s, c) => s + (c.valor || 0), 0) + totalRecorrenteSaidaSemana;

    saldoCorrente = saldoCorrente !== null ? saldoCorrente + entradas - saidas : null;

    semanas.push({
      inicio: inicioSemana,
      fim: fimSemana,
      entradas,
      saidas,
      contasPagar: contasPagarSemana,
      contasReceber: contasReceberSemana,
      saldoProjetado: saldoCorrente,
      aperto: saldoCorrente !== null && saldoCorrente < Math.max(0, minimoCaixa),
    });
  }

  return { semanas, recorrentesDetectados: recorrentes, minimoCaixa, alertasSazonalidade: alertasSazonalidade(referencia) };
}

function formatarProjecaoSemanal(projecao) {
  const linhas = ['🔮 Previsão semanal (próximas 12 semanas)', ''];

  if (projecao.semanas[0].saldoProjetado === null) {
    linhas.push('⚠️ Ainda não tenho um saldo atual confiável (preciso de um extrato recente com o saldo visível).', '');
  }

  const semanasDeAperto = projecao.semanas.filter((s) => s.aperto);
  if (semanasDeAperto.length > 0) {
    linhas.push(`⚠️ *${semanasDeAperto.length} semana(s) de aperto* (saldo projetado abaixo do mínimo de ${formatarMoeda(projecao.minimoCaixa)}):`);
    semanasDeAperto.slice(0, 6).forEach((s) => {
      linhas.push(`   • ${formatarDataBR(s.inicio.toISOString().slice(0, 10))} a ${formatarDataBR(s.fim.toISOString().slice(0, 10))}: saldo projetado ${formatarMoeda(s.saldoProjetado)}`);
    });
  } else {
    linhas.push('✅ Nenhuma semana de aperto nas próximas 12 semanas, com o que já está cadastrado.');
  }

  if (projecao.recorrentesDetectados.length > 0) {
    linhas.push('', '🔁 Recorrentes identificados no seu histórico (considerados na projeção mesmo sem cadastro):');
    projecao.recorrentesDetectados.slice(0, 8).forEach((r) => {
      linhas.push(`   • ${r.tipo === 'entrada' ? '🟢' : '🔴'} ${r.rotulo} — ${formatarMoeda(r.valorMedio)}/mês (visto em ${r.ocorrencias} meses)`);
    });
  }

  if (projecao.alertasSazonalidade.length > 0) {
    linhas.push('', '📅 Fique de olho:');
    projecao.alertasSazonalidade.forEach((a) => linhas.push(`   • ${a}`));
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
    // Realizado por chave, exposto pra fora (09/09/2026) — usado pelo comparativo orçado vs
    // realizado (compararOrcadoRealizado) sem precisar recalcular tudo de novo.
    totalPorChave,
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

// "Prova dos saldos" (09/09/2026, inspirada no projeto de Conciliação Bancária do curso "Seu
// financeiro no Claude") — confirma que a LEITURA do extrato do mês está internamente consistente:
// saldo inicial (saldo_apos da 1ª transação, subtraindo o próprio valor dela) + soma de entradas −
// soma de saídas do mês deveria bater com o saldo final (saldo_apos da última transação). Não é o
// mesmo "saldo do razão vs. saldo do banco" do curso original — o Pocket não mantém um saldo interno
// separado do banco — aqui a prova serve pra pegar bug de LEITURA/parsing do extrato (já aconteceu
// antes com número em formato BR mal convertido, ver numeroBR em sheets.js) antes que o cliente veja
// um resultado errado. Retorna null se não há transação com saldo_apos suficiente pra calcular.
function calcularProvaDosSaldos(extratoDoPeriodo) {
  const comSaldo = extratoDoPeriodo
    .filter((t) => t.saldo_apos !== null && t.saldo_apos !== undefined && paraData(t.data))
    .sort((a, b) => paraData(a.data) - paraData(b.data));

  if (comSaldo.length === 0) return null;

  const primeira = comSaldo[0];
  const ultima = comSaldo[comSaldo.length - 1];
  const valorComSinal = (t) => (t.tipo === 'saida' ? -1 : 1) * (t.valor || 0);

  const saldoInicial = primeira.saldo_apos - valorComSinal(primeira);
  const movimento = comSaldo.reduce((soma, t) => soma + valorComSinal(t), 0);
  const saldoCalculado = saldoInicial + movimento;
  const saldoFinalReal = ultima.saldo_apos;
  const diferenca = saldoFinalReal - saldoCalculado;

  return { saldoInicial, movimento, saldoCalculado, saldoFinalReal, diferenca, fechou: Math.abs(diferenca) <= 0.02 };
}

// Orçado vs Realizado (09/09/2026, inspirado no projeto "DRE e Orçado vs Realizado" do curso "Seu
// financeiro no Claude") — compara o orçamento cadastrado pelo cliente (comando "orçamento:", ver
// prompts.js/server.js) por grupo_dre com o realizado do mesmo período (totalPorChave do gerarDRE).
// Tolerância de 5% pra status "Dentro do orçado" (mesma do curso). Retorna null se o cliente não
// cadastrou orçamento pra essa competência — nesse caso o fechamento continua exatamente como
// sempre foi, sem essa seção.
const TOLERANCIA_ORCADO_PERCENTUAL = 5;

function compararOrcadoRealizado(totalPorChaveRealizado, orcamentoCompetencia) {
  if (!orcamentoCompetencia || orcamentoCompetencia.length === 0) return null;

  const linhas = orcamentoCompetencia.map((item) => {
    const def = porChave(item.grupo_dre);
    const orcado = item.valor_orcado || 0;
    const realizado = totalPorChaveRealizado[item.grupo_dre] || 0;
    const variacaoValor = realizado - orcado;
    const variacaoPercentual = orcado !== 0 ? (variacaoValor / orcado) * 100 : null;

    let status = 'Dentro';
    if (variacaoPercentual === null) status = realizado > 0 ? 'Acima do orçado' : 'Dentro';
    else if (variacaoPercentual > TOLERANCIA_ORCADO_PERCENTUAL) status = 'Acima do orçado';
    else if (variacaoPercentual < -TOLERANCIA_ORCADO_PERCENTUAL) status = 'Abaixo do orçado';

    return { grupoDre: item.grupo_dre, rotulo: def ? def.rotulo : item.grupo_dre, orcado, realizado, variacaoValor, variacaoPercentual, status };
  });

  const maioresVariacoes = [...linhas].sort((a, b) => Math.abs(b.variacaoValor) - Math.abs(a.variacaoValor)).slice(0, 5);

  return { linhas, maioresVariacoes };
}

// Pontos de atenção automáticos (09/09/2026, inspirado no projeto de Fechamento Mensal do curso
// "Seu financeiro no Claude") — os mesmos 4 sinais de alerta que um controller levaria pra
// diretoria, calculados a partir do que já está na planilha, sem precisar de dado novo do cliente.
// Máximo 5 itens (mesmo limite do curso) — se mais de um bater, prioriza por relevância financeira.
function calcularConcentracao(lancamentosMes, tipoMovimentacao, totalDoTipo) {
  if (!totalDoTipo) return null;
  const porContraparte = {};
  for (const l of lancamentosMes) {
    if (l.tipo_movimentacao !== tipoMovimentacao) continue;
    const nome = (l.estabelecimento_ou_pessoa || '').trim();
    if (!nome) continue;
    porContraparte[nome] = (porContraparte[nome] || 0) + (l.valor || 0);
  }
  const maior = Object.entries(porContraparte).sort((a, b) => b[1] - a[1])[0];
  if (!maior) return null;
  return { nome: maior[0], valor: maior[1], percentual: (maior[1] / totalDoTipo) * 100 };
}

function calcularPontosDeAtencao(fechamento, lancamentosMes) {
  const pontos = [];

  const concentracaoFornecedor = calcularConcentracao(lancamentosMes, 'saida', fechamento.saidas);
  if (concentracaoFornecedor && concentracaoFornecedor.percentual > 20) {
    pontos.push({ prioridade: concentracaoFornecedor.percentual, texto: `Fornecedor "${concentracaoFornecedor.nome}" concentra ${concentracaoFornecedor.percentual.toFixed(0)}% da despesa do mês (${formatarMoeda(concentracaoFornecedor.valor)}).` });
  }

  const concentracaoCliente = calcularConcentracao(lancamentosMes, 'entrada', fechamento.entradas);
  if (concentracaoCliente && concentracaoCliente.percentual > 30) {
    pontos.push({ prioridade: concentracaoCliente.percentual, texto: `Receita concentrada: "${concentracaoCliente.nome}" representa ${concentracaoCliente.percentual.toFixed(0)}% do faturamento do mês (${formatarMoeda(concentracaoCliente.valor)}).` });
  }

  if (fechamento.resultado < 0) {
    pontos.push({ prioridade: 1000, texto: `Resultado do mês foi negativo: ${formatarMoeda(fechamento.resultado)}.` });
  }

  if (fechamento.comparacaoMesAnterior) {
    const margemAtual = fechamento.entradas ? (fechamento.resultado / fechamento.entradas) * 100 : null;
    const c = fechamento.comparacaoMesAnterior;
    const margemAnterior = c.entradas ? (c.resultado / c.entradas) * 100 : null;
    if (margemAtual !== null && margemAnterior !== null && margemAnterior - margemAtual > 5) {
      pontos.push({ prioridade: margemAnterior - margemAtual + 100, texto: `Margem caiu ${(margemAnterior - margemAtual).toFixed(1)} pontos percentuais vs. o mês anterior (${margemAnterior.toFixed(1)}% → ${margemAtual.toFixed(1)}%).` });
    }
  }

  // "Saldo abaixo de 1 mês de despesa" — usa as saídas do próprio mês fechado como proxy de "1 mês
  // de despesa" (o Pocket não separa fixo/variável hoje). Só avalia quando há saldo real do extrato.
  if (fechamento.saldoFinalExtrato !== null && fechamento.saidas > 0 && fechamento.saldoFinalExtrato < fechamento.saidas) {
    pontos.push({ prioridade: 500, texto: `Saldo em conta (${formatarMoeda(fechamento.saldoFinalExtrato)}) está abaixo de 1 mês de despesa (${formatarMoeda(fechamento.saidas)}) — pouca folga pra um mês ruim.` });
  }

  return pontos.sort((a, b) => b.prioridade - a.prioridade).slice(0, 5).map((p) => p.texto);
}

// Decisões pendentes formuladas como pergunta fechada (09/09/2026, inspirado no projeto Relatório
// para Diretoria do curso "Seu financeiro no Claude") — reaproveita os mesmos sinais de
// calcularPontosDeAtencao, mas reformulados pra virar uma pergunta que dá pra responder sim/não sem
// pedir mais dado. Máximo 3 (mesmo limite do curso — mais que isso vira lista de tarefa, não relatório).
function calcularDecisoesPendentes(fechamento, lancamentosMes) {
  const decisoes = [];

  const concentracaoFornecedor = calcularConcentracao(lancamentosMes, 'saida', fechamento.saidas);
  if (concentracaoFornecedor && concentracaoFornecedor.percentual > 20) {
    decisoes.push({ prioridade: concentracaoFornecedor.percentual, texto: `Manter o fornecedor "${concentracaoFornecedor.nome}" concentrando ${concentracaoFornecedor.percentual.toFixed(0)}% da despesa do mês, ou buscar outro fornecedor pra diluir o risco?` });
  }

  const concentracaoCliente = calcularConcentracao(lancamentosMes, 'entrada', fechamento.entradas);
  if (concentracaoCliente && concentracaoCliente.percentual > 30) {
    decisoes.push({ prioridade: concentracaoCliente.percentual, texto: `A receita depende ${concentracaoCliente.percentual.toFixed(0)}% de "${concentracaoCliente.nome}" — vale priorizar captar novos clientes esse mês pra diluir esse risco?` });
  }

  if (fechamento.resultado < 0) {
    decisoes.push({ prioridade: 1000, texto: `O mês fechou negativo em ${formatarMoeda(Math.abs(fechamento.resultado))} — cortar despesa já no próximo mês, ou é esperado e vai reverter sozinho?` });
  }

  if (fechamento.orcadoVsRealizado && fechamento.orcadoVsRealizado.maioresVariacoes.length > 0) {
    const pior = fechamento.orcadoVsRealizado.maioresVariacoes[0];
    if (pior.status === 'Acima do orçado') {
      decisoes.push({ prioridade: Math.abs(pior.variacaoPercentual || 0) + 200, texto: `Manter "${pior.rotulo}" no ritmo atual (${formatarMoeda(pior.realizado)}, ${pior.variacaoPercentual.toFixed(0)}% acima do orçado de ${formatarMoeda(pior.orcado)}), ou revisar o orçamento dessa categoria?` });
    }
  }

  if (fechamento.saldoFinalExtrato !== null && fechamento.saidas > 0 && fechamento.saldoFinalExtrato < fechamento.saidas) {
    decisoes.push({ prioridade: 500, texto: `Caixa está abaixo de 1 mês de despesa — segurar qualquer investimento/retirada até recompor a reserva?` });
  }

  return decisoes.sort((a, b) => b.prioridade - a.prioridade).slice(0, 3).map((d) => d.texto);
}

// Checklist de 15 etapas de fechamento (09/09/2026, mesmo inspirado no curso) — cada etapa usa dado
// que já está na planilha/no fechamento calculado; "Sem dado" quando o Pocket não tem como saber
// (ex.: depreciação/provisões não são rastreadas hoje) em vez de supor "Feito".
function gerarChecklistFechamento(fechamento, contasAPagarMes, contasAReceberMes) {
  const SEM_DADO = 'Sem dado';
  const FEITO = 'Feito';
  const PENDENTE = 'Pendente';

  return [
    { numero: 1, etapa: 'Extrato bancário do mês completo e conferido', status: fechamento.qtdTransacoesExtrato > 0 ? FEITO : SEM_DADO },
    { numero: 2, etapa: 'Conciliação bancária fechada', status: fechamento.qtdTransacoesExtrato === 0 ? SEM_DADO : (fechamento.pctConciliado >= 95 ? FEITO : PENDENTE) },
    { numero: 3, etapa: 'Pendências do extrato lançadas no razão', status: fechamento.somenteNoExtrato === 0 ? FEITO : PENDENTE },
    { numero: 4, etapa: 'Contas a pagar do mês todas registradas', status: contasAPagarMes && contasAPagarMes.length > 0 ? FEITO : SEM_DADO },
    { numero: 5, etapa: 'Contas a receber do mês todas registradas', status: contasAReceberMes && contasAReceberMes.length > 0 ? FEITO : SEM_DADO },
    { numero: 6, etapa: 'Recebimentos sem baixa identificados', status: fechamento.pendentesComprovante.length === 0 ? FEITO : PENDENTE },
    { numero: 7, etapa: 'Despesas classificadas por categoria', status: fechamento.qtdLancamentos > 0 ? FEITO : SEM_DADO },
    { numero: 8, etapa: 'Folha e encargos lançados', status: fechamento.dre.despesasOperacionais.pessoal.total > 0 ? FEITO : SEM_DADO },
    { numero: 9, etapa: 'Impostos do período apurados', status: fechamento.dre.deducoes.total > 0 ? FEITO : SEM_DADO },
    { numero: 10, etapa: 'Depreciação e provisões', status: SEM_DADO }, // o Pocket não rastreia isso hoje
    { numero: 11, etapa: 'DRE gerencial montada', status: FEITO },
    { numero: 12, etapa: 'Fluxo de caixa do mês fechado', status: FEITO },
    { numero: 13, etapa: 'Comparativo orçado vs realizado', status: fechamento.orcadoVsRealizado ? FEITO : SEM_DADO },
    { numero: 14, etapa: 'Variações relevantes explicadas', status: fechamento.pontosDeAtencao && fechamento.pontosDeAtencao.length > 0 ? FEITO : (fechamento.pctConciliado >= 95 && fechamento.resultado >= 0 ? FEITO : PENDENTE) },
    { numero: 15, etapa: 'Relatório para a diretoria emitido', status: PENDENTE }, // vira Feito quando o cliente pede o relatório executivo (ver item 06)
  ];
}

// Fechamento mensal de UMA competência (02/09/2026) — dispara quando o cliente pede "fechar o
// mês X" (ver server.js). Diferente do "resumo": olha só o mês-calendário da competência, casa
// TUDO daquele mês com o extrato, e devolve os números que vão pro PDF (fechamento.js) e pras
// abas de controle (Fechamento no cliente, Fechamentos na mestre).
function gerarFechamento(lancamentos, extrato, contasAPagar, opcoes = {}) {
  const competencia = opcoes.competencia || new Date().toISOString().slice(0, 7);
  const [ano, mes] = competencia.split('-').map(Number);
  const inicio = new Date(ano, mes - 1, 1);
  const fim = new Date(ano, mes, 0, 23, 59, 59);

  const lancamentosMes = filtrarPorPeriodo(lancamentos, 'data', inicio, fim);
  const extratoMes = filtrarPorPeriodo(extrato, 'data', inicio, fim);

  const totais = calcularTotais(lancamentosMes, 'tipo_movimentacao');
  const topCategorias = calcularTopCategorias(lancamentosMes, 5);

  // Comparação com o mês anterior (04/09/2026, pedido do Aroldo — "relatório final" mais
  // executivo). Só entra se houver algum lançamento no mês anterior; senão fica null (1º mês do
  // cliente, ou mês anterior nunca fechado/enviado).
  const inicioAnterior = new Date(ano, mes - 2, 1);
  const fimAnterior = new Date(ano, mes - 1, 0, 23, 59, 59);
  const lancamentosMesAnterior = filtrarPorPeriodo(lancamentos, 'data', inicioAnterior, fimAnterior);
  let comparacaoMesAnterior = null;
  if (lancamentosMesAnterior.length > 0) {
    const totaisAnteriores = calcularTotais(lancamentosMesAnterior, 'tipo_movimentacao');
    const diferenca = totais.resultado - totaisAnteriores.resultado;
    comparacaoMesAnterior = {
      competenciaAnterior: `${inicioAnterior.getFullYear()}-${String(inicioAnterior.getMonth() + 1).padStart(2, '0')}`,
      entradas: totaisAnteriores.entradas,
      saidas: totaisAnteriores.saidas,
      resultado: totaisAnteriores.resultado,
      diferenca,
      percentual: totaisAnteriores.resultado !== 0 ? (diferenca / Math.abs(totaisAnteriores.resultado)) * 100 : null,
    };
  }

  const { conciliados, somenteNoExtrato, somenteNosComprovantes, agrupamentosPorTransacao, agrupamentosPorComprovante } = reconciliar(lancamentosMes, extratoMes);
  const qtdAgrupamentos = agrupamentosPorTransacao.length + agrupamentosPorComprovante.length;
  const totalConciliavel = conciliados.length + qtdAgrupamentos + somenteNosComprovantes.length;
  const pctConciliado = totalConciliavel > 0 ? Math.round(((conciliados.length + qtdAgrupamentos) / totalConciliavel) * 100) : 0;
  const provaDosSaldos = calcularProvaDosSaldos(extratoMes);

  const pendentesComprovante = lancamentosMes.filter((l) => l.status_conciliacao === 'PENDENTE_COMPROVANTE');
  const pendentesDuvida = lancamentosMes.filter((l) => l.status_conciliacao === 'PENDENTE_DUVIDA');
  const transferencias = lancamentosMes.filter((l) => l.grupo_dre === 'transferencia_entre_contas');

  const dre = gerarDRE(lancamentos, { periodo: 'mes', referencia: fim });

  const extratoComSaldo = extratoMes.filter((t) => t.saldo_apos !== null && t.saldo_apos !== undefined && t.data);
  const saldoFinalExtrato = extratoComSaldo.length
    ? extratoComSaldo.reduce((maisRecente, t) => (t.data >= maisRecente.data ? t : maisRecente)).saldo_apos
    : null;

  // contasAPagar/opcoes.contasAReceber (09/09/2026) — usados só pro checklist (etapas 4/5); o
  // resto do fechamento não depende deles, então continuam opcionais (default []) sem quebrar quem
  // já chamava gerarFechamento sem essa informação.
  const contasAPagarMes = filtrarPorPeriodo(contasAPagar || [], 'vencimento', inicio, fim);
  const contasAReceberMes = filtrarPorPeriodo(opcoes.contasAReceber || [], 'vencimento', inicio, fim);

  // Orçado vs realizado (09/09/2026) — só existe se o cliente já cadastrou orçamento pra essa
  // competência (opcoes.orcamento); senão fica null e o fechamento não muda em nada.
  const orcamentoDaCompetencia = (opcoes.orcamento || []).filter((o) => o.competencia === competencia);
  const orcadoVsRealizado = compararOrcadoRealizado(dre.totalPorChave, orcamentoDaCompetencia);

  const fechamentoParcial = {
    competencia,
    inicio,
    fim,
    entradas: totais.entradas,
    saidas: totais.saidas,
    resultado: totais.resultado,
    qtdLancamentos: lancamentosMes.length,
    qtdTransacoesExtrato: extratoMes.length,
    pctConciliado,
    conciliados: conciliados.length,
    qtdAgrupamentos,
    naoConciliados: somenteNosComprovantes.length,
    somenteNoExtrato: somenteNoExtrato.length,
    pendentesComprovante,
    pendentesDuvida,
    transferencias,
    saldoFinalExtrato,
    provaDosSaldos,
    topCategorias,
    comparacaoMesAnterior,
    orcadoVsRealizado,
    dre,
  };

  // Pontos de atenção e checklist (09/09/2026) usam o fechamento já quase pronto — calculados por
  // último, anexados ao mesmo objeto (aditivo, nenhum campo existente muda).
  fechamentoParcial.pontosDeAtencao = calcularPontosDeAtencao(fechamentoParcial, lancamentosMes);
  fechamentoParcial.decisoesPendentes = calcularDecisoesPendentes(fechamentoParcial, lancamentosMes);
  fechamentoParcial.checklist = gerarChecklistFechamento(fechamentoParcial, contasAPagarMes, contasAReceberMes);

  return fechamentoParcial;
}

module.exports = {
  reconciliar,
  sincronizarConciliacao,
  encontrarTransacoesOrfas,
  gerarResumo,
  gerarFechamento,
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
  compararOrcadoRealizado,
  calcularPontosDeAtencao,
  calcularDecisoesPendentes,
  gerarChecklistFechamento,
  calcularProvaDosSaldos,
  detectarRecorrenciaAutomatica,
  alertasSazonalidade,
  projetarFluxoSemanal,
  formatarProjecaoSemanal,
};
