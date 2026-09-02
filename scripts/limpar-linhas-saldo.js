// Limpeza única (02/09/2026) — remove os lançamentos "SALDO DO DIA" / "Saldo Anterior" / etc. que
// entraram por engano na aba Lancamentos de clientes reais (caso da Sirlene: 29 linhas de saldo
// registradas como entrada, inflando o resultado). A causa raiz já foi corrigida em prompts.js
// (PROMPT_EXTRATO) + server.js (removerLinhasDeSaldo); este script só faz a faxina do que já ficou.
//
// Uso:
//   node scripts/limpar-linhas-saldo.js                 -> DRY RUN (só mostra o que apagaria)
//   node scripts/limpar-linhas-saldo.js --apagar        -> apaga de verdade
//   node scripts/limpar-linhas-saldo.js --apagar <SHEET_ID>   -> só num cliente

require('dotenv').config();
const { google } = require('googleapis');

const RE_LINHA_SALDO = /^\s*s\s*a\s*l\s*d\s*o\b|^\s*saldo\s*(do\s*dia|anterior|final|do\s*per[íi]odo|dispon[íi]vel|bloquead|em\s*c|atual|\(\+\)|:)?\s*$|saldo\s+do\s+dia|saldo\s+anterior/i;

const ARGS = process.argv.slice(2);
const APAGAR = ARGS.includes('--apagar');
const SHEET_ARG = ARGS.find((a) => !a.startsWith('--'));

function auth() {
  const pk = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null, pk, ['https://www.googleapis.com/auth/spreadsheets']);
}

async function clientes(sheets) {
  const id = process.env.GOOGLE_MASTER_SHEET_ID;
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: 'Clientes!A2:D' });
  return (r.data.values || [])
    .filter((l) => (l[3] || '').toString().toLowerCase() !== 'false')
    .map((l) => ({ nome: l[1] || '', sheetId: l[2] || '' }))
    .filter((c) => c.sheetId);
}

// Abas que guardam lançamentos: 'Lancamentos' (legado) + qualquer 'YYYY-MM · Lançamentos' (pós-migração)
async function abasDeLancamento(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  return meta.data.sheets
    .map((s) => s.properties)
    .filter((p) => p.title === 'Lancamentos' || /·\s*Lançamentos$/.test(p.title));
}

async function limparAba(sheets, spreadsheetId, prop) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${prop.title}!A2:F` });
  const linhas = r.data.values || [];
  const alvos = []; // { linhaPlanilha, descricao, valor, tipo }
  linhas.forEach((l, i) => {
    const desc = `${l[4] || ''} ${l[5] || ''}`.trim();
    if (RE_LINHA_SALDO.test((l[4] || '').trim()) || RE_LINHA_SALDO.test((l[5] || '').trim())) {
      alvos.push({ linhaPlanilha: i + 2, descricao: desc, valor: l[2], tipo: l[3] });
    }
  });

  if (alvos.length === 0) return 0;

  console.log(`  [${prop.title}] ${alvos.length} linha(s) de saldo:`);
  alvos.forEach((a) => console.log(`     linha ${a.linhaPlanilha}: ${a.tipo} ${a.valor} — "${a.descricao}"`));

  if (APAGAR) {
    // De baixo pra cima, pra não desalinhar os índices.
    const requests = alvos
      .sort((a, b) => b.linhaPlanilha - a.linhaPlanilha)
      .map((a) => ({
        deleteDimension: { range: { sheetId: prop.sheetId, dimension: 'ROWS', startIndex: a.linhaPlanilha - 1, endIndex: a.linhaPlanilha } },
      }));
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    console.log(`     -> apagadas.`);
  }

  return alvos.length;
}

(async () => {
  const sheets = google.sheets({ version: 'v4', auth: auth() });
  const lista = SHEET_ARG ? [{ nome: '(arg)', sheetId: SHEET_ARG }] : await clientes(sheets);

  console.log(APAGAR ? '=== APAGANDO ===' : '=== DRY RUN (use --apagar pra valer) ===');
  let total = 0;
  for (const c of lista) {
    console.log(`\nCliente: ${c.nome} (${c.sheetId})`);
    try {
      const abas = await abasDeLancamento(sheets, c.sheetId);
      for (const prop of abas) total += await limparAba(sheets, c.sheetId, prop);
    } catch (e) {
      console.log(`  ERRO: ${e.message}`);
    }
  }
  console.log(`\nTotal: ${total} linha(s) de saldo ${APAGAR ? 'apagadas' : 'encontradas'}.`);
})();
