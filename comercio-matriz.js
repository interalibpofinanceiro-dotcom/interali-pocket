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
// 'Estoque_Atual' (23/08/2026, pedido do Aroldo) — coluna PREENCHIDA À MÃO pelo cliente (nunca
// escrita pelo código, só lida) com a quantidade que ele tem em estoque agora. O sistema só soma
// Qtd_Vendida sozinho; "Saldo" (estoque − vendido) é calculado na hora de mostrar (ver
// buscarResumoComercio) — não grava nada de volta na planilha, então o cliente sempre pode
// corrigir a contagem manualmente sem o Pocket sobrescrever.
const CABECALHO_MATRIZ_PADRAO = ['Fornecedor', 'Codigo', 'Produto', 'Qtd_Vendida', 'Conferencia', 'Estoque_Atual'];

const ABA_CLIENTES_FINAIS = 'ClientesFinais';
const CABECALHO_CLIENTES_FINAIS_PADRAO = ['Nome', 'Primeira_Compra', 'Ultima_Compra', 'Qtd_Compras', 'Valor_Total_Comprado'];

const ABA_VENDAS_CUPOM = 'VendasCupom';
const CABECALHO_VENDAS_CUPOM_PADRAO = [
  'Data', 'Hora', 'Numero_Venda', 'Cliente', 'Forma_Pagamento', 'Itens_Resumo',
  'Taxa_Entrega', 'Desconto', 'Valor_Total', 'Status', 'Registrado_Em',
];

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
};

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

  const ultimaColuna = String.fromCharCode('A'.charCodeAt(0) + cabecalhoPadrao.length - 1);
  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${nomeAba}!A1:${ultimaColuna}1` });

  if (!resposta.data.values || resposta.data.values.length === 0 || resposta.data.values[0].length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${nomeAba}!A1:${ultimaColuna}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [cabecalhoPadrao] },
    });
    return cabecalhoPadrao;
  }

  return resposta.data.values[0];
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

    const requests = [{
      range: `${ABA_MATRIZ}!${colunaParaLetra(colunas.qtdVendida)}${linhaPlanilha}`,
      values: [[novoValor]],
    }];
    if (colunas.conferencia !== undefined) {
      // "Replicar a quantidade pra manter a paridade visual" (pedido do Aroldo) — mesmo novo valor
      // somado, não só a quantidade do cupom atual.
      requests.push({ range: `${ABA_MATRIZ}!${colunaParaLetra(colunas.conferencia)}${linhaPlanilha}`, values: [[novoValor]] });
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
  // fica em branco (o cupom de venda não informa fornecedor) — fica marcado como pendência de
  // preenchimento manual, sem bloquear o lançamento da venda em si.
  const linhaNova = new Array(cabecalho.length).fill('');
  linhaNova[colunas.produto] = item.descricao || '(produto não identificado)';
  linhaNova[colunas.qtdVendida] = quantidadeVendida;
  if (colunas.codigo !== undefined && item.codigo) linhaNova[colunas.codigo] = item.codigo;
  if (colunas.conferencia !== undefined) linhaNova[colunas.conferencia] = quantidadeVendida;

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
    range: `${ABA_VENDAS_CUPOM}!A:K`,
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
      ]],
    },
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

// ---------------------------------------------------------------------------------------------
// LEITURA PRO DASHBOARD (23/08/2026) — top produtos, vendas recentes, ticket médio, clientes mais
// frequentes. Só leitura (nenhuma escrita), chamada por dashboard.js quando cliente.tipo ===
// 'COMERCIO_MATRIZ'.
// ---------------------------------------------------------------------------------------------

async function buscarResumoComercio(spreadsheetId, { dias = 30 } = {}) {
  const sheets = getSheetsClient();

  const cabecalhoMatriz = await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_MATRIZ, CABECALHO_MATRIZ_PADRAO);
  const colunas = mapearColunas(cabecalhoMatriz);
  const ultimaColunaMatriz = colunaParaLetra(Math.max(...Object.values(colunas), cabecalhoMatriz.length - 1, 0));
  const respMatriz = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_MATRIZ}!A2:${ultimaColunaMatriz}` });
  const linhasMatriz = respMatriz.data.values || [];

  const topProdutos = linhasMatriz
    .map((linha) => {
      const qtdVendida = colunas.qtdVendida !== undefined ? (Number(String(linha[colunas.qtdVendida] || '0').replace(',', '.')) || 0) : 0;
      // "Estoque_Atual" é preenchido À MÃO pelo cliente (nunca escrito pelo Pocket) — célula vazia
      // (cliente ainda não preencheu) devolve `estoque: null`, não 0, pra não parecer "acabou o
      // estoque" quando na verdade é só "ninguém contou ainda". `saldo` só existe quando o cliente
      // já preencheu.
      const estoqueBruto = colunas.estoque !== undefined ? linha[colunas.estoque] : undefined;
      const estoque = estoqueBruto !== undefined && estoqueBruto !== '' ? (Number(String(estoqueBruto).replace(',', '.')) || 0) : null;
      return {
        produto: colunas.produto !== undefined ? (linha[colunas.produto] || '') : '',
        fornecedor: colunas.fornecedor !== undefined ? (linha[colunas.fornecedor] || '') : '',
        qtdVendida,
        estoque,
        saldo: estoque !== null ? estoque - qtdVendida : null,
      };
    })
    .filter((p) => p.produto)
    .sort((a, b) => b.qtdVendida - a.qtdVendida)
    .slice(0, 10);

  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_VENDAS_CUPOM, CABECALHO_VENDAS_CUPOM_PADRAO);
  const respVendas = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ABA_VENDAS_CUPOM}!A2:K` });
  const linhasVendas = respVendas.data.values || [];

  const vendas = linhasVendas.map((l) => ({
    data: l[0] || '',
    hora: l[1] || '',
    numeroVenda: l[2] || '',
    cliente: l[3] || '',
    formaPagamento: l[4] || '',
    itensResumo: l[5] || '',
    taxaEntrega: Number(String(l[6] || '0').replace(',', '.')) || 0,
    desconto: Number(String(l[7] || '0').replace(',', '.')) || 0,
    valorTotal: Number(String(l[8] || '0').replace(',', '.')) || 0,
  }));

  const corte = new Date();
  corte.setDate(corte.getDate() - dias);
  const corteISO = corte.toISOString().slice(0, 10);
  const vendasPeriodo = vendas.filter((v) => v.data >= corteISO);

  const totalVendido = vendasPeriodo.reduce((soma, v) => soma + v.valorTotal, 0);
  const numeroVendas = vendasPeriodo.length;
  const ticketMedio = numeroVendas > 0 ? totalVendido / numeroVendas : 0;

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

  // Série diária do período (total vendido por dia) — pro gráfico do dashboard.
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
    topProdutos,
    vendasRecentes: vendas.slice(-10).reverse(),
    totalVendido,
    numeroVendas,
    ticketMedio,
    clientesFinais,
    serieDiaria,
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
  buscarResumoComercio,
  // Exportadas pra teste isolado (ver scratchpad de testes) — não usadas fora deste módulo em produção.
  normalizarNomeProduto,
  similaridadeNomes,
  mapearColunas,
};
