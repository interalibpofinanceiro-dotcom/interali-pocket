// Cria (ou reaproveita) a pasta de cada cliente ATIVO no Drive (16/09/2026) — cobre quem já
// existia ANTES da pasta virar automática (ver garantirPastaCliente em documentos-grandes.js,
// hookado em cadastrar-cliente.js e na ativação via checkout). Seguro rodar de novo: cliente que
// já tem Pasta_Drive_ID preenchido é pulado sem chamar o Drive.
//
// Uso:
//   node scripts/criar-pastas-drive-clientes.js                  # todos os clientes ATIVOS
//   node scripts/criar-pastas-drive-clientes.js "whatsapp:+55..." # só um cliente específico

require('dotenv').config();
const { listarClientesAtivos } = require('../clientes');
const { garantirPastaCliente } = require('../documentos-grandes');

async function main() {
  const filtroNumero = process.argv[2] || null;
  const todos = await listarClientesAtivos({ ignorarCache: true });
  const alvo = todos.filter((c) => c.ativo && (!filtroNumero || c.numeroWhatsapp === filtroNumero));

  console.log(`Criando pasta no Drive pra ${alvo.length} cliente(s) ativo(s)${filtroNumero ? ` (filtro: ${filtroNumero})` : ''}...\n`);

  for (const cliente of alvo) {
    if (cliente.pastaDriveId) {
      console.log(`--- ${cliente.nome} (${cliente.numeroWhatsapp}) --- já tem pasta (${cliente.pastaDriveId}), pulando.`);
      continue;
    }
    try {
      const pastaId = await garantirPastaCliente(cliente);
      console.log(`--- ${cliente.nome} (${cliente.numeroWhatsapp}) --- pasta criada: ${pastaId}`);
    } catch (erro) {
      console.error(`--- ${cliente.nome} (${cliente.numeroWhatsapp}) --- FALHA: ${erro.message}`);
    }
  }

  console.log('\nConcluído.');
}

main().catch((e) => { console.error('ERRO FATAL:', e.message); process.exit(1); });
