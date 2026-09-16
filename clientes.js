require('dotenv').config();
const { google } = require('googleapis');

const ABA_CLIENTES = 'Clientes';
// 'Tipo' adicionada no FIM em 23/08/2026 (mesmo padrão de sempre — nunca reordena as que já
// existem): perfil do cliente, hoje só usado pra ligar o módulo de Cupom Térmico + Matriz de
// Fornecedores (ver comercio-matriz.js) num cliente específico sem afetar os demais. Cliente
// antigo sem essa coluna preenchida cai em 'PADRAO' (ver carregarTodosClientes) — comportamento
// de hoje, sem mudança nenhuma.
// 'Senha_Hash' adicionada no FIM em 23/08/2026 (mesmo padrão — aditiva): senha do dashboard web
// do cliente (ver dashboard.js), guardada como "saltHex:hashHex" (scrypt, nunca texto puro).
// Cliente sem senha definida (célula vazia) simplesmente não consegue logar no dashboard ainda —
// não afeta em nada o funcionamento por WhatsApp.
// 'Pasta_Drive_ID' adicionada no FIM em 16/09/2026 (mesmo padrão — aditiva): ID da pasta do
// cliente dentro de GOOGLE_DRIVE_FOLDER_ID (ver documentos-grandes.js), criada sozinha na primeira
// vez que ele manda um extrato/fatura grande demais pra ler de uma vez. Célula vazia = pasta ainda
// não criada; garantirPastaCliente cria e preenche aqui pra nunca precisar recriar/duplicar.
const CABECALHO_CLIENTES = ['Numero_WhatsApp', 'Nome_Cliente', 'Sheet_ID', 'Ativo', 'Plano_Especialista', 'LimiteLancamentos', 'Tipo', 'Senha_Hash', 'Pasta_Drive_ID'];
const LIMITE_PADRAO = 300; // usado se um cliente antigo não tiver limite salvo (ex.: cadastro manual anterior a essa coluna existir)
const TIPO_PADRAO = 'PADRAO';

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
    range: `${ABA_CLIENTES}!A1:I1`,
  });

  if (!resposta.data.values || resposta.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${ABA_CLIENTES}!A1:I1`,
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
    range: `${ABA_CLIENTES}!A2:I`,
  });

  const linhas = resposta.data.values || [];

  return linhas.map((linha) => ({
    numeroWhatsapp: (linha[0] || '').trim(),
    nome: linha[1] || '',
    sheetId: linha[2] || '',
    ativo: (linha[3] || '').toString().trim().toLowerCase() !== 'false',
    planoEspecialista: (linha[4] || '').toString().trim().toUpperCase() === 'TRUE',
    limiteLancamentos: Number(linha[5]) || LIMITE_PADRAO,
    // Cliente antigo (linha sem a coluna G preenchida) cai em 'PADRAO' — comportamento de hoje,
    // ninguém muda de perfil sozinho só por essa coluna ter sido adicionada.
    tipo: (linha[6] || '').toString().trim().toUpperCase() || TIPO_PADRAO,
    // Vazio = ainda não tem senha de dashboard definida (ver definirSenhaDashboard).
    senhaHash: linha[7] || '',
    // Vazio = pasta ainda não criada no Drive (ver garantirPastaCliente em documentos-grandes.js).
    pastaDriveId: linha[8] || '',
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

// `tipo` (23/08/2026, opcional, default 'PADRAO') — perfil do cliente; hoje só 'PADRAO' ou
// 'COMERCIO_MATRIZ' têm efeito no código (ver comercio-matriz.js). Parâmetro novo no FIM da lista,
// então nenhuma chamada existente (cadastrar-cliente.js, checkout da landing page) precisa mudar.
async function adicionarCliente(numeroWhatsapp, nome, sheetId, planoEspecialista = false, limiteLancamentos = LIMITE_PADRAO, tipo = TIPO_PADRAO) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_CLIENTES}!A:G`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[numeroWhatsapp, nome, sheetId, 'TRUE', planoEspecialista ? 'TRUE' : 'FALSE', limiteLancamentos, tipo || TIPO_PADRAO]] },
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

// Define (ou troca) a senha do dashboard web de um cliente (23/08/2026) — mesmo padrão de
// desativarCliente/ativarPlanoEspecialista acima (acha a linha, escreve só a célula certa).
// Recebe o HASH já pronto (ver dashboard.js hashSenhaDashboard) — este módulo não sabe gerar hash
// sozinho, só grava/lê, pra não duplicar a lógica de criptografia em dois arquivos.
async function definirSenhaDashboard(numeroWhatsapp, senhaHash) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId);

  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_CLIENTES}!A2:A` });
  const linhas = resposta.data.values || [];
  const alvo = (numeroWhatsapp || '').trim();
  const indice = linhas.findIndex((linha) => (linha[0] || '').trim() === alvo);

  if (indice === -1) return false;

  const numeroLinha = indice + 2;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ABA_CLIENTES}!H${numeroLinha}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[senhaHash]] },
  });

  cache = null;
  return true;
}

// Grava o ID da pasta do cliente no Drive (16/09/2026, ver garantirPastaCliente em
// documentos-grandes.js) — mesmo padrão de definirSenhaDashboard (acha a linha pelo número, escreve
// só a célula certa). Chamada uma vez só, na primeira vez que a pasta é criada; nas próximas, o
// cliente já vem com pastaDriveId preenchido e a criação é pulada.
async function definirPastaDriveCliente(numeroWhatsapp, pastaDriveId) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId);

  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_CLIENTES}!A2:A` });
  const linhas = resposta.data.values || [];
  const alvo = (numeroWhatsapp || '').trim();
  const indice = linhas.findIndex((linha) => (linha[0] || '').trim() === alvo);

  if (indice === -1) return false;

  const numeroLinha = indice + 2;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ABA_CLIENTES}!I${numeroLinha}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[pastaDriveId]] },
  });

  cache = null;
  return true;
}

// Igual definirPastaDriveCliente, mas escreve em TODAS as linhas que apontam pro mesmo Sheet_ID
// (16/09/2026, achado ao criar as pastas: mais de um número/linha pode levar à MESMA planilha —
// ex.: Valmir Tomé + o número comercial "Valmir Tomé (Sirlene)", ou os vários números de teste do
// Aroldo — nesse caso a pasta no Drive também deve ser UMA SÓ, não uma por linha/número). Usada
// por garantirPastaCliente (documentos-grandes.js) pra manter todas as linhas de um mesmo cliente
// sempre apontando pra pasta certa, mesmo que a busca tenha sido disparada por só uma delas.
async function definirPastaDriveClientePorSheetId(sheetId, pastaDriveId) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId);

  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_CLIENTES}!A2:C` });
  const linhas = resposta.data.values || [];
  const indices = linhas
    .map((linha, indice) => ((linha[2] || '').trim() === sheetId ? indice : -1))
    .filter((indice) => indice !== -1);

  if (indices.length === 0) return 0;

  const dados = indices.map((indice) => ({
    range: `${ABA_CLIENTES}!I${indice + 2}`,
    values: [[pastaDriveId]],
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data: dados },
  });

  cache = null;
  return indices.length;
}

module.exports = {
  listarClientesAtivos,
  buscarClientePorNumero,
  adicionarCliente,
  desativarCliente,
  criarPlanilhaCliente,
  ativarPlanoEspecialista,
  definirSenhaDashboard,
  definirPastaDriveCliente,
  definirPastaDriveClientePorSheetId,
  getDriveClient,
};
