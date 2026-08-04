require('dotenv').config();
const express = require('express');
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

// Log de TODA requisição que chega, antes de qualquer outra coisa — inclusive as que não vão
// bater em nenhuma rota. Sem isso, um caminho ou método inesperado (ex.: a Evolution mandando
// pra "/webhook/messages-upsert" em vez de "/webhook") não deixa rastro nenhum nos logs.
app.use((req, _res, next) => {
  console.log(`Requisição recebida: ${req.method} ${req.originalUrl}`);
  next();
});

// type: '*/*' porque nem toda implementação de webhook manda o header Content-Type
// exatamente como "application/json" — sem isso, o body chegaria vazio silenciosamente.
// limit maior que o padrão (100kb) porque a Evolution API inclui thumbnails/dados em base64
// no próprio payload do webhook de imagem e documento — sem isso, toda mensagem com mídia
// era rejeitada com PayloadTooLargeError antes de chegar no handler (bug real encontrado em produção).
app.use(express.json({ type: '*/*', limit: '50mb' }));

const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;
const RELATORIO_SECRET = process.env.RELATORIO_SECRET;
const PORT = process.env.PORT || 3000;

// ── Números: a planilha guarda "whatsapp:+55XXXXXXXXXXX" (formato herdado do Twilio).
// A Evolution API usa só dígitos ("55XXXXXXXXXXX") pra enviar e JID ("55XXXXXXXXXXX@s.whatsapp.net")
// pra identificar quem mandou. Converte nas bordas pra não precisar migrar o que já tá cadastrado.
function jidParaFormatoPlanilha(remoteJid) {
  const numero = (remoteJid || '').split('@')[0];
  return `whatsapp:+${numero}`;
}

function formatoPlanilhaParaNumeroEvolution(numeroPlanilha) {
  return (numeroPlanilha || '').replace('whatsapp:', '').replace('+', '');
}

