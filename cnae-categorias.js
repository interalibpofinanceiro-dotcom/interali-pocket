// 02-03/09/2026 — mapa CNAE -> categoria/grupo_dre. Traduz a ATIVIDADE ECONÔMICA do fornecedor
// (consultada via cnae.js) numa sugestão de classificação financeira.
//
// PRINCÍPIO: o CNAE diz o que o FORNECEDOR faz. Pra atividade de serviço B2B (contador, energia,
// telecom, agência...) isso define a natureza do gasto com quase certeza -> confiança "alta".
// Pra comércio (mercado, atacado, loja) depende do que o cliente comprou e do nicho dele ->
// "media": o CNAE ajuda, mas os itens do comprovante / a leitura da IA mandam mais.
//
// COMO O server.js USA (enriquecerLancamentoComCnae):
//   - confiança "alta"  -> aplica o grupo_dre SEMPRE (menos chaves protegidas de contexto:
//                          transferência, repasse, investimento, dízimo); aplica a categoria se
//                          a IA tiver deixado genérica.
//   - confiança "media" -> aplica o grupo_dre só se a IA deixou "nao_classificado"/vazio; aplica
//                          a categoria se genérica.
//   - sempre grava CNPJ/razão/CNAE nas colunas de metadado + nota nas observações.
// Nunca faz 2ª chamada ao Claude.

const { porChave } = require('./dre');

