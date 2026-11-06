const { AsyncLocalStorage } = require('async_hooks');

// Cliente da mensagem/tarefa em andamento (05/11/2026 — pacotes por nicho, ver nichos.js).
// Em vez de passar o nicho por parâmetro em cada uma das ~15 chamadas à IA, o servidor marca o
// cliente uma vez no começo do processamento (webhook, mídia, tarefa por cliente) e index.js lê
// daqui na hora de montar o pedido. Cada mensagem/tarefa tem seu próprio contexto — um cliente
// nunca enxerga o nicho de outro, mesmo com mensagens chegando ao mesmo tempo.
const armazenamento = new AsyncLocalStorage();

function definirClienteAtual(cliente) {
  if (!cliente) return;
  armazenamento.enterWith({ cliente });
}

function clienteAtual() {
  const store = armazenamento.getStore();
  return store ? store.cliente : null;
}

module.exports = { definirClienteAtual, clienteAtual };
