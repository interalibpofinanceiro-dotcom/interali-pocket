require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const {
  extrairComprovanteDeBuffer,
  extrairExtratoDeBuffer,
  extrairContasAPagarDeBuffer,
  consultarFluxoDeCaixa,
} = require('./index');
const {
  salvarComprovante,
  buscarTodosLancamentos,
  salvarExtrato,
  buscarExtrato,
  salvarContasAPagar,
  buscarContasAPagar,
} = require('./sheets');
const {
  gerarResumo,
  formatarResumo,
  obterSaldoAtual,
  filtrarContasEmAberto,
  projetarFluxoDeCaixa,
  formatarProjecao,
} = require('./reconciliacao');

const app = express();
app.use(express.urlencoded({ extended: false }));

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const CLIENTE_WHATSAPP_NUMBER = process.env.CLIENTE_WHATSAPP_NUMBER;
const RELATORIO_SECRET = process.env.RELATORIO_SECRET;
const PORT = process.env.PORT || 3000;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

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

async function enviarMensagemWhatsApp(texto) {
  return twilioClient.messages.create({
    from: TWILIO_WHATSAPP_NUMBER,
    to: CLIENTE_WHATSAPP_NUMBER,
    body: texto,
  });
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

async function gerarEEnviarProjecao(dias) {
  const [lancamentos, extrato, contasAPagar] = await Promise.all([
    buscarTodosLancamentos(),
    buscarExtrato(),
    buscarContasAPagar(),
  ]);

  const saldoAtual = obterSaldoAtual(extrato);
  const contasEmAberto = filtrarContasEmAberto(contasAPagar, lancamentos);
  return projetarFluxoDeCaixa(saldoAtual, contasEmAberto, dias);
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
    } else if (numMedia > 0 && (corpoLower.includes('boleto') || corpoLower.includes('fatura') || corpoLower.includes('pagar'))) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0;

      const arquivoBuffer = await baixarMidiaDoTwilio(mediaUrl);
      const contas = await extrairContasAPagarDeBuffer(arquivoBuffer, mediaType);

      console.log(`Contas a pagar processadas: ${contas.length} conta(s)`);

      await salvarContasAPagar(contas);
      twiml.message(`✅ Registrei ${contas.length} conta(s) a pagar.\n\nPergunte "previsão" a qualquer momento para ver o fluxo de caixa projetado.`);
    } else if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0;

      const imageBuffer = await baixarMidiaDoTwilio(mediaUrl);
      const dadosExtraidos = await extrairComprovanteDeBuffer(imageBuffer, mediaType);

      console.log('Dados extraídos:', JSON.stringify(dadosExtraidos, null, 2));

      await salvarComprovante(dadosExtraidos);
      twiml.message(formatarResumoComprovante(dadosExtraidos));
    } else if (corpoLower.includes('resumo') || corpoLower.includes('fechamento')) {
      const periodo = corpoLower.includes('semana') ? 'semana' : corpoLower.includes('hoje') || corpoLower.includes('dia') ? 'dia' : 'mes';
      const [lancamentos, extrato] = await Promise.all([buscarTodosLancamentos(), buscarExtrato()]);
      const resumo = gerarResumo(lancamentos, extrato, { periodo });
      twiml.message(formatarResumo(resumo));
    } else if (corpoLower.includes('previsao') || corpoLower.includes('previsão') || corpoLower.includes('projecao') || corpoLower.includes('projeção')) {
      const dias = corpoLower.includes('semana') ? 7 : 30;
      const projecao = await gerarEEnviarProjecao(dias);
      twiml.message(formatarProjecao(projecao));
    } else if (corpoTexto.length > 0) {
      const [lancamentos, extrato, contasAPagar] = await Promise.all([
        buscarTodosLancamentos(),
        buscarExtrato(),
        buscarContasAPagar(),
      ]);
      const resposta = await consultarFluxoDeCaixa(corpoTexto, { lancamentos, extrato, contasAPagar });
      twiml.message(resposta);
    } else {
      twiml.message(
        'Olá! Sou o assistente financeiro da Interali Pocket 🤖\n\n' +
        '📸 Mande a foto de um comprovante, nota fiscal ou recibo para eu registrar.\n' +
        '🏦 Mande o extrato do banco (foto ou PDF) escrevendo "extrato" na legenda, para eu conciliar.\n' +
        '🧾 Mande um boleto ou fatura de cartão AINDA NÃO PAGO escrevendo "boleto" ou "fatura" na legenda.\n' +
        '💬 Pergunte "resumo do mês", "resumo da semana" ou "previsão" para ver seus relatórios.'
      );
    }
  } catch (error) {
    console.error('Erro ao processar mensagem:', error.message);
    twiml.message('Ops, não consegui processar isso agora. Pode tentar de novo?');
  }

  res.type('text/xml').send(twiml.toString());
});

// Endpoints para disparo de relatório proativo (chamados por um agendador externo,
// já que instâncias gratuitas do Render "dormem" e não sustentam um cron interno confiável).
app.all('/tarefas/relatorio/:periodo', async (req, res) => {
  if (!RELATORIO_SECRET || req.query.chave !== RELATORIO_SECRET) {
    return res.status(403).json({ erro: 'Não autorizado' });
  }

  const periodo = req.params.periodo;
  if (!['dia', 'semana', 'mes'].includes(periodo)) {
    return res.status(400).json({ erro: 'Período inválido. Use dia, semana ou mes.' });
  }

  try {
    const [lancamentos, extrato] = await Promise.all([buscarTodosLancamentos(), buscarExtrato()]);
    const resumo = gerarResumo(lancamentos, extrato, { periodo });
    await enviarMensagemWhatsApp(formatarResumo(resumo));
    res.json({ ok: true, periodo });
  } catch (error) {
    console.error('Erro ao enviar relatório proativo:', error.message);
    res.status(500).json({ erro: error.message });
  }
});

app.all('/tarefas/previsao', async (req, res) => {
  if (!RELATORIO_SECRET || req.query.chave !== RELATORIO_SECRET) {
    return res.status(403).json({ erro: 'Não autorizado' });
  }

  const dias = parseInt(req.query.dias || '30', 10);

  try {
    const projecao = await gerarEEnviarProjecao(dias);
    await enviarMensagemWhatsApp(formatarProjecao(projecao));
    res.json({ ok: true, dias });
  } catch (error) {
    console.error('Erro ao enviar previsão proativa:', error.message);
    res.status(500).json({ erro: error.message });
  }
});

app.get('/', (_req, res) => {
  res.send('Interali Pocket - servidor de webhook ativo.');
});

app.listen(PORT, () => {
  console.log(`Servidor Interali Pocket rodando na porta ${PORT}`);
  console.log(`Webhook: POST http://localhost:${PORT}/webhook`);
  console.log(`Número WhatsApp configurado: ${TWILIO_WHATSAPP_NUMBER}`);
});