async function chamarEvolutionAPI(caminho, corpo) {
  const resposta = await fetch(`${EVOLUTION_API_URL}${caminho}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify(corpo),
  });

  if (!resposta.ok) {
    const textoErro = await resposta.text().catch(() => '');
    throw new Error(`Evolution API respondeu ${resposta.status}: ${textoErro}`);
  }

  return resposta.json();
}

async function enviarMensagemWhatsApp(numeroDestinoPlanilha, texto) {
  const number = formatoPlanilhaParaNumeroEvolution(numeroDestinoPlanilha);
  // encodeURIComponent porque o nome real da instância na Evolution tem espaço ("Interlai Poket") —
  // sem isso, o espaço quebraria a URL da requisição.
  return chamarEvolutionAPI(`/message/sendText/${encodeURIComponent(EVOLUTION_INSTANCE)}`, { number, text: texto });
}

// Busca o binário (imagem/PDF) de uma mensagem recebida, pelo id da mensagem —
// a Evolution não manda o arquivo direto no webhook, só os metadados.
async function buscarMidiaBase64(messageId) {
  const resultado = await chamarEvolutionAPI(`/chat/getBase64FromMediaMessage/${encodeURIComponent(EVOLUTION_INSTANCE)}`, {
    message: { key: { id: messageId } },
    convertToMp4: false,
  });

  return {
    buffer: Buffer.from(resultado.base64, 'base64'),
    mimeType: resultado.mimetype,
  };
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

// Extrai o nome do cartão da legenda (ex.: "lançar como Cartão Bradesco" → "Bradesco"),
// já que o nome do cartão normalmente não aparece de forma confiável na própria imagem da fatura —
// quem sabe qual cartão é o cliente, então ele informa isso na legenda da mensagem.
function extrairNomeCartao(legendaLower) {
  const match = legendaLower.match(/cart[ãa]o\s+([a-zà-ÿ0-9]+(?:\s+[a-zà-ÿ0-9]+){0,2})/i);
  if (!match) return null;
  return match[1].trim().replace(/\b\w/g, (letra) => letra.toUpperCase());
}

// Extrai texto simples e dados de mídia de uma mensagem do formato Evolution (messages.upsert).
function interpretarMensagem(data) {
  const msg = data.message || {};

  if (msg.imageMessage) {
    return { tipoMidia: 'image', mimeType: msg.imageMessage.mimetype, legenda: (msg.imageMessage.caption || '').toLowerCase() };
  }
  if (msg.documentMessage) {
    return { tipoMidia: 'document', mimeType: msg.documentMessage.mimetype, legenda: (msg.documentMessage.caption || '').toLowerCase() };
  }

  const texto = msg.conversation || (msg.extendedTextMessage && msg.extendedTextMessage.text) || '';
  return { tipoMidia: null, texto: texto.trim() };
}

// Regex em vez de string fixa: se "Webhook by Events" estiver ligado na Evolution, ela manda
// pra "/webhook/<nome-do-evento>" (ex.: "/webhook/messages-upsert") em vez de só "/webhook" —
// isso aceita os dois casos, então não depende de lembrar de manter aquele toggle desligado.
app.post(/^\/webhook(\/.*)?$/, async (req, res) => {
  const body = req.body || {};

  // Log cru de tudo que chega, mesmo eventos que vamos ignorar — sem isso, um payload em
  // formato inesperado (ex.: nome do evento diferente do previsto) não deixa nenhum rastro nos logs.
  console.log(`Webhook recebido | event=${body.event} | chaves do body=${Object.keys(body).join(',')}`);

  // Só nos interessa evento de mensagem recebida; ignora connection.update, qrcode.updated etc.
  // Normaliza porque versões/telas diferentes da Evolution API usam grafias diferentes pro mesmo evento
  // (ex.: "messages.upsert" vs "MESSAGES_UPSERT").
  const eventoNormalizado = (body.event || '').toString().toUpperCase().replace(/[.\s]/g, '_');
  if (eventoNormalizado !== 'MESSAGES_UPSERT') {
    return res.sendStatus(200);
  }

  const data = body.data || {};
  const remoteJid = data.key && data.key.remoteJid;

  // Ignora eco de mensagens que o próprio agente mandou, e grupos/broadcast (só atende conversa 1:1).
  if (!remoteJid || (data.key && data.key.fromMe) || !remoteJid.endsWith('@s.whatsapp.net')) {
    console.log(`Webhook ignorado (sem remoteJid, é eco, ou não é conversa 1:1) | data.key=${JSON.stringify(data.key)}`);
    return res.sendStatus(200);
  }

  const remetente = jidParaFormatoPlanilha(remoteJid);
  const interpretado = interpretarMensagem(data);

  console.log(`Mensagem recebida de ${remetente} | mídia: ${interpretado.tipoMidia || 'nenhuma'} | texto: ${interpretado.texto || interpretado.legenda || ''}`);

  try {
    const cliente = await buscarClientePorNumero(remetente);

    if (!cliente) {
      await enviarMensagemWhatsApp(remetente, 'Esse número ainda não está cadastrado no Interali Pocket. Fale com a Interali para ativar seu acesso.');
      return res.sendStatus(200);
    }

    const sheetId = cliente.sheetId;

    if (interpretado.tipoMidia && interpretado.legenda.includes('extrato')) {
      const { buffer, mimeType } = await buscarMidiaBase64(data.key.id);
      const transacoes = await extrairExtratoDeBuffer(buffer, mimeType);

      console.log(`Extrato processado: ${transacoes.length} transação(ões)`);

      await salvarExtrato(sheetId, transacoes);
      await enviarMensagemWhatsApp(remetente, `✅ Extrato recebido! Registrei ${transacoes.length} transação(ões).\n\nPergunte "resumo do mês" para ver o fechamento com conciliação.`);
    } else if (interpretado.tipoMidia && (interpretado.legenda.includes('boleto') || interpretado.legenda.includes('fatura') || interpretado.legenda.includes('pagar') || interpretado.legenda.includes('cart'))) {
      const { buffer, mimeType } = await buscarMidiaBase64(data.key.id);
      const contas = await extrairContasAPagarDeBuffer(buffer, mimeType);
      const cartao = extrairNomeCartao(interpretado.legenda);

      if (cartao) {
        contas.forEach((conta) => { conta.cartao = cartao; });
      }

      console.log(`Contas a pagar processadas: ${contas.length} conta(s)${cartao ? ` | cartão: ${cartao}` : ''}`);

      await salvarContasAPagar(sheetId, contas);
      const sufixoCartao = cartao ? ` no cartão ${cartao}` : '';
      await enviarMensagemWhatsApp(remetente, `✅ Registrei ${contas.length} conta(s) a pagar${sufixoCartao}.\n\nPergunte "previsão" a qualquer momento para ver o fluxo de caixa projetado.`);
    } else if (interpretado.tipoMidia) {
      const { buffer, mimeType } = await buscarMidiaBase64(data.key.id);
      const dadosExtraidos = await extrairComprovanteDeBuffer(buffer, mimeType);

      console.log('Dados extraídos:', JSON.stringify(dadosExtraidos, null, 2));

      await salvarComprovante(sheetId, dadosExtraidos);
      await enviarMensagemWhatsApp(remetente, formatarResumoComprovante(dadosExtraidos));
    } else {
      const corpoLower = (interpretado.texto || '').toLowerCase();

      if (corpoLower.includes('resumo') || corpoLower.includes('fechamento')) {
        const periodo = corpoLower.includes('semana') ? 'semana' : corpoLower.includes('hoje') || corpoLower.includes('dia') ? 'dia' : 'mes';
        const [lancamentos, extrato] = await Promise.all([buscarTodosLancamentos(sheetId), buscarExtrato(sheetId)]);
        const resumo = gerarResumo(lancamentos, extrato, { periodo });
        await enviarMensagemWhatsApp(remetente, formatarResumo(resumo));
      } else if (corpoLower.includes('previsao') || corpoLower.includes('previsão') || corpoLower.includes('projecao') || corpoLower.includes('projeção')) {
        const dias = corpoLower.includes('semana') ? 7 : 30;
        const projecao = await gerarProjecao(sheetId, dias);
        await enviarMensagemWhatsApp(remetente, formatarProjecao(projecao));
      } else if (corpoLower.length > 0) {
        const [lancamentos, extrato, contasAPagar] = await Promise.all([
          buscarTodosLancamentos(sheetId),
          buscarExtrato(sheetId),
          buscarContasAPagar(sheetId),
        ]);
        const resposta = await consultarFluxoDeCaixa(interpretado.texto, { lancamentos, extrato, contasAPagar });
        await enviarMensagemWhatsApp(remetente, resposta);
      } else {
        await enviarMensagemWhatsApp(
          remetente,
          `Olá, ${cliente.nome || ''}! Sou o assistente financeiro da Interali Pocket 🤖\n\n` +
          '📸 Mande a foto de um comprovante, nota fiscal ou recibo para eu registrar.\n' +
          '🏦 Mande o extrato do banco (foto ou PDF) escrevendo "extrato" na legenda, para eu conciliar.\n' +
          '🧾 Mande um boleto ou fatura de cartão AINDA NÃO PAGO escrevendo "boleto" ou "fatura" na legenda.\n' +
          '💬 Pergunte "resumo do mês", "resumo da semana" ou "previsão" para ver seus relatórios.'
        );
      }
    }
  } catch (error) {
    console.error('Erro ao processar mensagem:', error.message);
    await enviarMensagemWhatsApp(remetente, 'Ops, não consegui processar isso agora. Pode tentar de novo?').catch(() => {});
  }

  res.sendStatus(200);
});

// Endpoints para disparo de relatório proativo (chamados por um agendador externo,
// já que instâncias gratuitas de hospedagem "dormem" e não sustentam um cron interno confiável).
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
  console.log(`Instância Evolution configurada: ${EVOLUTION_INSTANCE}`);
});
