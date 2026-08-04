require('dotenv').config();
const { criarVoucher } = require('./vendas');

const [, , codigo, descricao] = process.argv;

if (!codigo) {
  console.log('Uso: node criar-voucher.js "BARBER-8912" "Descrição opcional (ex.: nome do cliente/indicação)"');
  process.exit(1);
}

criarVoucher(codigo, descricao)
  .then(() => {
    const codigoUpper = codigo.trim().toUpperCase();
    console.log(`Voucher "${codigoUpper}" criado com sucesso.`);
    console.log(`Link pra mandar pro cliente: https://interali-pocket-production.up.railway.app/?voucher=${codigoUpper}`);
  })
  .catch((erro) => {
    console.error('Erro ao criar voucher:', erro.message);
    process.exit(1);
  });
