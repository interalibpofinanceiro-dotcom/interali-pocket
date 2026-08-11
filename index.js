require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { PROMPT_EXTRACAO, PROMPT_CONSULTA, PROMPT_EXTRATO, PROMPT_CONTA_A_PAGAR } = require('./prompts');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const CLAUDE_MODEL = 'claude-sonnet-5';

function extrairJSON(texto) {
  const semCercas = texto.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(semCercas.trim());
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
    max_tokens: 1024,
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

  const textoResposta = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return extrairJSON(textoResposta);
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

  const textoResposta = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const resultado = extrairJSON(textoResposta);
  return resultado.transacoes || [];
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

  const textoResposta = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const resultado = extrairJSON(textoResposta);
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
  extrairExtratoDeBuffer,
  extrairContasAPagarDeBuffer,
  consultarFluxoDeCaixa,
  getMediaType,
  testarAnthropic,
};
