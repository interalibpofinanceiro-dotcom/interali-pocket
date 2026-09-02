// Migração para abas mensais por competência (02/09/2026). Move as linhas das abas ÚNICAS antigas
// (`Lancamentos`, `Extrato`, `ContasAPagar`, `ContasAReceber`, `ItensComprovante`) para abas
// mensais `YYYY-MM · <sufixo>`, adicionando a coluna `Competencia` (derivada da data/vencimento).
// Depois RENOMEIA a aba antiga pra `_migrado_<nome>` — assim o sistema para de lê-la e a migração
// fica idempotente (rodar 2x não duplica: se a aba antiga não existe mais, pula).
//
// Também descarta as linhas "SALDO DO DIA" (mesma faxina do scripts/limpar-linhas-saldo.js).
//
// Uso:
//   node scripts/migrar-competencia.js                       -> DRY RUN, todos os clientes ativos
//   node scripts/migrar-competencia.js <SHEET_ID>            -> DRY RUN, um cliente
//   node scripts/migrar-competencia.js --migrar <SHEET_ID>   -> migra de verdade, um cliente
//   node scripts/migrar-competencia.js --migrar              -> migra de verdade, todos

require('dotenv').config();
const { google } = require('googleapis');
const {
  competenciaDe, garantirAbaMensal, reordenarAbas, SUFIXO,
  CABECALHO_LANCAMENTOS, CABECALHO_EXTRATO, CABECALHO_CONTAS_A_PAGAR, CABECALHO_CONTAS_A_RECEBER, CABECALHO_ITENS,
} = require('../sheets');

const CABECALHO_POR_SUFIXO = {
  [SUFIXO.LANCAMENTOS]: CABECALHO_LANCAMENTOS,
  [SUFIXO.EXTRATO]: CABECALHO_EXTRATO,
  [SUFIXO.CONTAS_A_PAGAR]: CABECALHO_CONTAS_A_PAGAR,
  [SUFIXO.CONTAS_A_RECEBER]: CABECALHO_CONTAS_A_RECEBER,
  [SUFIXO.ITENS]: CABECALHO_ITENS,
};

const RE_LINHA_SALDO = /^\s*s\s*a\s*l\s*d\s*o\b|^\s*saldo\s*(do\s*dia|anterior|final|do\s*per[íi]odo|dispon[íi]vel|bloquead|em\s*c|atual|\(\+\)|:)?\s*$|saldo\s+do\s+dia|saldo\s+anterior/i;

const ARGS = process.argv.slice(2);
const MIGRAR = ARGS.includes('--migrar');
const SHEET_ARG = ARGS.find((a) => !a.startsWith('--'));

// legado -> { sufixo, colData (índice 0-based da coluna de data/vencimento), colsLegado }
const TIPOS = [
  { legado: 'Lancamentos', sufixo: SUFIXO.LANCAMENTOS, colData: 0, colsLegado: 16, colsNovas: 22, colSaldoDesc: [4, 5] },
  { legado: 'Extrato', sufixo: SUFIXO.EXTRATO, colData: 0, colsLegado: 6, colsNovas: 7, colSaldoDesc: [1] },
  { legado: 'ContasAPagar', sufixo: SUFIXO.CONTAS_A_PAGAR, colData: 0, colsLegado: 10, colsNovas: 11, colSaldoDesc: [] },
  { legado: 'ContasAReceber', sufixo: SUFIXO.CONTAS_A_RECEBER, colData: 0, colsLegado: 10, colsNovas: 11, colSaldoDesc: [] },
  { legado: 'ItensComprovante', sufixo: SUFIXO.ITENS, colData: 0, colsLegado: 8, colsNovas: 10, colSaldoDesc: [] },
];

function auth() {
  const pk = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null, pk, ['https://www.googleapis.com/auth/spreadsheets']);
}

async function clientesAtivos(sheets) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_MASTER_SHEET_ID, range: 'Clientes!A2:D' });
  const vistos = new Set();
  return (r.data.values || [])
    .filter((l) => (l[3] || '').toString().toLowerCase() !== 'false')
    .map((l) => ({ nome: l[1] || '', sheetId: l[2] || '' }))
    .filter((c) => c.sheetId && !vistos.has(c.sheetId) && vistos.add(c.sheetId));
}

