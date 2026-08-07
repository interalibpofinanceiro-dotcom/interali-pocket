// Taxonomia fixa de classificação contábil (DRE Gerencial). Cada lançamento — comprovante ou
// conta a pagar — recebe um "grupo_dre" dentro desta lista, ALÉM da categoria/subcategoria
// dinâmica por nicho que já existia (prompts.js) — essa continua servindo pro "top categorias"
// do resumo, que é mais livre/específica do segmento. O grupo_dre é fixo e contábil, pra alimentar
// a Demonstração do Resultado do Exercício de forma sempre consistente entre clientes/nichos.
//
// Fonte: estrutura de DRE gerencial passada pelo contador especialista do Aroldo em 07/08/2026.
// Única fonte de verdade — tanto o prompt de extração (via listaParaPrompt) quanto o gerador da
// DRE (reconciliacao.js) usam esta mesma lista, pra nunca desalinhar.
const GRUPOS_DRE = [
  { chave: 'receita_venda_mercadorias', bloco: 'RECEITA_BRUTA', rotulo: 'Venda de Mercadorias / Produtos' },
  { chave: 'receita_prestacao_servicos', bloco: 'RECEITA_BRUTA', rotulo: 'Prestação de Serviços' },

  { chave: 'deducao_impostos_vendas', bloco: 'DEDUCOES', rotulo: 'Impostos sobre Vendas (Simples Nacional / DAS)' },
  { chave: 'deducao_devolucoes', bloco: 'DEDUCOES', rotulo: 'Devoluções e Cancelamentos de Vendas' },
  { chave: 'deducao_descontos', bloco: 'DEDUCOES', rotulo: 'Descontos Comerciais Concedidos' },

  { chave: 'custo_cmv', bloco: 'CUSTOS', rotulo: 'Custo das Mercadorias Vendidas (CMV)' },
  { chave: 'custo_cpv', bloco: 'CUSTOS', rotulo: 'Matéria-Prima Utilizada (CPV)' },
  { chave: 'custo_diretos_servicos', bloco: 'CUSTOS', rotulo: 'Custos Diretos de Serviços Prestados' },

  { chave: 'pessoal_salarios', bloco: 'DESPESAS_PESSOAL', rotulo: 'Salários e Ordenados' },
  { chave: 'pessoal_prolabore', bloco: 'DESPESAS_PESSOAL', rotulo: 'Pró-Labore dos Sócios' },
  { chave: 'pessoal_encargos', bloco: 'DESPESAS_PESSOAL', rotulo: 'Encargos Sociais (INSS / FGTS / Guias)' },
  { chave: 'pessoal_beneficios', bloco: 'DESPESAS_PESSOAL', rotulo: 'Benefícios (Vale Refeição / Transporte)' },
  { chave: 'pessoal_medicina_seguranca', bloco: 'DESPESAS_PESSOAL', rotulo: 'Medicina e Segurança do Trabalho' },

  { chave: 'admin_ocupacao', bloco: 'DESPESAS_ADMIN', rotulo: 'Aluguel, IPTU e Condomínio' },
  { chave: 'admin_utilidades', bloco: 'DESPESAS_ADMIN', rotulo: 'Utilidades (Água, Luz, Internet, Telefone)' },
  { chave: 'admin_insumos_internos', bloco: 'DESPESAS_ADMIN', rotulo: 'Insumos Internos (Padaria, Limpeza, Copa)' },
  { chave: 'admin_material_escritorio', bloco: 'DESPESAS_ADMIN', rotulo: 'Material de Escritório e Papelaria' },
  { chave: 'admin_servicos_tecnicos', bloco: 'DESPESAS_ADMIN', rotulo: 'Serviços Técnicos (Contador, Advogado)' },
  { chave: 'admin_sistemas_softwares', bloco: 'DESPESAS_ADMIN', rotulo: 'Sistemas e Softwares (ERP, SaaS, Nuvem)' },
  { chave: 'admin_manutencao', bloco: 'DESPESAS_ADMIN', rotulo: 'Manutenção e Reparos Gerais' },

  { chave: 'vendas_marketing', bloco: 'DESPESAS_VENDAS', rotulo: 'Anúncios e Tráfego Pago (Meta/Google Ads)' },
  { chave: 'vendas_comissoes', bloco: 'DESPESAS_VENDAS', rotulo: 'Comissões de Vendas' },
  { chave: 'vendas_fretes', bloco: 'DESPESAS_VENDAS', rotulo: 'Fretes de Entregas (Correios / Motoboy)' },

  { chave: 'financeiro_rendimentos', bloco: 'FINANCEIRO', rotulo: 'Rendimentos de Aplicações Financeiras' },
  { chave: 'financeiro_tarifas', bloco: 'FINANCEIRO', rotulo: 'Tarifas Bancárias e Manutenção de Conta' },
  { chave: 'financeiro_juros_emprestimos', bloco: 'FINANCEIRO', rotulo: 'Juros Pagos sobre Empréstimos Bancários' },
  { chave: 'financeiro_multas_atraso', bloco: 'FINANCEIRO', rotulo: 'Multas e Juros por Atraso de Contas' },

  { chave: 'nao_classificado', bloco: 'NAO_CLASSIFICADO', rotulo: 'Não Classificado' },
];

const ROTULO_BLOCO = {
  DESPESAS_PESSOAL: 'A. Despesas com Pessoal e Administração de Equipe',
  DESPESAS_ADMIN: 'B. Despesas Administrativas e de Estrutura',
  DESPESAS_VENDAS: 'C. Despesas com Vendas, Marketing e Logística',
};

function porChave(chave) {
  return GRUPOS_DRE.find((g) => g.chave === chave);
}

// Texto pronto pra colar dentro do prompt de extração (prompts.js) — lista cada chave válida
// com seu rótulo contábil, pra o Claude escolher a que melhor descreve o lançamento.
function listaParaPrompt() {
  return GRUPOS_DRE.map((g) => `  - "${g.chave}" — ${g.rotulo}`).join('\n');
}

module.exports = { GRUPOS_DRE, ROTULO_BLOCO, porChave, listaParaPrompt };
