require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { PROMPT_EXTRACAO, PROMPT_EXTRACAO_TEXTO, PROMPT_DESPESA_FIXA, PROMPT_VENDAS, PROMPT_CONSULTA, PROMPT_EXTRATO, PROMPT_CONTA_A_PAGAR } = require('./prompts');

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

async function extrairComprovanteDeBuffer(imageBuffer, mediaType) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    // 2048 em vez de 1024 (14/08/2026) — folga extra pra documentos com mais itens do que o normal
    // (ex.: nota de fornecedor com muita linha), sem chegar nem perto do limite de extrato (4096).
    max_tokens: 2048,
    system: PROMPT_EXTRACAO,
    messages: [
      {
        role: 'user',
        content: [
          construirBlocoConteudo(imageBuffer, mediaType),
          {
            type: 'text',
            text: 'Extraia os dados deste comprovante seguindo o formato JSON definido.',
          },
        ],
      },
    ],
  });

  return extrairJSON(extrairTextoResposta(response));
}

// Lançamento manual por texto — sem imagem, então manda a data de hoje explicitamente junto (o
// Claude não tem noção confiável da data atual sozinho, e a mensagem quase sempre é relativa a
// "hoje"/"ontem"/"dia N" — ver REGRAS SOBRE A DATA em PROMPT_EXTRACAO_TEXTO).
async function extrairComprovanteDeTexto(texto) {
  const hoje = new Date().toISOString().slice(0, 10); // "AAAA-MM-DD"

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: PROMPT_EXTRACAO_TEXTO,
    messages: [
      {
        role: 'user',
        content: `Data de hoje: ${hoje}\n\nMensagem do cliente: ${texto}`,
      },
    ],
  });

  return extrairJSON(extrairTextoResposta(response));
}

// Cadastro de despesa/receita fixa recorrente (comando "recorrente:" — ver server.js). Não
// depende da data de hoje (é uma REGRA, não um lançamento pontual — "dia_do_mes" se repete todo
// mês), então não precisa mandar a data como em extrairComprovanteDeTexto.
async function extrairDespesaFixaDeTexto(texto) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 512,
    system: PROMPT_DESPESA_FIXA,
    messages: [
      { role: 'user', content: texto },
    ],
  });

  return extrairJSON(extrairTextoResposta(response));
}

async function extrairComprovante(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  const mediaType = getMediaType(imagePath);
  return extrairComprovanteDeBuffer(imageBuffer, mediaType);
}

async function extrairExtratoDeBuffer(fileBuffer, mediaType) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: PROMPT_EXTRATO,
    messages: [
      {
        role: 'user',
        content: [
          construirBlocoConteudo(fileBuffer, mediaType),
          {
            type: 'text',
            text: 'Extraia todas as transações deste extrato bancário seguindo o formato JSON definido.',
          },
        ],
      },
    ],
  });

  const resultado = extrairJSON(extrairTextoResposta(response));
  return resultado.transacoes || [];
}

// Relatório de vendas do sistema/PDV/app de delivery (iFood, Rappi, InstaDelivery, etc. — o prompt
// não trava num app específico, ver PROMPT_VENDAS). Manda a data de hoje junto, mesmo motivo de
// extrairComprovanteDeTexto: relatórios "de hoje" costumam não repetir a data em cada linha.
async function extrairVendasDeBuffer(fileBuffer, mediaType) {
  const hoje = new Date().toISOString().slice(0, 10);

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: PROMPT_VENDAS,
    messages: [
      {
        role: 'user',
        content: [
          construirBlocoConteudo(fileBuffer, mediaType),
          {
            type: 'text',
            text: `Data de hoje: ${hoje}\n\nExtraia todas as vendas deste relatório seguindo o formato JSON definido.`,
          },
        ],
      },
    ],
  });

  const resultado = extrairJSON(extrairTextoResposta(response));
  return resultado.vendas || [];
}

async function extrairContasAPagarDeBuffer(fileBuffer, mediaType) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: PROMPT_CONTA_A_PAGAR,
    messages: [
      {
        role: 'user',
        content: [
          construirBlocoConteudo(fileBuffer, mediaType),
          {
            type: 'text',
            text: 'Extraia as contas a pagar deste boleto/fatura seguindo o formato JSON definido.',
          },
        ],
      },
    ],
  });

  const resultado = extrairJSON(extrairTextoResposta(response));
  return resultado.contas || [];
}

async function consultarFluxoDeCaixa(pergunta, dadosPlanilha) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 512,
    system: PROMPT_CONSULTA,
    messages: [
      {
        role: 'user',
        content: `Dados financeiros do cliente:\n${JSON.stringify(dadosPlanilha, null, 2)}\n\nPergunta do cliente: ${pergunta}`,
      },
    ],
  });

  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
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
  extrairVendasDeBuffer,
  extrairExtratoDeBuffer,
  extrairContasAPagarDeBuffer,
  consultarFluxoDeCaixa,
  getMediaType,
  testarAnthropic,
  RespostaCortadaError,
};
