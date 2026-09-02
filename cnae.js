require('dotenv').config();
const { google } = require('googleapis');

// 02/09/2026 (pedido do Aroldo — "a categorização deve considerar os CNAEs do CNPJ do comprovante"):
// consulta a atividade econômica (CNAE) do fornecedor a partir do CNPJ que a IA já extrai do
// comprovante (`cnpj_fornecedor`/`documento_identificacao`, ver prompts.js) e usa isso como sinal
// pra categorizar o lançamento (ver cnae-categorias.js + enriquecerLancamentoComCnae em server.js).
//
// FONTE DE DADOS: o site oficial da Receita (solucoes.receita.fazenda.gov.br/Servicos/cnpjreva)
// tem captcha e não é automatizável de forma confiável. A MESMA base — Dados Abertos do CNPJ,
// publicada mensalmente pela Receita Federal — é servida por APIs públicas sem captcha e sem
// chave. Usadas aqui em cascata: BrasilAPI (principal) -> CNPJá aberto (fallback). NENHUMA delas
// gasta token de IA — é requisição HTTP simples.
//
// CACHE: aba `Cache_CNPJ` na planilha MESTRE (GOOGLE_MASTER_SHEET_ID), compartilhada entre todos
// os clientes. Primeira vez que um CNPJ aparece (em qualquer cliente) -> 1 consulta à API -> grava
// no cache. Todas as próximas vezes leem do cache, sem tocar na API. O CNAE de uma empresa quase
// nunca muda, então o TTL (120 dias) é só uma revalidação de segurança. Falha de API nunca trava
// o lançamento — se não der pra consultar, o fluxo segue sem CNAE (categorização da IA normal).

const ABA_CACHE = 'Cache_CNPJ';
const CABECALHO_CACHE = [
  'CNPJ', 'Razao_Social', 'CNAE_Codigo', 'CNAE_Descricao', 'CNAEs_Secundarios',
  'Porte', 'Simples', 'MEI', 'Situacao', 'Fonte', 'Consultado_Em',
];
const TTL_DIAS = 120;
const TIMEOUT_MS = 8000;

// Cache em memória do processo — evita reler a aba do Sheets a cada comprovante dentro da mesma
// execução do servidor. Preenchido uma vez (lazy) na primeira consulta.
const memoria = new Map();
let cacheCarregado = false;

function getSheetsClient() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

// "12.345.678/0001-90", "12345678000190" ou o número solto que a IA colocou em documento_identificacao
// -> 14 dígitos limpos, ou null se não for um CNPJ plausível (CPF tem 11, chave Pix é outra coisa).
function normalizarCNPJ(valor) {
  if (!valor) return null;
  const digitos = String(valor).replace(/\D/g, '');
  if (digitos.length !== 14) return null;
  if (/^(\d)\1{13}$/.test(digitos)) return null; // 00000000000000 etc.
  return digitos;
}

function formatarCNPJ(digitos) {
  return String(digitos).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

// CNAE vem das APIs como número de 7 dígitos (ex.: 5611201) — formata pro padrão "5611-2/01".
function formatarCodigoCnae(codigo) {
  const d = String(codigo == null ? '' : codigo).replace(/\D/g, '').padStart(7, '0');
  if (d.length !== 7 || d === '0000000') return String(codigo || '');
  return `${d.slice(0, 4)}-${d.slice(4, 5)}/${d.slice(5, 7)}`;
}

function parseSecundarios(texto) {
  if (!texto) return [];
  // Guardado no cache como "5612-1/00 Descrição; 4721-1/02 Outra" — só precisa do código pra
  // casar no mapa (cnae-categorias.js), a descrição é ilustrativa.
  return String(texto)
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^([0-9]{4}-?[0-9]\/?[0-9]{2})\s*(.*)$/);
      return m ? { codigo: m[1], descricao: (m[2] || '').trim() } : { codigo: p, descricao: '' };
    });
}

function serializarSecundarios(lista) {
  if (!Array.isArray(lista) || lista.length === 0) return '';
  return lista
    .slice(0, 15)
    .map((c) => `${c.codigo}${c.descricao ? ` ${c.descricao}` : ''}`)
    .join('; ');
}

function cacheVencido(registro) {
  if (!registro || !registro.consultado_em) return true;
  const quando = new Date(registro.consultado_em).getTime();
  if (Number.isNaN(quando)) return true;
  return Date.now() - quando > TTL_DIAS * 24 * 60 * 60 * 1000;
}

async function garantirAbaCache(sheets, spreadsheetId) {
  const planilha = await sheets.spreadsheets.get({ spreadsheetId });
  const existe = planilha.data.sheets.some((aba) => aba.properties.title === ABA_CACHE);

  if (!existe) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: ABA_CACHE } } }] },
    });
  }

  const ultimaColuna = String.fromCharCode('A'.charCodeAt(0) + CABECALHO_CACHE.length - 1);
  const resposta = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${ABA_CACHE}!A1:${ultimaColuna}1`,
  });
  const cabecalhoAtual = (resposta.data.values && resposta.data.values[0]) || [];

  if (cabecalhoAtual.length < CABECALHO_CACHE.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${ABA_CACHE}!A1:${ultimaColuna}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [CABECALHO_CACHE] },
    });
  }
}

async function carregarCacheNaMemoria() {
  if (cacheCarregado) return;
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  if (!spreadsheetId) {
    cacheCarregado = true;
    return;
  }

  const sheets = getSheetsClient();
  await garantirAbaCache(sheets, spreadsheetId);

  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_CACHE}!A2:K` });
  for (const linha of resposta.data.values || []) {
    const cnpj = normalizarCNPJ(linha[0]);
    if (!cnpj) continue;
    // Última linha de um mesmo CNPJ vence (append sempre acrescenta, nunca reescreve) — deixa o
    // dedupe pra cá em vez de gastar chamada de API procurando/atualizando a linha certa.
    memoria.set(cnpj, {
      cnpj,
      cnpj_formatado: formatarCNPJ(cnpj),
      razao_social: linha[1] || '',
      cnae_codigo: linha[2] || '',
      cnae_descricao: linha[3] || '',
      cnaes_secundarios: parseSecundarios(linha[4]),
      porte: linha[5] || '',
      simples: linha[6] || '',
      mei: linha[7] || '',
      situacao: linha[8] || '',
      fonte: linha[9] || 'cache',
      consultado_em: linha[10] || '',
    });
  }
  cacheCarregado = true;
}

