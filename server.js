require('dotenv').config();
const path = require('path');
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
const { buscarClientePorNumero, listarClientesAtivos, adicionarCliente, criarPlanilhaCliente } = require('./clientes');
const {
  jidParaFormatoPlanilha,
  enviarMensagemWhatsApp,
  buscarMidiaBase64,
} = require('./evolution');
const {
  validarVoucher,
  queimarVoucher,
  criarVoucher,
  registrarAssinatura,
  buscarAssinaturaPorSubscription,
  ativarAssinatura,
} = require('./vendas');
const { buscarOuCriarCliente, criarAssinatura, buscarLinkPagamento } = require('./asaas');

const app = express();

// Log de TODA requisição que chega, antes de qualquer outra coisa — inclusive as que não vão
// bater em nenhuma rota. Sem isso, um caminho ou método inesperado (ex.: a Evolution mandando
// pra "/webhook/messages-upsert" em vez de "/webhook") não deixa rastro nenhum nos logs.
app.use((req, _res, next) => {
  console.log(`Requisição recebida: ${req.method} ${req.originalUrl}`);
  next();
});

// Assets estáticos da landing page (logo etc.) — ex.: public/logo.jpg fica em /logo.jpg.
app.use(express.static(path.join(__dirname, 'public')));

// type: '*/*' porque nem toda implementação de webhook manda o header Content-Type
// exatamente como "application/json" — sem isso, o body chegaria vazio silenciosamente.
// limit maior que o padrão (100kb) porque a Evolution API inclui thumbnails/dados em base64
// no próprio payload do webhook de imagem e documento — sem isso, toda mensagem com mídia
// era rejeitada com PayloadTooLargeError antes de chegar no handler (bug real encontrado em produção).
app.use(express.json({ type: '*/*', limit: '50mb' }));

const RELATORIO_SECRET = process.env.RELATORIO_SECRET;
const PORT = process.env.PORT || 3000;
const ADMIN_WHATSAPP_NUMBER = process.env.ADMIN_WHATSAPP_NUMBER; // formato "whatsapp:+55DDXXXXXXXXX" — número do Aroldo, avisado sobre leads e usado como contato de suporte pro cliente

// Mostra o número de suporte pro cliente em formato legível, ex.: "(41) 98788-5732".
function formatarNumeroExibicao(numeroPlanilha) {
  const digitos = (numeroPlanilha || '').replace(/\D/g, '');
  const ddd = digitos.slice(2, 4);
  const resto = digitos.slice(4);
  return `(${ddd}) ${resto.slice(0, 5)}-${resto.slice(5)}`;
}

const SUPORTE_TEXTO = ADMIN_WHATSAPP_NUMBER
  ? `Se der erro ou tiver qualquer dúvida, chama o suporte no WhatsApp: ${formatarNumeroExibicao(ADMIN_WHATSAPP_NUMBER)}`
  : '';

// Mensagem completa de orientação — usada tanto na ativação automática (pagamento confirmado)
// quanto como resposta padrão quando o cliente manda mensagem sem nada específico pra fazer.
function montarMensagemBoasVindas(nome) {
  return (
    `Olá, ${nome || ''}! Sou o assistente financeiro da Interali Pocket 🤖\n\n` +
    '📸 Mande a foto de um comprovante, nota fiscal ou recibo para eu registrar.\n' +
    '🏦 Mande o extrato do banco (foto ou PDF) escrevendo "extrato" na legenda, para eu conciliar.\n' +
    '🧾 Mande boleto ou fatura de cartão de crédito escrevendo "boleto" ou "cartão + nome do banco" na legenda (ex.: "cartão Bradesco").\n' +
    '💬 Pergunte "resumo do mês", "resumo da semana" ou "previsão" para ver seus relatórios — ou qualquer pergunta tipo "quanto eu gastei esse mês?".\n\n' +
    '💡 Dicas rápidas:\n' +
    '• Sempre escreva alguma legenda ao mandar boleto, fatura ou extrato — sem isso eu tento adivinhar o tipo de documento e posso errar.\n' +
    '• Uma foto por mensagem.\n' +
    '• Foto legível, sem cortar número.\n' +
    '• Se tiver mais de um cartão de crédito, sempre diga o nome do banco na legenda.' +
    (SUPORTE_TEXTO ? `\n\n${SUPORTE_TEXTO}` : '')
  );
}

