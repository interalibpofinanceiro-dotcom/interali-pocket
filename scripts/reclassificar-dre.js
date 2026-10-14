// Reclassifica o HISTÓRICO de lançamentos sem grupo_dre válido (14/10/2026). Até essa data, todo
// lançamento que nascia só do extrato (Pix, aplicação/resgate de CDB, débito de fatura) entrava como
// "nao_classificado" e a DRE ficava sem valor gerencial (caso real: 285 de 386 lançamentos da
// Sirlene). Os extratos novos já passam pela classificação na hora (registrarOrfaosDoExtrato em
// server.js); este script corrige o que já estava gravado.
//
// Mesma regra do fluxo novo: primeiro as regras determinísticas (classificacao-bancaria.js), depois
// a IA em lote (classificarTransacoesParaDRE). O que a IA marca como ambíguo (confiança baixa ou
// "nao_classificado") NÃO é tocado — continua "revisar" na DRE.
//
// Uso:
//   node scripts/reclassificar-dre.js                 -> simula TODOS os clientes ativos (não grava)
//   node scripts/reclassificar-dre.js --aplicar       -> grava
//   node scripts/reclassificar-dre.js --sheet <ID>    -> só uma planilha
require('dotenv').config();
const { listarClientesAtivos } = require('../clientes');
const { buscarTodosLancamentos, getSheetsClient } = require('../sheets');
const { porChave } = require('../dre');
const { classificarTransacoesParaDRE } = require('../index');
const { classificarTransacaoBancaria, CHAVES_SEM_COMPROVANTE } = require('../classificacao-bancaria');

const APLICAR = process.argv.includes('--aplicar');
const idxSheet = process.argv.indexOf('--sheet');
const SO_SHEET = idxSheet > -1 ? process.argv[idxSheet + 1] : null;

const semGrupoValido = (l) => !l.grupo_dre || !porChave(l.grupo_dre) || l.grupo_dre === 'nao_classificado';

async function processarPlanilha(sheetId, nomeCliente) {
  const lancamentos = (await buscarTodosLancamentos(sheetId)).filter(semGrupoValido);
  if (!lancamentos.length) return { nomeCliente, candidatos: 0, alteracoes: [] };

  const transacoes = lancamentos.map((l) => ({
    data: l.data,
    tipo: l.tipo_movimentacao === 'entrada' ? 'entrada' : 'saida',
    valor: l.valor,
    // Categoria livre já escrita pelo cliente/analista (ex.: "Construção", "Salário") é pista valiosa.
    descricao: [l.descricao || l.estabelecimento_ou_pessoa, l.categoria && l.categoria !== 'Não Classificado' ? `[categoria informada: ${l.categoria}]` : '']
      .filter(Boolean).join(' '),
  }));

  const deterministicas = transacoes.map((t) => classificarTransacaoBancaria(t));
  const paraIA = transacoes.filter((_, i) => !deterministicas[i]);
  const porIA = paraIA.length ? await classificarTransacoesParaDRE(paraIA, { nomeCliente }) : [];

  const alteracoes = [];
  let iIA = 0;
  lancamentos.forEach((l, i) => {
    let nova = deterministicas[i];
    if (!nova) {
      const ia = porIA[iIA++];
      if (ia && ia.grupo_dre !== 'nao_classificado' && ia.confianca !== 'baixa') nova = { categoria: ia.categoria, grupo_dre: ia.grupo_dre };
    }
    if (!nova) return;
    alteracoes.push({ l, nova });
  });

  if (APLICAR && alteracoes.length) {
    const data = [];
    for (const { l, nova } of alteracoes) {
      data.push({ range: `'${l.aba}'!M${l.linha}`, values: [[nova.grupo_dre]] });
      // Só substitui a categoria quando ela era o genérico "Não Classificado" — categoria escrita
      // por gente (cliente/analista) é preservada.
      if (!l.categoria || l.categoria === 'Não Classificado') data.push({ range: `'${l.aba}'!I${l.linha}`, values: [[nova.categoria]] });
      if (CHAVES_SEM_COMPROVANTE.includes(nova.grupo_dre) && l.status_conciliacao === 'PENDENTE_COMPROVANTE') {
        data.push({ range: `'${l.aba}'!O${l.linha}:P${l.linha}`, values: [['CONCILIADO_OK', 'Movimento bancário (transferência/aplicação própria, tarifa, rendimento ou fatura) — reclassificado em 14/10/2026, sem comprovante a receber.']] });
      }
    }
    const sheets = getSheetsClient();
    for (let i = 0; i < data.length; i += 400) {
      await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: sheetId, requestBody: { valueInputOption: 'RAW', data: data.slice(i, i + 400) } });
    }
  }
  return { nomeCliente, candidatos: lancamentos.length, alteracoes };
}

(async () => {
  const clientes = await listarClientesAtivos({ ignorarCache: true });
  const vistos = new Map();
  for (const c of clientes) {
    if (!c.sheetId || (SO_SHEET && c.sheetId !== SO_SHEET)) continue;
    if (!vistos.has(c.sheetId)) vistos.set(c.sheetId, c.nome);
  }
  console.log(APLICAR ? '*** MODO APLICAR — gravando nas planilhas ***' : '--- SIMULAÇÃO (nada é gravado; use --aplicar) ---');
  for (const [sheetId, nome] of vistos) {
    try {
      const r = await processarPlanilha(sheetId, nome);
      const porGrupo = {};
      let valor = 0;
      r.alteracoes.forEach(({ l, nova }) => { porGrupo[nova.grupo_dre] = (porGrupo[nova.grupo_dre] || 0) + 1; valor += l.valor || 0; });
      console.log(`\n${nome}: ${r.candidatos} sem categoria contábil -> ${r.alteracoes.length} reclassificados (R$ ${valor.toFixed(2)}), ${r.candidatos - r.alteracoes.length} continuam "revisar"`);
      Object.entries(porGrupo).sort((a, b) => b[1] - a[1]).forEach(([g, n]) => console.log(`   ${String(n).padStart(4)}  ${g}`));
    } catch (erro) {
      console.log(`\n${nome}: ERRO ${erro.message}`);
    }
  }
})();
