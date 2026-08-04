require('dotenv').config();
const { google } = require('googleapis');

const ABA_VOUCHERS = 'Vouchers';
const CABECALHO_VOUCHERS = ['Codigo', 'Descricao', 'Usado', 'UsadoPor', 'UsadoEm', 'CriadoEm'];

const ABA_ASSINATURAS = 'Assinaturas';
const CABECALHO_ASSINATURAS = [
  'Nome', 'WhatsApp', 'Documento', 'Plano', 'Valor', 'Voucher', 'AsaasSubscriptionId', 'Status', 'ClienteSheetId', 'CriadoEm',
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
      requestBody: { requests: [{ addSheet: { properties: { title: nomeAba } } }] },
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

// Retorna true se o código existir e ainda não tiver sido usado. Não faz distinção entre
// "não existe" e "já usado" pra quem chama — a mensagem de erro pro cliente é a mesma nos dois casos.
async function validarVoucher(codigo) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();
  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_VOUCHERS, CABECALHO_VOUCHERS);

  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_VOUCHERS}!A2:F` });
  const linhas = resposta.data.values || [];
  const alvo = (codigo || '').trim().toUpperCase();

  const linha = linhas.find((linha) => (linha[0] || '').trim().toUpperCase() === alvo);
  if (!linha) return false;

  const usado = (linha[2] || '').toString().trim().toUpperCase() === 'TRUE';
  return !usado;
}

// Marca o voucher como usado (soft — não apaga a linha, mantém rastro de quem usou e quando).
// Assume que validarVoucher() já confirmou que o código existe e está livre antes de chamar isso.
async function queimarVoucher(codigo, usadoPor) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();

  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_VOUCHERS}!A2:F` });
  const linhas = resposta.data.values || [];
  const alvo = (codigo || '').trim().toUpperCase();
  const indice = linhas.findIndex((linha) => (linha[0] || '').trim().toUpperCase() === alvo);

  if (indice === -1) return;

  const numeroLinha = indice + 2; // +2: a busca começou em A2, então índice 0 é a linha 2 da planilha

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ABA_VOUCHERS}!C${numeroLinha}:E${numeroLinha}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['TRUE', usadoPor || '', new Date().toISOString()]] },
  });
}

async function criarVoucher(codigo, descricao) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();
  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_VOUCHERS, CABECALHO_VOUCHERS);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_VOUCHERS}!A:F`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[(codigo || '').trim().toUpperCase(), descricao || '', 'FALSE', '', '', new Date().toISOString()]] },
  });
}

// Registra o pedido de assinatura vindo da landing page — não é o cliente ativo ainda.
// Ativação acontece sozinha quando o webhook do Asaas confirma o pagamento (ver ativarAssinatura).
async function registrarAssinatura({ nome, whatsapp, documento, plano, valor, voucher, asaasSubscriptionId }) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();
  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_ASSINATURAS, CABECALHO_ASSINATURAS);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_ASSINATURAS}!A:J`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        nome || '', whatsapp || '', documento || '', plano || '', valor || 0, voucher || '',
        asaasSubscriptionId || '', 'Aguardando pagamento', '', new Date().toISOString(),
      ]],
    },
  });
}

// Localiza a linha da assinatura pelo ID da assinatura no Asaas — é assim que o webhook
// de pagamento confirmado sabe qual pedido da landing page ele está confirmando.
async function buscarAssinaturaPorSubscription(asaasSubscriptionId) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();
  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_ASSINATURAS, CABECALHO_ASSINATURAS);

  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_ASSINATURAS}!A2:J` });
  const linhas = resposta.data.values || [];
  const indice = linhas.findIndex((linha) => (linha[6] || '').trim() === asaasSubscriptionId);

  if (indice === -1) return null;

  const linha = linhas[indice];
  return {
    numeroLinha: indice + 2, // +2: busca começou em A2
    nome: linha[0] || '',
    whatsapp: linha[1] || '',
    documento: linha[2] || '',
    plano: linha[3] || '',
    valor: Number(linha[4]) || 0,
    voucher: linha[5] || '',
    asaasSubscriptionId: linha[6] || '',
    status: linha[7] || '',
    clienteSheetId: linha[8] || '',
  };
}

// Marca a assinatura como ativada e guarda o ID da planilha individual criada pro cliente —
// idempotente por natureza (buscarAssinaturaPorSubscription reflete o status atual, e quem
// chama isso confere status antes, então reenvios do mesmo webhook não duplicam a ativação).
async function ativarAssinatura(numeroLinha, clienteSheetId) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ABA_ASSINATURAS}!H${numeroLinha}:I${numeroLinha}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Ativo', clienteSheetId]] },
  });
}

module.exports = {
  validarVoucher,
  queimarVoucher,
  criarVoucher,
  registrarAssinatura,
  buscarAssinaturaPorSubscription,
  ativarAssinatura,
};
