require('dotenv').config();
const { google } = require('googleapis');

// ============================================================================================
// Módulo "Comércio com Cupom Térmico e Matriz de Fornecedores" (23/08/2026, pedido do Aroldo,
// cliente-piloto Mysael — comércio de produtos de limpeza, teste de 10 dias).
//
// Só entra em ação pra cliente.tipo === 'COMERCIO_MATRIZ' (ver processarMidiaRecebida em
// server.js) — isolado de propósito, zero impacto nos clientes do plano padrão.
//
// O que faz: lê um cupom de venda impresso em impressora térmica (PROMPT_CUPOM_TERMICO em
// prompts.js), soma a quantidade vendida de cada produto na aba "Matriz" da planilha DO PRÓPRIO
// CLIENTE (não a planilha mestre), registra a venda consolidada (com taxa de entrega/desconto) e
// mantém um cadastro simples de clientes finais (quem compra do comércio) — tudo crescendo sozinho
// conforme os cupons chegam, sem precisar de configuração manual prévia (pedido explícito do
// Aroldo: "os clientes/fornecedores precisam ser adicionados automaticamente").
//
// Design própositalmente pouco fiel a nomes de coluna FIXOS: como ainda não existe uma planilha
// real do Mysael pra copiar a estrutura (ver mysael.md em CLIENTES/), a leitura das abas é
// GUIADA PELO CABEÇALHO (linha 1), com apelidos aceitos por coluna (ver ALIASES_COLUNA abaixo) —
// se o Aroldo/Mysael editarem os nomes das colunas depois (ex.: "QUANT VENDIDA" em vez de
// "Qtd_Vendida"), o código continua funcionando sem precisar mexer em código.
// ============================================================================================

const ABA_MATRIZ = 'Matriz';
// 'Estoque_Atual' e 'Estoque_Minimo' (23/08/2026, pedido do Aroldo) — colunas PREENCHIDAS À MÃO
// pelo cliente (nunca escritas pelo código, só lidas). "Saldo" (estoque − vendido) e "precisa
// repor" (saldo <= estoque mínimo) são calculados na hora de mostrar (ver buscarResumoComercio) —
// nada é gravado de volta na planilha por causa disso, o cliente sempre pode corrigir a contagem
// sem o Pocket sobrescrever.
//
// 'Conferencia' (23/08/2026, corrigido): NÃO é mais espelhada automaticamente pelo código a cada
// venda — antes era ("replicar a quantidade pra manter a paridade visual", pedido original), mas
// isso torna a coluna inútil pra conferência física de verdade (sempre bateria com Qtd_Vendida por
// definição). Agora é 100% preenchida à mão pelo balconista contando o estoque de verdade, e o
// dashboard compara Qtd_Vendida (lançado pela IA) x Conferencia (contagem física) pra achar
// divergência — é essa comparação que dá valor à coluna, não uma cópia automática.
// 'Custo_Unitario' (23/08/2026, pedido do Aroldo — inteligência financeira) — PREENCHIDO À MÃO
// pelo cliente com o que ele paga ao fornecedor por unidade. É a base de todo cálculo de
// margem/markup (ver buscarResumoComercio) — sem isso preenchido, o produto simplesmente não
// entra na análise de margem (não assume custo nenhum, nunca inventa número).
const CABECALHO_MATRIZ_PADRAO = ['Fornecedor', 'Codigo', 'Produto', 'Qtd_Vendida', 'Conferencia', 'Estoque_Atual', 'Estoque_Minimo', 'Custo_Unitario'];

const ABA_CLIENTES_FINAIS = 'ClientesFinais';
const CABECALHO_CLIENTES_FINAIS_PADRAO = ['Nome', 'Primeira_Compra', 'Ultima_Compra', 'Qtd_Compras', 'Valor_Total_Comprado'];

// 'Taxa_Cartao_Percentual' (23/08/2026, pedido do Aroldo) — PREENCHIDA À MÃO pelo cliente depois
// da venda, só quando a forma de pagamento foi cartão (a taxa varia por bandeira/parcelamento, só
// ele sabe o valor real cobrado pela maquininha/adquirente) — o Pocket nunca escreve aqui, só lê
// pra calcular o "Valor Líquido" (ver buscarResumoComercio). Pix/dinheiro não têm taxa, fica em
// branco de propósito (branco ≠ "0% preenchido", é "não se aplica").
const ABA_VENDAS_CUPOM = 'VendasCupom';
const CABECALHO_VENDAS_CUPOM_PADRAO = [
  'Data', 'Hora', 'Numero_Venda', 'Cliente', 'Forma_Pagamento', 'Itens_Resumo',
  'Taxa_Entrega', 'Desconto', 'Valor_Total', 'Status', 'Registrado_Em', 'Taxa_Cartao_Percentual',
];

// ItensVendaCupom (23/08/2026) — um registro POR ITEM de cada venda (VendasCupom só guarda um
// resumo em texto por venda, "2x Produto X; 1x Produto Y", que não serve pra calcular margem por
// produto). Existe só pra permitir comparar o preço de venda de cada item contra o Custo_Unitario
// da Matriz — não é editado à mão, é populado automaticamente junto com cada cupom processado.
const ABA_ITENS_VENDA = 'ItensVendaCupom';
const CABECALHO_ITENS_VENDA_PADRAO = ['Data', 'Numero_Venda', 'Produto', 'Fornecedor', 'Codigo', 'Quantidade', 'Valor_Unitario', 'Valor_Total'];

// ComprasFornecedor (23/08/2026) — log append-only de cada nota de compra processada (uma linha
// por nota), mesmo espírito de VendasCupom só que pro lado da REPOSIÇÃO de estoque, não da venda.
const ABA_COMPRAS_FORNECEDOR = 'ComprasFornecedor';
const CABECALHO_COMPRAS_FORNECEDOR_PADRAO = ['Data', 'Numero_Nota', 'Fornecedor', 'Itens_Resumo', 'Valor_Total', 'Registrado_Em'];

