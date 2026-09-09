require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const {
  PROMPT_EXTRACAO, PROMPT_EXTRACAO_TEXTO, PROMPT_DESPESA_FIXA, PROMPT_ORCAMENTO, PROMPT_VENDAS, PROMPT_CUPOM_TERMICO, PROMPT_CONSULTA,
  PROMPT_EXTRATO, PROMPT_CONTA_A_PAGAR, PROMPT_CONTA_A_RECEBER, PROMPT_CONTA_A_RECEBER_TEXTO,
  PROMPT_FATURA_RESUMO, PROMPT_EXTRATO_RESUMO, PROMPT_ESCLARECER_ORFAOS,
} = require('./prompts');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const CLAUDE_MODEL = 'claude-sonnet-5';

// Erro específico de "resposta incompleta" — deixa o server.js dar uma mensagem mais útil pro
// cliente (ex.: "tenta com a legenda certa") em vez do genérico "chama o suporte", que não ajuda
// em nada quando o problema é isso (bug real de 14/08/2026: extrato de várias páginas mandado sem
// a legenda "extrato" caía no formato de comprovante único, que tem um limite de resposta menor —
// a IA tentava listar tudo mesmo assim, estourava o limite e cortava a resposta no meio do JSON).
class RespostaCortadaError extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'RespostaCortadaError';
  }
}

// Junta o texto da resposta e confere se ela foi CORTADA por atingir max_tokens antes de terminar
// — sinal oficial da API (`stop_reason`), mais confiável que só tentar o JSON.parse e ver se falha
// (um JSON incompleto pode até "por acaso" ter chaves/colchetes balanceados em algum ponto).
function extrairTextoResposta(response) {
  const texto = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  if (response.stop_reason === 'max_tokens') {
    throw new RespostaCortadaError('A resposta da IA ficou grande demais e foi cortada antes de terminar — provavelmente o documento tem mais informação do que esse tipo de leitura processa de uma vez (ex.: extrato de várias páginas mandado sem a legenda certa).');
  }

  return texto;
}

function extrairJSON(texto) {
  const semCercas = texto.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(semCercas.trim());
  } catch (erroOriginal) {
    throw new RespostaCortadaError(`Não consegui interpretar a resposta da IA (formato inesperado ou incompleto): ${erroOriginal.message}`);
  }
}

function getMediaType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  return map[ext] || 'image/jpeg';
}

function construirBlocoConteudo(buffer, mediaType) {
  const dataBase64 = buffer.toString('base64');
  const tipo = mediaType === 'application/pdf' ? 'document' : 'image';
  return {
    type: tipo,
    source: {
      type: 'base64',
      media_type: mediaType,
      data: dataBase64,
    },
  };
}

// Teto padrão de qualquer extração de documento (imagem/PDF) — 32000 cobre extrato/fatura de
// centenas de transações com folga (testado, ver histórico). Só os prompts de RESUMO (objeto fixo
// pequeno, não cresce com o documento) passam um `maxTokens` menor de propósito.
const MAX_TOKENS_EXTRACAO_PADRAO = 32000;

// 04/09/2026 — PONTO ÚNICO de chamada à API pra extração de documento (imagem/PDF). Antes, cada
// função de extração (comprovante, extrato, fatura, cupom...) tinha sua PRÓPRIA chamada
// `anthropic.messages.create` copiada e colada, cada uma com seu `max_tokens` — e isso já causou
// bug real 2x: em 19/08/2026 extrato/fatura/contas a receber foram corrigidos pra max_tokens 32000
// + thinking desabilitado (RespostaCortadaError em documento com muitos itens), mas
// extrairComprovanteDeBuffer ficou esquecido em 2048 até cortar de novo num caso real da Sirlene
// em 04/09/2026. Consolidando aqui: TODA extração de documento passa por esta função, então
// "esquecer de corrigir um caminho" deixa de ser possível — corrige uma vez, vale pra todos.
// `thinking: disabled` sempre (senão o modelo pode gastar quase todo o max_tokens só "pensando"
// antes de responder, e fica lento demais pra bot de WhatsApp — medido: 14855 de 16000 tokens em
// thinking numa chamada real).
async function chamarExtracaoVisao(system, buffer, mediaType, instrucao, maxTokens = MAX_TOKENS_EXTRACAO_PADRAO) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    system,
    messages: [
      {
        role: 'user',
        content: [
          construirBlocoConteudo(buffer, mediaType),
          { type: 'text', text: instrucao },
        ],
      },
    ],
  });
  return extrairTextoResposta(response);
}

