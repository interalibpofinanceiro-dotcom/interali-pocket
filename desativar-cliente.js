require('dotenv').config();
const { desativarCliente } = require('./clientes');
const { enviarMensagemWhatsApp } = require('./whatsapp');

const [, , numero] = process.argv;

if (!numero) {
  console.log('Uso: node desativar-cliente.js "whatsapp:+55XXXXXXXXXXX"');
  process.exit(1);
}

async function main() {
  const cliente = await desativarCliente(numero);

  if (!cliente) {
    console.log(`Nenhum cliente encontrado com o número ${numero} na planilha mestre.`);
    return;
  }

  console.log(`Cliente "${cliente.nome}" (${numero}) desativado — ele não recebe mais respostas até ser reativado (Ativo=TRUE na planilha mestre).`);

  const admin = process.env.ADMIN_WHATSAPP_NUMBER;
  if (admin) {
    await enviarMensagemWhatsApp(admin, `⚠️ Cliente desativado no Interali Pocket: ${cliente.nome || ''} (${numero})`).catch(
      (erro) => console.error('Aviso: cliente desativado, mas não consegui notificar o admin:', erro.message)
    );
  }
}

main().catch((erro) => {
  console.error('Erro ao desativar cliente:', erro.message);
  process.exit(1);
});
