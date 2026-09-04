require('dotenv').config();
const PDFDocument = require('pdfkit');
const { getSheetsClient, garantirAbaComCabecalho, buscarLinhas } = require('./sheets');
const { formatarDRE } = require('./reconciliacao');

// 02/09/2026 — fechamento mensal disparado pelo cliente ("fechar agosto" / "fazer o fechamento do
// mês 08"). Calcula em reconciliacao.js (gerarFechamento); aqui: gera o PDF (pdfkit), o texto de
// resumo pro WhatsApp, e grava/lê as abas de controle:
//   - `Fechamento`  na planilha do CLIENTE  — 1 linha por competência, mais novo em cima
//   - `Fechamentos` na planilha MESTRE      — consolidado de todos os clientes

const ABA_FECHAMENTO_CLIENTE = 'Fechamento';
const CABECALHO_FECHAMENTO_CLIENTE = [
  'Competencia', 'Status', 'Data_Fechamento', 'Entradas', 'Saidas', 'Resultado',
  'Pct_Conciliado', 'Lancamentos', 'Transacoes_Extrato', 'Pendencias',
];

const ABA_FECHAMENTO_MESTRE = 'Fechamentos';
const CABECALHO_FECHAMENTO_MESTRE = [
  'Cliente', 'Numero', 'Competencia', 'Status', 'Data_Fechamento',
  'Entradas', 'Saidas', 'Resultado', 'Pct_Conciliado',
];

