require('dotenv').config();
const { Readable } = require('stream');
const { PDFDocument } = require('pdf-lib');
// getDriveClientPessoal (16/09/2026) — autenticado com a conta PESSOAL do Aroldo via OAuth (ver
// clientes.js), não a conta de serviço: é ela que tem cota de armazenamento de verdade pra criar
// pasta/arquivo novo no Drive. Só funciona depois de autorizado uma vez em
// /admin/google-oauth/iniciar (ver server.js) — antes disso, toda função aqui lança erro claro.
const { getDriveClientPessoal, definirPastaDriveClientePorSheetId } = require('./clientes');

// Módulo novo (16/09/2026, pedido do Aroldo: extrato/fatura de cartão grande travando na leitura
// de uma vez só). Duas responsabilidades que não existiam antes:
// 1) Guardar o arquivo original no Drive, organizado por CLIENTE > MÊS — pra o cliente nunca
//    perder o documento e o Aroldo poder auditar depois se precisar.
// 2) Ler OFX/CSV de extrato direto (sem IA, sem imagem, sem limite de token) — formato estruturado,
//    a leitura é 100% exata e não corre risco de "cortar" como acontece com um PDF grande.
// A divisão do PDF extenso em blocos de página (pra IA ler em várias chamadas menores, sem pressa
// de responder rápido) também mora aqui — quem decide QUANDO usar isso e escreve o resultado na
// planilha é o server.js (esse módulo só entrega blocos de bytes, não sabe nada de Sheets/WhatsApp).

// -------------------------------------------------------------------------------------------
// PASTAS NO DRIVE — Cliente > Mês
// -------------------------------------------------------------------------------------------

// Cria (ou reaproveita) a pasta do cliente dentro de GOOGLE_DRIVE_FOLDER_ID (a mesma pasta
// "CLIENTES" já usada pro estoque de planilhas em branco — não precisa de outra variável de
// ambiente nova). Uma vez criada, o ID fica salvo na planilha mestre (Pasta_Drive_ID) pra nunca
// mais precisar procurar/recriar.
//
// A pasta é UMA POR PLANILHA (Sheet_ID), não uma por número/linha — 16/09/2026, achado ao criar
// as pastas dos clientes já existentes: mais de um número de WhatsApp pode apontar pra MESMA
// planilha de propósito (ex.: Valmir Tomé + o número comercial da empresa dele que a esposa
// Sirlene também usa; ou os vários números de teste do Aroldo) — se a busca fosse por NOME (como
// era antes), cada número virava uma pasta diferente pro mesmo cliente, espalhando os documentos
// dele em Drive-folders diferentes por acidente. Por isso a busca/marcação usa appProperties.sheetId
// (nunca o nome, que pode mudar ou se repetir) e, ao criar/achar, grava o Pasta_Drive_ID em TODA
// linha da planilha mestre que aponta pro mesmo Sheet_ID (ver definirPastaDriveClientePorSheetId).
async function garantirPastaCliente(cliente) {
  if (cliente.pastaDriveId) return cliente.pastaDriveId;

  const raiz = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!raiz) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID não configurado — sem isso não dá pra criar a pasta do cliente no Drive.');
  }
  if (!cliente.sheetId) {
    throw new Error('Cliente sem Sheet_ID — não dá pra saber se já existe uma pasta pra ele.');
  }

  const drive = getDriveClientPessoal();

  const existentes = await drive.files.list({
    q: `'${raiz}' in parents and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='sheetId' and value='${cliente.sheetId}' } and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
  });

  let pastaId = existentes.data.files && existentes.data.files[0] && existentes.data.files[0].id;

  if (!pastaId) {
    const nomePasta = cliente.nome || cliente.numeroWhatsapp;
    const criada = await drive.files.create({
      requestBody: {
        name: nomePasta,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [raiz],
        appProperties: { sheetId: cliente.sheetId },
      },
      fields: 'id',
    });
    pastaId = criada.data.id;

    // Atalho pra planilha do cliente dentro da própria pasta — só organização visual (o sistema
    // continua lendo a planilha pelo Sheet_ID de sempre, este atalho é só pra quem abre o Drive
    // manualmente achar tudo junto). Melhor esforço: se falhar, não impede o resto do fluxo.
    await drive.files.create({
      requestBody: {
        name: `Planilha — ${nomePasta}`,
        mimeType: 'application/vnd.google-apps.shortcut',
        parents: [pastaId],
        shortcutDetails: { targetId: cliente.sheetId },
      },
    }).catch((erro) => console.error('Falha ao criar atalho da planilha na pasta do cliente (não crítico):', erro.message));
  }

  await definirPastaDriveClientePorSheetId(cliente.sheetId, pastaId).catch((erro) => {
    console.error('Falha ao salvar Pasta_Drive_ID na planilha mestre (pasta já foi criada, só não ficou registrada — próxima vez recupera pelo appProperties):', erro.message);
  });

  return pastaId;
}

async function garantirPastaMes(pastaClienteId, competencia) {
  const drive = getDriveClientPessoal();

  const existentes = await drive.files.list({
    q: `'${pastaClienteId}' in parents and name = '${competencia}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
  });

  const achada = existentes.data.files && existentes.data.files[0];
  if (achada) return achada.id;

  const criada = await drive.files.create({
    requestBody: { name: competencia, mimeType: 'application/vnd.google-apps.folder', parents: [pastaClienteId] },
    fields: 'id',
  });
  return criada.data.id;
}