// Espelha os planos exibidos em index.html — fonte da verdade fica no backend pra não confiar
// em valor/nome mandado pelo próprio formulário (alguém poderia adulterar o payload do fetch).
const PLANOS = {
  starter: { id: 'starter', nome: 'Pocket Starter', valor: 99.0, limite: 300 },
  pro: { id: 'pro', nome: 'Pocket Pro', valor: 169.0, limite: 600 },
  business: { id: 'business', nome: 'Pocket Business', valor: 249.0, limite: 1000 },
  teste: { id: 'teste', nome: 'Pocket Teste (Voucher)', valor: 49.9, limite: 300 },
};

// Aceita o número digitado em qualquer formato ((41) 99999-9999, 41999999999 etc.) e
// normaliza pro padrão "whatsapp:+55DDXXXXXXXXX" usado no resto do sistema.
function normalizarWhatsapp(numeroDigitado) {
  let digitos = (numeroDigitado || '').replace(/\D/g, '');
  if (digitos.length <= 11) {
    digitos = `55${digitos}`;
  }
  return `whatsapp:+${digitos}`;
}

// Evita notificar o admin toda vez que o mesmo número não cadastrado manda várias mensagens
// seguidas enquanto espera resposta — reresetada a cada deploy/restart (aceitável no volume atual).
const ULTIMA_NOTIFICACAO_LEAD = new Map();
const COOLDOWN_NOTIFICACAO_LEAD_MS = 15 * 60 * 1000;

