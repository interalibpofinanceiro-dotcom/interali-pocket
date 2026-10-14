// Classificador determinístico de transação bancária (tarifa, rendimento, transferência/aplicação
// do próprio titular, pagamento de fatura) a partir da descrição do extrato. Sem IA. Extraído de
// server.js em 14/10/2026 pra ser usado também pelo reprocessamento do histórico
// (scripts/reclassificar-dre.js). Histórico das regras: comentários em server.js, acima do require.
const RE_TARIFA = /\btarifa|cesta\s+de\s+servi[çc]|pacote\s+de\s+servi[çc]|manuten[çc][ãa]o\s+de\s+conta|tar\s+(ted|doc|pix|pacote)|\biof\b|anuidade|taxa\s+de\s+manuten|c\/c\s+tarifa/i;
const RE_RENDIMENTO = /rendimento|rend\s+pago|remunera[çc][ãa]o|juros\s+s\/?\s*saldo|juros\s+sobre\s+saldo|aplica[çc][ãa]o\s+autom.*rendiment|resgate.*rendiment/i;
const RE_TRANSF_MESMO_TITULAR = /transf(er[êe]ncia)?\s+entre\s+contas|mesma\s+titularidade|entre\s+contas\s+propri|aplica[çc][ãa]o\s+autom(?!.*rendiment)|resgate\s+autom(?!.*rendiment)|aplica[çc][ãa]o\s+financeira|resgate\s+de\s+aplica|\baplic(a[çc][ãa]o)?\s+(cdb|lci|lca|poupan|fundo|tesouro|rdb)|\bresgate\s+(cdb|lci|lca|poupan|fundo|tesouro|rdb)/i;
// 14/10/2026 — débito de fatura de cartão (caso real: "DEB AUTOR PORTOSEG SA CR" caía em não classificado).
const RE_PAGAMENTO_FATURA = /pag(amento|to)?\.?\s+(de\s+)?fatura|fatura\s+(do\s+)?cart|pgto\s+cart[ãa]o|deb\s+autor\s+.*(portoseg|nubank|itaucard|bradescard|santander\s+card|cartao|card)/i;

function classificarTransacaoBancaria(transacao) {
  const desc = transacao.descricao || '';
  if (RE_TRANSF_MESMO_TITULAR.test(desc)) {
    return { categoria: 'Transferência entre Contas', subcategoria: 'Mesmo titular', grupo_dre: 'transferencia_entre_contas' };
  }
  if (transacao.tipo === 'saida' && RE_PAGAMENTO_FATURA.test(desc)) {
    return { categoria: 'Fatura de Cartão de Crédito', subcategoria: 'Pagamento de fatura', grupo_dre: 'admin_fatura_cartao_consolidada' };
  }
  if (transacao.tipo === 'saida' && RE_TARIFA.test(desc)) {
    return { categoria: 'Tarifas Bancárias', subcategoria: 'Tarifa de conta', grupo_dre: 'financeiro_tarifas' };
  }
  if (transacao.tipo === 'entrada' && RE_RENDIMENTO.test(desc)) {
    return { categoria: 'Rendimentos de Aplicações', subcategoria: 'Rendimento de conta', grupo_dre: 'financeiro_rendimentos' };
  }
  return null;
}


// Chaves que, quando classificadas com segurança, dispensam comprovante (dinheiro do próprio banco
// ou só mudando de lugar) — entram CONCILIADO_OK.
const CHAVES_SEM_COMPROVANTE = ['transferencia_entre_contas', 'financeiro_tarifas', 'financeiro_rendimentos', 'financeiro_juros_emprestimos', 'financeiro_multas_atraso', 'admin_fatura_cartao_consolidada'];

module.exports = { classificarTransacaoBancaria, CHAVES_SEM_COMPROVANTE };