// Apelidos aceitos por coluna lógica — cabeçalho real é normalizado (maiúscula, sem acento/espaço/
// pontuação) e comparado contra esta lista. Adicione um apelido novo aqui se a planilha real do
// Mysael usar um nome diferente do previsto (não precisa mudar mais nada).
const ALIASES_COLUNA = {
  fornecedor: ['FORNECEDOR', 'FORNECEDORES'],
  codigo: ['CODIGO', 'COD', 'SKU'],
  produto: ['PRODUTO', 'DESCRICAO', 'ITEM', 'NOME', 'NOMEDOPRODUTO'],
  qtdVendida: ['QTDVENDIDA', 'QUANTVENDIDA', 'QUANTIDADEVENDIDA', 'QTDEVENDIDA', 'VENDIDO', 'VENDIDA', 'QTDVENDA'],
  conferencia: ['CONFERENCIA', 'CONFERENCIAS', 'CONFERE'],
  estoque: ['ESTOQUEATUAL', 'ESTOQUE', 'SALDOESTOQUE', 'QTDESTOQUE', 'QUANTIDADEESTOQUE'],
  estoqueMinimo: ['ESTOQUEMINIMO', 'ESTOQUEMIN', 'QTDMINIMA', 'MINIMO', 'META', 'METAREPOSICAO'],
  custoUnitario: ['CUSTOUNITARIO', 'CUSTO', 'PRECOCUSTO', 'PRECODECUSTO', 'CUSTOPORUNIDADE'],
};

// Marcas/fornecedores conhecidos do Mysael (23/08/2026, pedido do Aroldo) — lista extensível: uma
// marca nova nos cupons só precisa ser adicionada aqui (ou preenchida manualmente na planilha, os
// dois caminhos funcionam juntos). Usada só como FALLBACK quando o próprio cupom não veio com o
// campo "marca_fornecedor" preenchido pela IA (ver PROMPT_CUPOM_TERMICO) e a célula Fornecedor da
// linha já existente/nova está vazia — nunca sobrescreve o que já foi preenchido à mão.
const MARCAS_CONHECIDAS = ['bir-clean', 'bir clean', 'chemisch', 'rodos twist', 'twist', 'nobily'];

function capitalizarMarca(marca) {
  return marca.split(/[\s-]+/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function detectarFornecedorPorNome(descricaoProduto) {
  const normalizado = normalizarNomeProduto(descricaoProduto);
  // Ordena as mais longas primeiro (ex.: "rodos twist" antes de "twist" sozinho) pra não perder
  // detalhe quando uma marca é substring de outra.
  const marcasOrdenadas = [...MARCAS_CONHECIDAS].sort((a, b) => b.length - a.length);
  for (const marca of marcasOrdenadas) {
    if (normalizado.includes(normalizarNomeProduto(marca))) return capitalizarMarca(marca);
  }
  return '';
}

function normalizarCabecalho(texto) {
  return (texto || '')
    .toString()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

// Acha o índice (0-based) de cada coluna lógica na linha de cabeçalho real, por apelido — devolve
// só o que encontrou (chave ausente = coluna não existe nessa planilha).
function mapearColunas(linhaCabecalho) {
  const normalizados = (linhaCabecalho || []).map(normalizarCabecalho);
  const mapa = {};
  for (const [chaveLogica, apelidos] of Object.entries(ALIASES_COLUNA)) {
    const indice = normalizados.findIndex((h) => apelidos.includes(h));
    if (indice !== -1) mapa[chaveLogica] = indice;
  }
  return mapa;
}

function getAuthClient() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuthClient() });
}

