require('dotenv').config();
const { getSheetsClient, RE_ABA_MENSAL, SUFIXO } = require('./sheets');

// 02/09/2026 (pedido do Aroldo) — formatação executiva das planilhas de cliente via Sheets API
// batchUpdate: linha 1 congelada + filtro, cabeçalho azul marinho, cores condicionais por
// tipo/status, moeda BR, data centralizada, zebra. Só formatação — NÃO toca dado nem lógica.
// Roda no cadastro de cliente novo e via `npm run estilizar-planilhas` (todas as ativas).

function rgb(hex) {
  const h = hex.replace('#', '');
  return { red: parseInt(h.slice(0, 2), 16) / 255, green: parseInt(h.slice(2, 4), 16) / 255, blue: parseInt(h.slice(4, 6), 16) / 255 };
}

const COR = {
  headerBg: rgb('#1E293B'), headerText: rgb('#FFFFFF'),
  entradaBg: rgb('#DCFCE7'), entradaText: rgb('#15803D'),
  saidaBg: rgb('#FEE2E2'), saidaText: rgb('#B91C1C'),
  okBg: rgb('#DCFCE7'), okText: rgb('#15803D'),
  pendBg: rgb('#FEF9C3'), pendText: rgb('#A16207'),
  duvidaBg: rgb('#FFEDD5'), duvidaText: rgb('#C2410C'),
  zebra: rgb('#F1F5F9'), borda: rgb('#E2E8F0'),
};

const FORMATO_MOEDA = 'R$ #,##0.00;[Red]-R$ #,##0.00';
const FORMATO_DATA = 'dd/mm/yyyy';

// Por sufixo de aba: índices 0-based das colunas relevantes + total de colunas.
// (Layout = CABECALHO_* de sheets.js.)
const PERFIL = {
  [SUFIXO.LANCAMENTOS]: { cols: 22, data: [0], moeda: [2], tipo: 3, status: 14 },
  [SUFIXO.EXTRATO]: { cols: 7, data: [0], moeda: [2, 4], tipo: 3, status: null },
  [SUFIXO.CONTAS_A_PAGAR]: { cols: 11, data: [0], moeda: [1], tipo: null, status: null },
  [SUFIXO.CONTAS_A_RECEBER]: { cols: 11, data: [0], moeda: [1], tipo: null, status: null },
  [SUFIXO.ITENS]: { cols: 10, data: [0], moeda: [5, 6], tipo: null, status: null },
};
// Abas legadas (nomes antigos, pré-migração) -> mesmo perfil.
const PERFIL_LEGADO = {
  Lancamentos: PERFIL[SUFIXO.LANCAMENTOS], Extrato: PERFIL[SUFIXO.EXTRATO],
  ContasAPagar: PERFIL[SUFIXO.CONTAS_A_PAGAR], ContasAReceber: PERFIL[SUFIXO.CONTAS_A_RECEBER],
  ItensComprovante: PERFIL[SUFIXO.ITENS],
};

function perfilDaAba(titulo) {
  const m = titulo.match(RE_ABA_MENSAL);
  if (m) return PERFIL[m[2]] || null;
  return PERFIL_LEGADO[titulo] || null;
}

function regraTexto(sheetId, colIndex, textos, bg, fg) {
  return {
    addConditionalFormatRule: {
      rule: {
        ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 }],
        booleanRule: {
          condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: textos }] },
          format: { backgroundColor: bg, textFormat: { foregroundColor: fg, bold: true } },
        },
      },
      index: 0,
    },
  };
}

function requestsParaAba(prop) {
  const perfil = perfilDaAba(prop.title);
  if (!perfil) return [];
  const sheetId = prop.sheetId;
  const nCols = perfil.cols;
  const reqs = [];

  // Congelar linha 1
  reqs.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });

  // Cabeçalho
  reqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: nCols },
      cell: { userEnteredFormat: { backgroundColor: COR.headerBg, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { foregroundColor: COR.headerText, bold: true, fontSize: 11 } } },
      fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)',
    },
  });
  reqs.push({ updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 34 }, fields: 'pixelSize' } });

  // Filtro em todas as colunas
  reqs.push({ setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: nCols } } } });

  // Moeda
  for (const c of perfil.moeda) {
    reqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: c, endColumnIndex: c + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: FORMATO_MOEDA } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }
  // Data
  for (const c of perfil.data) {
    reqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: c, endColumnIndex: c + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: FORMATO_DATA }, horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    });
  }

  // Cores condicionais — Tipo
  if (perfil.tipo !== null) {
    reqs.push(regraTexto(sheetId, perfil.tipo, 'entrada', COR.entradaBg, COR.entradaText));
    reqs.push(regraTexto(sheetId, perfil.tipo, 'saida', COR.saidaBg, COR.saidaText));
  }
  // Cores condicionais — Status
  if (perfil.status !== null) {
    reqs.push(regraTexto(sheetId, perfil.status, 'CONCILIADO', COR.okBg, COR.okText));
    reqs.push(regraTexto(sheetId, perfil.status, 'PENDENTE', COR.pendBg, COR.pendText));
    reqs.push(regraTexto(sheetId, perfil.status, 'DUVIDA', COR.duvidaBg, COR.duvidaText));
  }

  // Zebra (banding) — remove a existente e recria pra ser idempotente
  reqs.push({
    addBanding: {
      bandedRange: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: nCols },
        rowProperties: { firstBandColor: { red: 1, green: 1, blue: 1 }, secondBandColor: COR.zebra },
      },
    },
  });

  return reqs;
}

async function estilizarPlanilhaCliente(spreadsheetId) {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const props = meta.data.sheets.map((s) => s.properties);

  // Limpa bandings e filtros antigos primeiro (senão addBanding/setBasicFilter podem colidir).
  // Cada limpeza no seu próprio batch — clearBasicFilter numa aba sem filtro dá erro, e não quero
  // que isso derrube a remoção de banding (nem vice-versa).
  const deletarBandings = [];
  for (const s of meta.data.sheets) {
    for (const b of s.bandedRanges || []) deletarBandings.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } });
  }
  if (deletarBandings.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: deletarBandings } }).catch((e) => console.error('styler: limpar banding falhou (ok seguir):', e.message));
  }
  for (const p of props) {
    if (!perfilDaAba(p.title)) continue;
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ clearBasicFilter: { sheetId: p.sheetId } }] } }).catch(() => {});
  }

  let requests = [];
  let abasEstilizadas = 0;
  for (const p of props) {
    const r = requestsParaAba(p);
    if (r.length) { requests = requests.concat(r); abasEstilizadas += 1; }
  }
  if (requests.length === 0) return { abasEstilizadas: 0 };

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return { abasEstilizadas };
}

module.exports = { estilizarPlanilhaCliente };
