require('dotenv').config();

const ASAAS_API_URL = 'https://api.asaas.com/v3';
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;

async function chamarAsaas(caminho, opcoes = {}) {
  const resposta = await fetch(`${ASAAS_API_URL}${caminho}`, {
    method: opcoes.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      access_token: ASAAS_API_KEY,
    },
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });

  const dados = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    const mensagem = (dados.errors && dados.errors[0] && dados.errors[0].description) || `Asaas respondeu ${resposta.status}`;
    throw new Error(mensagem);
  }

  return dados;
}

// Evita criar um cliente Asaas duplicado toda vez que a mesma pessoa assina de novo
// (ex.: trocou de plano, ou tentou pagar e desistiu antes) — reusa pelo CPF/CNPJ.
async function buscarOuCriarCliente({ nome, cpfCnpj, telefone, email }) {
  const cpfCnpjLimpo = (cpfCnpj || '').replace(/\D/g, '');

  const existentes = await chamarAsaas(`/customers?cpfCnpj=${cpfCnpjLimpo}`);
  if (existentes.data && existentes.data.length > 0) {
    return existentes.data[0].id;
  }

  const novoCliente = await chamarAsaas('/customers', {
    method: 'POST',
    body: {
      name: nome,
      cpfCnpj: cpfCnpjLimpo,
      mobilePhone: (telefone || '').replace(/\D/g, ''),
      email: email || undefined,
    },
  });

  return novoCliente.id;
}

// billingType "UNDEFINED" deixa o cliente escolher Pix, boleto ou cartão na própria
// página hospedada do Asaas — não processamos dado de cartão diretamente, evitando
// escopo de PCI compliance que essa integração não precisa carregar.
async function criarAssinatura({ customerId, valor, descricao, referenciaExterna }) {
  const hoje = new Date().toISOString().slice(0, 10);

  return chamarAsaas('/subscriptions', {
    method: 'POST',
    body: {
      customer: customerId,
      billingType: 'UNDEFINED',
      value: valor,
      nextDueDate: hoje,
      cycle: 'MONTHLY',
      description: descricao,
      externalReference: referenciaExterna,
    },
  });
}

// A cobrança (com o link de pagamento hospedado) só existe depois que a assinatura é
// criada — o Asaas gera a primeira fatura automaticamente, então buscamos ela em seguida.
async function buscarLinkPagamento(subscriptionId) {
  const pagamentos = await chamarAsaas(`/payments?subscription=${subscriptionId}`);
  const primeiraFatura = pagamentos.data && pagamentos.data[0];
  return primeiraFatura ? primeiraFatura.invoiceUrl : null;
}

module.exports = {
  buscarOuCriarCliente,
  criarAssinatura,
  buscarLinkPagamento,
};