const MESES_ABREV = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function rotuloCompetencia(competencia) {
  const m = String(competencia || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return competencia || '';
  return `${MESES_ABREV[Number(m[2]) - 1]}/${m[1]}`;
}

function formatarMoeda(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// "fechar agosto", "fechar o mês 08", "fazer o fechamento de agosto/2026", "fechamento mês 8" ->
// competência "2026-08". Null quando a mensagem não é um comando de fechamento.
const MESES_NOME = {
  janeiro: 1, fevereiro: 2, marco: 3, 'março': 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

function interpretarComandoFechamento(texto) {
  const t = (texto || '').trim().toLowerCase();
  if (!t) return null;

  const agora = new Date();
  let ano = agora.getFullYear();
  let mes = null;

  const mAnoMes = t.match(/(\d{4})[-/](\d{1,2})/);
  const mMesAno = t.match(/\b(\d{1,2})[-/](\d{4})\b/);
  if (mAnoMes) { ano = Number(mAnoMes[1]); mes = Number(mAnoMes[2]); }
  else if (mMesAno) { mes = Number(mMesAno[1]); ano = Number(mMesAno[2]); }
  else {
    for (const [nome, num] of Object.entries(MESES_NOME)) {
      if (t.includes(nome)) { mes = num; break; }
    }
    if (mes === null) {
      const mNum = t.match(/m[êe]s\s+(\d{1,2})\b/) || t.match(/\bfechar\s+(\d{1,2})\b/);
      if (mNum) mes = Number(mNum[1]);
    }
    const mAno = t.match(/\b(20\d{2})\b/);
    if (mAno) ano = Number(mAno[1]);
  }

  // Gatilho: o VERBO "fechar" (fechar agosto / pode fechar o mês / fecha julho pra mim), OU o
  // substantivo "fechamento" JUNTO de um mês explícito ("fazer o fechamento do mês 08"). Só
  // "fechamento" / "resumo do fechamento" sem verbo nem mês NÃO dispara — cai na visão rápida
  // (rota "resumo"/"fechamento" no server.js), comportamento de sempre.
  const temVerboFechar = /\bfech(ar|a|e|ei)\b|\bfecha\s+(o\s+)?m[êe]s|encerrar\s+o?\s*m[êe]s/.test(t);
  const temFechamentoComMes = /fechamento/.test(t) && (mes !== null || /\bfazer o fechamento\b/.test(t));
  if (!temVerboFechar && !temFechamentoComMes) return null;

  // "fechar o mês" sem dizer qual -> mês anterior ao corrente (o caso normal: fecha-se o mês que
  // acabou de passar, já com os extratos em mãos).
  if (mes === null) {
    const anterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
    return `${anterior.getFullYear()}-${String(anterior.getMonth() + 1).padStart(2, '0')}`;
  }

  if (mes < 1 || mes > 12) return null;
  // Mês informado sem ano e ainda não chegou neste ano -> assume ano passado.
  if (!/(20\d{2})/.test(t) && mes > agora.getMonth() + 1) ano -= 1;
  return `${ano}-${String(mes).padStart(2, '0')}`;
}

function contarPendencias(fechamento) {
  return (fechamento.pendentesComprovante || []).length
    + (fechamento.pendentesDuvida || []).length
    + (fechamento.naoConciliados || 0)
    + (fechamento.somenteNoExtrato || 0);
}

// ---------------------------------------------------------------------------------------------
// ABAS DE CONTROLE
// ---------------------------------------------------------------------------------------------

// Upsert por competência + reescrita ordenada (mais novo em cima). Poucas linhas (~12/ano), então
// ler tudo + reescrever é seguro e simples.
async function registrarFechamentoCliente(sheetId, fechamento, status) {
  const sheets = getSheetsClient();
  await garantirAbaComCabecalho(sheets, sheetId, ABA_FECHAMENTO_CLIENTE, CABECALHO_FECHAMENTO_CLIENTE);

  const linhas = await buscarLinhas(sheetId, ABA_FECHAMENTO_CLIENTE, 'A2:J');
  const semEssa = linhas.filter((l) => (l[0] || '') !== fechamento.competencia);

  const nova = [
    fechamento.competencia,
    status,
    new Date().toISOString(),
    fechamento.entradas,
    fechamento.saidas,
    fechamento.resultado,
    `${fechamento.pctConciliado}%`,
    fechamento.qtdLancamentos,
    fechamento.qtdTransacoesExtrato,
    contarPendencias(fechamento),
  ];

  const todas = [nova, ...semEssa].sort((a, b) => String(b[0]).localeCompare(String(a[0])));

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${ABA_FECHAMENTO_CLIENTE}!A2:J${todas.length + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: todas },
  });
}

async function registrarFechamentoMestre(cliente, fechamento, status) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  if (!spreadsheetId) return;

  const sheets = getSheetsClient();
  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_FECHAMENTO_MESTRE, CABECALHO_FECHAMENTO_MESTRE);

  const numero = cliente.numeroWhatsapp || '';
  const linhas = await buscarLinhas(spreadsheetId, ABA_FECHAMENTO_MESTRE, 'A2:I');
  const semEssa = linhas.filter((l) => !((l[1] || '') === numero && (l[2] || '') === fechamento.competencia));

  const nova = [
    cliente.nome || '',
    numero,
    fechamento.competencia,
    status,
    new Date().toISOString(),
    fechamento.entradas,
    fechamento.saidas,
    fechamento.resultado,
    `${fechamento.pctConciliado}%`,
  ];

  const todas = [nova, ...semEssa].sort((a, b) => {
    if (a[2] !== b[2]) return String(b[2]).localeCompare(String(a[2])); // competência desc
    return String(a[0]).localeCompare(String(b[0]));
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ABA_FECHAMENTO_MESTRE}!A2:I${todas.length + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: todas },
  });
}

async function competenciaEstaFechada(cliente, competencia) {
  if (!cliente || !cliente.sheetId) return false;
  const linhas = await buscarLinhas(cliente.sheetId, ABA_FECHAMENTO_CLIENTE, 'A2:B');
  const linha = linhas.find((l) => (l[0] || '') === competencia);
  return !!linha && /^FECHADO/i.test(linha[1] || '');
}

// ---------------------------------------------------------------------------------------------
// TEXTO E PDF
// ---------------------------------------------------------------------------------------------

