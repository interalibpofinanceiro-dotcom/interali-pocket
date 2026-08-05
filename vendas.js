require('dotenv').config();
const { google } = require('googleapis');

const ABA_VOUCHERS = 'Vouchers';
const CABECALHO_VOUCHERS = ['Codigo', 'Descricao', 'Usado', 'UsadoPor', 'UsadoEm', 'CriadoEm'];

const ABA_ASSINATURAS = 'Assinaturas';
const CABECALHO_ASSINATURAS = [
  'Nome', 'WhatsApp', 'Documento', 'Plano', 'Valor', 'Voucher', 'AsaasSubscriptionId', 'Status', 'ClienteSheetId', 'CriadoEm', 'PlanoEspecialista',
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
  } else if (resposta.data.values[0].length < cabecalho.length) {
    // Migração leve: aba já existia com menos colunas do que o cabeçalho atual prevê
    // (ex.: coluna nova adicionada depois que a aba já estava em uso).
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
async function registrarAssinatura({ nome, whatsapp, documento, plano, valor, voucher, asaasSubscriptionId, planoEspecialista }) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();
  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_ASSINATURAS, CABECALHO_ASSINATURAS);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_ASSINATURAS}!A:K`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        nome || '', whatsapp || '', documento || '', plano || '', valor || 0, voucher || '',
        asaasSubscriptionId || '', 'Aguardando pagamento', '', new Date().toISOString(),
        planoEspecialista ? 'TRUE' : 'FALSE',
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

  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_ASSINATURAS}!A2:K` });
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
    planoEspecialista: (linha[10] || '').toString().trim().toUpperCase() === 'TRUE',
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

// Localiza a assinatura ATIVA mais recente de um número — usado no upgrade do Especialista
// pedido depois (via WhatsApp), quando não temos o AsaasSubscriptionId à mão, só o número de
// quem está pedindo. Pega a última em vez da primeira porque pode haver histórico de
// assinaturas antigas/canceladas do mesmo número.
async function buscarAssinaturaAtivaPorWhatsapp(whatsapp) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();
  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_ASSINATURAS, CABECALHO_ASSINATURAS);

  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_ASSINATURAS}!A2:K` });
  const linhas = resposta.data.values || [];

  let ultimoIndice = -1;
  linhas.forEach((linha, i) => {
    if ((linha[1] || '').trim() === whatsapp && (linha[7] || '').trim() === 'Ativo') {
      ultimoIndice = i;
    }
  });

  if (ultimoIndice === -1) return null;

  const linha = linhas[ultimoIndice];
  return {
    numeroLinha: ultimoIndice + 2,
    nome: linha[0] || '',
    whatsapp: linha[1] || '',
    plano: linha[3] || '',
    valor: Number(linha[4]) || 0,
    asaasSubscriptionId: linha[6] || '',
    planoEspecialista: (linha[10] || '').toString().trim().toUpperCase() === 'TRUE',
  };
}

// Atualiza plano/valor/flag na linha da assinatura depois de um upgrade do Especialista
// processado via WhatsApp (fora do fluxo normal de checkout).
async function marcarEspecialistaNaAssinatura(numeroLinha, novoPlanoNome, novoValor) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ABA_ASSINATURAS}!D${numeroLinha}:E${numeroLinha}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[novoPlanoNome, novoValor]] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ABA_ASSINATURAS}!K${numeroLinha}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['TRUE']] },
  });
}

module.exports = {
  validarVoucher,
  queimarVoucher,
  criarVoucher,
  registrarAssinatura,
  buscarAssinaturaPorSubscription,
  ativarAssinatura,
  buscarAssinaturaAtivaPorWhatsapp,
  marcarEspecialistaNaAssinatura,
};
