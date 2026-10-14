// Aplica o acesso padrão em TODAS as planilhas de clientes ativos (14/10/2026): equipe de BPO edita,
// cliente só lê, nenhum link aberto (aplicarCompartilhamentoPadrao em clientes.js) — e atualiza as
// proteções antigas das abas de lançamento, que só deixavam o service account editar (o especialista
// precisa ajustar a Categoria). A aba "DRE <ano>" continua travada só pro sistema (dre-anual.js).
//
// Uso: node scripts/aplicar-acesso-padrao.js
require('dotenv').config();
const { listarClientesAtivos, aplicarCompartilhamentoPadrao } = require('../clientes');
const { getSheetsClient, equipeEditores } = require('../sheets');

const DESCRICAO_PROTECAO = 'Interali Pocket — editado só pelo sistema/consultor';

(async () => {
  const sheets = getSheetsClient();
  const editores = [process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, ...equipeEditores()].filter(Boolean);
  const vistos = new Set();
  for (const cliente of await listarClientesAtivos({ ignorarCache: true })) {
    if (!cliente.sheetId || vistos.has(cliente.sheetId)) continue;
    vistos.add(cliente.sheetId);
    try {
      await aplicarCompartilhamentoPadrao(cliente.sheetId);
      const planilha = await sheets.spreadsheets.get({ spreadsheetId: cliente.sheetId, fields: 'sheets(protectedRanges(protectedRangeId,description))' });
      const protecoes = planilha.data.sheets.flatMap((s) => s.protectedRanges || []).filter((p) => p.description === DESCRICAO_PROTECAO);
      const requests = protecoes.map((p) => ({
        updateProtectedRange: { protectedRange: { protectedRangeId: p.protectedRangeId, editors: { users: editores } }, fields: 'editors' },
      }));
      for (let i = 0; i < requests.length; i += 100) {
        await sheets.spreadsheets.batchUpdate({ spreadsheetId: cliente.sheetId, requestBody: { requests: requests.slice(i, i + 100) } });
      }
      console.log(`${cliente.nome}: acesso padrão ok, ${protecoes.length} proteção(ões) liberada(s) pra equipe.`);
    } catch (erro) {
      console.log(`${cliente.nome}: ERRO ${erro.message}`);
    }
  }
})();
