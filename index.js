require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { PROMPT_EXTRACAO, PROMPT_CONSULTA } = require('./prompts');

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

async function extrairComprovanteDeBuffer(imageBuffer, mediaType) {
  const imageBase64 = imageBuffer.toString('base64');

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: PROMPT_EXTRACAO,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: imageBase64,
            },
          },
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

async function consultarFluxoDeCaixa(pergunta, dadosPlanilha) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 512,
    system: PROMPT_CONSULTA,
    messages: [
      {
        role: 'user',
        content: `Dados financeiros do cliente (extraídos da planilha):\n${JSON.stringify(dadosPlanilha, null, 2)}\n\nPergunta do cliente: ${pergunta}`,
      },
    ],
  });

  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
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
  consultarFluxoDeCaixa,
  getMediaType,
};
