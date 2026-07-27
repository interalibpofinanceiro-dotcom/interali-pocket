require('dotenv').config();
const { google } = require('googleapis');

const ABA_CLIENTES = 'Clientes';
const CABECALHO_CLIENTES = ['Numero_WhatsApp', 'Nome_Cliente', 'Sheet_ID', 'Ativo'];

let cache = null;
let cacheExpiraEm = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

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

async function garantirAbaComCabecalho(sheets, spreadsheetId) {
  const planilha = await sheets.spreadsheets.get({ spreadsheetId });
  const abaExiste = planilha.data.sheets.some((aba) => aba.properties.title === ABA_CLIENTES);

  if (!abaExiste) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: ABA_CLIENTES } } }] },
    });
  }

  const resposta = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${ABA_CLIENTES}!A1:D1`,
  });

  if (!resposta.data.values || resposta.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${ABA_CLIENTES}!A1:D1`,
      valueInputOption: 'RAW',
      requestBody: { values: [CABECALHO_CLIENTES] },
    });
  }
}

async function carregarTodosClientes() {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId);

  const resposta = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${ABA_CLIENTES}!A2:D`,
  });

  const linhas = resposta.data.values || [];

  return linhas.map((linha) => ({
    numeroWhatsapp: (linha[0] || '').trim(),
    nome: linha[1] || '',
    sheetId: linha[2] || '',
    ativo: (linha[3] || '').toString().trim().toLowerCase() !== 'false',
  }));
}

async function listarClientesAtivos({ ignorarCache = false } = {}) {
  const agora = Date.now();
  if (!ignorarCache && cache && agora < cacheExpiraEm) {
    return cache;
  }

  const clientes = await carregarTodosClientes();
  cache = clientes;
  cacheExpiraEm = agora + CACHE_TTL_MS;
  return clientes;
}

async function buscarClientePorNumero(numeroWhatsapp) {
  const clientes = await listarClientesAtivos();
  const alvo = (numeroWhatsapp || '').trim();
  return clientes.find((cliente) => cliente.numeroWhatsapp === alvo && cliente.ativo) || null;
}

async function adicionarCliente(numeroWhatsapp, nome, sheetId) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_CLIENTES}!A:D`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[numeroWhatsapp, nome, sheetId, 'TRUE']] },
  });

  cache = null;
}

module.exports = {
  listarClientesAtivos,
  buscarClientePorNumero,
  adicionarCliente,
};