// Salva o documento original (PDF grande, ou OFX/CSV que já foi lido mas vale guardar por
// histórico) na pasta do mês do cliente. `appProperties.status` é o que marca "ainda não lido" —
// ver listarDocumentosPendentes/marcarStatusArquivo. Usa busca por appProperties (não por nome de
// arquivo ou subpasta) pra achar pendências depois, então não precisa varrer pasta por pasta.
async function salvarDocumentoPendente(cliente, buffer, mimeType, nomeArquivoOriginal, tipoAlvo) {
  const pastaCliente = await garantirPastaCliente(cliente);
  const competencia = new Date().toISOString().slice(0, 7); // "AAAA-MM"
  const pastaMes = await garantirPastaMes(pastaCliente, competencia);

  const drive = getDriveClientPessoal();
  const nome = nomeArquivoOriginal || `documento-${Date.now()}.${mimeType === 'application/pdf' ? 'pdf' : 'bin'}`;

  const resposta = await drive.files.create({
    requestBody: {
      name: nome,
      parents: [pastaMes],
      appProperties: {
        status: 'aguardando',
        tipoAlvo, // 'extrato' | 'fatura'
        numeroWhatsapp: cliente.numeroWhatsapp,
      },
    },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id,name',
  });

  return resposta.data;
}

