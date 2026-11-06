require('dotenv').config();
const { listarClientesAtivos, definirNichoPorSheetId } = require('./clientes');
const { listaNichos } = require('./nichos');

// Define o nicho de um cliente que já existe (05/11/2026, ver nichos.js).
// Uso: npm run definir-nicho -- "parte do nome do cliente" NICHO
const [, , nomeCliente, nicho] = process.argv;

async function main() {
  if (!nomeCliente || !nicho) {
    console.log('Uso: npm run definir-nicho -- "Nome do Cliente" NICHO');
    console.log(`Nichos: ${listaNichos().join(' | ')}`);
    process.exit(1);
  }
  const clientes = await listarClientesAtivos({ ignorarCache: true });
  const alvo = nomeCliente.toLowerCase();
  const porPlanilha = new Map(clientes.filter((c) => c.nome.toLowerCase().includes(alvo)).map((c) => [c.sheetId, c]));
  if (porPlanilha.size !== 1) {
    console.error(porPlanilha.size ? `Mais de uma planilha encontrada: ${[...porPlanilha.values()].map((c) => c.nome).join(', ')}` : 'Nenhum cliente encontrado.');
    process.exit(1);
  }
  const [cliente] = porPlanilha.values();
  const { chave, linhas } = await definirNichoPorSheetId(cliente.sheetId, nicho);
  console.log(`${cliente.nome}: nicho ${chave} (${linhas} número(s)).`);
}

main().catch((erro) => { console.error(erro.message); process.exit(1); });
