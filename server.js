require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { extrairComprovanteDeBuffer, extrairExtratoDeBuffer, consultarFluxoDeCaixa } = require('./index');
const { salvarComprovante, buscarTodosLancamentos, salvarExtrato, buscarExtrato } = require('./sheets');
const { gerarResumo, formatarResumo } = require('./reconciliacao');

const app = express();
app.use(express.urlencoded({ extended: false }));

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const PORT = process.env.PORT || 3000;

async function baixarMidiaDoTwilio(mediaUrl) {
  const credenciais = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  const resposta = await fetch(mediaUrl, {
    headers: {
      Authorization: `Basic ${credenciais}`,
    },
  });

  if (!resposta.ok) {
    throw new Error(`Falha ao baixar mídia do Twilio: ${resposta.status}`);
  }

  const arrayBuffer = await resposta.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function formatarNumero(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarResumoComprovante(dados) {
  const linhas = [
    '✅ Comprovante processado!',
    '',
    `📅 Data: ${dados.data || 'não identificada'}`,
    `💰 Valor: ${formatarNumero(dados.valor)}`,
    `↕️ Tipo: ${dados.tipo_movimentacao === 'entrada' ? 'Entrada' : 'Saída'}`,
    `🏢 ${dados.estabelecimento_ou_pessoa || 'Não identificado'}`,
    `🏷️ Categoria: ${dados.categoria || 'Não Classificado'}`,
  ];

  if (dados.subcategoria) {
    linhas.push(`   Subcategoria: ${dados.subcategoria}`);
  }

  if (dados.descricao) {
    linhas.push(`📝 ${dados.descricao}`);
  }

  return linhas.join('\n');
}

app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const remetente = req.body.From;
  const corpoTexto = (req.body.Body || '').trim();
  const corpoLower = corpoTexto.toLowerCase();

  console.log(`Mensagem recebida de ${remetente} | mídias: ${numMedia} | texto: ${corpoTexto}`);

  try {
    if (numMedia > 0 && corpoLower.includes('extrato')) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0;

      const arquivoBuffer = await baixarMidiaDoTwilio(mediaUrl);
      const transacoes = await extrairExtratoDeBuffer(arquivoBuffer, mediaType);

      console.log(`Extrato processado: ${transacoes.length} transação(ões)`);

      await salvarExtrato(transacoes);
      twiml.message(`✅ Extrato recebido! Registrei ${transacoes.length} transação(ões).\n\nPergunte "resumo do mês" para ver o fechamento com conciliação.`);
    } else if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0;

      const imageBuffer = await baixarMidiaDoTwilio(mediaUrl);
      const dadosExtraidos = await extrairComprovanteDeBuffer(imageBuffer, mediaType);

      console.log('Dados extraídos:', JSON.stringify(dadosExtraidos, null, 2));

      await salvarComprovante(dadosExtraidos);
      twiml.message(formatarResumoComprovante(dadosExtraidos));
    } else if (corpoLower.includes('resumo') || corpoLower.includes('fechamento')) {
      const periodo = corpoLower.includes('semana') ? 'semana' : 'mes';
      const [lancamentos, extrato] = await Promise.all([buscarTodosLancamentos(), buscarExtrato()]);
      const resumo = gerarResumo(lancamentos, extrato, { periodo });
      twiml.message(formatarResumo(resumo));
    } else if (corpoTexto.length > 0) {
      const [lancamentos, extrato] = await Promise.all([buscarTodosLancamentos(), buscarExtrato()]);
      const resposta = await consultarFluxoDeCaixa(corpoTexto, { lancamentos, extrato });
      twiml.message(resposta);
    } else {
      twiml.message(
        'Olá! Sou o assistente financeiro da Interali Pocket 🤖\n\n' +
        '📸 Mande a foto de um comprovante, nota fiscal ou recibo para eu registrar.\n' +
        '🏦 Mande o extrato do banco (foto ou PDF) escrevendo "extrato" na legenda, para eu conciliar.\n' +
        '💬 Pergunte sobre seu fluxo de caixa (ex: "quanto gastei essa semana?") ou peça o "resumo do mês".'
      );
    }
  } catch (error) {
    console.error('Erro ao processar mensagem:', error.message);
    twiml.message('Ops, não consegui processar isso agora. Pode tentar de novo?');
  }

  res.type('text/xml').send(twiml.toString());
});

app.get('/', (_req, res) => {
  res.send('Interali Pocket - servidor de webhook ativo.');
});

app.listen(PORT, () => {
  console.log(`Servidor Interali Pocket rodando na porta ${PORT}`);
  console.log(`Webhook: POST http://localhost:${PORT}/webhook`);
  console.log(`Número WhatsApp configurado: ${TWILIO_WHATSAPP_NUMBER}`);
});
