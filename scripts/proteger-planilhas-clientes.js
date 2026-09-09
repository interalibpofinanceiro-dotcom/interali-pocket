// Proteger planilhas de clientes JÁ EXISTENTES (09/09/2026) — trava todas as abas conhecidas
// exceto a coluna Subcategoria (quando existir), igual já acontece automaticamente pra ABA NOVA
// desde que protegerAbaExcetoSubcategoria foi ligado em garantirAbaMensal/garantirAbaComCabecalho
// (sheets.js). Este script cobre o que já existia ANTES dessa mudança — roda uma vez por cliente,
// é seguro rodar de novo (Sheets ignora duplicata de protectedRange com o mesmo range/editors,
// só cria mais uma sobreposta — sem quebrar nada, mas evite rodar sem necessidade).
//
// Uso:
//   node scripts/proteger-planilhas-clientes.js                 # todos os clientes ATIVOS
//   node scripts/proteger-planilhas-clientes.js "whatsapp:+55..." # só um cliente específico

require('dotenv').config();
const { listarClientesAtivos } = require('../clientes');
const {
  getSheetsClient, obterSheetIdNumerico, protegerAbaExcetoSubcategoria,
  SUFIXO, CABECALHO_LANCAMENTOS, CABECALHO_EXTRATO, CABECALHO_CONTAS_A_PAGAR,
  CABECALHO_CONTAS_A_RECEBER, CABECALHO_ITENS, CABECALHO_DESPESAS_FIXAS, CABECALHO_ORCAMENTO,
  ABA_DESPESAS_FIXAS, ABA_ORCAMENTO,
} = require('../sheets');
const { ABA_FECHAMENTO_CLIENTE } = require('../fechamento');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function comRetry(fn, tentativas = 5) {
  for (let i = 0; i < tentativas; i++) {
    try { return await fn(); }
    catch (e) {
      const transiente = /429|500|502|503|504|ECONNRESET|ETIMEDOUT|socket hang up|quota/i.test(e.message || '');
      if (!transiente || i === tentativas - 1) throw e;
      const espera = 2000 * (2 ** i);
      console.log(`    retry após erro (${e.message.slice(0, 60)}) -> aguardando ${espera}ms`);
      await sleep(espera);
    }
  }
}

// Cabeçalho conhecido por sufixo de aba mensal ou nome exato de aba de config.
const CABECALHO_POR_SUFIXO = {
  [SUFIXO.LANCAMENTOS]: CABECALHO_LANCAMENTOS,
  [SUFIXO.EXTRATO]: CABECALHO_EXTRATO,
  [SUFIXO.CONTAS_A_PAGAR]: CABECALHO_CONTAS_A_PAGAR,
  [SUFIXO.CONTAS_A_RECEBER]: CABECALHO_CONTAS_A_RECEBER,
  [SUFIXO.ITENS]: CABECALHO_ITENS,
};
const CABECALHO_POR_NOME_EXATO = {
  [ABA_DESPESAS_FIXAS]: CABECALHO_DESPESAS_FIXAS,
  [ABA_ORCAMENTO]: CABECALHO_ORCAMENTO,
};

function cabecalhoParaAba(titulo) {
  if (CABECALHO_POR_NOME_EXATO[titulo]) return CABECALHO_POR_NOME_EXATO[titulo];
  if (titulo === ABA_FECHAMENTO_CLIENTE) return null; // sem Subcategoria -> protege tudo, sem cabeçalho fixo conhecido aqui
  const match = Object.entries(CABECALHO_POR_SUFIXO).find(([sufixo]) => titulo.endsWith(` · ${sufixo}`));
  return match ? match[1] : undefined; // undefined = aba desconhecida, pular
}

async function protegerPlanilhaDoCliente(sheets, cliente) {
  if (!cliente.sheetId) { console.log(`  [${cliente.nome}] sem Sheet_ID, pulando.`); return; }

  const planilha = await comRetry(() => sheets.spreadsheets.get({ spreadsheetId: cliente.sheetId, fields: 'sheets(properties(sheetId,title),protectedRanges)' }));
  const abas = planilha.data.sheets || [];

  for (const aba of abas) {
    const titulo = aba.properties.title;
    const cabecalho = cabecalhoParaAba(titulo);

    if (cabecalho === undefined) {
      console.log(`  [${cliente.nome}] "${titulo}" — aba desconhecida, pulando (confira manualmente se precisa proteção).`);
      continue;
    }
    if (aba.protectedRanges && aba.protectedRanges.length > 0) {
      console.log(`  [${cliente.nome}] "${titulo}" já tem proteção (${aba.protectedRanges.length} faixa(s)) — pulando.`);
      continue;
    }

    // ABA_FECHAMENTO_CLIENTE (cabecalho null aqui) -> sem coluna livre, protege tudo. Usa a
    // contagem de colunas já existente na própria aba (gridProperties) como cabeçalho "vazio"
    // do tamanho certo, já que não importamos CABECALHO_FECHAMENTO_CLIENTE de fechamento.js.
    const cabecalhoEfetivo = cabecalho || new Array(aba.properties.gridProperties ? aba.properties.gridProperties.columnCount : 10).fill('');

    try {
      await comRetry(() => protegerAbaExcetoSubcategoria(sheets, cliente.sheetId, aba.properties.sheetId, cabecalhoEfetivo));
      console.log(`  [${cliente.nome}] "${titulo}" protegida.`);
    } catch (e) {
      console.error(`  [${cliente.nome}] FALHA ao proteger "${titulo}": ${e.message}`);
    }
    await sleep(400);
  }
}

async function main() {
  const filtroNumero = process.argv[2] || null;
  const sheets = getSheetsClient();
  const todos = await listarClientesAtivos({ ignorarCache: true });
  const alvo = todos.filter((c) => c.ativo && (!filtroNumero || c.numeroWhatsapp === filtroNumero));

  console.log(`Protegendo planilha de ${alvo.length} cliente(s) ativo(s)${filtroNumero ? ` (filtro: ${filtroNumero})` : ''}...\n`);

  for (const cliente of alvo) {
    console.log(`--- ${cliente.nome} (${cliente.numeroWhatsapp}) ---`);
    await protegerPlanilhaDoCliente(sheets, cliente).catch((e) => console.error(`  ERRO GERAL nesse cliente: ${e.message}`));
    console.log('');
  }

  console.log('Concluído.');
}

main().catch((e) => { console.error('ERRO FATAL:', e.message); process.exit(1); });