// Mesma ideia acima, pro lado dos prompts SEM imagem (lançamento por texto, pergunta livre etc.) —
// um único ponto, thinking desabilitado por padrão, pra não repetir a chamada crua em cada função.
async function chamarExtracaoTexto(system, mensagemUsuario, maxTokens = 1024) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    system,
    messages: [{ role: 'user', content: mensagemUsuario }],
  });
  return extrairTextoResposta(response);
}

async function extrairComprovanteDeBuffer(imageBuffer, mediaType) {
  const texto = await chamarExtracaoVisao(
    PROMPT_EXTRACAO, imageBuffer, mediaType,
    'Extraia os dados deste comprovante seguindo o formato JSON definido.'
  );
  return extrairJSON(texto);
}

// Lançamento manual por texto — sem imagem, então manda a data de hoje explicitamente junto (o
// Claude não tem noção confiável da data atual sozinho, e a mensagem quase sempre é relativa a
// "hoje"/"ontem"/"dia N" — ver REGRAS SOBRE A DATA em PROMPT_EXTRACAO_TEXTO).
async function extrairComprovanteDeTexto(texto) {
  const hoje = new Date().toISOString().slice(0, 10); // "AAAA-MM-DD"
  const resposta = await chamarExtracaoTexto(PROMPT_EXTRACAO_TEXTO, `Data de hoje: ${hoje}\n\nMensagem do cliente: ${texto}`);
  return extrairJSON(resposta);
}

// Cadastro de despesa/receita fixa recorrente (comando "recorrente:" — ver server.js). Não
// depende da data de hoje (é uma REGRA, não um lançamento pontual — "dia_do_mes" se repete todo
// mês), então não precisa mandar a data como em extrairComprovanteDeTexto.
async function extrairDespesaFixaDeTexto(texto) {
  const resposta = await chamarExtracaoTexto(PROMPT_DESPESA_FIXA, texto, 512);
  return extrairJSON(resposta);
}

// Cadastro de orçamento por competência (comando "orçamento:" — ver server.js, 09/09/2026). Manda a
// competência ATUAL explicitamente (mesmo motivo de extrairComprovanteDeTexto) — "esse mês" só faz
// sentido se o Claude souber qual é o mês atual.
async function extrairOrcamentoDeTexto(texto) {
  const competenciaAtual = new Date().toISOString().slice(0, 7); // "AAAA-MM"
  const resposta = await chamarExtracaoTexto(PROMPT_ORCAMENTO, `Competência atual: ${competenciaAtual}\n\nMensagem do cliente: ${texto}`, 512);
  return extrairJSON(resposta);
}

async function extrairComprovante(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  const mediaType = getMediaType(imagePath);
  return extrairComprovanteDeBuffer(imageBuffer, mediaType);
}

// Investigação completa por trás do teto de 32000 + thinking desabilitado (19/08/2026, caso real:
// extrato extenso da Sirlene cortando repetidamente): o modelo engata "thinking" automático mesmo
// sem pedir, e pode consumir quase todo o max_tokens SÓ raciocinando (medido: 14855 de 16000 numa
// chamada real, e outra ficou 15min+ sem terminar) — `chamarExtracaoVisao` já desabilita isso por
// padrão. Um extrato real de 350 transações cortava mesmo com 16000; testado com 32000, coube com
// folga (25699 tokens usados). O produto promete "manda uma vez, funciona" — nunca pedir pro
// cliente dividir o arquivo; ver processarExtratoComoResumo em server.js pra quando mesmo assim
// não couber.
// 09/09/2026 — passou a devolver também `banco_conta` (nome do banco/conta lido do cabeçalho do
// extrato, ver PROMPT_EXTRATO), não só o array de transações. Quem chama (server.js) usa isso pra
// preencher a coluna Conta_Bancaria tanto no Extrato quanto nos lançamentos "órfãos" auto-registrados
// a partir dele — antes esse campo ficava sempre vazio pra esses lançamentos.
async function extrairExtratoDeBuffer(fileBuffer, mediaType) {
  const texto = await chamarExtracaoVisao(
    PROMPT_EXTRATO, fileBuffer, mediaType,
    'Extraia todas as transações deste extrato bancário seguindo o formato JSON definido.'
  );
  const resultado = extrairJSON(texto);
  return { transacoes: resultado.transacoes || [], banco_conta: resultado.banco_conta || null };
}