// Mesmo padrão de garantirAbaComCabecalho já usado em sheets.js/clientes.js (cada módulo de I/O
// deste projeto é auto-contido, não importa client interno de outro arquivo) — cria a aba se não
// existir, e só ESCREVE o cabeçalho padrão se a aba estiver em branco (cabeçalho já preenchido por
// alguém nunca é sobrescrito, pra não perder colunas que o Aroldo/Mysael tenham criado na mão).
async function garantirAbaComCabecalho(sheets, spreadsheetId, nomeAba, cabecalhoPadrao) {
  const planilha = await sheets.spreadsheets.get({ spreadsheetId });
  const abaExiste = planilha.data.sheets.some((aba) => aba.properties.title === nomeAba);

  if (!abaExiste) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: nomeAba } } }] },
    });
  }

  const ultimaColuna = colunaParaLetra(cabecalhoPadrao.length - 1);
  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${nomeAba}!A1:${ultimaColuna}1` });
  const cabecalhoAtual = resposta.data.values && resposta.data.values[0];

  if (!cabecalhoAtual || cabecalhoAtual.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${nomeAba}!A1:${ultimaColuna}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [cabecalhoPadrao] },
    });
    return cabecalhoPadrao;
  }

  // Migração leve (mesmo padrão de sheets.js/clientes.js): cabeçalho já existe mas é mais CURTO do
  // que o esperado hoje (ex.: coluna nova adicionada ao módulo depois que essa aba já existia pra
  // um cliente real) — só ACRESCENTA os rótulos que faltam no fim, nunca reordena/sobrescreve os
  // que já existem (mesmo que o Aroldo/Mysael tenham renomeado uma coluna existente na mão).
  if (cabecalhoAtual.length < cabecalhoPadrao.length) {
    const cabecalhoCompleto = [...cabecalhoAtual, ...cabecalhoPadrao.slice(cabecalhoAtual.length)];
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${nomeAba}!A1:${ultimaColuna}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [cabecalhoCompleto] },
    });
    return cabecalhoCompleto;
  }

  return cabecalhoAtual;
}

async function obterSheetIdNumerico(sheets, spreadsheetId, nomeAba) {
  const planilha = await sheets.spreadsheets.get({ spreadsheetId });
  const aba = planilha.data.sheets.find((a) => a.properties.title === nomeAba);
  return aba ? aba.properties.sheetId : null;
}

function colunaParaLetra(indice) {
  // 0-based -> letra de coluna do Sheets (0='A', 25='Z', 26='AA'...). Sem lib externa, só as
  // planilhas deste módulo (Matriz/ClientesFinais/VendasCupom) nunca chegam nem perto de 26+ colunas.
  let n = indice;
  let letra = '';
  do {
    letra = String.fromCharCode('A'.charCodeAt(0) + (n % 26)) + letra;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letra;
}

// ---------------------------------------------------------------------------------------------
// FUZZY MATCHING de nome de produto/cliente — normaliza acento/pontuação/variação de volume
// ("5L"/"5 Litros"/"5LT" -> "5l") e compara por sobreposição de palavras (Jaccard) + bônus se um
// nome é substring do outro (ex.: "detergente" dentro de "detergente neutro 5l"). Pura função, sem
// I/O — testável isoladamente.
// ---------------------------------------------------------------------------------------------

function normalizarNomeProduto(texto) {
  let t = (texto || '').toString().trim().toLowerCase();
  t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); // remove acentos
  // variações de unidade/volume comuns em produto de limpeza -> forma canônica
  t = t.replace(/(\d+(?:[.,]\d+)?)\s*(litros?|lts?|l)\b/g, '$1l');
  t = t.replace(/(\d+(?:[.,]\d+)?)\s*(mililitros?|ml)\b/g, '$1ml');
  t = t.replace(/(\d+(?:[.,]\d+)?)\s*(quilos?|kgs?|kg)\b/g, '$1kg');
  t = t.replace(/(\d+(?:[.,]\d+)?)\s*(gramas?|gr?)\b/g, '$1g');
  t = t.replace(/[^\w\s]/g, ' '); // pontuação -> espaço
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function similaridadeNomes(a, b) {
  const na = normalizarNomeProduto(a);
  const nb = normalizarNomeProduto(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const tokensA = new Set(na.split(' '));
  const tokensB = new Set(nb.split(' '));
  const intersecao = [...tokensA].filter((t) => tokensB.has(t)).length;
  const uniao = new Set([...tokensA, ...tokensB]).size;
  const jaccard = uniao === 0 ? 0 : intersecao / uniao;
  const substringBonus = (na.includes(nb) || nb.includes(na)) ? 0.15 : 0;

  return Math.min(1, jaccard + substringBonus);
}

const LIMIAR_SIMILARIDADE_PRODUTO = 0.6;
const LIMIAR_SIMILARIDADE_CLIENTE = 0.75; // nome de pessoa pede um pouco mais de precisão que nome de produto

// Acha, dentro de uma lista de candidatos { texto, ... }, o de maior similaridade acima do limiar.
function melhorCorrespondencia(alvo, candidatos, extrairTexto, limiar) {
  let melhor = null;
  let melhorScore = 0;
  for (const candidato of candidatos) {
    const score = similaridadeNomes(alvo, extrairTexto(candidato));
    if (score > melhorScore) {
      melhorScore = score;
      melhor = candidato;
    }
  }
  return melhorScore >= limiar ? { candidato: melhor, score: melhorScore } : null;
}

// ---------------------------------------------------------------------------------------------
// MATRIZ DE PRODUTOS — localizar (por código exato, senão por nome fuzzy) e SOMAR quantidade
// vendida; se não achar, CRIA a linha na hora (pedido do Aroldo: produto/fornecedor novo entra
// sozinho, sem bloquear o cupom esperando alguém cadastrar manualmente).
// ---------------------------------------------------------------------------------------------

async function processarItemNaMatriz(sheets, spreadsheetId, item) {
  const cabecalho = await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_MATRIZ, CABECALHO_MATRIZ_PADRAO);
  const colunas = mapearColunas(cabecalho);

  if (colunas.produto === undefined || colunas.qtdVendida === undefined) {
    // Aba existe mas não tem as colunas mínimas reconhecíveis (nem por apelido) — não arrisca
    // gravar em coluna errada. Quem chama decide como avisar (ver processarCupomTermico).
    return { status: 'sem_estrutura_reconhecida' };
  }

  const ultimaColuna = colunaParaLetra(Math.max(...Object.values(colunas).map((i) => i), cabecalho.length - 1));
  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_MATRIZ}!A2:${ultimaColuna}` });
  const linhas = resposta.data.values || [];

  // 1ª tentativa: código exato (mais confiável que nome quando o cupom traz um código/SKU).
  let indiceEncontrado = -1;
  if (item.codigo && colunas.codigo !== undefined) {
    const codigoAlvo = String(item.codigo).trim().toUpperCase();
    indiceEncontrado = linhas.findIndex((linha) => (linha[colunas.codigo] || '').toString().trim().toUpperCase() === codigoAlvo);
  }

  // 2ª tentativa: nome por fuzzy matching (normaliza acento/pontuação/volume).
  let scoreEncontrado = 1;
  if (indiceEncontrado === -1) {
    const match = melhorCorrespondencia(item.descricao, linhas, (linha) => linha[colunas.produto] || '', LIMIAR_SIMILARIDADE_PRODUTO);
    if (match) {
      indiceEncontrado = linhas.indexOf(match.candidato);
      scoreEncontrado = match.score;
    }
  }

  const quantidadeVendida = Number(item.quantidade) || 0;

  if (indiceEncontrado !== -1) {
    const linhaPlanilha = indiceEncontrado + 2; // +2: A2 é a 1ª linha de dado, índice 0
    const valorAtual = Number(String(linhas[indiceEncontrado][colunas.qtdVendida] || '0').replace(',', '.')) || 0;
    const novoValor = valorAtual + quantidadeVendida;

    // Conferencia NÃO é mais tocada aqui (23/08/2026) — é 100% manual (ver comentário no
    // cabeçalho do arquivo), só Qtd_Vendida é somada automaticamente.
    const requests = [{
      range: `${ABA_MATRIZ}!${colunaParaLetra(colunas.qtdVendida)}${linhaPlanilha}`,
      values: [[novoValor]],
    }];

    // Fornecedor: só preenche se a célula estiver VAZIA (nunca sobrescreve o que já foi
    // preenchido, seja à mão ou por uma leitura anterior) — prioriza o que a própria IA leu no
    // cupom (item.marca_fornecedor), com o dicionário local de marcas conhecidas como reforço.
    const fornecedorAtual = colunas.fornecedor !== undefined ? (linhas[indiceEncontrado][colunas.fornecedor] || '') : '';
    if (colunas.fornecedor !== undefined && !fornecedorAtual.trim()) {
      const fornecedorDetectado = (item.marca_fornecedor || '').trim() || detectarFornecedorPorNome(item.descricao);
      if (fornecedorDetectado) {
        requests.push({ range: `${ABA_MATRIZ}!${colunaParaLetra(colunas.fornecedor)}${linhaPlanilha}`, values: [[fornecedorDetectado]] });
      }
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: requests },
    });

    return {
      status: 'somado',
      produtoNaPlanilha: linhas[indiceEncontrado][colunas.produto] || item.descricao,
      quantidadeAdicionada: quantidadeVendida,
      novoTotal: novoValor,
      similaridade: scoreEncontrado,
    };
  }

  // Não achou (nem por código, nem por nome parecido o bastante) — CRIA a linha agora. Fornecedor
  // tenta detectar sozinho (campo lido pela IA no cupom, ou dicionário local de marcas conhecidas)
  // — se não conseguir, fica em branco mesmo, marcado como pendência de preenchimento manual, sem
  // bloquear o lançamento da venda em si.
  const linhaNova = new Array(cabecalho.length).fill('');
  linhaNova[colunas.produto] = item.descricao || '(produto não identificado)';
  linhaNova[colunas.qtdVendida] = quantidadeVendida;
  if (colunas.codigo !== undefined && item.codigo) linhaNova[colunas.codigo] = item.codigo;
  if (colunas.fornecedor !== undefined) {
    linhaNova[colunas.fornecedor] = (item.marca_fornecedor || '').trim() || detectarFornecedorPorNome(item.descricao);
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_MATRIZ}!A:${colunaParaLetra(cabecalho.length - 1)}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [linhaNova] },
  });

  return {
    status: 'criado',
    produtoNaPlanilha: item.descricao,
    quantidadeAdicionada: quantidadeVendida,
    novoTotal: quantidadeVendida,
  };
}