async function notificarAdminSobreLead(remetente) {
  if (!ADMIN_WHATSAPP_NUMBER) return;

  const agora = Date.now();
  const ultimaNotificacao = ULTIMA_NOTIFICACAO_LEAD.get(remetente) || 0;
  if (agora - ultimaNotificacao < COOLDOWN_NOTIFICACAO_LEAD_MS) return;
  ULTIMA_NOTIFICACAO_LEAD.set(remetente, agora);

  await enviarMensagemWhatsApp(
    ADMIN_WHATSAPP_NUMBER,
    `🔔 Novo lead no Interali Pocket: ${remetente} tentou mandar mensagem e ainda não está cadastrado.\n\nPra liberar: npm run cadastrar-cliente -- "${remetente}" "Nome" "ID_DA_PLANILHA"`
  ).catch((erro) => console.error('Falha ao notificar admin sobre lead:', erro.message));
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

// Reconhece o comando do admin pra criar voucher direto pelo WhatsApp, sem precisar de
// terminal: "criar cupom BARBER-8912" ou "criar cupom BARBER-8912 indicação Instagram".
// Tudo depois do código vira a descrição (opcional, só pra controle interno do Aroldo).
function interpretarComandoVoucher(texto) {
  const match = (texto || '').trim().match(/^(?:criar|novo)\s+(?:cupom|voucher)\s+(\S+)\s*(.*)$/i);
  if (!match) return null;
  return { codigo: match[1].toUpperCase(), descricao: match[2].trim() };
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

  // Comando de admin (só funciona vindo do número configurado em ADMIN_WHATSAPP_NUMBER) —
  // checado antes de tudo, porque o admin não precisa (nem deve) estar cadastrado como cliente.
  if (ADMIN_WHATSAPP_NUMBER && remetente === ADMIN_WHATSAPP_NUMBER && !interpretado.tipoMidia) {
    const comandoVoucher = interpretarComandoVoucher(interpretado.texto);
    if (comandoVoucher) {
      try {
        await criarVoucher(comandoVoucher.codigo, comandoVoucher.descricao);
        await enviarMensagemWhatsApp(
          remetente,
          `✅ Cupom *${comandoVoucher.codigo}* criado!\n\n` +
          '🎟️ Libera o plano Pocket Starter por R$ 49,90/mês (300 lançamentos).\n' +
          `📋 Passa pro cliente: ele acessa pocket.interali.com.br, escolhe o plano Starter e digita o código *${comandoVoucher.codigo}* no campo "Código do Voucher" ao assinar.\n\n` +
          '⚠️ Uso único — some sozinho assim que alguém pagar com ele.'
        );
      } catch (error) {
        console.error('Erro ao criar voucher via comando WhatsApp:', error.message);
        await enviarMensagemWhatsApp(remetente, `❌ Não consegui criar o cupom "${comandoVoucher.codigo}". Tenta de novo em instantes.`).catch(() => {});
      }
      return res.sendStatus(200);
    }
  }

  let cliente;

  try {
    cliente = await buscarClientePorNumero(remetente);

    if (!cliente) {
      await enviarMensagemWhatsApp(remetente, 'Esse número ainda não está cadastrado no Interali Pocket. Fale com a Interali para ativar seu acesso.');
      await notificarAdminSobreLead(remetente);
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

      if (dadosExtraidos.tipo_documento === 'fatura_cartao_credito') {
        // Chegou sem legenda "fatura"/"boleto"/"cartão" (ex.: cliente só colou a imagem), mas o
        // Claude percebeu que é uma fatura com múltiplos lançamentos — reprocessa como contas a
        // pagar (item a item, com vencimento) em vez de salvar como um único comprovante, senão
        // os lançamentos individuais e as parcelas ficariam perdidos dentro de "itens".
        const contas = await extrairContasAPagarDeBuffer(buffer, mimeType);
        const cartao = extrairNomeCartao(interpretado.legenda);

        if (cartao) {
          contas.forEach((conta) => { conta.cartao = cartao; });
        }

        console.log(`Fatura de cartão detectada sem legenda apropriada — reprocessada como ${contas.length} conta(s) a pagar${cartao ? ` | cartão: ${cartao}` : ''}`);

        await salvarContasAPagar(sheetId, contas);
        const sufixoCartao = cartao ? ` no cartão ${cartao}` : '';
        await enviarMensagemWhatsApp(
          remetente,
          `✅ Essa imagem é uma fatura de cartão com ${contas.length} lançamento(s) — registrei${sufixoCartao} como contas a pagar, não como um gasto único.\n\n` +
          'Da próxima vez, pode escrever "fatura" ou "cartão <nome do banco>" na legenda pra eu já processar assim direto. 😉\n\nPergunte "previsão" para ver o fluxo de caixa projetado.'
        );
      } else {
        console.log('Dados extraídos:', JSON.stringify(dadosExtraidos, null, 2));

        await salvarComprovante(sheetId, dadosExtraidos);
        await enviarMensagemWhatsApp(remetente, formatarResumoComprovante(dadosExtraidos));
      }
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
        await enviarMensagemWhatsApp(remetente, montarMensagemBoasVindas(cliente.nome));
      }
    }
  } catch (error) {
    console.error('Erro ao processar mensagem:', error.message);

    const mensagemErroCliente = SUPORTE_TEXTO
      ? `Ops, não consegui processar isso agora. Pode tentar de novo?\n\nSe continuar dando errado, ${SUPORTE_TEXTO.charAt(0).toLowerCase()}${SUPORTE_TEXTO.slice(1)}`
      : 'Ops, não consegui processar isso agora. Pode tentar de novo?';

    await enviarMensagemWhatsApp(remetente, mensagemErroCliente).catch(() => {});

    if (ADMIN_WHATSAPP_NUMBER) {
      const nomeCliente = cliente ? cliente.nome : '(não identificado)';
      await enviarMensagemWhatsApp(
        ADMIN_WHATSAPP_NUMBER,
        `⚠️ Erro processando mensagem no Interali Pocket\n\n👤 ${nomeCliente}\n📱 ${remetente}\n📎 Tipo: ${interpretado.tipoMidia || 'texto'}\n❌ ${error.message}`
      ).catch((erroNotificacao) => console.error('Falha ao notificar admin sobre erro de processamento:', erroNotificacao.message));
    }
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
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Recebe o formulário de checkout da landing page (index.html), cria a cobrança recorrente
// de verdade no Asaas e devolve o link de pagamento hospedado pra redirecionar o cliente.
// A ativação em si (liberar o número no bot) só acontece depois, no /webhook-asaas, quando
// o Asaas confirma que o pagamento entrou — nunca no momento do formulário.
app.post('/api/assinar', async (req, res) => {
  const { nome, whatsapp, documento, planoId, voucher } = req.body || {};

  if (!nome || !whatsapp || !documento || !planoId) {
    return res.status(400).json({ ok: false, erro: 'Preencha nome, WhatsApp, CPF/CNPJ e escolha um plano.' });
  }

  const documentoLimpo = documento.replace(/\D/g, '');
  if (documentoLimpo.length !== 11 && documentoLimpo.length !== 14) {
    return res.status(400).json({ ok: false, erro: 'CPF ou CNPJ inválido. Confira os números e tente de novo.' });
  }

  const planoOficial = PLANOS[planoId];
  if (!planoOficial) {
    return res.status(400).json({ ok: false, erro: 'Plano inválido.' });
  }

  const numeroFormatado = normalizarWhatsapp(whatsapp);
  let planoFinal = planoOficial;
  let voucherAplicado = null;

  const codigoVoucher = (voucher || '').trim();
  if (codigoVoucher) {
    // Voucher só se aplica junto com o plano Starter — nos outros planos, o valor do voucher
    // não faz sentido (ex.: alguém pagando Business não deveria cair pro tier de teste).
    if (planoId !== 'starter') {
      return res.status(400).json({ ok: false, erro: 'O voucher só pode ser usado ao assinar o plano Pocket Starter (R$ 99,00).' });
    }

    const voucherValido = await validarVoucher(codigoVoucher);
    if (!voucherValido) {
      return res.status(400).json({ ok: false, erro: 'Esse voucher é inválido ou já foi utilizado. Você pode assinar sem o voucher, no valor normal do plano.' });
    }
    // Só confere disponibilidade aqui — o voucher só é de fato "queimado" quando o pagamento
    // é confirmado (/webhook-asaas), pra não desperdiçar o código se o cliente nunca pagar.
    planoFinal = PLANOS.teste;
    voucherAplicado = codigoVoucher.toUpperCase();
  }

  let linkPagamento;
  let subscriptionId;

  try {
    const customerId = await buscarOuCriarCliente({ nome, cpfCnpj: documentoLimpo, telefone: numeroFormatado });
    const assinatura = await criarAssinatura({
      customerId,
      valor: planoFinal.valor,
      descricao: `Interali Pocket - ${planoFinal.nome}`,
      referenciaExterna: `pocket-${Date.now()}`,
    });
    subscriptionId = assinatura.id;
    linkPagamento = await buscarLinkPagamento(subscriptionId);

    if (!linkPagamento) {
      throw new Error('Asaas não retornou o link de pagamento da primeira fatura.');
    }
  } catch (error) {
    console.error('Erro ao criar cobrança no Asaas:', error.message);
    return res.status(500).json({ ok: false, erro: 'Não consegui gerar o link de pagamento agora. Tente novamente em instantes ou fale com a gente no WhatsApp.' });
  }

  try {
    await registrarAssinatura({
      nome,
      whatsapp: numeroFormatado,
      documento: documentoLimpo,
      plano: planoFinal.nome,
      valor: planoFinal.valor,
      voucher: voucherAplicado,
      asaasSubscriptionId: subscriptionId,
    });
  } catch (error) {
    // A cobrança no Asaas já foi criada e o link já existe — não bloqueia o cliente por causa
    // de uma falha só no registro interno, só loga pra investigar depois.
    console.error('Erro ao registrar assinatura na planilha (cobrança no Asaas já foi criada):', error.message);
  }

  if (ADMIN_WHATSAPP_NUMBER) {
    const linhaVoucher = voucherAplicado ? `\n🎟️ Voucher: ${voucherAplicado}` : '';
    await enviarMensagemWhatsApp(
      ADMIN_WHATSAPP_NUMBER,
      `🛒 Novo checkout iniciado no site do Interali Pocket (aguardando pagamento)\n\n👤 ${nome}\n📱 ${numeroFormatado}\n📋 Plano: ${planoFinal.nome} (R$ ${planoFinal.valor.toFixed(2)})${linhaVoucher}\n\nVocê será avisado de novo automaticamente assim que o pagamento cair.`
    ).catch((erro) => console.error('Falha ao notificar admin sobre assinatura:', erro.message));
  }

  res.json({ ok: true, plano: planoFinal, redirectUrl: linkPagamento });
});

// Webhook do Asaas — configurado manualmente no painel dele (Configurações > Integrações >
// Webhooks), apontando pra esta URL com o token abaixo. Confirma pagamento e ativa o cliente
// sozinho: cria a planilha individual dele e libera o número no bot, sem intervenção manual.
app.post('/webhook-asaas', async (req, res) => {
  const tokenRecebido = req.headers['asaas-access-token'];
  if (!process.env.ASAAS_WEBHOOK_TOKEN || tokenRecebido !== process.env.ASAAS_WEBHOOK_TOKEN) {
    console.error('Webhook do Asaas recebido com token inválido ou ausente.');
    return res.sendStatus(401);
  }

  const body = req.body || {};
  const evento = body.event;
  const pagamento = body.payment || {};

  console.log(`Webhook Asaas recebido | event=${evento} | subscription=${pagamento.subscription}`);

  const eventosDePagamentoConfirmado = ['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'];
  if (!eventosDePagamentoConfirmado.includes(evento) || !pagamento.subscription) {
    return res.sendStatus(200);
  }

  try {
    const assinatura = await buscarAssinaturaPorSubscription(pagamento.subscription);

    if (!assinatura) {
      console.error(`Webhook Asaas: nenhuma assinatura encontrada pra subscription ${pagamento.subscription}`);
      return res.sendStatus(200);
    }

    if (assinatura.status === 'Ativo') {
      // Asaas reenvia webhook em caso de dúvida de entrega — evita ativar/avisar duas vezes.
      return res.sendStatus(200);
    }

    const sheetIdNovo = await criarPlanilhaCliente(assinatura.nome);
    await adicionarCliente(assinatura.whatsapp, assinatura.nome, sheetIdNovo);
    await ativarAssinatura(assinatura.numeroLinha, sheetIdNovo);

    if (assinatura.voucher) {
      await queimarVoucher(assinatura.voucher, `${assinatura.nome} (${assinatura.whatsapp})`);
    }

    await enviarMensagemWhatsApp(
      assinatura.whatsapp,
      `🎉 Pagamento confirmado! Seu Interali Pocket (${assinatura.plano}) já está ativo.\n\n` + montarMensagemBoasVindas(assinatura.nome)
    ).catch((erro) => console.error('Falha ao mandar boas-vindas pro cliente novo:', erro.message));

    if (ADMIN_WHATSAPP_NUMBER) {
      await enviarMensagemWhatsApp(
        ADMIN_WHATSAPP_NUMBER,
        `✅ Pagamento confirmado e cliente ativado automaticamente!\n\n👤 ${assinatura.nome}\n📱 ${assinatura.whatsapp}\n📋 ${assinatura.plano}\n📄 Planilha: https://docs.google.com/spreadsheets/d/${sheetIdNovo}/edit`
      ).catch((erro) => console.error('Falha ao notificar admin sobre ativação automática:', erro.message));
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Erro ao processar webhook do Asaas:', error.message);
    res.sendStatus(200); // 200 mesmo em erro interno, pra evitar reenvio infinito do Asaas
  }
});

app.listen(PORT, () => {
  console.log(`Servidor Interali Pocket rodando na porta ${PORT}`);
  console.log(`Webhook: POST http://localhost:${PORT}/webhook`);
  console.log(`Instância Evolution configurada: ${process.env.EVOLUTION_INSTANCE}`);
});
