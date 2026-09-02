// 02/09/2026 — mapa CNAE -> categoria/grupo_dre. Traduz a ATIVIDADE ECONÔMICA do fornecedor
// (consultada via cnae.js) numa sugestão de classificação financeira.
//
// PRINCÍPIO (visão de analista financeiro): o CNAE diz o que o FORNECEDOR faz, não a natureza
// exata do gasto pro COMPRADOR. Um supermercado (CNAE 47.11) pode ser rancho pessoal OU reposição
// de estoque de um restaurante — só os itens do comprovante desempatam. Por isso este mapa só
// devolve sugestão com confiança "alta" pra atividades onde a natureza do gasto é praticamente
// inequívoca pra qualquer negócio (serviço contábil, energia elétrica, telecom, agência de
// publicidade, hospedagem/SaaS...). Pra todo o resto devolve confiança "media" (que o server.js
// usa só como NOTA em observações, sem trocar a categoria) ou null.
//
// O server.js (enriquecerLancamentoComCnae) só APLICA a sugestão de fato quando: (a) a IA não
// classificou (grupo_dre 'nao_classificado' / categoria genérica) E a confiança é "alta"; ou
// (b) já existe histórico do mesmo CNPJ naquele cliente (memória de fornecedor, tem prioridade).
// Nunca sobrescreve uma classificação boa que a IA já fez lendo o documento de verdade.

const { porChave } = require('./dre');

// Chave = prefixo do código CNAE (2 dígitos = divisão, ou 4-5 = grupo/classe). O lookup testa do
// mais específico pro mais genérico. `grupo_dre` tem que existir em dre.js (GRUPOS_DRE).
const MAPA = [
  // --- ALTA confiança: despesa B2B de natureza inequívoca, qualquer nicho ---
  { prefixo: '6920', categoria: 'Serviços Contábeis', subcategoria: 'Contabilidade', grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '6911', categoria: 'Serviços Jurídicos', subcategoria: 'Advocacia', grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '6912', categoria: 'Serviços Jurídicos', subcategoria: 'Cartório', grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '7020', categoria: 'Consultoria Empresarial', subcategoria: 'Consultoria de gestão', grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '7311', categoria: 'Marketing / Anúncios', subcategoria: 'Agência de publicidade', grupo_dre: 'vendas_marketing', confianca: 'alta' },
  { prefixo: '7312', categoria: 'Marketing / Anúncios', subcategoria: 'Mídia / veiculação', grupo_dre: 'vendas_marketing', confianca: 'alta' },
  { prefixo: '7319', categoria: 'Marketing / Anúncios', subcategoria: 'Publicidade (outros)', grupo_dre: 'vendas_marketing', confianca: 'alta' },
  { prefixo: '620', categoria: 'Sistemas e Software', subcategoria: 'Desenvolvimento / TI', grupo_dre: 'admin_sistemas_softwares', confianca: 'alta' },
  { prefixo: '6311', categoria: 'Sistemas e Software', subcategoria: 'Hospedagem / nuvem', grupo_dre: 'admin_sistemas_softwares', confianca: 'alta' },
  { prefixo: '6319', categoria: 'Sistemas e Software', subcategoria: 'Portais / serviços web', grupo_dre: 'admin_sistemas_softwares', confianca: 'alta' },
  { prefixo: '61', categoria: 'Utilidades', subcategoria: 'Telefone / Internet', grupo_dre: 'admin_utilidades', confianca: 'alta' },
  { prefixo: '3511', categoria: 'Utilidades', subcategoria: 'Energia elétrica (geração)', grupo_dre: 'admin_utilidades', confianca: 'alta' },
  { prefixo: '3513', categoria: 'Utilidades', subcategoria: 'Energia elétrica', grupo_dre: 'admin_utilidades', confianca: 'alta' },
  { prefixo: '3514', categoria: 'Utilidades', subcategoria: 'Energia elétrica', grupo_dre: 'admin_utilidades', confianca: 'alta' },
  { prefixo: '3600', categoria: 'Utilidades', subcategoria: 'Água e esgoto', grupo_dre: 'admin_utilidades', confianca: 'alta' },
  { prefixo: '381', categoria: 'Utilidades', subcategoria: 'Coleta de resíduos', grupo_dre: 'admin_utilidades', confianca: 'alta' },

  // --- MEDIA confiança: provável, mas depende do contexto do comprador — vira só NOTA ---
  { prefixo: '641', categoria: 'Tarifas Bancárias', subcategoria: 'Banco', grupo_dre: 'financeiro_tarifas', confianca: 'media' },
  { prefixo: '649', categoria: 'Serviços Financeiros', subcategoria: 'Crédito / financeira', grupo_dre: 'financeiro_juros_emprestimos', confianca: 'media' },
  { prefixo: '6622', categoria: 'Seguros', subcategoria: 'Corretora de seguros', grupo_dre: 'admin_servicos_tecnicos', confianca: 'media' },
  { prefixo: '681', categoria: 'Ocupação', subcategoria: 'Imóveis', grupo_dre: 'admin_ocupacao', confianca: 'media' },
  { prefixo: '682', categoria: 'Ocupação', subcategoria: 'Aluguel de imóvel', grupo_dre: 'admin_ocupacao', confianca: 'media' },
  { prefixo: '4930', categoria: 'Frete / Transporte', subcategoria: 'Transporte rodoviário de carga', grupo_dre: 'vendas_fretes', confianca: 'media' },
  { prefixo: '5320', categoria: 'Frete / Transporte', subcategoria: 'Entrega / courier', grupo_dre: 'vendas_fretes', confianca: 'media' },
  { prefixo: '5310', categoria: 'Frete / Transporte', subcategoria: 'Correios', grupo_dre: 'vendas_fretes', confianca: 'media' },
  { prefixo: '4520', categoria: 'Manutenção de Veículos', subcategoria: 'Oficina', grupo_dre: 'admin_manutencao', confianca: 'media' },
  { prefixo: '4711', categoria: 'Compras em Mercado/Atacado', subcategoria: 'Supermercado', grupo_dre: null, confianca: 'media' },
  { prefixo: '4712', categoria: 'Compras em Mercado/Atacado', subcategoria: 'Minimercado', grupo_dre: null, confianca: 'media' },
  { prefixo: '4639', categoria: 'Compras em Atacado', subcategoria: 'Atacado de alimentos', grupo_dre: null, confianca: 'media' },
  { prefixo: '4930', categoria: 'Combustível', subcategoria: 'Posto de combustível', grupo_dre: null, confianca: 'media' },
  { prefixo: '4731', categoria: 'Combustível', subcategoria: 'Posto de combustível', grupo_dre: null, confianca: 'media' },
  { prefixo: '5611', categoria: 'Alimentação (refeições)', subcategoria: 'Restaurante / lanchonete', grupo_dre: null, confianca: 'media' },
  { prefixo: '8630', categoria: 'Saúde', subcategoria: 'Serviços médicos / clínica', grupo_dre: null, confianca: 'media' },
  { prefixo: '85', categoria: 'Educação / Treinamento', subcategoria: 'Cursos e capacitação', grupo_dre: 'admin_servicos_tecnicos', confianca: 'media' },
];

