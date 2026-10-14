// DRE anual no padrão OMIE (14/10/2026, pedido do Aroldo: "igual à DRE da FIC... seguir padrão
// OMIE"). Mesma hierarquia da DRE de julho/2026 da FIC (Tipo > Grupo > Conta do DRE > Categoria,
// uma coluna por mês + total), com o bloco de indicadores da planilha automatizada da FIC (Receita
// Líquida, Margem de Contribuição, EBITDA, Resultado Financeiro, Lucro Líquido) logo abaixo.
//
// Os números saem SEMPRE de gerarDRE (reconciliacao.js), mês a mês — a mesma conta da DRE que o
// cliente recebe no WhatsApp e no PDF de fechamento. Este módulo só reorganiza o resultado no
// layout OMIE; nunca recalcula nada por conta própria, pra os três lugares nunca divergirem.
// Valores com sinal, como no OMIE: receita positiva, dedução/custo/despesa negativa — a soma de
// todas as linhas de categoria é o Lucro Líquido ("Total geral").

const { GRUPOS_DRE } = require('./dre');
const { gerarDRE } = require('./reconciliacao');
const { getSheetsClient, obterSheetIdNumerico } = require('./sheets');

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

// Bloco do dre.js -> posição na árvore OMIE. `sinal` converte o valor (sempre positivo no
// gerarDRE) pro sinal de apresentação.
const ESTRUTURA = [
  { tipo: '1. Lucro Bruto', grupo: '01. Receita Líquida Operacional', conta: '01. Receita Bruta de Vendas', bloco: 'RECEITA_BRUTA', sinal: 1 },
  { tipo: '1. Lucro Bruto', grupo: '01. Receita Líquida Operacional', conta: '03. Deduções de Receita', bloco: 'DEDUCOES', sinal: -1 },
  { tipo: '1. Lucro Bruto', grupo: '11. Receita Líquida Indireta', conta: '01. Outras Receitas', especial: 'outrasReceitas', sinal: 1 },
  { tipo: '1. Lucro Bruto', grupo: '11. Receita Líquida Indireta', conta: '02. Receitas Financeiras', chaves: ['financeiro_rendimentos'], sinal: 1 },
  { tipo: '1. Lucro Bruto', grupo: '21. Custos', conta: '02. Custo dos Produtos e Serviços', bloco: 'CUSTOS', sinal: -1 },
  { tipo: '2. Despesas', grupo: '01. Variáveis', conta: '01. Despesas Variáveis (Vendas e Logística)', bloco: 'DESPESAS_VENDAS', sinal: -1 },
  { tipo: '2. Despesas', grupo: '11. Fixas', conta: '01. Despesas com Pessoal', bloco: 'DESPESAS_PESSOAL', sinal: -1 },
  { tipo: '2. Despesas', grupo: '11. Fixas', conta: '02. Despesas Administrativas', bloco: 'DESPESAS_ADMIN', especial: 'outrasDespesas', sinal: -1 },
  { tipo: '2. Despesas', grupo: '11. Fixas', conta: '03. Despesas Financeiras', chaves: ['financeiro_tarifas', 'financeiro_juros_emprestimos', 'financeiro_multas_atraso'], sinal: -1 },
];

const ROTULO_ESPECIAL = {
  outrasReceitas: 'Outras Receitas (Não Classificado — revisar)',
  outrasDespesas: 'Outras Despesas (Não Classificado — revisar)',
};

function chavesDoNo(no) {
  if (no.chaves) return no.chaves;
  if (no.bloco) return GRUPOS_DRE.filter((g) => g.bloco === no.bloco).map((g) => g.chave);
  return [];
}

function valorEspecial(dre, especial) {
  if (especial === 'outrasReceitas') return dre.receitaBruta.outrasReceitas || 0;
  if (especial === 'outrasDespesas') return dre.despesasOperacionais.administrativas.outrasDespesas || 0;
  return 0;
}

function arred(v) {
  return Math.round((v || 0) * 100) / 100;
}

