require('dotenv').config();
const { google } = require('googleapis');

const ABA_LANCAMENTOS = 'Lancamentos';
const CABECALHO_LANCAMENTOS = [
  'Data', 'Hora', 'Valor', 'Tipo', 'Descricao', 'Estabelecimento_Pessoa',
  'Documento', 'Forma_Pagamento', 'Categoria', 'Subcategoria', 'Observacoes', 'Registrado_Em',
];

const ABA_EXTRATO = 'Extrato';
const CABECALHO_EXTRATO = ['Data', 'Descricao', 'Valor', 'Tipo', 'Saldo_Apos', 'Registrado_Em'];

const ABA_CONTAS_A_PAGAR = 'ContasAPagar';
const CABECALHO_CONTAS_A_PAGAR = [
  'Vencimento', 'Valor', 'Beneficiario', 'Descricao', 'Categoria', 'Parcela_Atual', 'Parcela_Total', 'Registrado_Em',
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

  if (!resposta.data.values || resposta.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${nomeAba}!A1:${ultimaColuna}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [cabecalho] },
    });
  }
}

async function buscarLinhas(nomeAba, range) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
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

async function salvarComprovante(dados) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
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
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_LANCAMENTOS}!A:L`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [linha] },
  });
}

async function buscarTodosLancamentos() {
  const linhas = await buscarLinhas(ABA_LANCAMENTOS, 'A2:L');

  return linhas.map((linha) => ({
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
  }));
}

async function salvarExtrato(transacoes) {
  if (!transacoes || transacoes.length === 0) {
    return;
  }

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
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

async function buscarExtrato() {
  const linhas = await buscarLinhas(ABA_EXTRATO, 'A2:F');

  return linhas.map((linha) => ({
    data: linha[0] || '',
    descricao: linha[1] || '',
    valor: Number(linha[2]) || 0,
    tipo: linha[3] || '',
    saldo_apos: linha[4] ? Number(linha[4]) : null,
  }));
}

async function salvarContasAPagar(contas) {
  if (!contas || contas.length === 0) {
    return;
  }

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_CONTAS_A_PAGAR, CABECALHO_CONTAS_A_PAGAR);

  const registradoEm = new Date().toISOString();
  const linhas = contas.map((conta) => [
    conta.vencimento || '',
    conta.valor || 0,
    conta.beneficiario || '',
    conta.descricao || '',
    conta.categoria || '',
    conta.parcela_atual ?? '',
    conta.parcela_total ?? '',
    registradoEm,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_CONTAS_A_PAGAR}!A:H`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: linhas },
  });
}

async function buscarContasAPagar() {
  const linhas = await buscarLinhas(ABA_CONTAS_A_PAGAR, 'A2:H');

  return linhas.map((linha) => ({
    vencimento: linha[0] || '',
    valor: Number(linha[1]) || 0,
    beneficiario: linha[2] || '',
    descricao: linha[3] || '',
    categoria: linha[4] || '',
    parcela_atual: linha[5] ? Number(linha[5]) : null,
    parcela_total: linha[6] ? Number(linha[6]) : null,
  }));
}

module.exports = {
  salvarComprovante,
  buscarTodosLancamentos,
  salvarExtrato,
  buscarExtrato,
  salvarContasAPagar,
  buscarContasAPagar,
};
