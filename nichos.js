require('dotenv').config();
const { google } = require('googleapis');

// Pacotes por NICHO (05/11/2026, pedido do Aroldo: "tudo o que eu fizer pra salão já fica pronto
// pro próximo salão").
//
// Antes: a IA adivinhava o ramo do cliente a cada documento (passo 1 de REGRAS_CATEGORIZACAO_DINAMICA
// em prompts.js). Agora o ramo fica na coluna "Nicho" da planilha mestre e o pacote daquele ramo
// entra no pedido à IA (ver contexto-cliente.js + index.js). Cliente SEM nicho preenchido continua
// exatamente como antes — nada muda pra ele.
//
// Três camadas, da mais geral pra mais específica:
//   1. regras gerais de prompts.js (entrada x saída, dízimo, repasse a terceiros...) — valem pra todos;
//   2. pacote do nicho (este arquivo) + regras aprendidas do nicho (aba "Regras_Nicho" da mestre);
//   3. memória do próprio cliente (memoria-cliente.js — o que o especialista já classificou pra ELE).
// Uma decisão de um cliente só vira regra do nicho quando alguém salva de propósito na aba
// Regras_Nicho (ou pelo comando de admin "regra salao: ..."). Nunca automático.
//
// Ao ajustar um nicho: edite o pacote aqui (regra fixa, vai com deploy) OU adicione uma linha na
// aba Regras_Nicho (vale na hora, sem deploy). Toda chave de "grupo_dre" citada aqui precisa
// existir em dre.js (GRUPOS_DRE) — validarPacotes() confere isso.