// ---------------------------------------------------------------------------------------------
// NOTA DE COMPRA DE FORNECEDOR (23/08/2026, pedido do Aroldo: "às vezes já soma a nota que
// comprou do fornecedor, e às vezes ele quer adicionar manual") — sentido OPOSTO da venda: em vez
// de somar Qtd_Vendida, SOMA Estoque_Atual (reposição de estoque). Mesmo motor de fuzzy
// matching/criação automática da venda, só muda qual coluna é incrementada. Estoque_Atual continua
// editável à mão a qualquer momento (é só um número na planilha) — isso aqui só faz o Pocket somar
// sozinho quando o cliente manda a nota em vez de digitar, os dois caminhos convivem porque ambos
// no fim das contas só mudam o mesmo número.
// ---------------------------------------------------------------------------------------------

async function processarItemDeCompra(sheets, spreadsheetId, item, fornecedorDaNota) {
  const cabecalho = await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_MATRIZ, CABECALHO_MATRIZ_PADRAO);
  const colunas = mapearColunas(cabecalho);

  if (colunas.produto === undefined || colunas.estoque === undefined) {
    // Sem a coluna Estoque_Atual reconhecível, não tem onde somar a compra com segurança — quem
    // chama decide como avisar (ver processarNotaCompra).
    return { status: 'sem_estrutura_reconhecida' };
  }

  const ultimaColuna = colunaParaLetra(Math.max(...Object.values(colunas).map((i) => i), cabecalho.length - 1));
  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_MATRIZ}!A2:${ultimaColuna}` });
  const linhas = resposta.data.values || [];

  let indiceEncontrado = -1;
  if (item.codigo && colunas.codigo !== undefined) {
    const codigoAlvo = String(item.codigo).trim().toUpperCase();
    indiceEncontrado = linhas.findIndex((linha) => (linha[colunas.codigo] || '').toString().trim().toUpperCase() === codigoAlvo);
  }
  let scoreEncontrado = 1;
  if (indiceEncontrado === -1) {
    const match = melhorCorrespondencia(item.descricao, linhas, (linha) => linha[colunas.produto] || '', LIMIAR_SIMILARIDADE_PRODUTO);
    if (match) {
      indiceEncontrado = linhas.indexOf(match.candidato);
      scoreEncontrado = match.score;
    }
  }

  const quantidadeComprada = Number(item.quantidade) || 0;
  const custoUnitarioNota = Number(item.custo_unitario) || 0;

  if (indiceEncontrado !== -1) {
    const linhaPlanilha = indiceEncontrado + 2;
    const estoqueAtual = Number(String(linhas[indiceEncontrado][colunas.estoque] || '0').replace(',', '.')) || 0;
    const novoEstoque = estoqueAtual + quantidadeComprada;

    const requests = [{ range: `${ABA_MATRIZ}!${colunaParaLetra(colunas.estoque)}${linhaPlanilha}`, values: [[novoEstoque]] }];

    // Custo_Unitario: só preenche se estiver VAZIO — uma nota de compra real é uma fonte ótima pra
    // isso (é literalmente o custo pago), mas nunca sobrescreve um valor que o cliente já colocou
    // (pode ter negociado um preço diferente, ou já ter atualizado à mão).
    const custoAtual = colunas.custoUnitario !== undefined ? (linhas[indiceEncontrado][colunas.custoUnitario] || '') : '';
    if (colunas.custoUnitario !== undefined && !String(custoAtual).trim() && custoUnitarioNota > 0) {
      requests.push({ range: `${ABA_MATRIZ}!${colunaParaLetra(colunas.custoUnitario)}${linhaPlanilha}`, values: [[custoUnitarioNota]] });
    }

    const fornecedorAtual = colunas.fornecedor !== undefined ? (linhas[indiceEncontrado][colunas.fornecedor] || '') : '';
    if (colunas.fornecedor !== undefined && !fornecedorAtual.trim() && fornecedorDaNota) {
      requests.push({ range: `${ABA_MATRIZ}!${colunaParaLetra(colunas.fornecedor)}${linhaPlanilha}`, values: [[fornecedorDaNota]] });
    }

    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data: requests } });

    return {
      status: 'somado',
      produtoNaPlanilha: linhas[indiceEncontrado][colunas.produto] || item.descricao,
      quantidadeAdicionada: quantidadeComprada,
      novoEstoque,
      similaridade: scoreEncontrado,
    };
  }

  // Produto novo (nunca vendido nem comprado antes) — cria a linha já com o estoque inicial e o
  // custo da própria nota.
  const linhaNova = new Array(cabecalho.length).fill('');
  linhaNova[colunas.produto] = item.descricao || '(produto não identificado)';
  linhaNova[colunas.estoque] = quantidadeComprada;
  if (colunas.codigo !== undefined && item.codigo) linhaNova[colunas.codigo] = item.codigo;
  if (colunas.custoUnitario !== undefined && custoUnitarioNota > 0) linhaNova[colunas.custoUnitario] = custoUnitarioNota;
  if (colunas.fornecedor !== undefined && fornecedorDaNota) linhaNova[colunas.fornecedor] = fornecedorDaNota;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_MATRIZ}!A:${colunaParaLetra(cabecalho.length - 1)}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [linhaNova] },
  });

  return { status: 'criado', produtoNaPlanilha: item.descricao, quantidadeAdicionada: quantidadeComprada, novoEstoque: quantidadeComprada };
}

// ---------------------------------------------------------------------------------------------
// CLIENTES FINAIS — cadastro simples de quem compra do comércio (nome + contadores), crescendo
// sozinho a cada cupom novo. "Consumidor Final" (ou vazio) nunca vira registro — não faz sentido
// rastrear comprador anônimo.
// ---------------------------------------------------------------------------------------------

async function processarClienteFinal(sheets, spreadsheetId, nomeCliente, valorCompra, dataISO) {
  const nome = (nomeCliente || '').trim();
  if (!nome || /^consumidor\s*final$/i.test(nome)) return { status: 'anonimo' };

  // Planilha própria deste módulo (cabeçalho padrão sempre criado por garantirAbaComCabecalho
  // abaixo) — índices fixos (0=Nome, 2=Ultima_Compra, 3=Qtd_Compras, 4=Valor_Total_Comprado), não
  // precisa de mapearColunas aqui como na Matriz.
  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_CLIENTES_FINAIS, CABECALHO_CLIENTES_FINAIS_PADRAO);

  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_CLIENTES_FINAIS}!A2:E` });
  const linhas = resposta.data.values || [];

  const match = melhorCorrespondencia(nome, linhas, (linha) => linha[0] || '', LIMIAR_SIMILARIDADE_CLIENTE);

  if (match) {
    const indice = linhas.indexOf(match.candidato);
    const linhaPlanilha = indice + 2;
    const qtdAtual = Number(linhas[indice][3]) || 0;
    const valorAtual = Number(String(linhas[indice][4] || '0').replace(',', '.')) || 0;
    // Primeira_Compra (índice 1) / Ultima_Compra (índice 2) comparadas por data, não só
    // sobrescritas — cupons quase sempre chegam em ordem cronológica de verdade (é o dia a dia do
    // WhatsApp), mas nada garante isso 100% (ex.: cliente manda um cupom atrasado). Comparar em vez
    // de sobrescrever cego evita "Ultima_Compra" voltar no tempo se isso acontecer.
    const primeiraCompraAtual = linhas[indice][1] || dataISO;
    const ultimaCompraAtual = linhas[indice][2] || dataISO;
    const novaPrimeiraCompra = dataISO < primeiraCompraAtual ? dataISO : primeiraCompraAtual;
    const novaUltimaCompra = dataISO > ultimaCompraAtual ? dataISO : ultimaCompraAtual;

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: `${ABA_CLIENTES_FINAIS}!B${linhaPlanilha}`, values: [[novaPrimeiraCompra]] },
          { range: `${ABA_CLIENTES_FINAIS}!C${linhaPlanilha}`, values: [[novaUltimaCompra]] },
          { range: `${ABA_CLIENTES_FINAIS}!D${linhaPlanilha}`, values: [[qtdAtual + 1]] },
          { range: `${ABA_CLIENTES_FINAIS}!E${linhaPlanilha}`, values: [[valorAtual + (Number(valorCompra) || 0)]] },
        ],
      },
    });

    return { status: 'atualizado', nome: linhas[indice][0] };
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_CLIENTES_FINAIS}!A:E`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[nome, dataISO, dataISO, 1, Number(valorCompra) || 0]] },
  });

  return { status: 'criado', nome };
}

// ---------------------------------------------------------------------------------------------
// VENDA CONSOLIDADA — log append-only de cada cupom processado (uma linha por cupom).
// ---------------------------------------------------------------------------------------------

async function registrarVendaCupom(sheets, spreadsheetId, cupom) {
  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_VENDAS_CUPOM, CABECALHO_VENDAS_CUPOM_PADRAO);

  const itensResumo = (cupom.itens || [])
    .map((item) => `${item.quantidade}x ${item.descricao}`)
    .join('; ');

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_VENDAS_CUPOM}!A:L`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        cupom.data || new Date().toISOString().slice(0, 10),
        cupom.hora || '',
        cupom.numero_venda || '',
        cupom.cliente || 'Consumidor Final',
        cupom.forma_pagamento || '',
        itensResumo,
        cupom.taxa_entrega || 0,
        cupom.desconto || 0,
        cupom.valor_total || 0,
        'PROCESSADO_IA',
        new Date().toISOString(),
        '', // Taxa_Cartao_Percentual — em branco de propósito, é preenchida à mão depois (ver comentário no cabeçalho)
      ]],
    },
  });
}