// prefixo = começo do código CNAE só com dígitos (ex.: "6920" casa "6920-6/01"). Testa do prefixo
// mais longo pro mais curto. grupo_dre tem que existir em dre.js.
const MAPA = [
  // ===== SERVIÇOS PROFISSIONAIS (alta) =====
  { prefixo: '6920', categoria: 'Serviços Contábeis', subcategoria: 'Contabilidade', grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '6911', categoria: 'Serviços Jurídicos', subcategoria: 'Advocacia', grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '6912', categoria: 'Serviços Jurídicos', subcategoria: 'Cartório / Tabelionato', grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '69', categoria: 'Serviços Jurídicos / Contábeis', subcategoria: null, grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '7020', categoria: 'Consultoria Empresarial', subcategoria: 'Gestão', grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '711', categoria: 'Serviços de Engenharia / Arquitetura', subcategoria: null, grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '712', categoria: 'Ensaios e Análises Técnicas', subcategoria: null, grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '7810', categoria: 'Recrutamento e Seleção', subcategoria: 'RH', grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '7820', categoria: 'Mão de Obra Temporária', subcategoria: 'RH', grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '822', categoria: 'Teleatendimento / Call Center', subcategoria: null, grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '8020', categoria: 'Monitoramento de Segurança', subcategoria: null, grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '8011', categoria: 'Vigilância / Segurança Privada', subcategoria: null, grupo_dre: 'admin_servicos_tecnicos', confianca: 'alta' },
  { prefixo: '7490', categoria: 'Serviços Técnicos Profissionais', subcategoria: null, grupo_dre: 'admin_servicos_tecnicos', confianca: 'media' },
  { prefixo: '7410', categoria: 'Design', subcategoria: null, grupo_dre: 'admin_servicos_tecnicos', confianca: 'media' },
  { prefixo: '7420', categoria: 'Serviços de Fotografia', subcategoria: null, grupo_dre: 'admin_servicos_tecnicos', confianca: 'media' },
  { prefixo: '8599', categoria: 'Treinamento / Capacitação', subcategoria: null, grupo_dre: 'admin_servicos_tecnicos', confianca: 'media' },
  { prefixo: '85', categoria: 'Educação / Cursos', subcategoria: null, grupo_dre: 'admin_servicos_tecnicos', confianca: 'media' },

  // ===== MARKETING / PUBLICIDADE (alta) =====
  { prefixo: '7311', categoria: 'Marketing / Anúncios', subcategoria: 'Agência de publicidade', grupo_dre: 'vendas_marketing', confianca: 'alta' },
  { prefixo: '7312', categoria: 'Marketing / Anúncios', subcategoria: 'Mídia exterior', grupo_dre: 'vendas_marketing', confianca: 'alta' },
  { prefixo: '7319', categoria: 'Marketing / Anúncios', subcategoria: 'Publicidade (outros)', grupo_dre: 'vendas_marketing', confianca: 'alta' },
  { prefixo: '7320', categoria: 'Pesquisa de Mercado', subcategoria: null, grupo_dre: 'vendas_marketing', confianca: 'alta' },
  { prefixo: '731', categoria: 'Marketing / Anúncios', subcategoria: null, grupo_dre: 'vendas_marketing', confianca: 'alta' },
  { prefixo: '5912', categoria: 'Produção de Vídeo / Audiovisual', subcategoria: null, grupo_dre: 'vendas_marketing', confianca: 'media' },
  { prefixo: '5911', categoria: 'Produção de Vídeo / Audiovisual', subcategoria: null, grupo_dre: 'vendas_marketing', confianca: 'media' },
  { prefixo: '1813', categoria: 'Serviços Gráficos / Impressão', subcategoria: null, grupo_dre: 'vendas_marketing', confianca: 'media' },
  { prefixo: '1811', categoria: 'Serviços Gráficos / Impressão', subcategoria: null, grupo_dre: 'vendas_marketing', confianca: 'media' },

  // ===== SISTEMAS E SOFTWARE (alta) =====
  { prefixo: '6201', categoria: 'Sistemas e Software', subcategoria: 'Desenvolvimento', grupo_dre: 'admin_sistemas_softwares', confianca: 'alta' },
  { prefixo: '6202', categoria: 'Sistemas e Software', subcategoria: 'Customização', grupo_dre: 'admin_sistemas_softwares', confianca: 'alta' },
  { prefixo: '6203', categoria: 'Sistemas e Software', subcategoria: 'Licenciamento', grupo_dre: 'admin_sistemas_softwares', confianca: 'alta' },
  { prefixo: '6204', categoria: 'Sistemas e Software', subcategoria: 'Licenciamento', grupo_dre: 'admin_sistemas_softwares', confianca: 'alta' },
  { prefixo: '6209', categoria: 'Sistemas e Software', subcategoria: 'Suporte / TI', grupo_dre: 'admin_sistemas_softwares', confianca: 'alta' },
  { prefixo: '620', categoria: 'Sistemas e Software', subcategoria: 'TI', grupo_dre: 'admin_sistemas_softwares', confianca: 'alta' },
  { prefixo: '6311', categoria: 'Sistemas e Software', subcategoria: 'Hospedagem / nuvem', grupo_dre: 'admin_sistemas_softwares', confianca: 'alta' },
  { prefixo: '6319', categoria: 'Sistemas e Software', subcategoria: 'Portais / serviços web', grupo_dre: 'admin_sistemas_softwares', confianca: 'alta' },
  { prefixo: '5820', categoria: 'Sistemas e Software', subcategoria: 'Edição de software', grupo_dre: 'admin_sistemas_softwares', confianca: 'alta' },
  { prefixo: '6010', categoria: 'Assinaturas / Streaming', subcategoria: 'Rádio', grupo_dre: 'admin_sistemas_softwares', confianca: 'media' },
  { prefixo: '6020', categoria: 'Assinaturas / Streaming', subcategoria: 'TV / vídeo', grupo_dre: 'admin_sistemas_softwares', confianca: 'media' },

  // ===== UTILIDADES (alta) =====
  { prefixo: '3511', categoria: 'Utilidades', subcategoria: 'Energia elétrica', grupo_dre: 'admin_utilidades', confianca: 'alta' },
  { prefixo: '3513', categoria: 'Utilidades', subcategoria: 'Energia elétrica', grupo_dre: 'admin_utilidades', confianca: 'alta' },
  { prefixo: '3514', categoria: 'Utilidades', subcategoria: 'Energia elétrica', grupo_dre: 'admin_utilidades', confianca: 'alta' },
  { prefixo: '35', categoria: 'Utilidades', subcategoria: 'Energia / gás', grupo_dre: 'admin_utilidades', confianca: 'alta' },
  { prefixo: '3600', categoria: 'Utilidades', subcategoria: 'Água', grupo_dre: 'admin_utilidades', confianca: 'alta' },
  { prefixo: '37', categoria: 'Utilidades', subcategoria: 'Esgoto', grupo_dre: 'admin_utilidades', confianca: 'alta' },
  { prefixo: '381', categoria: 'Utilidades', subcategoria: 'Coleta de resíduos', grupo_dre: 'admin_utilidades', confianca: 'alta' },
  { prefixo: '61', categoria: 'Utilidades', subcategoria: 'Telefone / Internet', grupo_dre: 'admin_utilidades', confianca: 'alta' },

  // ===== OCUPAÇÃO / IMÓVEIS (alta pra serviço, media pra compra) =====
  { prefixo: '6821', categoria: 'Ocupação', subcategoria: 'Corretagem / intermediação imobiliária', grupo_dre: 'admin_ocupacao', confianca: 'alta' },
  { prefixo: '6822', categoria: 'Ocupação', subcategoria: 'Administração de imóveis', grupo_dre: 'admin_ocupacao', confianca: 'alta' },
  { prefixo: '8112', categoria: 'Ocupação', subcategoria: 'Condomínio', grupo_dre: 'admin_ocupacao', confianca: 'alta' },
  { prefixo: '8121', categoria: 'Ocupação', subcategoria: 'Limpeza predial / facilities', grupo_dre: 'admin_ocupacao', confianca: 'alta' },
  { prefixo: '8122', categoria: 'Ocupação', subcategoria: 'Limpeza predial / facilities', grupo_dre: 'admin_ocupacao', confianca: 'alta' },
  { prefixo: '8129', categoria: 'Ocupação', subcategoria: 'Serviços prediais', grupo_dre: 'admin_ocupacao', confianca: 'alta' },
  { prefixo: '6810', categoria: 'Ocupação', subcategoria: 'Imóveis', grupo_dre: 'admin_ocupacao', confianca: 'media' },
  { prefixo: '682', categoria: 'Ocupação', subcategoria: 'Aluguel de imóvel', grupo_dre: 'admin_ocupacao', confianca: 'media' },

  // ===== VEÍCULOS (alta) =====
  { prefixo: '4520', categoria: 'Veículos', subcategoria: 'Manutenção / oficina', grupo_dre: 'admin_veiculos', confianca: 'alta' },
  { prefixo: '4531', categoria: 'Veículos', subcategoria: 'Peças e acessórios', grupo_dre: 'admin_veiculos', confianca: 'media' },
  { prefixo: '4532', categoria: 'Veículos', subcategoria: 'Peças e acessórios', grupo_dre: 'admin_veiculos', confianca: 'media' },
  { prefixo: '4731', categoria: 'Veículos', subcategoria: 'Combustível', grupo_dre: 'admin_veiculos', confianca: 'alta' },
  { prefixo: '4732', categoria: 'Veículos', subcategoria: 'Lubrificantes', grupo_dre: 'admin_veiculos', confianca: 'alta' },
  { prefixo: '4923', categoria: 'Veículos', subcategoria: 'Táxi / transporte de passageiros', grupo_dre: 'admin_veiculos', confianca: 'alta' },
  { prefixo: '4929', categoria: 'Veículos', subcategoria: 'Transporte de passageiros', grupo_dre: 'admin_veiculos', confianca: 'media' },
  { prefixo: '5223', categoria: 'Veículos', subcategoria: 'Estacionamento', grupo_dre: 'admin_veiculos', confianca: 'alta' },
  { prefixo: '7711', categoria: 'Veículos', subcategoria: 'Locação de automóvel', grupo_dre: 'admin_veiculos', confianca: 'alta' },
  { prefixo: '5221', categoria: 'Veículos', subcategoria: 'Pedágio / rodovia', grupo_dre: 'admin_veiculos', confianca: 'media' },

  // ===== FRETE / LOGÍSTICA (alta) =====
  { prefixo: '4930', categoria: 'Frete / Transporte de Carga', subcategoria: null, grupo_dre: 'vendas_fretes', confianca: 'alta' },
  { prefixo: '5211', categoria: 'Armazenagem', subcategoria: null, grupo_dre: 'vendas_fretes', confianca: 'alta' },
  { prefixo: '5212', categoria: 'Armazenagem', subcategoria: null, grupo_dre: 'vendas_fretes', confianca: 'alta' },
  { prefixo: '5250', categoria: 'Frete / Agenciamento de Carga', subcategoria: null, grupo_dre: 'vendas_fretes', confianca: 'alta' },
  { prefixo: '5310', categoria: 'Correios / Encomendas', subcategoria: null, grupo_dre: 'vendas_fretes', confianca: 'alta' },
  { prefixo: '5320', categoria: 'Courier / Motoboy', subcategoria: null, grupo_dre: 'vendas_fretes', confianca: 'alta' },

  // ===== FINANCEIRO (media) =====
  { prefixo: '6421', categoria: 'Tarifas Bancárias', subcategoria: 'Banco', grupo_dre: 'financeiro_tarifas', confianca: 'media' },
  { prefixo: '6422', categoria: 'Tarifas Bancárias', subcategoria: 'Banco', grupo_dre: 'financeiro_tarifas', confianca: 'media' },
  { prefixo: '6423', categoria: 'Tarifas Bancárias', subcategoria: 'Cooperativa de crédito', grupo_dre: 'financeiro_tarifas', confianca: 'media' },
  { prefixo: '641', categoria: 'Tarifas Bancárias', subcategoria: 'Banco', grupo_dre: 'financeiro_tarifas', confianca: 'media' },
  { prefixo: '6491', categoria: 'Juros / Financiamento', subcategoria: 'Financeira', grupo_dre: 'financeiro_juros_emprestimos', confianca: 'media' },
  { prefixo: '6492', categoria: 'Juros / Financiamento', subcategoria: 'Crédito', grupo_dre: 'financeiro_juros_emprestimos', confianca: 'media' },
  { prefixo: '6550', categoria: 'Benefícios - Plano de Saúde', subcategoria: null, grupo_dre: 'pessoal_beneficios', confianca: 'media' },
  { prefixo: '6512', categoria: 'Seguros', subcategoria: null, grupo_dre: 'admin_servicos_tecnicos', confianca: 'media' },
  { prefixo: '6622', categoria: 'Seguros', subcategoria: 'Corretora', grupo_dre: 'admin_servicos_tecnicos', confianca: 'media' },

  // ===== MATERIAL / INSUMOS INTERNOS (media) =====
  { prefixo: '4761', categoria: 'Material de Escritório e Papelaria', subcategoria: null, grupo_dre: 'admin_material_escritorio', confianca: 'media' },
  { prefixo: '172', categoria: 'Material de Escritório e Papelaria', subcategoria: 'Papel', grupo_dre: 'admin_material_escritorio', confianca: 'media' },
  { prefixo: '4789', categoria: 'Insumos Internos / Limpeza', subcategoria: null, grupo_dre: 'admin_insumos_internos', confianca: 'media' },
  { prefixo: '2061', categoria: 'Insumos Internos / Limpeza', subcategoria: 'Sabões e detergentes', grupo_dre: 'admin_insumos_internos', confianca: 'media' },
  { prefixo: '2062', categoria: 'Insumos Internos / Limpeza', subcategoria: 'Produtos de limpeza', grupo_dre: 'admin_insumos_internos', confianca: 'media' },

  // ===== COMÉRCIO / CMV — sempre media (depende do nicho e dos itens) =====
  { prefixo: '461', categoria: 'Compra de Mercadorias (Atacado)', subcategoria: null, grupo_dre: 'custo_cmv', confianca: 'media' },
  { prefixo: '462', categoria: 'Compra de Insumos (Atacado Agro)', subcategoria: null, grupo_dre: 'custo_cmv', confianca: 'media' },
  { prefixo: '463', categoria: 'Compra de Mercadorias - Alimentos (Atacado)', subcategoria: null, grupo_dre: 'custo_cmv', confianca: 'media' },
  { prefixo: '464', categoria: 'Compra de Mercadorias (Atacado)', subcategoria: null, grupo_dre: 'custo_cmv', confianca: 'media' },
  { prefixo: '469', categoria: 'Compra de Mercadorias (Atacado)', subcategoria: null, grupo_dre: 'custo_cmv', confianca: 'media' },
  { prefixo: '4711', categoria: 'Compra em Supermercado', subcategoria: null, grupo_dre: null, confianca: 'media' },
  { prefixo: '4712', categoria: 'Compra em Minimercado / Mercearia', subcategoria: null, grupo_dre: null, confianca: 'media' },
  { prefixo: '4721', categoria: 'Compra - Padaria / Alimentos', subcategoria: null, grupo_dre: null, confianca: 'media' },
  { prefixo: '4722', categoria: 'Compra - Açougue / Carnes', subcategoria: null, grupo_dre: null, confianca: 'media' },
  { prefixo: '4723', categoria: 'Compra - Bebidas', subcategoria: null, grupo_dre: null, confianca: 'media' },
  { prefixo: '4729', categoria: 'Compra - Alimentos (Varejo)', subcategoria: null, grupo_dre: null, confianca: 'media' },
  { prefixo: '10', categoria: 'Matéria-Prima (Indústria de Alimentos)', subcategoria: null, grupo_dre: 'custo_cpv', confianca: 'media' },
  { prefixo: '11', categoria: 'Matéria-Prima (Bebidas)', subcategoria: null, grupo_dre: 'custo_cpv', confianca: 'media' },

  // ===== ALIMENTAÇÃO / REFEIÇÕES (media — pode ser refeição de equipe, cliente, ou pessoal) =====
  { prefixo: '5611', categoria: 'Alimentação (Refeições)', subcategoria: 'Restaurante / lanchonete', grupo_dre: null, confianca: 'media' },
  { prefixo: '5612', categoria: 'Alimentação (Refeições)', subcategoria: 'Ambulante', grupo_dre: null, confianca: 'media' },
  { prefixo: '5620', categoria: 'Alimentação (Fornecimento)', subcategoria: 'Catering / marmita', grupo_dre: 'pessoal_beneficios', confianca: 'media' },

  // ===== SAÚDE / BEM-ESTAR (media) =====
  { prefixo: '8610', categoria: 'Saúde', subcategoria: 'Hospital', grupo_dre: null, confianca: 'media' },
  { prefixo: '8630', categoria: 'Saúde', subcategoria: 'Consultório / clínica', grupo_dre: null, confianca: 'media' },
  { prefixo: '8640', categoria: 'Saúde', subcategoria: 'Exames laboratoriais', grupo_dre: null, confianca: 'media' },
  { prefixo: '4771', categoria: 'Saúde', subcategoria: 'Farmácia', grupo_dre: null, confianca: 'media' },
  { prefixo: '9313', categoria: 'Saúde e Bem-estar', subcategoria: 'Academia', grupo_dre: null, confianca: 'media' },
];