function ehSaldo(linha, colsSaldoDesc) {
  return colsSaldoDesc.some((c) => RE_LINHA_SALDO.test((linha[c] || '').trim()));
}

function letra(n) {
  let s = '', x = n;
  while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); }
  return s;
}

async function migrarCliente(sheets, cliente) {
  console.log(`\n=== ${cliente.nome} (${cliente.sheetId}) ===`);
  const meta = await sheets.spreadsheets.get({ spreadsheetId: cliente.sheetId });
  const titulos = meta.data.sheets.map((s) => s.properties.title);
  let criouAlgo = false;

  for (const tipo of TIPOS) {
    if (titulos.includes(`_migrado_${tipo.legado}`)) {
      console.log(`  [${tipo.legado}] já migrado (existe _migrado_${tipo.legado}) — pulando`);
      continue;
    }
    if (!titulos.includes(tipo.legado)) {
      console.log(`  [${tipo.legado}] não existe — pulando`);
      continue;
    }

    const ultima = letra(tipo.colsLegado);
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: cliente.sheetId, range: `${tipo.legado}!A2:${ultima}` });
    const linhas = r.data.values || [];

    const porComp = new Map();
    let saldoPulado = 0;
    for (const linha of linhas) {
      if (ehSaldo(linha, tipo.colSaldoDesc)) { saldoPulado += 1; continue; }
      const comp = competenciaDe(linha[tipo.colData]);
      const preenchida = [...linha];
      while (preenchida.length < tipo.colsLegado) preenchida.push('');
      // Competencia entra logo após as colunas legadas; o resto (CNAE, Lancamento_Aba) fica vazio.
      preenchida[tipo.colsLegado] = comp;
      while (preenchida.length < tipo.colsNovas) preenchida.push('');
      if (!porComp.has(comp)) porComp.set(comp, []);
      porComp.get(comp).push(preenchida);
    }

    const resumo = [...porComp.entries()].map(([c, ls]) => `${c}:${ls.length}`).join('  ');
    console.log(`  [${tipo.legado}] ${linhas.length} linha(s) -> ${porComp.size} competência(s) [${resumo}]${saldoPulado ? `  (${saldoPulado} saldo pulado)` : ''}`);

    if (!MIGRAR) continue;

    const CAB = CABECALHO_POR_SUFIXO[tipo.sufixo];
    for (const [comp, ls] of porComp) {
      const aba = await garantirAbaMensal(sheets, cliente.sheetId, comp, tipo.sufixo, CAB);
      await sheets.spreadsheets.values.append({
        spreadsheetId: cliente.sheetId,
        range: `${aba}!A:${letra(tipo.colsNovas)}`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: ls },
      });
      criouAlgo = true;
    }

    // Renomeia a aba antiga -> _migrado_<nome> (para de ser lida; idempotente).
    const prop = meta.data.sheets.find((s) => s.properties.title === tipo.legado).properties;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: cliente.sheetId,
      requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId: prop.sheetId, title: `_migrado_${tipo.legado}` }, fields: 'title' } }] },
    });
    console.log(`  [${tipo.legado}] migrado -> abas mensais; aba antiga renomeada pra _migrado_${tipo.legado}`);
  }

  if (MIGRAR && criouAlgo) {
    await reordenarAbas(sheets, cliente.sheetId).catch((e) => console.log(`  aviso: reordenar abas falhou: ${e.message}`));
  }
}

(async () => {
  const sheets = google.sheets({ version: 'v4', auth: auth() });
  const lista = SHEET_ARG ? [{ nome: '(arg)', sheetId: SHEET_ARG }] : await clientesAtivos(sheets);

  console.log(MIGRAR ? '=== MIGRANDO DE VERDADE ===' : '=== DRY RUN (use --migrar pra valer) ===');
  for (const c of lista) {
    try { await migrarCliente(sheets, c); }
    catch (e) { console.log(`  ERRO em ${c.nome}: ${e.message}`); }
  }
  console.log('\nFim.');
})();