// Relatório de vendas do sistema/PDV/app de delivery (iFood, Rappi, InstaDelivery, etc. — o prompt
// não trava num app específico, ver PROMPT_VENDAS). Manda a data de hoje junto, mesmo motivo de
// extrairComprovanteDeTexto: relatórios "de hoje" costumam não repetir a data em cada linha.
async function extrairVendasDeBuffer(fileBuffer, mediaType) {
  const hoje = new Date().toISOString().slice(0, 10);
  const texto = await chamarExtracaoVisao(
    PROMPT_VENDAS, fileBuffer, mediaType,
    `Data de hoje: ${hoje}\n\nExtraia todas as vendas deste relatório seguindo o formato JSON definido.`
  );
  const resultado = extrairJSON(texto);
  return resultado.vendas || [];
}

// Cupom de venda impresso em impressora térmica de POS (23/08/2026, módulo Comércio com Cupom
// Térmico + Matriz de Fornecedores — ver PROMPT_CUPOM_TERMICO). Só chamada pra cliente.tipo ===
// 'COMERCIO_MATRIZ' (ver processarMidiaRecebida em server.js). Manda a data de hoje junto, mesmo
// motivo de extrairComprovanteDeTexto/extrairVendasDeBuffer: cupom físico às vezes não imprime o
// ano, ou imprime borrado.
async function extrairCupomTermicoDeBuffer(fileBuffer, mediaType) {
  const hoje = new Date().toISOString().slice(0, 10);
  const texto = await chamarExtracaoVisao(
    PROMPT_CUPOM_TERMICO, fileBuffer, mediaType,
    `Data de hoje: ${hoje}\n\nAnalise este cupom de venda seguindo o formato JSON definido.`
  );
  return extrairJSON(texto);
}

async function extrairContasAPagarDeBuffer(fileBuffer, mediaType) {
  const texto = await chamarExtracaoVisao(
    PROMPT_CONTA_A_PAGAR, fileBuffer, mediaType,
    'Extraia as contas a pagar deste boleto/fatura seguindo o formato JSON definido.'
  );
  const resultado = extrairJSON(texto);
  return resultado.contas || [];
}

// Conta a RECEBER a partir de foto/PDF (nota fiscal emitida, contrato, venda parcelada) — ver
// PROMPT_CONTA_A_RECEBER. Espelha extrairContasAPagarDeBuffer, sentido inverso.
async function extrairContasAReceberDeBuffer(fileBuffer, mediaType) {
  const texto = await chamarExtracaoVisao(
    PROMPT_CONTA_A_RECEBER, fileBuffer, mediaType,
    'Extraia as contas a receber deste documento seguindo o formato JSON definido.'
  );
  const resultado = extrairJSON(texto);
  return resultado.contas || [];
}

// RESUMO de fatura/extrato extenso (17/08/2026) — max_tokens pequeno DE PROPÓSITO (passa 512
// explícito pro 3º argumento de chamarExtracaoVisao): a resposta é sempre um objeto fixo (5-6
// campos), nunca cresce com o número de páginas/lançamentos do documento, então NÃO estoura mesmo
// numa fatura de 6+ páginas (ver PROMPT_FATURA_RESUMO em prompts.js — usado quando o documento é
// extenso demais pra extração item a item, ver documentoPareceExtenso em server.js).
async function extrairResumoFaturaDeBuffer(fileBuffer, mediaType) {
  const texto = await chamarExtracaoVisao(
    PROMPT_FATURA_RESUMO, fileBuffer, mediaType,
    'Extraia o resumo (não item a item) desta fatura/extrato seguindo o formato JSON definido.',
    512
  );
  return extrairJSON(texto);
}

// RESUMO de extrato (19/08/2026) — rede de segurança de ÚLTIMO recurso, só acionada quando mesmo
// com o teto padrão (32000) a leitura transação a transação ainda cortar (caso real: extrato da
// cliente Sirlene, RespostaCortadaError repetido). Resposta sempre um objeto fixo pequeno, nunca
// cresce com o nº de transações, então não estoura.
async function extrairResumoExtratoDeBuffer(fileBuffer, mediaType) {
  const texto = await chamarExtracaoVisao(
    PROMPT_EXTRATO_RESUMO, fileBuffer, mediaType,
    'Extraia o resumo (não transação a transação) deste extrato bancário seguindo o formato JSON definido.',
    512
  );
  return extrairJSON(texto);
}

