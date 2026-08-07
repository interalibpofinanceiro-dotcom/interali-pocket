require('dotenv').config();
const { google } = require('googleapis');

const ABA_LANCAMENTOS = 'Lancamentos';
// Grupo_DRE, Conta_Bancaria e Status_Conciliacao foram ADICIONADAS no fim em 07/08/2026 (não
// inseridas no meio) de propósito — clientes que já tinham linhas gravadas com o cabeçalho antigo
// de 12 colunas continuam lendo certo, essas 3 colunas novas é que ficam em branco pra eles até o
// próximo lançamento/sincronização.
const CABECALHO_LANCAMENTOS = [
  'Data', 'Hora', 'Valor', 'Tipo', 'Descricao', 'Estabelecimento_Pessoa',
  'Documento', 'Forma_Pagamento', 'Categoria', 'Subcategoria', 'Observacoes', 'Registrado_Em',
  'Grupo_DRE', 'Conta_Bancaria', 'Status_Conciliacao',
];
const COLUNA_STATUS_CONCILIACAO = 'O'; // precisa bater com a posição de Status_Conciliacao acima (15ª coluna)

const ABA_EXTRATO = 'Extrato';
const CABECALHO_EXTRATO = ['Data', 'Descricao', 'Valor', 'Tipo', 'Saldo_Apos', 'Registrado_Em'];

const ABA_CONTAS_A_PAGAR = 'ContasAPagar';
// Grupo_DRE também adicionada no fim aqui, mesmo motivo do Lancamentos acima.
const CABECALHO_CONTAS_A_PAGAR = [
  'Vencimento', 'Valor', 'Cartao', 'Beneficiario', 'Descricao', 'Categoria', 'Parcela_Atual', 'Parcela_Total', 'Registrado_Em',
  'Grupo_DRE',
];

function getAuthClient() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuthClient() });
}

async function garantirAbaComCabecalho(sheets, spreadsheetId, nomeAba, cabecalho) {
  const planilha = await sheets.spreadsheets.get({ spreadsheetId });
  const abaExiste = planilha.data.sheets.some((aba) => aba.properties.title === nomeAba);

  if (!abaExiste) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: nomeAba } } }],
      },
    });
  }

  const ultimaColuna = String.fromCharCode('A'.charCodeAt(0) + cabecalho.length - 1);
  const resposta = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${nomeAba}!A1:${ultimaColuna}1`,
  });

  const cabecalhoAtual = (resposta.data.values && resposta.data.values[0]) || [];

  // Reescreve o cabeçalho quando a aba é nova (cabeçalho vazio) OU quando o cabeçalho já
  // existente é mais curto que o esperado — isso acontece pra clientes cadastrados antes de uma
  // coluna nova ser adicionada (ex.: Grupo_DRE/Status_Conciliacao, 07/08/2026). É seguro porque
  // `cabecalho` só ACRESCENTA colunas no fim, nunca reordena ou apaga as que já existem.
  if (cabecalhoAtual.length < cabecalho.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${nomeAba}!A1:${ultimaColuna}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [cabecalho] },
    });
  }
}

async function buscarLinhas(spreadsheetId, nomeAba, range) {
  const sheets = getSheetsClient();

  try {
    const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${nomeAba}!${range}` });
    return resposta.data.values || [];
  } catch (error) {
    if (error.code === 400 || error.code === 404) {
      return [];
    }
    throw error;
  }
}

