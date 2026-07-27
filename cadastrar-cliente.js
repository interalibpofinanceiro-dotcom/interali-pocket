require('dotenv').config();
const { adicionarCliente } = require('./clientes');

const [, , numero, nome, sheetId] = process.argv;

if (!numero || !nome || !sheetId) {
  console.log('Uso: node cadastrar-cliente.js "whatsapp:+55XXXXXXXXXXX" "Nome do Cliente" "ID_DA_PLANILHA"');
  process.exit(1);
}

adicionarCliente(numero, nome, sheetId)
  .then(() => {
    console.log(`Cliente "${nome}" (${numero}) cadastrado com sucesso.`);
  })
  .catch((erro) => {
    console.error('Erro ao cadastrar cliente:', erro.message);
    process.exit(1);
  });