function formatarResumoFechamentoTexto(cliente, fechamento) {
  const linhas = [
    `📋 *Fechamento — ${rotuloCompetencia(fechamento.competencia)}*`,
    cliente && cliente.nome ? `Empresa: ${cliente.nome}` : '',
    '',
    `🟢 Entradas: ${formatarMoeda(fechamento.entradas)}`,
    `🔴 Saídas: ${formatarMoeda(fechamento.saidas)}`,
    `📈 Resultado do mês: ${formatarMoeda(fechamento.resultado)}`,
    '',
    `🔗 Conciliação: ${fechamento.pctConciliado}% (${fechamento.conciliados} de ${fechamento.conciliados + fechamento.naoConciliados})`,
    fechamento.saldoFinalExtrato !== null ? `💰 Saldo final no extrato: ${formatarMoeda(fechamento.saldoFinalExtrato)}` : '',
  ].filter(Boolean);

  if (fechamento.comparacaoMesAnterior) {
    const c = fechamento.comparacaoMesAnterior;
    const seta = c.diferenca >= 0 ? '📈' : '📉';
    const pct = c.percentual !== null ? ` (${c.percentual >= 0 ? '+' : ''}${c.percentual.toFixed(0)}%)` : '';
    linhas.push('', `${seta} *Vs. ${rotuloCompetencia(c.competenciaAnterior)}*: resultado ${c.diferenca >= 0 ? 'melhorou' : 'piorou'} ${formatarMoeda(Math.abs(c.diferenca))}${pct} (era ${formatarMoeda(c.resultado)}).`);
  }

  if (fechamento.topCategorias && fechamento.topCategorias.length) {
    linhas.push('', '🏷️ *Maiores gastos do mês:*');
    fechamento.topCategorias.forEach(([categoria, valor], i) => linhas.push(`   ${i + 1}. ${categoria} — ${formatarMoeda(valor)}`));
  }

  const pend = contarPendencias(fechamento);
  if (pend > 0) {
    linhas.push('', `⚠️ ${pend} pendência(s):`);
    if (fechamento.pendentesComprovante.length) linhas.push(`   • ${fechamento.pendentesComprovante.length} lançamento(s) sem comprovante`);
    if (fechamento.pendentesDuvida.length) linhas.push(`   • ${fechamento.pendentesDuvida.length} em dúvida de conciliação`);
    if (fechamento.naoConciliados) linhas.push(`   • ${fechamento.naoConciliados} comprovante(s) sem correspondência no extrato`);
    if (fechamento.somenteNoExtrato) linhas.push(`   • ${fechamento.somenteNoExtrato} transação(ões) do extrato sem comprovante`);
  }

  if (fechamento.transferencias.length) {
    const totalTransf = fechamento.transferencias.reduce((s, t) => s + (t.valor || 0), 0);
    linhas.push('', `↔️ ${fechamento.transferencias.length} transferência(s) entre contas (${formatarMoeda(totalTransf)}) — não entram no resultado.`);
  }

  linhas.push('', 'O PDF do fechamento vai em seguida. 📎');
  return linhas.join('\n');
}

