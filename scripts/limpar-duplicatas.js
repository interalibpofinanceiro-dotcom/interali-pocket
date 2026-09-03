// Remove linhas DUPLICADAS das abas mensais de Lançamentos e Extrato (03/09/2026 — caso Sirlene:
// reenviou o extrato e a deduplicação por texto exato falhou, duplicando extrato + órfãos). O fix
// da causa raiz está no server.js (transacoesIguais / normalizarDescricaoTransacao); este script
// faz a faxina do que já duplicou.
//
// Chave de duplicidade: data + valor(ao centavo) + tipo + descrição normalizada. Mantém a
// PRIMEIRA ocorrência de cada, apaga as demais.
//
// Uso:
//   node scripts/limpar-duplicatas.js <SHEET_ID>            -> DRY RUN
//   node scripts/limpar-duplicatas.js --apagar <SHEET_ID>   -> apaga
//   node scripts/limpar-duplicatas.js --apagar              -> todos os clientes ativos

require('dotenv').config();
const { google } = require('googleapis');
const { RE_ABA_MENSAL, SUFIXO } = require('../sheets');

const ARGS = process.argv.slice(2);
const APAGAR = ARGS.includes('--apagar');
const SHEET_ARG = ARGS.find((a) => !a.startsWith('--'));

function auth() {
  const pk = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null, pk, ['https://www.googleapis.com/auth/spreadsheets']);
}

function num(v) {
  if (typeof v === 'number') return v;
  let s = String(v || '').trim().replace(/[^\d.,-]/g, '');
  s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}

function normDesc(desc) {
  return String(desc || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// { colData, colValor, colTipo, colDesc, colStatus } por sufixo
const PERFIL = {
  [SUFIXO.LANCAMENTOS]: { colData: 0, colValor: 2, colTipo: 3, colDesc: 4, colStatus: 14, ultima: 'V' },
  [SUFIXO.EXTRATO]: { colData: 0, colValor: 2, colTipo: 3, colDesc: 1, colStatus: null, ultima: 'G' },
};

async function clientes(sheets) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_MASTER_SHEET_ID, range: 'Clientes!A2:D' });
  const vistos = new Set();
  return (r.data.values || [])
    .filter((l) => (l[3] || '').toString().toLowerCase() !== 'false')
    .map((l) => ({ nome: l[1] || '', sheetId: l[2] || '' }))
    .filter((c) => c.sheetId && !vistos.has(c.sheetId) && vistos.add(c.sheetId));
}

async function limparAba(sheets, spreadsheetId, prop, perfil) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${prop.title}!A2:${perfil.ultima}`,
    valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING',
  });
  const linhas = r.data.values || [];
  const vistas = new Set();
  const duplicadas = [];
  let valorZero = 0;

  linhas.forEach((row, i) => {
    const valor = num(row[perfil.colValor]);
    // Linha com valor 0/vazio: NÃO entra na deduplicação (pode ser transação distinta com valor
    // que a IA não capturou — apagar seria perder dado). Só conta pra avisar.
    if (Math.abs(valor) < 0.01) { valorZero += 1; return; }

    const base = [
      String(row[perfil.colData] || '').trim(),
      valor.toFixed(2),
      String(row[perfil.colTipo] || '').trim().toLowerCase(),
    ].join('|');
    const status = perfil.colStatus !== null ? String(row[perfil.colStatus] || '').trim().toUpperCase() : '';
    const chave = status === 'PENDENTE_COMPROVANTE' ? base : `${base}|${normDesc(row[perfil.colDesc])}`;
    if (vistas.has(chave)) duplicadas.push({ linhaPlanilha: i + 2, chave, desc: row[perfil.colDesc], valor: row[perfil.colValor] });
    else vistas.add(chave);
  });
  if (valorZero > 0) console.log(`  [${prop.title}] ⚠️ ${valorZero} linha(s) com valor 0/vazio — ignoradas na dedup (conferir manualmente)`);

  if (duplicadas.length === 0) { console.log(`  [${prop.title}] sem duplicatas (${linhas.length} linhas)`); return 0; }
  console.log(`  [${prop.title}] ${linhas.length} linhas, ${duplicadas.length} DUPLICATA(s):`);
  duplicadas.slice(0, 15).forEach((d) => console.log(`     linha ${d.linhaPlanilha}: ${d.valor} — "${d.desc}"`));
  if (duplicadas.length > 15) console.log(`     ...+${duplicadas.length - 15}`);

  if (APAGAR) {
    const requests = duplicadas
      .sort((a, b) => b.linhaPlanilha - a.linhaPlanilha)
      .map((d) => ({ deleteDimension: { range: { sheetId: prop.sheetId, dimension: 'ROWS', startIndex: d.linhaPlanilha - 1, endIndex: d.linhaPlanilha } } }));
    // em lotes de 100 requests
    for (let k = 0; k < requests.length; k += 100) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: requests.slice(k, k + 100) } });
    }
    console.log(`     -> ${duplicadas.length} apagada(s)`);
  }
  return duplicadas.length;
}

(async () => {
  const sheets = google.sheets({ version: 'v4', auth: auth() });
  const lista = SHEET_ARG ? [{ nome: '(arg)', sheetId: SHEET_ARG }] : await clientes(sheets);

  console.log(APAGAR ? '=== APAGANDO DUPLICATAS ===' : '=== DRY RUN (use --apagar) ===');
  let total = 0;
  for (const c of lista) {
    console.log(`\n=== ${c.nome} (${c.sheetId}) ===`);
    const meta = await sheets.spreadsheets.get({ spreadsheetId: c.sheetId });
    for (const p of meta.data.sheets.map((s) => s.properties)) {
      const m = p.title.match(RE_ABA_MENSAL);
      if (!m || !PERFIL[m[2]]) continue;
      total += await limparAba(sheets, c.sheetId, p, PERFIL[m[2]]);
    }
  }
  console.log(`\nTotal: ${total} duplicata(s) ${APAGAR ? 'apagadas' : 'encontradas'}.`);
})().catch((e) => console.log('ERRO:', e.message));
