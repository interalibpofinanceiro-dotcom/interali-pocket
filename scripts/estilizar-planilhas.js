// Aplica a formatação executiva (sheets-styler.js) nas planilhas dos clientes ativos.
//
// Uso:
//   npm run estilizar-planilhas                 -> lista o que faria (dry-run)
//   npm run estilizar-planilhas -- --aplicar    -> aplica em todos os clientes ativos
//   npm run estilizar-planilhas -- --aplicar <SHEET_ID>   -> um cliente só

require('dotenv').config();
const { google } = require('googleapis');
const { estilizarPlanilhaCliente } = require('../sheets-styler');

const ARGS = process.argv.slice(2);
const APLICAR = ARGS.includes('--aplicar');
const SHEET_ARG = ARGS.find((a) => !a.startsWith('--'));

function auth() {
  const pk = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null, pk, ['https://www.googleapis.com/auth/spreadsheets']);
}

async function clientes(sheets) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_MASTER_SHEET_ID, range: 'Clientes!A2:D' });
  const vistos = new Set();
  return (r.data.values || [])
    .filter((l) => (l[3] || '').toString().toLowerCase() !== 'false')
    .map((l) => ({ nome: l[1] || '', sheetId: l[2] || '' }))
    .filter((c) => c.sheetId && !vistos.has(c.sheetId) && vistos.add(c.sheetId));
}

(async () => {
  const sheets = google.sheets({ version: 'v4', auth: auth() });
  const lista = SHEET_ARG ? [{ nome: '(arg)', sheetId: SHEET_ARG }] : await clientes(sheets);

  console.log(APLICAR ? '=== APLICANDO ===' : '=== DRY RUN (use -- --aplicar) ===');
  for (const c of lista) {
    if (!APLICAR) { console.log(`  ${c.nome} (${c.sheetId})`); continue; }
    try {
      const r = await estilizarPlanilhaCliente(c.sheetId);
      console.log(`  ${c.nome}: ${r.abasEstilizadas} aba(s) estilizada(s)`);
    } catch (e) {
      console.log(`  ${c.nome}: ERRO ${e.message}`);
    }
  }
  console.log('Fim.');
})();