// Conta a RECEBER por texto ("receber: 500 do João dia 20") — manda a data de hoje, mesmo motivo
// de extrairComprovanteDeTexto (vencimento relativo tipo "dia 20" precisa de referência real).
async function extrairContaAReceberDeTexto(texto) {
  const hoje = new Date().toISOString().slice(0, 10);
  const resposta = await chamarExtracaoTexto(PROMPT_CONTA_A_RECEBER_TEXTO, `Data de hoje: ${hoje}\n\nMensagem do cliente: ${texto}`, 512);
  return extrairJSON(resposta);
}

// 23/08/2026 (pedido do Aroldo — tolerância a "hoje"/"ontem"/"esse mês"/"mês passado"): a data de
// hoje NUNCA era mandada aqui, diferente de toda outra função deste arquivo que lida com data
// relativa (extrairComprovanteDeTexto, extrairCupomTermicoDeBuffer etc.) — sem isso, o Claude só
// tinha como "adivinhar" o dia de hoje pela data mais recente presente nos dados, o que falha se o
// cliente não mandou nada recente. Mesmo padrão das outras funções agora.
// Pergunta livre do "Consultor Financeiro" — única função que devolve TEXTO puro (não JSON), por
// isso não passa por chamarExtracaoTexto (que serve pra quem chama extrairJSON em cima).
async function consultarFluxoDeCaixa(pergunta, dadosPlanilha) {
  const hoje = new Date().toISOString().slice(0, 10);

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 512,
    thinking: { type: 'disabled' },
    system: PROMPT_CONSULTA,
    messages: [
      {
        role: 'user',
        content: `Data de hoje: ${hoje}\n\nDados financeiros do cliente:\n${JSON.stringify(dadosPlanilha, null, 2)}\n\nPergunta do cliente: ${pergunta}`,
      },
    ],
  });

  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

// Casa a resposta livre do cliente com a lista de recebimentos do extrato sem comprovante
// (ver PROMPT_ESCLARECER_ORFAOS / PENDENCIAS_ORFAOS em server.js). `itens` = [{ valor, data,
// descricao }] na MESMA ordem em que foram mostrados pro cliente (o índice do JSON aponta pra cá).
async function esclarecerOrfaosDeTexto(itens, texto) {
  const lista = itens.map((it, i) => `${i}. R$ ${it.valor} em ${it.data}${it.descricao ? ` — "${it.descricao}"` : ''}`).join('\n');
  const resposta = await chamarExtracaoTexto(PROMPT_ESCLARECER_ORFAOS, `RECEBIMENTOS PENDENTES:\n${lista}\n\nMENSAGEM DO CLIENTE:\n${texto}`, 2048);
  return extrairJSON(resposta);
}

async function testarAnthropic() {
  return anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1,
    system: 'Você está testando a conexão com a API da Anthropic. Responda apenas "pong".',
    messages: [
      { role: 'user', content: 'teste' },
    ],
  });
}

async function main() {
  const cliente = 'Valmir Tomé';
  const comprovantePath = path.join(__dirname, 'comprovantes', 'comprovante-valmir-tome.jpg');

  console.log(`Processando comprovante do cliente: ${cliente}`);
  console.log(`Arquivo: ${comprovantePath}`);

  try {
    const dadosExtraidos = await extrairComprovante(comprovantePath);

    console.log('\n=== Dados extraídos do comprovante ===');
    console.log(JSON.stringify(dadosExtraidos, null, 2));

    // Exemplo de uso futuro: enviar `dadosExtraidos` para o Google Sheets do cliente
    // e depois usar `consultarFluxoDeCaixa` para responder perguntas via WhatsApp.
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`\nArquivo de comprovante não encontrado em: ${comprovantePath}`);
      console.error('Coloque a imagem do comprovante nesse caminho para testar o processamento.');
    } else {
      console.error('Erro ao processar comprovante:', error.message);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  extrairComprovante,
  extrairComprovanteDeBuffer,
  extrairComprovanteDeTexto,
  extrairDespesaFixaDeTexto,
  extrairOrcamentoDeTexto,
  extrairVendasDeBuffer,
  extrairCupomTermicoDeBuffer,
  extrairExtratoDeBuffer,
  extrairContasAPagarDeBuffer,
  extrairContasAReceberDeBuffer,
  extrairContaAReceberDeTexto,
  extrairResumoFaturaDeBuffer,
  extrairResumoExtratoDeBuffer,
  esclarecerOrfaosDeTexto,
  consultarFluxoDeCaixa,
  getMediaType,
  testarAnthropic,
  RespostaCortadaError,
};
