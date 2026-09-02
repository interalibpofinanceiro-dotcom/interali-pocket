// Migração para abas mensais por competência (02/09/2026). Move as linhas das abas ÚNICAS antigas
// (`Lancamentos`, `Extrato`, `ContasAPagar`, `ContasAReceber`, `ItensComprovante`) para abas
// mensais `YYYY-MM · <sufixo>`, adicionando a coluna `Competencia` (derivada da data/vencimento).
// Depois RENOMEIA a aba antiga pra `_migrado_<nome>` — assim o sistema para de lê-la e a migração
// fica idempotente (se a aba antiga não existe mais, pula).
//
// Também descarta as linhas "SALDO DO DIA".
//
// Uso:
//   node scripts/migrar-competencia.js                        -> DRY RUN, todos os ativos
//   node scripts/migrar-competencia.js <SHEET_ID>             -> DRY RUN, um cliente
//   node scripts/migrar-competencia.js --migrar [<SHEET_ID>]  -> migra de verdade
//   node scripts/migrar-competencia.js --apagar-mensais <tipo> <SHEET_ID>
//        -> apaga as abas mensais `YYYY-MM · X` de um tipo (pra desfazer uma migração parcial que
//           falhou no meio e re-rodar do zero). <tipo> = lancamentos|extrato|contas-pagar|
//           contas-receber|itens