// Busca GLOBAL por appProperties (status=aguardando + o número do cliente) — dispensa varrer
// pasta por pasta ou mês por mês; funciona mesmo se o job de processamento ficar dias sem rodar.
async function listarDocumentosPendentes(cliente) {
  const drive = getDriveClientPessoal();
  const numeroEscapado = cliente.numeroWhatsapp.replace(/'/g, "\\'");

  const resposta = await drive.files.list({
    q: `appProperties has { key='status' and value='aguardando' } and appProperties has { key='numeroWhatsapp' and value='${numeroEscapado}' } and trashed = false`,
    fields: 'files(id,name,mimeType,appProperties)',
    pageSize: 50,
  });

  return resposta.data.files || [];
}

async function baixarArquivo(fileId) {
  const drive = getDriveClientPessoal();
  const resposta = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(resposta.data);
}

// appProperties é mesclado pelo Drive (não substitui o mapa inteiro) — só o "status" muda,
// tipoAlvo/numeroWhatsapp continuam lá pra quem quiser auditar depois.
async function marcarStatusArquivo(fileId, status) {
  const drive = getDriveClientPessoal();
  await drive.files.update({ fileId, requestBody: { appProperties: { status } } });
}

// -------------------------------------------------------------------------------------------
// DIVISÃO DE PDF GRANDE EM BLOCOS DE PÁGINA
// -------------------------------------------------------------------------------------------

// Divide o PDF em blocos de N páginas (padrão 6) pra extração item a item rodar em várias
// chamadas menores em vez de uma só — sem essa divisão é isso que estoura o limite de resposta da
// IA num extrato/fatura de muitas páginas (ver RespostaCortadaError em index.js). Cada bloco é
// lido pelo MESMO prompt/função que já existe (extrairExtratoDeBuffer/extrairContasAPagarDeBuffer
// em index.js) — quem chama (server.js) é responsável por juntar os resultados de todos os blocos.
// Header/rodapé (nome do banco, vencimento) normalmente só aparece na 1ª página — quem consome o
// resultado dos blocos 2+ deve usar o valor lido no bloco 1 como fallback quando vier vazio.
async function dividirPdfEmBlocos(buffer, paginasPorBloco = 6) {
  const origem = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const totalPaginas = origem.getPageCount();
  const blocos = [];

  for (let inicio = 0; inicio < totalPaginas; inicio += paginasPorBloco) {
    const fim = Math.min(inicio + paginasPorBloco, totalPaginas);
    const indices = Array.from({ length: fim - inicio }, (_, i) => inicio + i);

    const novoPdf = await PDFDocument.create();
    const paginasCopiadas = await novoPdf.copyPages(origem, indices);
    paginasCopiadas.forEach((pagina) => novoPdf.addPage(pagina));

    const bytes = await novoPdf.save();
    blocos.push(Buffer.from(bytes));
  }

  return blocos;
}

// -------------------------------------------------------------------------------------------
// OFX (extrato/fatura em formato estruturado — sem IA, leitura exata)
// -------------------------------------------------------------------------------------------

function campoOfx(bloco, tag) {
  const m = bloco.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'));
  return m ? m[1].trim() : '';
}

// OFX pode vir em SGML antigo (tag sem fechamento, ex. "<DTPOSTED>20260901000000") ou XML novo
// (com fechamento, "<DTPOSTED>20260901</DTPOSTED>") — campoOfx lida com os dois porque só lê até
// o próximo "<" ou fim de linha, não depende da tag de fechamento existir.
function parseOFX(buffer) {
  const texto = buffer.toString('latin1');
  const blocosTransacao = texto.match(/<STMTTRN>[\s\S]*?(?=<STMTTRN>|<\/BANKTRANLIST>|<\/CCSTMTRS>|$)/gi) || [];

  const transacoes = blocosTransacao
    .map((bloco) => {
      const dataRaw = campoOfx(bloco, 'DTPOSTED');
      const data = dataRaw.length >= 8 ? `${dataRaw.slice(0, 4)}-${dataRaw.slice(4, 6)}-${dataRaw.slice(6, 8)}` : null;
      const valorRaw = parseFloat(campoOfx(bloco, 'TRNAMT').replace(',', '.'));
      const descricao = campoOfx(bloco, 'NAME') || campoOfx(bloco, 'MEMO') || '';

      return {
        data,
        valor: Math.abs(valorRaw),
        tipo: valorRaw >= 0 ? 'entrada' : 'saida',
        descricao,
        saldo_apos: null,
      };
    })
    .filter((t) => t.data && !Number.isNaN(t.valor));

  const bancoMatch = texto.match(/<ORG>([^<\r\n]*)/i) || texto.match(/<BANKID>([^<\r\n]*)/i);
  const contaBancaria = bancoMatch ? bancoMatch[1].trim() : null;

  return { transacoes, contaBancaria };
}

// -------------------------------------------------------------------------------------------
// CSV (extrato/fatura exportado em planilha) — melhor esforço, sem IA
// -------------------------------------------------------------------------------------------

class CsvNaoReconhecidoError extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'CsvNaoReconhecidoError';
  }
}

function detectarDelimitadorCsv(linha) {
  const virgulas = (linha.match(/,/g) || []).length;
  const pontoVirgulas = (linha.match(/;/g) || []).length;
  return pontoVirgulas > virgulas ? ';' : ',';
}

