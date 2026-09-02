require('dotenv').config();
const { adicionarCliente } = require('./clientes');
const { enviarMensagemWhatsApp } = require('./whatsapp');
const { estilizarPlanilhaCliente } = require('./sheets-styler');

const [, , numero, nome, sheetId] = process.argv;

if (!numero || !nome || !sheetId) {
  console.log('Uso: node cadastrar-cliente.js "whatsapp:+55XXXXXXXXXXX" "Nome do Cliente" "ID_DA_PLANILHA"');
  process.exit(1);
}

async function main() {
  await adicionarCliente(numero, nome, sheetId);
  console.log(`Cliente "${nome}" (${numero}) cadastrado com sucesso.`);

  await estilizarPlanilhaCliente(sheetId)
    .then((r) => console.log(`Planilha estilizada (${r.abasEstilizadas} aba(s)).`))
    .catch((erro) => console.error('Aviso: cliente cadastrado, mas a estilização da planilha falhou:', erro.message));

  const admin = process.env.ADMIN_WHATSAPP_NUMBER;
  if (admin) {
    await enviarMensagemWhatsApp(admin, `✅ Novo cliente ativado no Interali Pocket: ${nome} (${numero})`).catch(
      (erro) => console.error('Aviso: cliente cadastrado, mas não consegui notificar o admin:', erro.message)
    );
  }
}

main().catch((erro) => {
  console.error('Erro ao cadastrar cliente:', erro.message);
  process.exit(1);
});