const NICHOS = {
  SALAO: {
    nome: 'Salão de Beleza / Barbearia / Estética',
    pessoaFisica: false,
    apelidos: ['SALAO', 'SALÃO', 'BELEZA', 'BARBEARIA', 'ESTETICA', 'ESTÉTICA', 'SALAO_DE_BELEZA'],
    categorias: [
      ['entrada', 'Serviços', 'Corte, Barba, Coloração, Luzes, Escova, Manicure, Pedicure, Depilação, Estética, Sobrancelha', 'receita_prestacao_servicos'],
      ['entrada', 'Venda de Produtos', 'Shampoo, Pomada, Óleo, Cosméticos vendidos ao cliente', 'receita_venda_mercadorias'],
      ['entrada', 'Consumo/Bar', 'Bebidas, Cafés vendidos no salão', 'receita_venda_mercadorias'],
      ['saida', 'Comissão / Repasse de Profissionais Parceiros', 'Cabeleireiro, Barbeiro, Manicure, Esteticista parceiros (cota-parte)', 'custo_comissao_parceiros'],
      ['saida', 'Insumos e Descartáveis', 'Tinturas, Oxidantes, Lâminas, Luvas, Toalhas, Esmaltes, Cosméticos de uso interno', 'custo_diretos_servicos'],
      ['saida', 'Produtos para Revenda', 'Reposição de prateleira/vitrine', 'custo_cmv'],
      ['saida', 'Equipe CLT', 'Recepcionista, Auxiliar, Limpeza com carteira assinada', 'pessoal_salarios'],
      ['saida', 'Ocupação', 'Aluguel, Condomínio, IPTU', 'admin_ocupacao'],
      ['saida', 'Utilidades', 'Luz, Água, Internet, Telefone', 'admin_utilidades'],
      ['saida', 'Sistemas e Agendamento', 'Trinks, Booksy, Avec, Belasis, sistema de agenda', 'admin_sistemas_softwares'],
      ['saida', 'Marketing/Anúncios', 'Instagram/Meta Ads, Google, influenciador', 'vendas_marketing'],
      ['saida', 'Taxas de Maquininha', 'Stone, Cielo, Rede, PagSeguro, InfinitePay', 'financeiro_tarifas'],
      ['saida', 'Equipamentos e Reforma', 'Cadeira, Lavatório, Secador profissional, Reforma do espaço', 'investimento_imobilizado'],
    ],
    regrasEspeciais: [
      'Profissional PARCEIRO (Lei do Salão-Parceiro, recebe percentual/cota-parte, sem carteira assinada) NÃO é folha de pagamento: use "custo_comissao_parceiros", nunca "pessoal_salarios".',
      'Só funcionário com carteira assinada (recepcionista, auxiliar CLT) vai em "pessoal_salarios".',
      'Cosmético usado NO atendimento é insumo ("custo_diretos_servicos"); cosmético comprado pra REVENDER é "custo_cmv". Na dúvida (nota mista), use insumo e registre em "observacoes".',
      'Recebimento de maquininha/Pix de cliente do salão é receita de SERVIÇO ("receita_prestacao_servicos"), salvo se a descrição indicar venda de produto.',
    ],
    vocabulario: 'Fale de "atendimentos", "serviços", "ticket médio por atendimento" e "repasse às profissionais".',
  },

  PIZZARIA: {
    nome: 'Pizzaria / Restaurante / Gastronomia',
    pessoaFisica: false,
    apelidos: ['PIZZARIA', 'RESTAURANTE', 'GASTRONOMIA', 'ALIMENTACAO', 'ALIMENTAÇÃO', 'LANCHONETE', 'HAMBURGUERIA', 'BAR', 'DELIVERY'],
    categorias: [
      ['entrada', 'Vendas Salão/Balcão', 'Consumo no local e retirada no balcão', 'receita_venda_mercadorias'],
      ['entrada', 'Vendas Delivery Próprio', 'Pedidos por WhatsApp/telefone/site próprio, inclusive taxa de entrega cobrada', 'receita_venda_mercadorias'],
      ['entrada', 'Vendas iFood/Apps', 'iFood, Rappi, 99Food, Aiqfome — valor BRUTO do pedido', 'receita_venda_mercadorias'],
      ['saida', 'Taxas e Comissões de Apps', 'Comissão iFood/Rappi, taxa de pagamento online do app', 'deducao_taxas_plataforma'],
      ['saida', 'Insumos - Massa e Farinha', 'Farinha, Fermento, Óleo, Azeite', 'custo_cpv'],
      ['saida', 'Insumos - Queijos e Frios', 'Mussarela, Calabresa, Presunto, Bacon, Catupiry', 'custo_cpv'],
      ['saida', 'Insumos - Carnes', 'Frango, Carne, Peixe', 'custo_cpv'],
      ['saida', 'Insumos - Hortifruti', 'Tomate, Cebola, Verduras, Frutas', 'custo_cpv'],
      ['saida', 'Insumos - Molhos e Temperos', 'Molho de tomate, Orégano, Temperos', 'custo_cpv'],
      ['saida', 'Embalagens', 'Caixas de pizza, Sacolas, Potes, Guardanapos', 'custo_cpv'],
      ['saida', 'Gás e Lenha do Forno', 'Botijão/GLP, Lenha', 'custo_cpv'],
      ['saida', 'Bebidas para Revenda', 'Refrigerante, Cerveja, Suco, Água compradas pra vender', 'custo_cmv'],
      ['saida', 'Motoboy / Entregas', 'Entregador, diária de motoboy, taxa de entrega terceirizada (Loggi, Lalamove)', 'vendas_fretes'],
      ['saida', 'Equipe CLT', 'Pizzaiolo, Cozinheiro, Atendente, Garçom com carteira', 'pessoal_salarios'],
      ['saida', 'Freelancers / Extras', 'Diária de garçom/pizzaiolo extra em noite de movimento', 'pessoal_salarios'],
      ['saida', 'Ocupação', 'Aluguel, Condomínio, IPTU', 'admin_ocupacao'],
      ['saida', 'Utilidades', 'Luz, Água, Internet, Telefone', 'admin_utilidades'],
      ['saida', 'Sistemas e Cardápio Digital', 'PDV, Anota AI, Goomer, Saipos, Consumer', 'admin_sistemas_softwares'],
      ['saida', 'Marketing/Anúncios', 'Meta Ads, Google, panfletos, promoção paga no iFood', 'vendas_marketing'],
      ['saida', 'Manutenção de Equipamentos', 'Conserto de forno, geladeira, freezer, coifa', 'admin_manutencao'],
      ['saida', 'Equipamentos e Reforma', 'Compra de forno, freezer, masseira, mobiliário', 'investimento_imobilizado'],
      ['saida', 'Taxas de Maquininha', 'Stone, Cielo, Rede, PagSeguro', 'financeiro_tarifas'],
    ],
    regrasEspeciais: [
      'Venda por aplicativo (iFood etc.) entra pelo valor BRUTO em receita; a comissão/taxa do app sai separada em "deducao_taxas_plataforma". Nunca registre só o líquido como receita.',
      'Ingrediente, embalagem e gás/lenha do forno são custo de produção ("custo_cpv"), não despesa administrativa.',
      'Bebida comprada pronta pra revender é "custo_cmv" (mercadoria), não insumo.',
      'Motoboy/entregador pago por entrega ou diária é "vendas_fretes", mesmo sem nota fiscal; não é folha.',
      'Compra em atacadista/mercado (Atacadão, Assaí, Makro, Condor) numa pizzaria é INSUMO ("custo_cpv"), não "supermercado" pessoal.',
    ],
    vocabulario: 'Fale de "pedidos", "ticket médio", "CMV (custo dos insumos sobre as vendas)" e "peso do iFood nas vendas".',
  },

  TRANSPORTES: {
    nome: 'Transportes / Fretes / Logística',
    pessoaFisica: false,
    apelidos: ['TRANSPORTES', 'TRANSPORTE', 'TRANSPORTADORA', 'FRETE', 'FRETES', 'LOGISTICA', 'LOGÍSTICA', 'CAMINHONEIRO'],
    categorias: [
      ['entrada', 'Fretes Recebidos', 'Pagamento de frete por embarcador/cliente, CT-e', 'receita_prestacao_servicos'],
      ['entrada', 'Adiantamento de Frete', 'Adiantamento recebido antes da viagem (é receita do frete)', 'receita_prestacao_servicos'],
      ['entrada', 'Estadias / Diárias Cobradas', 'Estadia de caminhão parado cobrada do cliente', 'receita_prestacao_servicos'],
      ['saida', 'Combustível (Diesel/Arla)', 'Diesel, Arla 32, abastecimento em posto de estrada', 'custo_diretos_servicos'],
      ['saida', 'Pedágio', 'Pedágio, vale-pedágio, Sem Parar/ConectCar da frota', 'custo_diretos_servicos'],
      ['saida', 'Manutenção da Frota', 'Mecânica, Pneus, Peças, Troca de óleo, Borracharia, Lavagem do caminhão', 'custo_diretos_servicos'],
      ['saida', 'Frete Terceirizado / Agregado', 'Motorista agregado ou transportador terceiro pago por viagem', 'custo_diretos_servicos'],
      ['saida', 'Despesas de Viagem', 'Diária de motorista, Alimentação e Pernoite na estrada', 'custo_diretos_servicos'],
      ['saida', 'Seguro de Carga e Veículo', 'RCTR-C, RCF-DC, seguro do caminhão', 'custo_diretos_servicos'],
      ['saida', 'Motoristas CLT', 'Salário de motorista e ajudante com carteira', 'pessoal_salarios'],
      ['saida', 'Documentação da Frota', 'IPVA, Licenciamento, ANTT/RNTRC, Tacógrafo, multas de trânsito', 'admin_veiculos'],
      ['saida', 'Rastreamento e Sistemas', 'Rastreador, emissor de CT-e/MDF-e, gestão de frota', 'admin_sistemas_softwares'],
      ['saida', 'Financiamento do Caminhão — Juros', 'Parte de juros da parcela (Finame, CDC, consórcio contemplado)', 'financeiro_juros_emprestimos'],
      ['saida', 'Compra de Caminhão / Implemento', 'Caminhão, Carreta, Baú, entrada de financiamento', 'investimento_imobilizado'],
      ['saida', 'Impostos sobre Frete', 'DAS/Simples, ICMS sobre transporte', 'deducao_impostos_vendas'],
    ],
    regrasEspeciais: [
      'Em transportadora, combustível, pedágio e manutenção do caminhão são CUSTO DIRETO do frete ("custo_diretos_servicos"), NÃO "admin_veiculos". "admin_veiculos" fica só pra documentação/IPVA/multas ou carro administrativo.',
      'Parcela de financiamento de caminhão sem separação de juros: registre como "investimento_imobilizado" e escreva em "observacoes" que é parcela de financiamento (juros não separados).',
      'Pagamento a motorista agregado/terceiro por viagem é "Frete Terceirizado / Agregado" ("custo_diretos_servicos"), não salário.',
      'Posto de combustível na estrada para transportadora = Combustível (custo direto), nunca despesa pessoal.',
    ],
    vocabulario: 'Fale de "fretes", "viagens", "custo por viagem", "peso do diesel no frete" e "margem por frete".',
  },

  PESSOA_FISICA: {
    nome: 'Pessoa Física (finanças pessoais/familiares)',
    pessoaFisica: true,
    apelidos: ['PESSOA_FISICA', 'PESSOA FISICA', 'PESSOA FÍSICA', 'PF', 'PESSOAL', 'FAMILIA', 'FAMÍLIA'],
    categorias: [
      ['entrada', 'Renda', 'Salário, 13º, Férias, Comissões, Renda com Aluguéis, Resgate de Investimentos, Outros', 'receita_prestacao_servicos'],
      ['saida', 'Habitação', 'Aluguel/Prestação, Condomínio, Manutenção, Seguros, Luz, Empregados, Telefones, TV/Internet, Impostos', 'admin_ocupacao'],
      ['saida', 'Alimentação', 'Supermercado, Padaria, Sacolão, Açougue, Lanche, Almoço no Trabalho', 'admin_insumos_internos'],
      ['saida', 'Transporte', 'Combustível, Estacionamento, Manutenção, IPVA, Seguro, Licenciamento, Uber, Ônibus, Lavagem', 'admin_veiculos'],
      ['saida', 'Compras', 'Roupas, Calçados, Presentes, Eletrônicos, Materiais', 'admin_outras_despesas'],
      ['saida', 'Cuidados Pessoais', 'Salão de Beleza, Atividades Físicas, Depilação, Xampu/Cremes, Barba/Cabelo', 'admin_outras_despesas'],
      ['saida', 'Educação', 'Faculdade/Colégio, Uniforme, Material Escolar, Cursos, Livros, Mesada/Merenda', 'admin_outras_despesas'],
      ['saida', 'Saúde', 'Plano de Saúde, Seguro de Vida, Psicólogo, Dentista, Fisioterapia, Exames, Farmácia', 'admin_outras_despesas'],
      ['saida', 'Entretenimento', 'Restaurante, Streaming, Viagens, Cinema, Shows, Clube', 'admin_outras_despesas'],
      ['saida', 'Despesas Financeiras', 'Imposto de Renda, INSS, Anuidade de Cartão, Tarifas Bancárias, Juros', 'financeiro_tarifas'],
      ['saida', 'Contribuições', 'Dízimo, Oferta, Doação', 'admin_doacoes_contribuicoes'],
      ['saida', 'Investimentos / Reservas', 'Poupança, Reserva, Consórcio de Imóvel/Carro (dinheiro guardado, não é gasto perdido)', 'investimento_imobilizado'],
    ],
    regrasEspeciais: [
      'Cliente é PESSOA FÍSICA: nunca trate gasto de casa como despesa de empresa. Use SEMPRE a estrutura de categoria/subcategoria de PESSOA FÍSICA (categoria = grupo, ex.: "Alimentação"; subcategoria = item, ex.: "Supermercado").',
      'Salão de beleza, restaurante, mercado etc. aqui são GASTOS PESSOAIS do titular, nunca fornecedor de negócio.',
      'Empregada doméstica/diarista: categoria "Habitação", subcategoria "Empregados", grupo_dre "pessoal_salarios".',
      'Poupança, aplicação e consórcio são dinheiro GUARDADO: "Investimentos / Reservas" (grupo_dre "investimento_imobilizado" para consórcio de bem; "transferencia_entre_contas" para aplicação/poupança do próprio titular).',
    ],
    vocabulario: 'Cliente é pessoa física: NUNCA use "DRE", "receita", "faturamento", "lucro", "custo" ou "despesa operacional". Fale "entrou", "gastou", "sobrou", "para onde foi seu dinheiro", "maiores gastos".',
  },

  VETERINARIA: {
    nome: 'Clínica Veterinária / Pet Shop',
    pessoaFisica: false,
    apelidos: ['VETERINARIA', 'VETERINÁRIA', 'PET', 'PETSHOP', 'PET_SHOP', 'CLINICA_VETERINARIA'],
    categorias: [
      ['entrada', 'Consultas', '', 'receita_prestacao_servicos'],
      ['entrada', 'Vacinas', '', 'receita_prestacao_servicos'],
      ['entrada', 'Cirurgias', '', 'receita_prestacao_servicos'],
      ['entrada', 'Internações', 'Inclui diárias', 'receita_prestacao_servicos'],
      ['entrada', 'Banho & Tosa', '', 'receita_prestacao_servicos'],
      ['entrada', 'Exames', 'Laboratoriais e de imagem', 'receita_prestacao_servicos'],
      ['entrada', 'Venda de Produtos', 'Ração, Medicamentos avulsos, Acessórios', 'receita_venda_mercadorias'],
      ['saida', 'Medicamentos e Insumos Veterinários', 'Vacinas de estoque, Anestésicos, Material cirúrgico', 'custo_diretos_servicos'],
      ['saida', 'Ração e Produtos para Revenda', '', 'custo_cmv'],
      ['saida', 'Comissão / Repasse de Veterinários Parceiros', 'Profissional não-CLT recebendo percentual', 'custo_comissao_parceiros'],
      ['saida', 'Ocupação', 'Aluguel, Condomínio, Luz, Água', 'admin_ocupacao'],
      ['saida', 'Sistemas de Agendamento/Prontuário', '', 'admin_sistemas_softwares'],
      ['saida', 'Marketing/Anúncios', '', 'vendas_marketing'],
    ],
    regrasEspeciais: [
      'Separe SEMPRE as entradas em Consultas/Vacinas/Cirurgias/Internações/Banho & Tosa/Exames — nunca agrupe tudo em "Serviços".',
      'Veterinário parceiro (não-CLT, por percentual) é "custo_comissao_parceiros", não folha.',
    ],
    vocabulario: 'Fale de "atendimentos", "procedimentos" e "peso de cada serviço (consulta, cirurgia, banho & tosa) no faturamento".',
  },

  SERVICOS: {
    nome: 'Serviços Profissionais (Advocacia, Contabilidade, Consultoria)',
    pessoaFisica: false,
    apelidos: ['SERVICOS', 'SERVIÇOS', 'ADVOCACIA', 'ADVOGADO', 'CONTABILIDADE', 'CONSULTORIA', 'PRESTADOR'],
    categorias: [
      ['entrada', 'Honorários', 'Honorários contratuais, mensalidades de clientes, êxito', 'receita_prestacao_servicos'],
      ['entrada', 'Valores de Clientes (Repasse)', 'Acordo/causa recebido que pertence ao cliente do escritório', 'repasse_terceiros_entrada'],
      ['saida', 'Repasse a Clientes', 'Parte do acordo repassada ao cliente', 'repasse_terceiros_saida'],
      ['saida', 'Custas Processuais', 'Custas, Taxas judiciais, Certidões, Diligências', 'custo_custas_processuais'],
      ['saida', 'Parceiros / Correspondentes', 'Advogado correspondente, freelancer, profissional parceiro por percentual', 'custo_comissao_parceiros'],
      ['saida', 'Equipe CLT', 'Secretária, Estagiário, Assistente', 'pessoal_salarios'],
      ['saida', 'Sistemas e Softwares', 'Sistema jurídico/contábil, Nuvem, Assinatura digital', 'admin_sistemas_softwares'],
      ['saida', 'Ocupação', 'Aluguel de sala, Condomínio, Coworking', 'admin_ocupacao'],
      ['saida', 'Órgãos de Classe', 'OAB, CRC, CRA, Anuidades', 'admin_servicos_tecnicos'],
      ['saida', 'Marketing', 'Anúncios, Site, Conteúdo', 'vendas_marketing'],
    ],
    regrasEspeciais: [
      'Valor de acordo/causa que pertence ao cliente do escritório NÃO é receita: "repasse_terceiros_entrada". Só o honorário é receita.',
      'Custas pagas em nome do cliente (reembolsáveis) vão em "custo_custas_processuais" com "observacoes" indicando se será reembolsada.',
    ],
    vocabulario: 'Fale de "honorários", "carteira de clientes", "receita recorrente" e "valores de terceiros (repasse)".',
  },

  MARKETING: {
    nome: 'Marketing / Agência / Social Media / Tráfego Pago',
    pessoaFisica: false,
    apelidos: ['MARKETING', 'AGENCIA', 'AGÊNCIA', 'AGENCIA_DE_MARKETING', 'AGÊNCIA_DE_MARKETING', 'SOCIAL_MEDIA', 'SOCIALMEDIA', 'TRAFEGO', 'TRÁFEGO', 'TRAFEGO_PAGO', 'DESIGN', 'PUBLICIDADE'],
    categorias: [
      ['entrada', 'Gestão de Redes Sociais', 'Mensalidade de social media, Planejamento de conteúdo', 'receita_prestacao_servicos'],
      ['entrada', 'Gestão de Tráfego Pago', 'Fee de gestão de Meta Ads/Google Ads (só o honorário da gestão)', 'receita_prestacao_servicos'],
      ['entrada', 'Produção de Conteúdo', 'Fotos, Vídeos, Reels, Captação', 'receita_prestacao_servicos'],
      ['entrada', 'Design e Identidade Visual', 'Logo, Identidade visual, Artes avulsas', 'receita_prestacao_servicos'],
      ['entrada', 'Sites e Landing Pages', 'Criação e manutenção de site', 'receita_prestacao_servicos'],
      ['entrada', 'Verba de Anúncio do Cliente (Repasse)', 'Dinheiro que o cliente manda para a agência pagar os anúncios dele', 'repasse_terceiros_entrada'],
      ['saida', 'Anúncios Pagos em Nome de Clientes', 'Meta/Google Ads pagos com a verba do cliente', 'repasse_terceiros_saida'],
      ['saida', 'Freelancers e Parceiros', 'Designer, Videomaker, Fotógrafo, Copywriter, Social media parceiro', 'custo_comissao_parceiros'],
      ['saida', 'Ferramentas e Softwares', 'Canva, Adobe, mLabs, Metricool, CapCut, ChatGPT/Claude, hospedagem', 'admin_sistemas_softwares'],
      ['saida', 'Banco de Imagens e Músicas', 'Envato, Shutterstock, Epidemic Sound', 'custo_diretos_servicos'],
      ['saida', 'Anúncios da Própria Agência', 'Tráfego pago pra divulgar a própria agência', 'vendas_marketing'],
      ['saida', 'Equipamentos', 'Câmera, Lente, Iluminação, Computador, Celular', 'investimento_imobilizado'],
      ['saida', 'Equipe CLT', 'Funcionários com carteira', 'pessoal_salarios'],
      ['saida', 'Ocupação', 'Aluguel de sala, Coworking', 'admin_ocupacao'],
    ],
    regrasEspeciais: [
      'Verba de anúncio que o CLIENTE da agência manda pra ela pagar os anúncios dele NÃO é receita ("repasse_terceiros_entrada"); o pagamento desses anúncios ao Meta/Google também não é despesa da agência ("repasse_terceiros_saida"). Só o fee de gestão é receita.',
      'Anúncio pra divulgar a PRÓPRIA agência é despesa normal ("vendas_marketing").',
      'Freelancer/parceiro pago por job (designer, videomaker) é "custo_comissao_parceiros", não folha.',
      'Ferramenta usada na entrega aos clientes (Canva, Adobe, mLabs) é "admin_sistemas_softwares".',
    ],
    vocabulario: 'Fale de "clientes da carteira", "receita recorrente (mensalidades)", "fee de gestão", "custo com freelancers" e "margem por cliente".',
  },

  COMERCIO: {
    nome: 'Comércio / Loja / Varejo',
    pessoaFisica: false,
    apelidos: ['COMERCIO', 'COMÉRCIO', 'LOJA', 'VAREJO', 'MERCADINHO', 'AUTOPECAS', 'AUTOPEÇAS', 'BOUTIQUE'],
    categorias: [
      ['entrada', 'Vendas Balcão/Loja', 'Venda no balcão, maquininha, Pix de cliente', 'receita_venda_mercadorias'],
      ['entrada', 'Vendas Online/Marketplace', 'Mercado Livre, Shopee, loja virtual — valor BRUTO', 'receita_venda_mercadorias'],
      ['saida', 'Compra de Mercadoria para Revenda', 'Fornecedor, distribuidora, atacado', 'custo_cmv'],
      ['saida', 'Taxas de Marketplace', 'Comissão Mercado Livre/Shopee', 'deducao_taxas_plataforma'],
      ['saida', 'Fretes de Entrega', 'Correios, transportadora, motoboy', 'vendas_fretes'],
      ['saida', 'Equipe CLT', 'Vendedor, Caixa, Estoquista', 'pessoal_salarios'],
      ['saida', 'Comissões de Vendedores', '', 'vendas_comissoes'],
      ['saida', 'Ocupação', 'Aluguel, Condomínio, IPTU', 'admin_ocupacao'],
      ['saida', 'Utilidades', 'Luz, Água, Internet', 'admin_utilidades'],
      ['saida', 'Sistemas', 'PDV, ERP, emissor de nota', 'admin_sistemas_softwares'],
      ['saida', 'Marketing/Anúncios', '', 'vendas_marketing'],
      ['saida', 'Taxas de Maquininha', '', 'financeiro_tarifas'],
    ],
    regrasEspeciais: [
      'Compra de mercadoria pra revender é "custo_cmv", nunca despesa administrativa.',
      'Venda em marketplace entra pelo valor BRUTO; comissão do marketplace sai separada em "deducao_taxas_plataforma".',
    ],
    vocabulario: 'Fale de "vendas", "giro de estoque", "margem sobre o custo da mercadoria" e "ticket médio".',
  },
};