function normalizarCodigo(codigo) {
  return String(codigo == null ? '' : codigo).replace(/\D/g, '');
}

// Testa um código CNAE (formato "5611-2/01" ou "5611201") contra o mapa, do prefixo mais longo
// pro mais curto. Devolve a entrada do mapa ou null.
function casarPrefixo(codigo) {
  const digitos = normalizarCodigo(codigo);
  if (!digitos) return null;

  const candidatos = MAPA
    .filter((entrada) => digitos.startsWith(entrada.prefixo))
    .sort((a, b) => b.prefixo.length - a.prefixo.length);

  return candidatos[0] || null;
}

// Recebe o registro de CNAE (cnae.js: { cnae_codigo, cnae_descricao, cnaes_secundarios }) e o
// tipo do lançamento. Devolve { categoria, subcategoria, grupo_dre, confianca, motivo } ou null.
// Só sugere pra "saida" — o CNAE de um cliente/pagador não classifica a RECEITA do seu cliente.
function sugerirPorCNAE(registroCnae, tipoMovimentacao = 'saida') {
  if (!registroCnae || tipoMovimentacao !== 'saida') return null;

  const principal = casarPrefixo(registroCnae.cnae_codigo);
  if (!principal) return null;

  // Segurança: só devolve grupo_dre que exista de verdade em dre.js e seja de saída.
  let grupoDre = principal.grupo_dre;
  if (grupoDre) {
    const def = porChave(grupoDre);
    const blocoEntrada = def && ['RECEITA_BRUTA', 'REPASSE_TERCEIROS'].includes(def.bloco);
    if (!def || def.chave === 'financeiro_rendimentos' || blocoEntrada) grupoDre = null;
  }

  return {
    categoria: principal.categoria,
    subcategoria: principal.subcategoria || null,
    grupo_dre: grupoDre,
    confianca: principal.confianca,
    motivo: `Fornecedor com atividade "${registroCnae.cnae_descricao || principal.subcategoria}" (CNAE ${registroCnae.cnae_codigo}).`,
  };
}

module.exports = { sugerirPorCNAE, casarPrefixo };