// Um registro por ITEM da venda (não por venda inteira) — base pro cálculo de margem/markup em
// buscarResumoComercio, comparando Valor_Unitario aqui contra Custo_Unitario da Matriz.
async function registrarItensVenda(sheets, spreadsheetId, cupom) {
  const itens = cupom.itens || [];
  if (itens.length === 0) return;

  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_ITENS_VENDA, CABECALHO_ITENS_VENDA_PADRAO);

  const linhas = itens.map((item) => [
    cupom.data || new Date().toISOString().slice(0, 10),
    cupom.numero_venda || '',
    item.descricao || '',
    (item.marca_fornecedor || '').trim() || detectarFornecedorPorNome(item.descricao),
    item.codigo || '',
    Number(item.quantidade) || 0,
    Number(item.valor_unitario) || 0,
    Number(item.valor_total) || 0,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_ITENS_VENDA}!A:H`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: linhas },
  });
}

// ---------------------------------------------------------------------------------------------
// ORQUESTRAÇÃO — chamada por server.js depois que extrairCupomTermicoDeBuffer (index.js) já
// extraiu o cupom. Processa cada item na Matriz, o cliente final, registra a venda consolidada, e
// devolve um resultado estruturado pra formatarResumoCupom montar a mensagem do WhatsApp.
// ---------------------------------------------------------------------------------------------

async function processarCupomTermico(spreadsheetId, cupom) {
  const sheets = getSheetsClient();

  const itensProcessados = [];
  let semEstruturaReconhecida = false;

  for (const item of cupom.itens || []) {
    const resultado = await processarItemNaMatriz(sheets, spreadsheetId, item);
    if (resultado.status === 'sem_estrutura_reconhecida') {
      semEstruturaReconhecida = true;
      continue;
    }
    itensProcessados.push({ ...resultado, descricaoOriginal: item.descricao, quantidade: item.quantidade });
  }

  const clienteFinal = await processarClienteFinal(
    sheets, spreadsheetId, cupom.cliente, cupom.valor_total, cupom.data || new Date().toISOString().slice(0, 10)
  );

  await registrarVendaCupom(sheets, spreadsheetId, cupom);
  await registrarItensVenda(sheets, spreadsheetId, cupom);

  return {
    numeroVenda: cupom.numero_venda || null,
    itensProcessados,
    semEstruturaReconhecida,
    taxaEntrega: Number(cupom.taxa_entrega) || 0,
    desconto: Number(cupom.desconto) || 0,
    valorTotal: Number(cupom.valor_total) || 0,
    formaPagamento: cupom.forma_pagamento || null,
    clienteFinal,
  };
}

async function registrarCompraFornecedor(sheets, spreadsheetId, compra) {
  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_COMPRAS_FORNECEDOR, CABECALHO_COMPRAS_FORNECEDOR_PADRAO);

  const itensResumo = (compra.itens || []).map((item) => `${item.quantidade}x ${item.descricao}`).join('; ');

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_COMPRAS_FORNECEDOR}!A:F`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        compra.data || new Date().toISOString().slice(0, 10),
        compra.numero_nota || '',
        compra.fornecedor || '',
        itensResumo,
        compra.valor_total || 0,
        new Date().toISOString(),
      ]],
    },
  });
}

