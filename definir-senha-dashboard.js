require('dotenv').config();
const { definirSenhaDashboard } = require('./clientes');
const { hashSenhaDashboard } = require('./dashboard');

const [, , numero, senha] = process.argv;

if (!numero || !senha) {
  console.log('Uso: node definir-senha-dashboard.js "whatsapp:+55XXXXXXXXXXX" "senha-do-cliente"');
  process.exit(1);
}

if (senha.length < 6) {
  console.log('A senha precisa ter pelo menos 6 caracteres.');
  process.exit(1);
}

async function main() {
  const hash = hashSenhaDashboard(senha);
  const ok = await definirSenhaDashboard(numero, hash);

  if (!ok) {
    console.log(`Não achei nenhum cliente cadastrado com o número ${numero} na planilha mestre.`);
    process.exit(1);
  }

  console.log(`Senha do dashboard definida com sucesso pra ${numero}.`);
  console.log('O cliente já pode entrar em pocket.interali.com.br/dashboard/login com o WhatsApp e essa senha.');
}

main().catch((erro) => {
  console.error('Erro ao definir senha:', erro.message);
  process.exit(1);
});