function normalizarCodigo(codigo) {
  return String(codigo == null ? '' : codigo).replace(/\D/g, '');
}

function casarPrefixo(codigo) {
  const digitos = normalizarCodigo(codigo);
  if (!digitos) return null;
  const candidatos = MAPA
    .filter((entrada) => digitos.startsWith(entrada.prefixo))
    .sort((a, b) => b.prefixo.length - a.prefixo.length);
  return candidatos[0] || null;
}

// Só sugere pra "saida" — o CNAE de um cliente/pagador não classifica a RECEITA do seu cliente.
function sugerirPorCNAE(registroCnae, tipoMovimentacao = 'saida') {
  if (!registroCnae || tipoMovimentacao !== 'saida') return null;

  const principal = casarPrefixo(registroCnae.cnae_codigo);
  if (!principal) return null;

  let grupoDre = principal.grupo_dre;
  if (grupoDre) {
    const def = porChave(grupoDre);
    const blocoEntrada = def && ['RECEITA_BRUTA', 'REPASSE_TERCEIROS', 'TRANSFERENCIA_CONTAS'].includes(def.bloco);
    if (!def || def.chave === 'financeiro_rendimentos' || blocoEntrada) grupoDre = null;
  }

  return {
    categoria: principal.categoria,
    subcategoria: principal.subcategoria || null,
    grupo_dre: grupoDre,
    confianca: principal.confianca,
    motivo: `Fornecedor com atividade "${registroCnae.cnae_descricao || principal.subcategoria || principal.categoria}" (CNAE ${registroCnae.cnae_codigo}).`,
  };
}

module.exports = { sugerirPorCNAE, casarPrefixo };