// Orquestração da nota de compra de fornecedor — mesmo papel de processarCupomTermico, só que pro
// lado da REPOSIÇÃO de estoque (soma Estoque_Atual, não Qtd_Vendida). Chamada por server.js quando
// PROMPT_CUPOM_TERMICO classifica o documento como "compra_fornecedor".
async function processarNotaCompra(spreadsheetId, compra) {
  const sheets = getSheetsClient();

  const itensProcessados = [];
  let semEstruturaReconhecida = false;

  for (const item of compra.itens || []) {
    const resultado = await processarItemDeCompra(sheets, spreadsheetId, item, (compra.fornecedor || '').trim());
    if (resultado.status === 'sem_estrutura_reconhecida') {
      semEstruturaReconhecida = true;
      continue;
    }
    itensProcessados.push({ ...resultado, descricaoOriginal: item.descricao, quantidade: item.quantidade });
  }

  await registrarCompraFornecedor(sheets, spreadsheetId, compra);

  return {
    numeroNota: compra.numero_nota || null,
    fornecedor: compra.fornecedor || null,
    itensProcessados,
    semEstruturaReconhecida,
    valorTotal: Number(compra.valor_total) || 0,
  };
}

function formatarResumoCompra(resultado) {
  const linhasItens = resultado.itensProcessados.map((item) => {
    const sufixo = item.status === 'criado' ? ' (produto novo, cadastrado agora)' : ' (somado ao estoque)';
    return `• ${item.quantidade}x ${item.descricaoOriginal}${sufixo}`;
  });

  const avisoEstrutura = resultado.semEstruturaReconhecida
    ? '\n\n⚠️ A aba "Matriz" não tem uma coluna de estoque reconhecível — pelo menos um item NÃO foi somado. Confira o cabeçalho da aba (precisa ter algo como "Produto" e "Estoque_Atual").'
    : '';

  const partes = [
    `✅ *Nota de compra${resultado.numeroNota ? ` #${resultado.numeroNota}` : ''} processada com sucesso!*`,
    resultado.fornecedor ? `🏭 Fornecedor: ${resultado.fornecedor}` : '',
    '',
    '📦 *Estoque reposto:*',
    ...(linhasItens.length > 0 ? linhasItens : ['(nenhum item identificado na nota)']),
    '',
    `💰 Total da compra: ${formatarMoeda(resultado.valorTotal)}`,
    '📊 Planilha e estoque atualizados!',
  ].filter(Boolean);

  return partes.join('\n') + avisoEstrutura;
}

// ---------------------------------------------------------------------------------------------
// LEITURA PRO DASHBOARD (23/08/2026) — top produtos, vendas recentes, ticket médio, clientes mais
// frequentes. Só leitura (nenhuma escrita), chamada por dashboard.js quando cliente.tipo ===
// 'COMERCIO_MATRIZ'.
// ---------------------------------------------------------------------------------------------

// Soma o total vendido e a quantidade de vendas dentro de [inicioISO, fimISO] (ambos inclusive) —
// mesma semântica de "dia"/"semana" (últimos 7 dias)/"mes" (dia 1 até hoje) já usada em
// calcularPeriodo (reconciliacao.js), repetida aqui porque aquele arquivo não exporta a função e
// este módulo é auto-contido (mesmo padrão de sempre).
function totalizarVendasNoPeriodo(vendas, inicioISO, fimISO) {
  const doPeriodo = vendas.filter((v) => v.data >= inicioISO && v.data <= fimISO);
  const total = doPeriodo.reduce((soma, v) => soma + v.valorTotal, 0);
  // "líquido" = valorLiquido quando a taxa de cartão foi preenchida à mão pra aquela venda, senão
  // cai no valorTotal bruto (mesma coisa) — não faz sentido "descontar" uma taxa desconhecida.
  const liquido = doPeriodo.reduce((soma, v) => soma + v.valorLiquido, 0);
  return {
    total,
    liquido,
    numeroVendas: doPeriodo.length,
    ticketMedio: doPeriodo.length > 0 ? total / doPeriodo.length : 0,
  };
}