async function salvarComprovante(spreadsheetId, dados) {
  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_LANCAMENTOS, CABECALHO_LANCAMENTOS);

  const linha = [
    dados.data || '',
    dados.hora || '',
    dados.valor || 0,
    dados.tipo_movimentacao || '',
    dados.descricao || '',
    dados.estabelecimento_ou_pessoa || '',
    dados.documento_identificacao || '',
    dados.forma_pagamento || '',
    dados.categoria || '',
    dados.subcategoria || '',
    dados.observacoes || '',
    new Date().toISOString(),
    dados.grupo_dre || '',
    dados.conta_bancaria || '',
    'Pendente', // status inicial — atualizado pra "Conciliado..." quando bater com o extrato (ver sincronizarConciliacao em reconciliacao.js)
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_LANCAMENTOS}!A:O`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [linha] },
  });
}

async function buscarTodosLancamentos(spreadsheetId) {
  const linhas = await buscarLinhas(spreadsheetId, ABA_LANCAMENTOS, 'A2:O');

  return linhas.map((linha, indice) => ({
    linha: indice + 2, // número real da linha na planilha (cabeçalho ocupa a 1) — usado pra reescrever só o Status_Conciliacao depois, sem tocar no resto
    data: linha[0] || '',
    hora: linha[1] || '',
    valor: Number(linha[2]) || 0,
    tipo_movimentacao: linha[3] || '',
    descricao: linha[4] || '',
    estabelecimento_ou_pessoa: linha[5] || '',
    documento_identificacao: linha[6] || '',
    forma_pagamento: linha[7] || '',
    categoria: linha[8] || '',
    subcategoria: linha[9] || '',
    observacoes: linha[10] || '',
    grupo_dre: linha[12] || '',
    conta_bancaria: linha[13] || '',
    status_conciliacao: linha[14] || '',
  }));
}

// Atualiza só a coluna Status_Conciliacao das linhas informadas, sem reescrever o resto do
// lançamento — chamada depois de rodar sincronizarConciliacao() (reconciliacao.js). Um único
// batchUpdate mesmo quando várias linhas mudam, pra não gastar uma chamada de API por linha.
async function atualizarStatusConciliacaoEmLote(spreadsheetId, atualizacoes) {
  if (!atualizacoes || atualizacoes.length === 0) return;

  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: atualizacoes.map(({ linha, status }) => ({
        range: `${ABA_LANCAMENTOS}!${COLUNA_STATUS_CONCILIACAO}${linha}`,
        values: [[status]],
      })),
    },
  });
}

async function salvarExtrato(spreadsheetId, transacoes) {
  if (!transacoes || transacoes.length === 0) {
    return;
  }

  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_EXTRATO, CABECALHO_EXTRATO);

  const registradoEm = new Date().toISOString();
  const linhas = transacoes.map((transacao) => [
    transacao.data || '',
    transacao.descricao || '',
    transacao.valor || 0,
    transacao.tipo || '',
    transacao.saldo_apos ?? '',
    registradoEm,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_EXTRATO}!A:F`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: linhas },
  });
}

async function buscarExtrato(spreadsheetId) {
  const linhas = await buscarLinhas(spreadsheetId, ABA_EXTRATO, 'A2:F');

  return linhas.map((linha) => ({
    data: linha[0] || '',
    descricao: linha[1] || '',
    valor: Number(linha[2]) || 0,
    tipo: linha[3] || '',
    saldo_apos: linha[4] ? Number(linha[4]) : null,
  }));
}

async function salvarContasAPagar(spreadsheetId, contas) {
  if (!contas || contas.length === 0) {
    return;
  }

  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_CONTAS_A_PAGAR, CABECALHO_CONTAS_A_PAGAR);

  const registradoEm = new Date().toISOString();
  const linhas = contas.map((conta) => [
    conta.vencimento || '',
    conta.valor || 0,
    conta.cartao || '',
    conta.beneficiario || '',
    conta.descricao || '',
    conta.categoria || '',
    conta.parcela_atual ?? '',
    conta.parcela_total ?? '',
    registradoEm,
    conta.grupo_dre || '',
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_CONTAS_A_PAGAR}!A:J`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: linhas },
  });
}

async function buscarContasAPagar(spreadsheetId) {
  const linhas = await buscarLinhas(spreadsheetId, ABA_CONTAS_A_PAGAR, 'A2:J');

  return linhas.map((linha) => ({
    vencimento: linha[0] || '',
    valor: Number(linha[1]) || 0,
    cartao: linha[2] || '',
    beneficiario: linha[3] || '',
    descricao: linha[4] || '',
    categoria: linha[5] || '',
    parcela_atual: linha[6] ? Number(linha[6]) : null,
    parcela_total: linha[7] ? Number(linha[7]) : null,
    grupo_dre: linha[9] || '',
  }));
}

module.exports = {
  salvarComprovante,
  buscarTodosLancamentos,
  atualizarStatusConciliacaoEmLote,
  salvarExtrato,
  buscarExtrato,
  salvarContasAPagar,
  buscarContasAPagar,
};