require('dotenv').config();
const { google } = require('googleapis');
const {
  competenciaDe, paraDataBR, garantirAbaMensal, reordenarAbas, SUFIXO, RE_ABA_MENSAL,
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
const APAGAR_MENSAIS_IDX = ARGS.indexOf('--apagar-mensais');
const APAGAR_MENSAIS = APAGAR_MENSAIS_IDX >= 0 ? ARGS[APAGAR_MENSAIS_IDX + 1] : null;
const SHEET_ARG = ARGS.filter((a) => !a.startsWith('--')).find((a) => a.length > 20);

const SUFIXO_POR_APELIDO = {
  lancamentos: SUFIXO.LANCAMENTOS, 'lançamentos': SUFIXO.LANCAMENTOS,
  extrato: SUFIXO.EXTRATO,
  'contas-pagar': SUFIXO.CONTAS_A_PAGAR, 'contas-receber': SUFIXO.CONTAS_A_RECEBER,
  itens: SUFIXO.ITENS,
};

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry com backoff pra 429 (rate limit) / 500 / 503 / reset de conexão — a causa provável da
// migração da Sirlene ter falhado no meio (muitas chamadas de API em sequência).
async function comRetry(fn, rotulo, tentativas = 5) {
  for (let i = 0; i < tentativas; i += 1) {
    try {
      return await fn();
    } catch (e) {
      const cod = e.code || (e.response && e.response.status);
      const transiente = [429, 500, 502, 503, 504].includes(Number(cod)) || /ECONNRESET|ETIMEDOUT|socket hang up/i.test(e.message || '');
      if (!transiente || i === tentativas - 1) throw e;
      const espera = 1500 * 2 ** i;
      console.log(`  ... ${rotulo}: ${e.message} — tentando de novo em ${espera}ms (${i + 1}/${tentativas})`);
      await sleep(espera);
    }
  }
  return undefined;
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

async function apagarAbasMensaisDoTipo(sheets, spreadsheetId, sufixo) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const alvos = meta.data.sheets
    .map((s) => s.properties)
    .filter((p) => { const m = p.title.match(RE_ABA_MENSAL); return m && m[2] === sufixo; });

  if (alvos.length === 0) { console.log(`Nenhuma aba mensal "· ${sufixo}" pra apagar.`); return; }

  for (const p of alvos) {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${p.title}!A2:A` }).catch(() => ({ data: {} }));
    console.log(`  vai apagar "${p.title}" (${(r.data.values || []).length} linha(s))`);
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: alvos.map((p) => ({ deleteSheet: { sheetId: p.sheetId } })) },
  });
  console.log(`${alvos.length} aba(s) apagada(s).`);
}

async function migrarCliente(sheets, cliente) {
  console.log(`\n=== ${cliente.nome} (${cliente.sheetId}) ===`);
  const meta = await comRetry(() => sheets.spreadsheets.get({ spreadsheetId: cliente.sheetId }), 'get meta');
  const titulos = meta.data.sheets.map((s) => s.properties.title);
  let criouAlgo = false;

  for (const tipo of TIPOS) {
    if (titulos.includes(`_migrado_${tipo.legado}`)) {
      console.log(`  [${tipo.legado}] já migrado — pulando`);
      continue;
    }
    if (!titulos.includes(tipo.legado)) {
      console.log(`  [${tipo.legado}] não existe — pulando`);
      continue;
    }

    const ultima = letra(tipo.colsLegado);
    const r = await comRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: cliente.sheetId, range: `${tipo.legado}!A2:${ultima}` }), `ler ${tipo.legado}`);
    const linhas = r.data.values || [];

    const porComp = new Map();
    let saldoPulado = 0;
    for (const linha of linhas) {
      if (ehSaldo(linha, tipo.colSaldoDesc)) { saldoPulado += 1; continue; }
      const comp = competenciaDe(linha[tipo.colData]);
      const preenchida = [...linha];
      preenchida[tipo.colData] = paraDataBR(linha[tipo.colData]); // data vira "01/09/2026"
      while (preenchida.length < tipo.colsLegado) preenchida.push('');
      preenchida[tipo.colsLegado] = comp;
      while (preenchida.length < tipo.colsNovas) preenchida.push('');
      if (!porComp.has(comp)) porComp.set(comp, []);
      porComp.get(comp).push(preenchida);
    }

    const resumo = [...porComp.entries()].map(([c, ls]) => `${c}:${ls.length}`).join('  ');
    console.log(`  [${tipo.legado}] ${linhas.length} linha(s) -> ${porComp.size} competência(s) [${resumo}]${saldoPulado ? `  (${saldoPulado} saldo pulado)` : ''}`);

    if (!MIGRAR) continue;

    // Guarda anti-duplicação: se JÁ existem abas mensais desse tipo (migração parcial que falhou),
    // aborta esse tipo com aviso — o operador roda `--apagar-mensais <tipo> <SHEET_ID>` e re-tenta.
    // (Exceção: Contas a Pagar/Receber podem ter aba mensal criada por tráfego ao vivo — aí é
    // append mesmo, não é leftover; então só bloqueia Lançamentos/Extrato/Itens.)
    const jaTemMensal = titulos.some((t) => { const m = t.match(RE_ABA_MENSAL); return m && m[2] === tipo.sufixo; });
    const tipoSensivel = [SUFIXO.LANCAMENTOS, SUFIXO.EXTRATO, SUFIXO.ITENS].includes(tipo.sufixo);
    if (jaTemMensal && tipoSensivel) {
      const apelido = tipo.sufixo === SUFIXO.LANCAMENTOS ? 'lancamentos' : tipo.sufixo === SUFIXO.EXTRATO ? 'extrato' : 'itens';
      console.log(`  ⚠️ [${tipo.legado}] JÁ existem abas mensais "· ${tipo.sufixo}" (migração parcial anterior). NÃO migrei pra não duplicar.`);
      console.log(`     Rode:  node scripts/migrar-competencia.js --apagar-mensais ${apelido} ${cliente.sheetId}`);
      console.log(`     Depois re-rode a migração.`);
      continue;
    }

    const CAB = CABECALHO_POR_SUFIXO[tipo.sufixo];
    for (const [comp, ls] of porComp) {
      const aba = await comRetry(() => garantirAbaMensal(sheets, cliente.sheetId, comp, tipo.sufixo, CAB, { pularReordenar: true }), `criar ${comp} · ${tipo.sufixo}`);
      await comRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId: cliente.sheetId,
        range: `${aba}!A:${letra(tipo.colsNovas)}`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: ls },
      }), `append ${aba}`);
      criouAlgo = true;
      await sleep(300);
    }

    const prop = meta.data.sheets.find((s) => s.properties.title === tipo.legado).properties;
    await comRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: cliente.sheetId,
      requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId: prop.sheetId, title: `_migrado_${tipo.legado}` }, fields: 'title' } }] },
    }), `renomear ${tipo.legado}`);
    console.log(`  [${tipo.legado}] OK -> abas mensais; antiga renomeada pra _migrado_${tipo.legado}`);
    await sleep(500);
  }

  if (MIGRAR && criouAlgo) {
    await comRetry(() => reordenarAbas(sheets, cliente.sheetId), 'reordenar').catch((e) => console.log(`  aviso: reordenar falhou: ${e.message}`));
  }
}

(async () => {
  const sheets = google.sheets({ version: 'v4', auth: auth() });

  if (APAGAR_MENSAIS) {
    const sufixo = SUFIXO_POR_APELIDO[APAGAR_MENSAIS.toLowerCase()];
    if (!sufixo || !SHEET_ARG) { console.log('Uso: --apagar-mensais <lancamentos|extrato|contas-pagar|contas-receber|itens> <SHEET_ID>'); process.exit(1); }
    console.log(`=== APAGANDO abas mensais "· ${sufixo}" de ${SHEET_ARG} ===`);
    await apagarAbasMensaisDoTipo(sheets, SHEET_ARG, sufixo);
    console.log('Feito. Re-rode a migração desse cliente.');
    return;
  }

  const lista = SHEET_ARG ? [{ nome: '(arg)', sheetId: SHEET_ARG }] : await clientesAtivos(sheets);
  console.log(MIGRAR ? '=== MIGRANDO DE VERDADE ===' : '=== DRY RUN (use --migrar pra valer) ===');
  for (const c of lista) {
    try { await migrarCliente(sheets, c); }
    catch (e) { console.log(`  ERRO em ${c.nome}: ${e.message}`); }
    await sleep(800);
  }
  console.log('\nFim.');
})();