async function buscarResumoComercio(spreadsheetId, { dias = 30 } = {}) {
  const sheets = getSheetsClient();

  const cabecalhoMatriz = await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_MATRIZ, CABECALHO_MATRIZ_PADRAO);
  const colunas = mapearColunas(cabecalhoMatriz);
  const ultimaColunaMatriz = colunaParaLetra(Math.max(...Object.values(colunas), cabecalhoMatriz.length - 1, 0));
  const respMatriz = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_MATRIZ}!A2:${ultimaColunaMatriz}` });
  const linhasMatriz = respMatriz.data.values || [];

  // Célula vazia devolve `null` (não 0) em estoque/estoqueMinimo/conferenciaFisica — "ninguém
  // preencheu ainda" é diferente de "zero", e misturar os dois faria o Termômetro de Reposição
  // avisar falso alarme pra todo produto que ninguém contou ainda.
  function numeroOuNulo(bruto) {
    return bruto !== undefined && bruto !== '' ? (Number(String(bruto).replace(',', '.')) || 0) : null;
  }

  const produtos = linhasMatriz
    .map((linha) => {
      const qtdVendida = colunas.qtdVendida !== undefined ? (Number(String(linha[colunas.qtdVendida] || '0').replace(',', '.')) || 0) : 0;
      const estoque = colunas.estoque !== undefined ? numeroOuNulo(linha[colunas.estoque]) : null;
      const estoqueMinimo = colunas.estoqueMinimo !== undefined ? numeroOuNulo(linha[colunas.estoqueMinimo]) : null;
      const conferenciaFisica = colunas.conferencia !== undefined ? numeroOuNulo(linha[colunas.conferencia]) : null;
      const custoUnitario = colunas.custoUnitario !== undefined ? numeroOuNulo(linha[colunas.custoUnitario]) : null;
      const saldo = estoque !== null ? estoque - qtdVendida : null;

      return {
        produto: colunas.produto !== undefined ? (linha[colunas.produto] || '') : '',
        fornecedor: colunas.fornecedor !== undefined ? (linha[colunas.fornecedor] || '') : '',
        qtdVendida,
        estoque,
        estoqueMinimo,
        saldo,
        // Termômetro de Reposição: só avisa quando o cliente já preencheu estoque (saldo não-nulo)
        // — sem meta definida, usa 0 como limiar padrão (saldo zerado/negativo = repor); com meta
        // definida (Estoque_Minimo), usa o limiar do próprio cliente.
        precisaRepor: saldo !== null && saldo <= (estoqueMinimo !== null ? estoqueMinimo : 0),
        // Conferência Diária: só existe divergência quando alguém de fato contou fisicamente
        // (conferenciaFisica não-nulo) — célula vazia não é "divergência de 0 contra a IA".
        conferenciaFisica,
        divergenciaConferencia: conferenciaFisica !== null ? conferenciaFisica - qtdVendida : null,
        // Custo_Unitario é preenchido à mão (ver cabeçalho do arquivo) — margem/markup calculados
        // logo abaixo, depois de ler o preço médio de venda de cada produto em ItensVendaCupom.
        custoUnitario,
        precoMedioVenda: null,
        margemUnitaria: null,
        markupPercentual: null,
      };
    })
    .filter((p) => p.produto);

  const rankingMaisVendidos = [...produtos].sort((a, b) => b.qtdVendida - a.qtdVendida).slice(0, 10);
  const precisamRepor = produtos.filter((p) => p.precisaRepor).sort((a, b) => (a.saldo ?? 0) - (b.saldo ?? 0));
  const divergenciasConferencia = produtos.filter((p) => p.divergenciaConferencia !== null && p.divergenciaConferencia !== 0);
  const estoqueTotalAtual = produtos.reduce((soma, p) => soma + (p.estoque ?? 0), 0);
  const fornecedores = [...new Set(produtos.map((p) => p.fornecedor).filter(Boolean))].sort();

  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_VENDAS_CUPOM, CABECALHO_VENDAS_CUPOM_PADRAO);
  const respVendas = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_VENDAS_CUPOM}!A2:L` });
  const linhasVendas = respVendas.data.values || [];

  const vendas = linhasVendas.map((l) => {
    const valorTotal = Number(String(l[8] || '0').replace(',', '.')) || 0;
    // Taxa_Cartao_Percentual (coluna L, 12ª) — PREENCHIDA À MÃO, só faz sentido quando a forma de
    // pagamento foi cartão. Célula vazia = taxa não informada ainda -> valorLiquido cai no bruto
    // (não desconta um percentual que ninguém informou, não inventa número).
    const taxaCartaoBruta = l[11];
    const taxaCartaoPercentual = taxaCartaoBruta !== undefined && taxaCartaoBruta !== ''
      ? (Number(String(taxaCartaoBruta).replace(',', '.')) || 0)
      : null;
    const valorLiquido = taxaCartaoPercentual !== null ? valorTotal * (1 - taxaCartaoPercentual / 100) : valorTotal;

    return {
      data: l[0] || '',
      hora: l[1] || '',
      numeroVenda: l[2] || '',
      cliente: l[3] || '',
      formaPagamento: l[4] || '',
      itensResumo: l[5] || '',
      taxaEntrega: Number(String(l[6] || '0').replace(',', '.')) || 0,
      desconto: Number(String(l[7] || '0').replace(',', '.')) || 0,
      valorTotal,
      taxaCartaoPercentual,
      valorLiquido,
    };
  });

  // Margem/markup por produto (pedido do Aroldo, "aja como especialista em finanças") — cruza o
  // preço de venda de cada item (ItensVendaCupom) com o Custo_Unitario da Matriz. Só calcula pra
  // produto que já tem custo preenchido — sem custo conhecido, não estima margem nenhuma (nunca
  // inventa número financeiro).
  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_ITENS_VENDA, CABECALHO_ITENS_VENDA_PADRAO);
  const respItensVenda = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_ITENS_VENDA}!A2:H` });
  const linhasItensVenda = respItensVenda.data.values || [];

  const vendidoPorProduto = new Map(); // produto normalizado -> { somaValor, somaQtd }
  for (const l of linhasItensVenda) {
    const produtoNome = l[2] || '';
    const qtd = Number(l[5]) || 0;
    const valorUnit = Number(String(l[6] || '0').replace(',', '.')) || 0;
    if (!produtoNome || qtd <= 0) continue;
    const chave = normalizarNomeProduto(produtoNome);
    const atual = vendidoPorProduto.get(chave) || { somaValor: 0, somaQtd: 0 };
    atual.somaValor += valorUnit * qtd;
    atual.somaQtd += qtd;
    vendidoPorProduto.set(chave, atual);
  }

  let lucroEstimadoTotal = 0;
  let temAlgumaMargemCalculada = false;
  for (const p of produtos) {
    const agregado = vendidoPorProduto.get(normalizarNomeProduto(p.produto));
    if (!agregado || agregado.somaQtd === 0) continue;
    p.precoMedioVenda = agregado.somaValor / agregado.somaQtd;
    if (p.custoUnitario !== null) {
      p.margemUnitaria = p.precoMedioVenda - p.custoUnitario;
      p.markupPercentual = p.custoUnitario > 0 ? (p.margemUnitaria / p.custoUnitario) * 100 : null;
      lucroEstimadoTotal += p.margemUnitaria * p.qtdVendida;
      temAlgumaMargemCalculada = true;
    }
  }

  // Relatório Dia / Semana / Mês (pedido do Aroldo) — mesma definição de período já usada no resto
  // do Pocket (calcularPeriodo/calcularPeriodoAnterior em reconciliacao.js): dia = hoje; semana =
  // últimos 7 dias corridos; mês = do dia 1 do mês corrente até hoje. "mesPassado" (23/08/2026) —
  // mês civil anterior COMPLETO, adicionado depois de um teste real mostrar que faltava: sem isso,
  // o Consultor Financeiro (PROMPT_CONSULTA) não tinha como responder "esse mês comparado ao mês
  // passado?" pros clientes de comércio, mesma pergunta que os clientes do plano padrão já
  // conseguem fazer via gerarResumo.
  const hoje = new Date();
  const hojeISO = hoje.toISOString().slice(0, 10);
  const inicioSemana = new Date(hoje);
  inicioSemana.setDate(inicioSemana.getDate() - 6);
  const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0, 10);
  const inicioMesPassado = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1).toISOString().slice(0, 10);
  const fimMesPassado = new Date(hoje.getFullYear(), hoje.getMonth(), 0).toISOString().slice(0, 10); // dia 0 do mês atual = último dia do mês anterior

  const relatorioPorPeriodo = {
    dia: totalizarVendasNoPeriodo(vendas, hojeISO, hojeISO),
    semana: totalizarVendasNoPeriodo(vendas, inicioSemana.toISOString().slice(0, 10), hojeISO),
    mes: totalizarVendasNoPeriodo(vendas, inicioMes, hojeISO),
    mesPassado: totalizarVendasNoPeriodo(vendas, inicioMesPassado, fimMesPassado),
  };

  // Mantido pro gráfico de tendência (série diária dos últimos `dias`) — resumo geral (cards) usa
  // relatorioPorPeriodo.mes agora, não mais essa janela fixa de 30 dias.
  const corte = new Date();
  corte.setDate(corte.getDate() - dias);
  const corteISO = corte.toISOString().slice(0, 10);
  const vendasPeriodo = vendas.filter((v) => v.data >= corteISO);

  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_CLIENTES_FINAIS, CABECALHO_CLIENTES_FINAIS_PADRAO);
  const respClientes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_CLIENTES_FINAIS}!A2:E` });
  const linhasClientes = respClientes.data.values || [];
  const clientesFinais = linhasClientes
    .map((l) => ({
      nome: l[0] || '',
      ultimaCompra: l[2] || '',
      qtdCompras: Number(l[3]) || 0,
      valorTotalComprado: Number(String(l[4] || '0').replace(',', '.')) || 0,
    }))
    .sort((a, b) => b.valorTotalComprado - a.valorTotalComprado)
    .slice(0, 10);

  // Série diária do período (total vendido por dia) — pro gráfico de tendência do dashboard.
  const serieMap = new Map();
  for (let i = dias - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    serieMap.set(d.toISOString().slice(0, 10), 0);
  }
  for (const v of vendasPeriodo) {
    if (serieMap.has(v.data)) serieMap.set(v.data, serieMap.get(v.data) + v.valorTotal);
  }
  const serieDiaria = [...serieMap.entries()].map(([data, total]) => ({ data, total }));

  return {
    // Cards principais do painel agora refletem o MÊS corrente (relatorioPorPeriodo.mes), não mais
    // uma janela fixa de 30 dias — dia/semana ficam disponíveis pras abas do relatório.
    totalVendido: relatorioPorPeriodo.mes.total,
    totalVendidoLiquido: relatorioPorPeriodo.mes.liquido,
    numeroVendas: relatorioPorPeriodo.mes.numeroVendas,
    ticketMedio: relatorioPorPeriodo.mes.ticketMedio,
    relatorioPorPeriodo,
    produtos,
    rankingMaisVendidos,
    precisamRepor,
    divergenciasConferencia,
    estoqueTotalAtual,
    fornecedores,
    vendasRecentes: vendas.slice(-10).reverse(),
    clientesFinais,
    serieDiaria,
    // null quando NENHUM produto tem Custo_Unitario preenchido ainda — dashboard mostra "preencha
    // o custo pra ver a margem" em vez de um lucro de R$0,00 enganoso.
    lucroEstimadoTotal: temAlgumaMargemCalculada ? lucroEstimadoTotal : null,
  };
}

