require('dotenv').config();
const { adicionarCliente } = require('./clientes');
const { enviarMensagemWhatsApp } = require('./whatsapp');
const { estilizarPlanilhaCliente } = require('./sheets-styler');
const { garantirPastaCliente } = require('./documentos-grandes');

const [, , numero, nome, sheetId] = process.argv;

if (!numero || !nome || !sheetId) {
  console.log('Uso: node cadastrar-cliente.js "whatsapp:+55XXXXXXXXXXX" "Nome do Cliente" "ID_DA_PLANILHA"');
  process.exit(1);
}

async function main() {
  await adicionarCliente(numero, nome, sheetId);
  console.log(`Cliente "${nome}" (${numero}) cadastrado com sucesso.`);

  // Pasta do cliente no Drive (16/09/2026) — já deixa pronta no cadastro, não só na primeira vez
  // que ele mandar um documento pesado (ver garantirPastaCliente em documentos-grandes.js).
  await garantirPastaCliente({ numeroWhatsapp: numero, nome, sheetId, pastaDriveId: '' })
    .then((pastaId) => console.log(`Pasta no Drive criada/reaproveitada (ID: ${pastaId}).`))
    .catch((erro) => console.error('Aviso: cliente cadastrado, mas a criação da pasta no Drive falhou:', erro.message));

  await estilizarPlanilhaCliente(sheetId)
    .then((r) => console.log(`Planilha estilizada (${r.abasEstilizadas} aba(s)).`))
    .catch((erro) => console.error('Aviso: cliente cadastrado, mas a estilização da planilha falhou:', erro.message));

  const admin = process.env.ADMIN_WHATSAPP_NUMBER;
  if (admin) {
    await enviarMensagemWhatsApp(admin, `✅ Novo cliente ativado no Interali Pocket: ${nome} (${numero})`).catch(
      (erro) => console.error('Aviso: cliente cadastrado, mas não consegui notificar o admin:', erro.message)
    );
  }

  // Link de "criar senha" do painel web (16/09/2026) — mesmo mecanismo do "esqueci minha senha".
  // Gerar o token AQUI não funcionaria (fica na memória deste processo avulso, o servidor de
  // produção nunca ficaria sabendo dele) — em vez disso, chama o endpoint de verdade no servidor
  // rodando em produção, que já manda o link direto pro WhatsApp do cliente sozinho (mesma
  // mensagem de "esqueci minha senha"). Best-effort: se falhar (servidor fora do ar, sem internet),
  // só avisa — o cliente cadastrado continua normal, e sempre pode gerar o link sozinho depois
  // clicando em "Esqueci minha senha" na tela de login.
  await fetch('https://pocket.interali.com.br/dashboard/esqueci-senha', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ whatsapp: numero }),
  })
    .then((r) => (r.ok ? console.log('\nLink de criação de senha do painel já foi enviado pro WhatsApp do cliente.') : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch((erro) => console.error('Aviso: cliente cadastrado, mas não consegui mandar o link de senha do painel automaticamente:', erro.message));
}

main().catch((erro) => {
  console.error('Erro ao cadastrar cliente:', erro.message);
  process.exit(1);
});