// Aceita valor em formato BR ("1.234,56") ou internacional ("1234.56"); parênteses ou "-" na
// frente marcam débito, igual boa parte dos exports de banco/cartão.
function normalizarValorCsv(txt) {
  if (!txt) return NaN;
  let limpo = txt.trim().replace(/^R\$\s*/i, '');
  const negativo = /^\(.*\)$/.test(limpo) || limpo.startsWith('-');
  limpo = limpo.replace(/[()]/g, '').replace(/^-/, '');
  if (/,\d{1,2}$/.test(limpo) && limpo.includes('.')) {
    limpo = limpo.replace(/\./g, '').replace(',', '.');
  } else if (limpo.includes(',') && !limpo.includes('.')) {
    limpo = limpo.replace(',', '.');
  }
  const numero = parseFloat(limpo);
  return negativo ? -numero : numero;
}

function normalizarDataCsv(txt) {
  const t = (txt || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const ano = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${ano}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

const CABECALHOS_DATA_CSV = ['data', 'date', 'dt', 'data lancamento', 'data lançamento', 'data da compra'];
const CABECALHOS_VALOR_CSV = ['valor', 'amount', 'value', 'vlr', 'vlr(r$)', 'valor(r$)'];
const CABECALHOS_DESCRICAO_CSV = ['descricao', 'descrição', 'description', 'historico', 'histórico', 'memo', 'lançamento', 'lancamento', 'estabelecimento'];

// Melhor esforço DE PROPÓSITO: se não reconhecer as colunas com confiança, lança
// CsvNaoReconhecidoError em vez de adivinhar — mesmo princípio do resto do projeto (nunca lançar
// errado só pra não incomodar ninguém). Quem chama decide o que fazer (avisar admin, pedir pro
// cliente mandar em outro formato).
function parseCSV(buffer) {
  const texto = buffer.toString('utf8').replace(/^﻿/, '');
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim().length > 0);

  if (linhas.length < 2) {
    throw new CsvNaoReconhecidoError('CSV vazio ou sem linhas suficientes pra ter cabeçalho + dado.');
  }

  const delimitador = detectarDelimitadorCsv(linhas[0]);
  const cabecalho = linhas[0].split(delimitador).map((c) => c.trim().toLowerCase().replace(/"/g, ''));

  const achaColuna = (opcoes) => cabecalho.findIndex((c) => opcoes.includes(c));
  const idxData = achaColuna(CABECALHOS_DATA_CSV);
  const idxValor = achaColuna(CABECALHOS_VALOR_CSV);
  const idxDescricao = achaColuna(CABECALHOS_DESCRICAO_CSV);

  if (idxData === -1 || idxValor === -1) {
    throw new CsvNaoReconhecidoError(`Não reconheci as colunas de data/valor no cabeçalho do CSV: "${linhas[0]}"`);
  }

  const transacoes = [];
  for (let i = 1; i < linhas.length; i += 1) {
    const colunas = linhas[i].split(delimitador).map((c) => c.trim().replace(/^"|"$/g, ''));
    const data = normalizarDataCsv(colunas[idxData]);
    const valorBruto = normalizarValorCsv(colunas[idxValor]);
    if (!data || Number.isNaN(valorBruto)) continue;

    transacoes.push({
      data,
      valor: Math.abs(valorBruto),
      tipo: valorBruto >= 0 ? 'entrada' : 'saida',
      descricao: idxDescricao !== -1 ? (colunas[idxDescricao] || '') : '',
      saldo_apos: null,
    });
  }

  if (transacoes.length === 0) {
    throw new CsvNaoReconhecidoError('Nenhuma transação válida encontrada no CSV (datas/valores não reconhecidos nas linhas).');
  }

  return { transacoes, contaBancaria: null };
}

// -------------------------------------------------------------------------------------------

function tipoDoArquivo(nomeArquivo, mimeType) {
  const nome = (nomeArquivo || '').toLowerCase();
  if (nome.endsWith('.ofx') || nome.endsWith('.qfx')) return 'ofx';
  if (nome.endsWith('.csv')) return 'csv';
  if (mimeType === 'application/pdf' || nome.endsWith('.pdf')) return 'pdf';
  return null;
}

module.exports = {
  garantirPastaCliente,
  salvarDocumentoPendente,
  listarDocumentosPendentes,
  baixarArquivo,
  marcarStatusArquivo,
  dividirPdfEmBlocos,
  parseOFX,
  parseCSV,
  tipoDoArquivo,
  CsvNaoReconhecidoError,
};