const NOMES_FORMA_PAGAMENTO = {
  dinheiro: 'Dinheiro', cartao_credito: 'Cartão Crédito', cartao_debito: 'Cartão Débito', pix: 'Pix', outro: 'Outro',
};

function formatarMoeda(valor) {
  return (Number(valor) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Formato pedido pelo Aroldo (23/08/2026) — resumo amigável no WhatsApp depois de processar o cupom.
function formatarResumoCupom(resultado) {
  const linhasItens = resultado.itensProcessados.map((item) => {
    const sufixo = item.status === 'criado' ? ' (produto novo, cadastrado agora)' : ' (somado na planilha)';
    return `• ${item.quantidade}x ${item.descricaoOriginal}${sufixo}`;
  });

  const avisoEstrutura = resultado.semEstruturaReconhecida
    ? '\n\n⚠️ A aba "Matriz" não tem uma coluna de quantidade vendida reconhecível — pelo menos um item NÃO foi somado no estoque. Confira o cabeçalho da aba (precisa ter algo como "Produto" e "Qtd_Vendida").'
    : '';

  const avisoClienteNovo = resultado.clienteFinal && resultado.clienteFinal.status === 'criado'
    ? `\n👤 Cliente novo cadastrado: ${resultado.clienteFinal.nome}`
    : '';

  const partes = [
    `✅ *Cupom${resultado.numeroVenda ? ` #${resultado.numeroVenda}` : ''} processado com sucesso!*`,
    '',
    '📦 *Itens lançados na matriz:*',
    ...(linhasItens.length > 0 ? linhasItens : ['(nenhum item identificado no cupom)']),
  ];

  if (resultado.taxaEntrega > 0) partes.push(`🛵 Taxa de Entrega: ${formatarMoeda(resultado.taxaEntrega)}`);
  if (resultado.desconto > 0) partes.push(`🏷️ Desconto: ${formatarMoeda(resultado.desconto)}`);

  partes.push(`💰 Total da Venda: ${formatarMoeda(resultado.valorTotal)} (${NOMES_FORMA_PAGAMENTO[resultado.formaPagamento] || resultado.formaPagamento || 'não identificado'})`);
  partes.push('📊 Planilha e estoque atualizados!');

  return partes.join('\n') + avisoClienteNovo + avisoEstrutura;
}

module.exports = {
  processarCupomTermico,
  formatarResumoCupom,
  processarNotaCompra,
  formatarResumoCompra,
  buscarResumoComercio,
  // Exportadas pra teste isolado (ver scratchpad de testes) — não usadas fora deste módulo em produção.
  normalizarNomeProduto,
  similaridadeNomes,
  mapearColunas,
};