// PDF de 1 página A4. pdfkit é JS puro (fontes AFM embutidas) — roda no Railway sem navegador.
function gerarPdfFechamento(cliente, fechamento) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(18).text('Fechamento Mensal', { align: 'left' });
      doc.moveDown(0.2);
      doc.fontSize(11).fillColor('#555')
        .text(`${cliente && cliente.nome ? cliente.nome + '  ·  ' : ''}Competência ${rotuloCompetencia(fechamento.competencia)}`)
        .text(`Gerado em ${new Date().toLocaleString('pt-BR')}`);
      doc.fillColor('#000').moveDown(1);

      const linha = (rotulo, valor, negrito) => {
        doc.font(negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(12);
        const y = doc.y;
        doc.text(rotulo, 50, y);
        doc.text(valor, 50, y, { align: 'right', width: doc.page.width - 100 });
        doc.moveDown(0.4);
      };

      linha('Entradas', formatarMoeda(fechamento.entradas));
      linha('Saídas', formatarMoeda(fechamento.saidas));
      linha('Resultado do mês', formatarMoeda(fechamento.resultado), true);
      doc.moveDown(0.5);
      linha('Lançamentos no mês', String(fechamento.qtdLancamentos));
      linha('Transações no extrato', String(fechamento.qtdTransacoesExtrato));
      linha('Conciliação', `${fechamento.pctConciliado}%`);
      if (fechamento.saldoFinalExtrato !== null) linha('Saldo final no extrato', formatarMoeda(fechamento.saldoFinalExtrato));

      if (fechamento.comparacaoMesAnterior) {
        const c = fechamento.comparacaoMesAnterior;
        doc.moveDown(0.8).font('Helvetica-Bold').fontSize(13).text(`Vs. ${rotuloCompetencia(c.competenciaAnterior)}`);
        doc.font('Helvetica').fontSize(11);
        const pct = c.percentual !== null ? ` (${c.percentual >= 0 ? '+' : ''}${c.percentual.toFixed(0)}%)` : '';
        doc.fillColor(c.diferenca >= 0 ? '#15803D' : '#B91C1C')
          .text(`Resultado ${c.diferenca >= 0 ? 'melhorou' : 'piorou'} ${formatarMoeda(Math.abs(c.diferenca))}${pct} — era ${formatarMoeda(c.resultado)}, agora ${formatarMoeda(fechamento.resultado)}.`)
          .fillColor('#000');
      }

      if (fechamento.topCategorias && fechamento.topCategorias.length) {
        doc.moveDown(0.8).font('Helvetica-Bold').fontSize(13).text('Maiores Gastos do Mês');
        doc.font('Helvetica').fontSize(11);
        fechamento.topCategorias.forEach(([categoria, valor], i) => linha(`${i + 1}. ${categoria}`, formatarMoeda(valor)));
      }

      const pend = contarPendencias(fechamento);
      doc.moveDown(0.8).font('Helvetica-Bold').fontSize(13).text('Pendências');
      doc.font('Helvetica').fontSize(11);
      if (pend === 0) {
        doc.text('Nenhuma — mês conciliado.');
      } else {
        if (fechamento.pendentesComprovante.length) doc.text(`• ${fechamento.pendentesComprovante.length} lançamento(s) sem comprovante`);
        if (fechamento.pendentesDuvida.length) doc.text(`• ${fechamento.pendentesDuvida.length} em dúvida de conciliação`);
        if (fechamento.naoConciliados) doc.text(`• ${fechamento.naoConciliados} comprovante(s) sem correspondência no extrato`);
        if (fechamento.somenteNoExtrato) doc.text(`• ${fechamento.somenteNoExtrato} transação(ões) do extrato sem comprovante`);
      }

      if (fechamento.transferencias.length) {
        const totalTransf = fechamento.transferencias.reduce((s, t) => s + (t.valor || 0), 0);
        doc.moveDown(0.5).fillColor('#555').text(`Transferências entre contas do mesmo titular: ${fechamento.transferencias.length} (${formatarMoeda(totalTransf)}) — não afetam o resultado.`).fillColor('#000');
      }

      // DRE resumida (texto monoespaçado, o mesmo formato do WhatsApp)
      const dreTexto = formatarDRE(fechamento.dre, cliente && cliente.nome).replace(/```/g, '').trim();
      doc.addPage();
      doc.font('Courier').fontSize(8).text(dreTexto, { width: doc.page.width - 100 });

      doc.end();
    } catch (erro) {
      reject(erro);
    }
  });
}

module.exports = {
  registrarFechamentoCliente,
  registrarFechamentoMestre,
  competenciaEstaFechada,
  gerarPdfFechamento,
  formatarResumoFechamentoTexto,
  interpretarComandoFechamento,
  rotuloCompetencia,
  ABA_FECHAMENTO_CLIENTE,
  ABA_FECHAMENTO_MESTRE,
};