// Aceita o que o Aroldo digitar ("salão", "Pizzaria", "pf") e devolve a chave oficial, ou null.
function normalizarNicho(valor) {
  const bruto = String(valor || '').trim().toUpperCase();
  if (!bruto) return null;
  const semAcento = bruto.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_');
  for (const [chave, pacote] of Object.entries(NICHOS)) {
    if (chave === semAcento) return chave;
    const apelidos = pacote.apelidos.map((a) => a.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_'));
    if (apelidos.includes(semAcento)) return chave;
  }
  return null;
}

function pacoteDoNicho(nicho) {
  const chave = normalizarNicho(nicho);
  return chave ? { chave, ...NICHOS[chave] } : null;
}

function listaNichos() {
  return Object.entries(NICHOS).map(([chave, p]) => `${chave} — ${p.nome}`);
}

// -------------------------------------------------------------------------------------------
// Regras aprendidas por nicho — aba "Regras_Nicho" da planilha MESTRE (Nicho | Regra | Ativo |
// Criado_Em | Origem). Vale na hora, sem deploy. Cache de 5 min (mesmo padrão de clientes.js).
// -------------------------------------------------------------------------------------------
const ABA_REGRAS_NICHO = 'Regras_Nicho';
const CABECALHO_REGRAS_NICHO = ['Nicho', 'Regra', 'Ativo', 'Criado_Em', 'Origem'];
const CACHE_TTL_MS = 5 * 60 * 1000;
let cacheRegras = null;
let cacheRegrasExpiraEm = 0;

function getSheetsClient() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const auth = new google.auth.JWT(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null, privateKey, ['https://www.googleapis.com/auth/spreadsheets']);
  return google.sheets({ version: 'v4', auth });
}