// Monta a DRE do ano inteiro. Mês futuro fica null (coluna vazia, não zero — "ainda não aconteceu"
// é diferente de "aconteceu e deu zero"). Mês corrente vai até hoje.
function montarDreAnual(lancamentos, ano = new Date().getFullYear(), hoje = new Date()) {
  const porMes = MESES.map((_, m) => {
    const inicioMes = new Date(ano, m, 1);
    if (inicioMes > hoje) return null;
    const referencia = new Date(ano, m + 1, 0); // último dia do mês, 00:00 — paraData() também usa 00:00
    return gerarDRE(lancamentos, { periodo: 'mes', referencia });
  });

  const linhas = [];
  for (const no of ESTRUTURA) {
    const categorias = chavesDoNo(no).map((chave) => ({
      categoria: GRUPOS_DRE.find((g) => g.chave === chave).rotulo,
      valores: porMes.map((dre) => (dre ? arred(no.sinal * (dre.totalPorChave[chave] || 0)) : null)),
    }));
    if (no.especial) {
      categorias.push({
        categoria: ROTULO_ESPECIAL[no.especial],
        valores: porMes.map((dre) => (dre ? arred(no.sinal * valorEspecial(dre, no.especial)) : null)),
      });
    }
    for (const c of categorias) {
      const total = arred(c.valores.reduce((s, v) => s + (v || 0), 0));
      if (c.valores.some((v) => v)) linhas.push({ tipo: no.tipo, grupo: no.grupo, conta: no.conta, categoria: c.categoria, valores: c.valores, total });
    }
  }

  const serie = (fn) => {
    const valores = porMes.map((dre) => (dre ? arred(fn(dre)) : null));
    return { valores, total: arred(valores.reduce((s, v) => s + (v || 0), 0)) };
  };

  // Indicadores no formato da planilha automatizada da FIC (06_FecharMesNovo.gs). Margem de
  // Contribuição = Receita Líquida − Custos (CMV/CPV/CSP), igual à FIC; Despesas Operacionais =
  // pessoal + administrativas + vendas; financeiro à parte.
  const indicadores = [
    { rotulo: '(+) Receita Bruta de Vendas/Serviços', ...serie((d) => d.receitaBruta.total - (d.receitaBruta.outrasReceitas || 0)) },
    { rotulo: '(+) Outras Receitas Operacionais', ...serie((d) => d.receitaBruta.outrasReceitas || 0) },
    { rotulo: '(-) Deduções e Impostos', ...serie((d) => -d.deducoes.total) },
    { rotulo: '(=) RECEITA LÍQUIDA', destaque: true, ...serie((d) => d.receitaLiquida) },
    { rotulo: '(-) Custos Variáveis / CPV / CMV', ...serie((d) => -d.custos.total) },
    { rotulo: '(=) MARGEM DE CONTRIBUIÇÃO', destaque: true, ...serie((d) => d.lucroBruto) },
    { rotulo: '(-) Despesas Operacionais', ...serie((d) => -d.despesasOperacionais.total) },
    { rotulo: '(=) RESULTADO OPERACIONAL (EBITDA)', destaque: true, ...serie((d) => d.resultadoOperacional) },
    { rotulo: '(+) Receitas Financeiras', ...serie((d) => d.financeiro.rendimentos) },
    { rotulo: '(-) Despesas Financeiras', ...serie((d) => -(d.financeiro.tarifas + d.financeiro.jurosEmprestimos + d.financeiro.multasAtraso)) },
    { rotulo: '(=) Resultado Financeiro', destaque: true, ...serie((d) => d.financeiro.total) },
    { rotulo: '(=) LUCRO / PREJUÍZO LÍQUIDO DO PERÍODO', destaque: true, ...serie((d) => d.lucroLiquido) },
  ];

  const receitaLiquida = indicadores[3];
  const lucro = indicadores[11];
  const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);
  const margemLiquida = {
    valores: receitaLiquida.valores.map((rl, i) => (rl === null ? null : pct(lucro.valores[i], rl))),
    total: pct(lucro.total, receitaLiquida.total),
  };

  const mesesComDado = porMes.map((d) => d !== null);
  return { ano, meses: MESES, mesesComDado, linhas, totalGeral: lucro, indicadores, margemLiquida };
}

// ---------------------------------------------------------------------------------------------
// Aba "DRE <ano>" na planilha do cliente — sobrescrita inteira a cada atualização (é relatório
// gerado, não lugar de digitar). Protegida contra edição pelo cliente.
// ---------------------------------------------------------------------------------------------