async function gravarCache(registro) {
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  if (!spreadsheetId) return;

  const sheets = getSheetsClient();
  await garantirAbaCache(sheets, spreadsheetId);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_CACHE}!A:K`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        registro.cnpj_formatado || formatarCNPJ(registro.cnpj),
        registro.razao_social || '',
        registro.cnae_codigo || '',
        registro.cnae_descricao || '',
        serializarSecundarios(registro.cnaes_secundarios),
        registro.porte || '',
        registro.simples || '',
        registro.mei || '',
        registro.situacao || '',
        registro.fonte || '',
        registro.consultado_em || new Date().toISOString(),
      ]],
    },
  });
}

async function buscarComTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resposta = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'interali-pocket/1.0' },
    });
    if (!resposta.ok) return null;
    return await resposta.json();
  } catch (erro) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// BrasilAPI — base de Dados Abertos do CNPJ da Receita. Sem chave, sem captcha.
async function consultarBrasilAPI(cnpj) {
  const dados = await buscarComTimeout(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
  if (!dados || !dados.cnae_fiscal) return null;

  return {
    cnpj,
    cnpj_formatado: formatarCNPJ(cnpj),
    razao_social: dados.razao_social || dados.nome_fantasia || '',
    cnae_codigo: formatarCodigoCnae(dados.cnae_fiscal),
    cnae_descricao: dados.cnae_fiscal_descricao || '',
    cnaes_secundarios: (dados.cnaes_secundarios || [])
      .filter((c) => c && c.codigo && String(c.codigo) !== '0')
      .map((c) => ({ codigo: formatarCodigoCnae(c.codigo), descricao: c.descricao || '' })),
    porte: dados.porte || '',
    simples: dados.opcao_pelo_simples === true ? 'Sim' : dados.opcao_pelo_simples === false ? 'Não' : '',
    mei: dados.opcao_pelo_mei === true ? 'Sim' : dados.opcao_pelo_mei === false ? 'Não' : '',
    situacao: dados.descricao_situacao_cadastral || '',
    fonte: 'brasilapi',
    consultado_em: new Date().toISOString(),
  };
}

// CNPJá aberto — fallback (mesma base da Receita, formato diferente).
async function consultarCnpja(cnpj) {
  const dados = await buscarComTimeout(`https://open.cnpja.com/office/${cnpj}`);
  if (!dados || !dados.mainActivity) return null;

  return {
    cnpj,
    cnpj_formatado: formatarCNPJ(cnpj),
    razao_social: (dados.company && dados.company.name) || dados.alias || '',
    cnae_codigo: formatarCodigoCnae(dados.mainActivity.id),
    cnae_descricao: dados.mainActivity.text || '',
    cnaes_secundarios: (dados.sideActivities || [])
      .map((c) => ({ codigo: formatarCodigoCnae(c.id), descricao: c.text || '' })),
    porte: (dados.company && dados.company.size && dados.company.size.text) || '',
    simples: dados.company && dados.company.simples
      ? (dados.company.simples.optant ? 'Sim' : 'Não') : '',
    mei: dados.company && dados.company.simei
      ? (dados.company.simei.optant ? 'Sim' : 'Não') : '',
    situacao: (dados.status && dados.status.text) || '',
    fonte: 'cnpja',
    consultado_em: new Date().toISOString(),
  };
}

async function consultarNasAPIs(cnpj) {
  const brasil = await consultarBrasilAPI(cnpj);
  if (brasil) return brasil;
  return consultarCnpja(cnpj);
}

// Ponto de entrada — recebe o valor cru que a IA extraiu (CNPJ formatado, só dígitos, ou lixo) e
// devolve o registro de CNAE, ou null se não for CNPJ / não achou / API fora do ar sem cache.
async function consultarCNPJ(valorCnpj) {
  const cnpj = normalizarCNPJ(valorCnpj);
  if (!cnpj) return null;

  try {
    await carregarCacheNaMemoria();
  } catch (erro) {
    console.error('CNAE: falha ao carregar cache da planilha mestre:', erro.message);
  }

  const doCache = memoria.get(cnpj);
  if (doCache && !cacheVencido(doCache)) return doCache;

  const consultado = await consultarNasAPIs(cnpj);
  if (!consultado) {
    // API fora do ar / CNPJ não encontrado: usa o cache vencido se existir, senão desiste (o
    // fluxo segue sem CNAE — categorização da IA normal, nada quebra).
    return doCache || null;
  }

  memoria.set(cnpj, consultado);
  gravarCache(consultado).catch((erro) => console.error('CNAE: falha ao gravar cache:', erro.message));
  return consultado;
}

module.exports = {
  consultarCNPJ,
  normalizarCNPJ,
  formatarCNPJ,
  formatarCodigoCnae,
  ABA_CACHE,
};
