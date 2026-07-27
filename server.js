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
const { buscarClientePorNumero, listarClientesAtivos } = require('./clientes');

const app = express();
app.use(express.urlencoded({ extended: false }));

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
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

async function enviarMensagemWhatsApp(numeroDestino, texto) {
  return twilioClient.messages.create({
    from: TWILIO_WHATSAPP_NUMBER,
    to: numeroDestino,
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

async function gerarProjecao(sheetId, dias) {
  const [lancamentos, extrato, contasAPagar] = await Promise.all([
    buscarTodosLancamentos(sheetId),
    buscarExtrato(sheetId),
    buscarContasAPagar(sheetId),
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
    const cliente = await buscarClientePorNumero(remetente);

    if (!cliente) {
      twiml.message('Esse número ainda não está cadastrado no Interali Pocket. Fale com a Interali para ativar seu acesso.');
      res.type('text/xml').send(twiml.toString());
      return;
    }

    const sheetId = cliente.sheetId;

    if (numMedia > 0 && corpoLower.includes('extrato')) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0;

      const arquivoBuffer = await baixarMidiaDoTwilio(mediaUrl);
      const transacoes = await extrairExtratoDeBuffer(arquivoBuffer, mediaType);

      console.log(`Extrato processado: ${transacoes.length} transação(ões)`);

      await salvarExtrato(sheetId, transacoes);
      twiml.message(`✅ Extrato recebido! Registrei ${transacoes.length} transação(ões).\n\nPergunte "resumo do mês" para ver o fechamento com conciliação.`);
    } else if (numMedia > 0 && (corpoLower.includes('boleto') || corpoLower.includes('fatura') || corpoLower.includes('pagar'))) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0;

      const arquivoBuffer = await baixarMidiaDoTwilio(mediaUrl);
      const contas = await extrairContasAPagarDeBuffer(arquivoBuffer, mediaType);

      console.log(`Contas a pagar processadas: ${contas.length} conta(s)`);

      await salvarContasAPagar(sheetId, contas);
      twiml.message(`✅ Registrei ${contas.length} conta(s) a pagar.\n\nPergunte "previsão" a qualquer momento para ver o fluxo de caixa projetado.`);
    } else if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0;

      const imageBuffer = await baixarMidiaDoTwilio(mediaUrl);
      const dadosExtraidos = await extrairComprovanteDeBuffer(imageBuffer, mediaType);

      console.log('Dados extraídos:', JSON.stringify(dadosExtraidos, null, 2));

      await salvarComprovante(sheetId, dadosExtraidos);
      twiml.message(formatarResumoComprovante(dadosExtraidos));
    } else if (corpoLower.includes('resumo') || corpoLower.includes('fechamento')) {
      const periodo = corpoLower.includes('semana') ? 'semana' : corpoLower.includes('hoje') || corpoLower.includes('dia') ? 'dia' : 'mes';
      const [lancamentos, extrato] = await Promise.all([buscarTodosLancamentos(sheetId), buscarExtrato(sheetId)]);
      const resumo = gerarResumo(lancamentos, extrato, { periodo });
      twiml.message(formatarResumo(resumo));
    } else if (corpoLower.includes('previsao') || corpoLower.includes('previsão') || corpoLower.includes('projecao') || corpoLower.includes('projeção')) {
      const dias = corpoLower.includes('semana') ? 7 : 30;
      const projecao = await gerarProjecao(sheetId, dias);
      twiml.message(formatarProjecao(projecao));
    } else if (corpoTexto.length > 0) {
      const [lancamentos, extrato, contasAPagar] = await Promise.all([
        buscarTodosLancamentos(sheetId),
        buscarExtrato(sheetId),
        buscarContasAPagar(sheetId),
      ]);
      const resposta = await consultarFluxoDeCaixa(corpoTexto, { lancamentos, extrato, contasAPagar });
      twiml.message(resposta);
    } else {
      twiml.message(
        `Olá, ${cliente.nome || ''}! Sou o assistente financeiro da Interali Pocket 🤖\n\n` +
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
// Percorrem todos os clientes ativos da planilha mestre, ou só um (?numero=whatsapp:+55...) para teste.
app.all('/tarefas/relatorio/:periodo', async (req, res) => {
  if (!RELATORIO_SECRET || req.query.chave !== RELATORIO_SECRET) {
    return res.status(403).json({ erro: 'Não autorizado' });
  }

  const periodo = req.params.periodo;
  if (!['dia', 'semana', 'mes'].includes(periodo)) {
    return res.status(400).json({ erro: 'Período inválido. Use dia, semana ou mes.' });
  }

  try {
    const clientes = await listarClientesAtivos({ ignorarCache: true });
    const alvo = req.query.numero
      ? clientes.filter((cliente) => cliente.numeroWhatsapp === req.query.numero)
      : clientes;

    const resultados = [];
    for (const cliente of alvo) {
      const [lancamentos, extrato] = await Promise.all([
        buscarTodosLancamentos(cliente.sheetId),
        buscarExtrato(cliente.sheetId),
      ]);
      const resumo = gerarResumo(lancamentos, extrato, { periodo });
      await enviarMensagemWhatsApp(cliente.numeroWhatsapp, formatarResumo(resumo));
      resultados.push(cliente.numeroWhatsapp);
    }

    res.json({ ok: true, periodo, enviados: resultados });
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
    const clientes = await listarClientesAtivos({ ignorarCache: true });
    const alvo = req.query.numero
      ? clientes.filter((cliente) => cliente.numeroWhatsapp === req.query.numero)
      : clientes;

    const resultados = [];
    for (const cliente of alvo) {
      const projecao = await gerarProjecao(cliente.sheetId, dias);
      await enviarMensagemWhatsApp(cliente.numeroWhatsapp, formatarProjecao(projecao));
      resultados.push(cliente.numeroWhatsapp);
    }

    res.json({ ok: true, dias, enviados: resultados });
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