function nomeAbaDre(ano) {
  return `DRE ${ano}`;
}

const COR_TITULO = { red: 0.12, green: 0.22, blue: 0.39 }; // #1F3864 (FIC)
const COR_CABECALHO = { red: 0.12, green: 0.22, blue: 0.39 };
const COR_DESTAQUE = { red: 0.85, green: 0.89, blue: 0.95 }; // #D9E2F3 (FIC)
const BRANCO = { red: 1, green: 1, blue: 1 };
const FORMATO_MOEDA = { type: 'NUMBER', pattern: '#,##0.00;[RED]-#,##0.00' };

async function escreverAbaDre(spreadsheetId, dreAnual, nomeCliente) {
  const sheets = getSheetsClient();
  const nomeAba = nomeAbaDre(dreAnual.ano);

  let sheetId = await obterSheetIdNumerico(sheets, spreadsheetId, nomeAba).catch(() => null);
  if (sheetId === null || sheetId === undefined) {
    const criada = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: nomeAba, index: 0, tabColor: COR_TITULO, gridProperties: { frozenRowCount: 5, frozenColumnCount: 4 } } } }] },
    });
    sheetId = criada.data.replies[0].addSheet.properties.sheetId;
  }

  const nCols = 4 + 12 + 1; // Tipo, Grupo, Conta, Categoria + 12 meses + Total
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const cel = (v) => (v === null || v === undefined ? '' : v);

  const valores = [];
  valores.push([`DRE ${dreAnual.ano} — ${nomeCliente || ''}`.trim()]);
  valores.push([`Demonstração do Resultado do Exercício (gerencial, regime de caixa) · padrão OMIE · atualizado automaticamente pelo Interali Pocket em ${agora}`]);
  valores.push([]);
  valores.push(['', '', '', '', ...dreAnual.meses.map(() => String(dreAnual.ano)), '']);
  valores.push(['Tipo', 'Grupo', 'Conta do DRE', 'Categoria', ...dreAnual.meses, 'Total']);

  const linhaInicioCorpo = valores.length; // índice 0-based
  let anterior = {};
  for (const l of dreAnual.linhas) {
    valores.push([
      l.tipo !== anterior.tipo ? l.tipo : '',
      l.grupo !== anterior.grupo || l.tipo !== anterior.tipo ? l.grupo : '',
      l.conta !== anterior.conta || l.grupo !== anterior.grupo ? l.conta : '',
      l.categoria,
      ...l.valores.map(cel),
      l.total,
    ]);
    anterior = l;
  }
  if (!dreAnual.linhas.length) valores.push(['', '', '', 'Ainda não há lançamentos categorizados neste ano.']);
  const linhaTotalGeral = valores.length;
  valores.push(['Total geral', '', '', '', ...dreAnual.totalGeral.valores.map(cel), dreAnual.totalGeral.total]);

  valores.push([]);
  valores.push([]);
  const linhaTituloIndicadores = valores.length;
  valores.push(['INDICADORES DO RESULTADO']);
  const linhaCabIndicadores = valores.length;
  valores.push(['Linha do DRE', '', '', '', ...dreAnual.meses, 'Total Ano']);
  const linhaInicioInd = valores.length;
  for (const ind of dreAnual.indicadores) {
    valores.push([ind.rotulo, '', '', '', ...ind.valores.map(cel), ind.total]);
  }
  const linhaMargem = valores.length;
  valores.push(['Margem Líquida (% da Receita Líquida)', '', '', '',
    ...dreAnual.margemLiquida.valores.map((v) => (v === null ? '' : v / 100)),
    dreAnual.margemLiquida.total === null ? '' : dreAnual.margemLiquida.total / 100]);

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${nomeAba}'` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${nomeAba}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: valores },
  });

  const faixa = (r0, r1, c0, c1) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
  const formatar = (range, userEnteredFormat, fields) => ({ repeatCell: { range, cell: { userEnteredFormat }, fields } });
  const cabecalho = { backgroundColor: COR_CABECALHO, textFormat: { bold: true, foregroundColor: BRANCO }, horizontalAlignment: 'CENTER' };

  const requests = [
    // Zera formatação antiga (a aba é reescrita inteira a cada atualização)
    formatar(faixa(0, 1000, 0, nCols + 2), {}, 'userEnteredFormat'),
    formatar(faixa(0, 1, 0, 1), { textFormat: { bold: true, fontSize: 14, foregroundColor: COR_TITULO } }, 'userEnteredFormat.textFormat'),
    formatar(faixa(1, 2, 0, 1), { textFormat: { italic: true, fontSize: 9, foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 } } }, 'userEnteredFormat.textFormat'),
    formatar(faixa(3, 4, 4, nCols), { textFormat: { bold: true, foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 } }, horizontalAlignment: 'CENTER' }, 'userEnteredFormat(textFormat,horizontalAlignment)'),
    formatar(faixa(4, 5, 0, nCols), cabecalho, 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'),
    formatar(faixa(linhaInicioCorpo, linhaTotalGeral + 1, 4, nCols), { numberFormat: FORMATO_MOEDA }, 'userEnteredFormat.numberFormat'),
    formatar(faixa(linhaInicioCorpo, linhaTotalGeral, 0, 3), { textFormat: { bold: true } }, 'userEnteredFormat.textFormat'),
    formatar(faixa(linhaTotalGeral, linhaTotalGeral + 1, 0, nCols), { backgroundColor: COR_DESTAQUE, textFormat: { bold: true } }, 'userEnteredFormat(backgroundColor,textFormat)'),
    formatar(faixa(linhaInicioCorpo, linhaTotalGeral + 1, nCols - 1, nCols), { textFormat: { bold: true } }, 'userEnteredFormat.textFormat'),
    formatar(faixa(linhaTituloIndicadores, linhaTituloIndicadores + 1, 0, 1), { textFormat: { bold: true, fontSize: 12, foregroundColor: COR_TITULO } }, 'userEnteredFormat.textFormat'),
    formatar(faixa(linhaCabIndicadores, linhaCabIndicadores + 1, 0, nCols), cabecalho, 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'),
    formatar(faixa(linhaInicioInd, linhaMargem, 4, nCols), { numberFormat: FORMATO_MOEDA }, 'userEnteredFormat.numberFormat'),
    formatar(faixa(linhaMargem, linhaMargem + 1, 4, nCols), { numberFormat: { type: 'PERCENT', pattern: '0.0%' }, textFormat: { italic: true } }, 'userEnteredFormat(numberFormat,textFormat)'),
    formatar(faixa(linhaMargem, linhaMargem + 1, 0, 1), { textFormat: { italic: true } }, 'userEnteredFormat.textFormat'),
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 3 }, properties: { pixelSize: 200 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 }, properties: { pixelSize: 360 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 4, endIndex: nCols }, properties: { pixelSize: 105 }, fields: 'pixelSize' } },
    { updateSheetProperties: { properties: { sheetId, index: 0, gridProperties: { frozenRowCount: 5, frozenColumnCount: 4 } }, fields: 'index,gridProperties.frozenRowCount,gridProperties.frozenColumnCount' } },
  ];

  dreAnual.indicadores.forEach((ind, i) => {
    if (ind.destaque) {
      requests.push(formatar(faixa(linhaInicioInd + i, linhaInicioInd + i + 1, 0, nCols), { backgroundColor: COR_DESTAQUE, textFormat: { bold: true } }, 'userEnteredFormat(backgroundColor,textFormat)'));
    }
  });

  // Proteção: relatório gerado — só o Pocket (service account) escreve. Recria a cada vez pra não
  // acumular proteções duplicadas.
  const planilha = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId),protectedRanges(protectedRangeId,range(sheetId)))' });
  const daAba = planilha.data.sheets.find((s) => s.properties.sheetId === sheetId);
  (daAba && daAba.protectedRanges || []).forEach((p) => requests.push({ deleteProtectedRange: { protectedRangeId: p.protectedRangeId } }));
  requests.push({
    addProtectedRange: {
      protectedRange: {
        range: { sheetId },
        description: 'DRE gerada automaticamente pelo Interali Pocket — não editar à mão',
        editors: { users: [process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL].filter(Boolean) },
      },
    },
  });

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return nomeAba;
}

module.exports = { montarDreAnual, escreverAbaDre, nomeAbaDre, MESES };
