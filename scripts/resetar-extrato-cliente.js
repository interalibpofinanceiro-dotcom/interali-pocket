// Reset de extrato de um cliente pra refazer teste (02/09/2026) — limpa a aba `Extrato` e remove
// os lançamentos que nasceram de extrato (Status_Conciliacao = PENDENTE_COMPROVANTE, o que inclui
// as linhas "SALDO DO DIA"). Os comprovantes de verdade (fotos que o cliente mandou) NÃO são
// tocados. Depois o cliente reenvia o extrato e a gente confere o comportamento novo.
//
// Uso:
//   node scripts/resetar-extrato-cliente.js <SHEET_ID>            -> DRY RUN
//   node scripts/resetar-extrato-cliente.js --reset <SHEET_ID>    -> executa

require('dotenv').config();
const { google } = require('googleapis');

const ARGS = process.argv.slice(2);
const RESET = ARGS.includes('--reset');
const SHEET_ID = ARGS.find((a) => !a.startsWith('--'));

if (!SHEET_ID) { console.log('Falta o SHEET_ID. Ver comentário no topo do arquivo.'); process.exit(1); }

function auth() {
  const pk = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null, pk, ['https://www.googleapis.com/auth/spreadsheets']);
}

(async () => {
  const sheets = google.sheets({ version: 'v4', auth: auth() });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const abas = Object.fromEntries(meta.data.sheets.map((s) => [s.properties.title, s.properties.sheetId]));

  console.log(RESET ? '=== RESET ===' : '=== DRY RUN (use --reset) ===');

  // 1) Extrato — quantas linhas de dados
  if (abas.Extrato !== undefined) {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Extrato!A2:F' });
    const n = (r.data.values || []).length;
    console.log(`Extrato: ${n} linha(s) de transação`);
    if (RESET && n > 0) {
      await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: 'Extrato!A2:F' });
      console.log('  -> Extrato limpo (cabeçalho mantido)');
    }
  } else {
    console.log('Extrato: aba não existe');
  }

  // 2) Lançamentos PENDENTE_COMPROVANTE (nascidos de extrato/fatura)
  if (abas.Lancamentos !== undefined) {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Lancamentos!A2:P' });
    const linhas = r.data.values || [];
    const alvos = [];
    linhas.forEach((l, i) => {
      if ((l[14] || '').trim().toUpperCase() === 'PENDENTE_COMPROVANTE') {
        alvos.push({ linhaPlanilha: i + 2, data: l[0], valor: l[2], tipo: l[3], desc: l[4] });
      }
    });
    console.log(`Lançamentos PENDENTE_COMPROVANTE: ${alvos.length}`);
    alvos.slice(0, 40).forEach((a) => console.log(`  linha ${a.linhaPlanilha}: ${a.data} ${a.tipo} ${a.valor} — ${a.desc}`));
    if (alvos.length > 40) console.log(`  ... +${alvos.length - 40}`);

    if (RESET && alvos.length > 0) {
      const requests = alvos
        .sort((a, b) => b.linhaPlanilha - a.linhaPlanilha)
        .map((a) => ({ deleteDimension: { range: { sheetId: abas.Lancamentos, dimension: 'ROWS', startIndex: a.linhaPlanilha - 1, endIndex: a.linhaPlanilha } } }));
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
      console.log(`  -> ${alvos.length} lançamento(s) removido(s)`);
    }
  }

  console.log('\nPronto. Peça pro cliente reenviar o extrato com a legenda "extrato".');
})().catch((e) => console.log('ERRO:', e.message));
