require('dotenv').config();
const { google } = require('googleapis');

const ABA_CLIENTES = 'Clientes';
const CABECALHO_CLIENTES = ['Numero_WhatsApp', 'Nome_Cliente', 'Sheet_ID', 'Ativo', 'Plano_Especialista', 'LimiteLancamentos'];
const LIMITE_PADRAO = 300; // usado se um cliente antigo não tiver limite salvo (ex.: cadastro manual anterior a essa coluna existir)

let cache = null;
let cacheExpiraEm = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function getAuthClient() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
  );
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuthClient() });
}

function getDriveClient() {
  return google.drive({ version: 'v3', auth: getAuthClient() });
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
    range: `${ABA_CLIENTES}!A1:F1`,
  });

  if (!resposta.data.values || resposta.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${ABA_CLIENTES}!A1:F1`,
      valueInputOption: 'RAW',
      requestBody: { values: [CABECALHO_CLIENTES] },
    });
  } else if (resposta.data.values[0].length < CABECALHO_CLIENTES.length) {
    // Migração leve: planilha já existia com menos colunas do que o cabeçalho atual prevê.
    const ultimaColuna = String.fromCharCode('A'.charCodeAt(0) + CABECALHO_CLIENTES.length - 1);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${ABA_CLIENTES}!A1:${ultimaColuna}1`,
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
    range: `${ABA_CLIENTES}!A2:F`,
  });

  const linhas = resposta.data.values || [];

  return linhas.map((linha) => ({
    numeroWhatsapp: (linha[0] || '').trim(),
    nome: linha[1] || '',
    sheetId: linha[2] || '',
    ativo: (linha[3] || '').toString().trim().toLowerCase() !== 'false',
    planoEspecialista: (linha[4] || '').toString().trim().toUpperCase() === 'TRUE',
    limiteLancamentos: Number(linha[5]) || LIMITE_PADRAO,
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

// Números brasileiros de celular têm um 9º dígito extra que o WhatsApp às vezes omite
// no identificador da conversa, mesmo o número real tendo 9 dígitos. Gera as duas variantes
// (com e sem o 9) pra comparação não depender de qual formato exato foi usado no cadastro.
function candidatosNumero(numeroWhatsapp) {
  const match = (numeroWhatsapp || '').match(/^whatsapp:\+55(\d{2})(\d{8,9})$/);
  if (!match) return [numeroWhatsapp];

  const [, ddd, numero] = match;
  if (numero.length === 9 && numero[0] === '9') {
    return [numeroWhatsapp, `whatsapp:+55${ddd}${numero.slice(1)}`];
  }
  if (numero.length === 8) {
    return [numeroWhatsapp, `whatsapp:+55${ddd}9${numero}`];
  }
  return [numeroWhatsapp];
}

async function buscarClientePorNumero(numeroWhatsapp) {
  const clientes = await listarClientesAtivos();
  const alvo = (numeroWhatsapp || '').trim();
  const candidatos = candidatosNumero(alvo);
  return clientes.find((cliente) => candidatos.includes(cliente.numeroWhatsapp) && cliente.ativo) || null;
}

// Reserva a planilha individual do cliente a partir de um "estoque" de planilhas em branco
// pré-criadas na pasta CLIENTES (nomeadas "TEMPLATE-VAZIO" ou variações tipo "Cópia de
// TEMPLATE-VAZIO"), em vez de criar uma nova do zero. Necessário porque a conta de serviço
// não tem espaço próprio no Drive (0 bytes de quota — normal fora do Google Workspace) e,
// numa conta pessoal, isso vale mesmo pra arquivos criados dentro de uma pasta compartilhada
// (esse truque só funciona em Shared Drives do Workspace). Editar um arquivo que já existe,
// porém, funciona normalmente — é o que o resto do sistema já faz o tempo todo.
async function criarPlanilhaCliente(nomeCliente) {
  const pastaClientes = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!pastaClientes) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID não configurado — sem isso não dá pra localizar o estoque de planilhas em branco.');
  }

  const drive = getDriveClient();

  const disponiveis = await drive.files.list({
    q: `'${pastaClientes}' in parents and name contains 'TEMPLATE' and trashed = false`,
    fields: 'files(id,name)',
    orderBy: 'name',
    pageSize: 1,
  });

  const template = disponiveis.data.files && disponiveis.data.files[0];
  if (!template) {
    throw new Error('Estoque de planilhas em branco (TEMPLATE-VAZIO) na pasta CLIENTES está vazio. Crie mais cópias em branco lá antes de tentar de novo.');
  }

  await drive.files.update({
    fileId: template.id,
    requestBody: { name: `Interali Pocket — ${nomeCliente}` },
  });

  return template.id;
}

async function adicionarCliente(numeroWhatsapp, nome, sheetId, planoEspecialista = false, limiteLancamentos = LIMITE_PADRAO) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_CLIENTES}!A:F`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[numeroWhatsapp, nome, sheetId, 'TRUE', planoEspecialista ? 'TRUE' : 'FALSE', limiteLancamentos]] },
  });

  cache = null;
}

// Desativação por soft delete (marca Ativo=FALSE em vez de apagar a linha) — preserva o
// histórico de quem já foi cliente e evita reindexar linhas de outros clientes por engano.
async function desativarCliente(numeroWhatsapp) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId);

  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_CLIENTES}!A2:D` });
  const linhas = resposta.data.values || [];
  const alvo = (numeroWhatsapp || '').trim();
  const indice = linhas.findIndex((linha) => (linha[0] || '').trim() === alvo);

  if (indice === -1) return null;

  const nome = linhas[indice][1] || '';
  const numeroLinha = indice + 2; // +2: a busca começou em A2, então índice 0 é a linha 2 da planilha

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ABA_CLIENTES}!D${numeroLinha}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['FALSE']] },
  });

  cache = null;
  return { numeroWhatsapp: alvo, nome };
}

// Liga o Plano_Especialista de um cliente já ativo — usado quando o upgrade é pedido depois
// (via WhatsApp), não no checkout original.
async function ativarPlanoEspecialista(numeroWhatsapp) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId);

  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_CLIENTES}!A2:E` });
  const linhas = resposta.data.values || [];
  const alvo = (numeroWhatsapp || '').trim();
  const indice = linhas.findIndex((linha) => (linha[0] || '').trim() === alvo);

  if (indice === -1) return false;

  const numeroLinha = indice + 2;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ABA_CLIENTES}!E${numeroLinha}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['TRUE']] },
  });

  cache = null;
  return true;
}

module.exports = {
  listarClientesAtivos,
  buscarClientePorNumero,
  adicionarCliente,
  desativarCliente,
  criarPlanilhaCliente,
  ativarPlanoEspecialista,
};