async function garantirAbaRegras(sheets, spreadsheetId) {
  const planilha = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  if (planilha.data.sheets.some((a) => a.properties.title === ABA_REGRAS_NICHO)) return;
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: ABA_REGRAS_NICHO } } }] } });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${ABA_REGRAS_NICHO}!A1:E1`, valueInputOption: 'RAW', requestBody: { values: [CABECALHO_REGRAS_NICHO] },
  });
}

// Map nicho -> [regras ativas]. Falha de leitura nunca trava o Pocket: devolve o último cache ou vazio.
async function carregarRegrasNicho({ ignorarCache = false } = {}) {
  if (!ignorarCache && cacheRegras && Date.now() < cacheRegrasExpiraEm) return cacheRegras;
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  if (!spreadsheetId) return new Map();
  try {
    const sheets = getSheetsClient();
    await garantirAbaRegras(sheets, spreadsheetId);
    const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_REGRAS_NICHO}!A2:C` });
    const mapa = new Map();
    for (const linha of r.data.values || []) {
      const chave = normalizarNicho(linha[0]);
      const regra = String(linha[1] || '').trim();
      const ativo = String(linha[2] || 'TRUE').trim().toUpperCase() !== 'FALSE';
      if (!chave || !regra || !ativo) continue;
      if (!mapa.has(chave)) mapa.set(chave, []);
      mapa.get(chave).push(regra);
    }
    cacheRegras = mapa;
    cacheRegrasExpiraEm = Date.now() + CACHE_TTL_MS;
    return mapa;
  } catch (erro) {
    console.error('Falha ao ler Regras_Nicho (segue só com o pacote fixo):', erro.message);
    return cacheRegras || new Map();
  }
}

