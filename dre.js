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
  // 17/08/2026 — relatório de venda de delivery que mostra a taxa da plataforma separada do valor
  // do pedido (em vez de já vir líquida): a taxa entra aqui, como dedução, não misturada na receita.
  { chave: 'deducao_taxas_plataforma', bloco: 'DEDUCOES', rotulo: 'Taxas de Plataformas de Delivery/Marketplace (iFood, Rappi, etc.)' },

  { chave: 'custo_cmv', bloco: 'CUSTOS', rotulo: 'Custo das Mercadorias Vendidas (CMV)' },
  { chave: 'custo_cpv', bloco: 'CUSTOS', rotulo: 'Matéria-Prima Utilizada (CPV)' },
  { chave: 'custo_diretos_servicos', bloco: 'CUSTOS', rotulo: 'Custos Diretos de Serviços Prestados' },
  // 17/08/2026 (pedido do Aroldo, sugestão do analista financeiro) — nichos de serviço/parceria
  // (salão-parceiro, barbearia com comissionados, autônomos associados) têm um custo direto que não
  // é "pessoal" (não é funcionário CLT) nem CMV — é repasse por serviço prestado por um parceiro.
  { chave: 'custo_comissao_parceiros', bloco: 'CUSTOS', rotulo: 'Comissões e Repasse a Profissionais Parceiros (Salão-Parceiro, Comissionados)' },
  // Idem — escritórios de advocacia/contabilidade: custas judiciais, certidões e taxas pagas em
  // nome de um processo. Muitas vezes reembolsável pelo cliente depois — se for o caso, considere
  // também registrar uma Conta a Receber correspondente (legenda "receber:") pra não perder o
  // controle da cobrança.
  { chave: 'custo_custas_processuais', bloco: 'CUSTOS', rotulo: 'Custas Processuais, Taxas Judiciais e Certidões (verificar se reembolsável pelo cliente)' },

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
  // 16/08/2026 — dízimo/oferta/doação (pedido do Aroldo, caso real de lançamento errado como
  // entrada). Chave própria pra não forçar em "Rendimentos" nem em nenhum grupo de receita — ver
  // REGRAS_FLUXO_ENTRADA_SAIDA em prompts.js.
  { chave: 'admin_doacoes_contribuicoes', bloco: 'DESPESAS_ADMIN', rotulo: 'Doações, Ofertas e Contribuições (Dízimo, ONG, Igreja)' },
  // 17/08/2026 — fatura de cartão extensa (várias páginas) lançada pelo RESUMO, sem detalhamento
  // item a item (ver PROMPT_FATURA_RESUMO/processarFaturaComoResumo). Chave própria pra não
  // misturar com "admin_sistemas_softwares" nem forçar numa categoria de nicho que não se aplica
  // a um lançamento consolidado.
  { chave: 'admin_fatura_cartao_consolidada', bloco: 'DESPESAS_ADMIN', rotulo: 'Fatura de Cartão de Crédito (Lançamento Consolidado, sem Detalhamento por Item)' },

  { chave: 'vendas_marketing', bloco: 'DESPESAS_VENDAS', rotulo: 'Anúncios e Tráfego Pago (Meta/Google Ads)' },
  { chave: 'vendas_comissoes', bloco: 'DESPESAS_VENDAS', rotulo: 'Comissões de Vendas' },
  { chave: 'vendas_fretes', bloco: 'DESPESAS_VENDAS', rotulo: 'Fretes de Entregas (Correios / Motoboy)' },

  { chave: 'financeiro_rendimentos', bloco: 'FINANCEIRO', rotulo: 'Rendimentos de Aplicações Financeiras' },
  { chave: 'financeiro_tarifas', bloco: 'FINANCEIRO', rotulo: 'Tarifas Bancárias e Manutenção de Conta' },
  { chave: 'financeiro_juros_emprestimos', bloco: 'FINANCEIRO', rotulo: 'Juros Pagos sobre Empréstimos Bancários' },
  { chave: 'financeiro_multas_atraso', bloco: 'FINANCEIRO', rotulo: 'Multas e Juros por Atraso de Contas' },

  // Bloco à parte (14/08/2026, pedido do Aroldo) — compra de equipamento, reforma, imobilizado.
  // Contabilmente NÃO é despesa do exercício (não entra no DRE/lucro líquido, vai pro balanço/
  // imobilizado) — por isso `gerarDRE()` em reconciliacao.js NUNCA soma este bloco em nenhum
  // total. Fica só marcado e consultável (ex.: "quanto investi em equipamento esse mês?"), pra
  // não misturar com despesa operacional nem inflar custo indevidamente.
  { chave: 'investimento_imobilizado', bloco: 'INVESTIMENTO', rotulo: 'Compra de Equipamentos, Reforma e Imobilizado' },

  // Bloco à parte (17/08/2026, sugestão do analista financeiro — risco crítico real: escritório de
  // advocacia recebe o valor total de um acordo/causa na própria conta, mas só uma parte é
  // honorário — o resto é do cliente do escritório e só está "de passagem"). Mesmo raciocínio do
  // bloco INVESTIMENTO acima: `gerarDRE()` NUNCA soma este bloco em nenhum total (nem receita, nem
  // despesa) — dinheiro de terceiro não é faturamento nem custo do negócio, só fica marcado e
  // consultável. Duas chaves (uma por direção) porque o dinheiro entra e depois sai de novo:
  { chave: 'repasse_terceiros_entrada', bloco: 'REPASSE_TERCEIROS', rotulo: 'Valores de Terceiros Recebidos (Repasse — Não é Receita Própria)' },
  { chave: 'repasse_terceiros_saida', bloco: 'REPASSE_TERCEIROS', rotulo: 'Repasse de Valores a Terceiros / Clientes' },

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