async function adicionarRegraNicho(nicho, regra, origem = 'admin') {
  const chave = normalizarNicho(nicho);
  if (!chave) throw new Error(`Nicho "${nicho}" não existe. Use um destes: ${Object.keys(NICHOS).join(', ')}`);
  const texto = String(regra || '').trim();
  if (!texto) throw new Error('Regra vazia.');
  const spreadsheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  const sheets = getSheetsClient();
  await garantirAbaRegras(sheets, spreadsheetId);
  await sheets.spreadsheets.values.append({
    spreadsheetId, range: `${ABA_REGRAS_NICHO}!A:E`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[chave, texto, 'TRUE', new Date().toISOString().slice(0, 10), origem]] },
  });
  cacheRegras = null;
  return chave;
}

// -------------------------------------------------------------------------------------------
// Bloco que vai junto do pedido à IA quando o cliente tem nicho.
// -------------------------------------------------------------------------------------------
function blocoCategorizacao(pacote, regrasAprendidas = []) {
  const categorias = pacote.categorias
    .map(([tipo, cat, sub, grupo]) => `  - ${tipo === 'entrada' ? 'ENTRADA' : 'SAÍDA'} | "${cat}"${sub ? ` (subcategorias: ${sub})` : ''} -> grupo_dre "${grupo}"`)
    .join('\n');
  const especiais = pacote.regrasEspeciais.map((r) => `  - ${r}`).join('\n');
  const aprendidas = regrasAprendidas.length
    ? `\nREGRAS APRENDIDAS PARA ESTE NICHO (salvas pela equipe Interali — têm prioridade sobre o pacote acima):\n${regrasAprendidas.map((r) => `  - ${r}`).join('\n')}`
    : '';
  return `NICHO DO CLIENTE — DEFINIDO NO CADASTRO: ${pacote.chave} (${pacote.nome}).
NÃO tente identificar o nicho pelo documento (ignore o passo 1 das REGRAS DE CATEGORIZAÇÃO DINÂMICA e os exemplos de OUTROS nichos). Use a lista abaixo como plano de contas PRINCIPAL deste cliente; se nada encaixar, crie uma categoria coerente com ESTE nicho. As regras gerais de entrada x saída, dízimo/doação, repasse a terceiros, transferência entre contas e as identidades do cliente continuam valendo e vêm antes desta lista.
CATEGORIAS DO NICHO:
${categorias}
REGRAS ESPECIAIS DO NICHO:
${especiais}${aprendidas}`;
}

function blocoLinguagem(pacote) {
  return `LINGUAGEM PARA ESTE CLIENTE (nicho ${pacote.chave}): ${pacote.vocabulario}`;
}

// Confere que toda chave citada nos pacotes existe em dre.js — roda nos testes e no boot.
function validarPacotes() {
  const { porChave } = require('./dre');
  const erros = [];
  for (const [chave, p] of Object.entries(NICHOS)) {
    for (const [tipo, cat, , grupo] of p.categorias) {
      if (!porChave(grupo)) erros.push(`${chave} / ${cat}: grupo_dre "${grupo}" não existe em dre.js`);
      if (tipo !== 'entrada' && tipo !== 'saida') erros.push(`${chave} / ${cat}: tipo inválido "${tipo}"`);
    }
  }
  return erros;
}

module.exports = {
  NICHOS,
  normalizarNicho,
  pacoteDoNicho,
  listaNichos,
  carregarRegrasNicho,
  adicionarRegraNicho,
  blocoCategorizacao,
  blocoLinguagem,
  validarPacotes,
  ABA_REGRAS_NICHO,
};
