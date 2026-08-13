require('dotenv').config();
const path = require('path');
const express = require('express');
const {
  extrairComprovanteDeBuffer,
  extrairExtratoDeBuffer,
  extrairContasAPagarDeBuffer,
  consultarFluxoDeCaixa,
  testarAnthropic,
} = require('./index');
const {
  salvarComprovante,
  buscarTodosLancamentos,
  atualizarStatusConciliacaoEmLote,
  salvarExtrato,
  buscarExtrato,
  salvarContasAPagar,
  buscarContasAPagar,
} = require('./sheets');
const {
  gerarResumo,
  formatarResumo,
  formatarUpsellEspecialista,
  obterSaldoAtual,
  filtrarContasEmAberto,
  projetarFluxoDeCaixa,
  formatarProjecao,
  sincronizarConciliacao,
  encontrarTransacoesOrfas,
  gerarDRE,
  formatarDRE,
  formatarDataBR,
} = require('./reconciliacao');
const {
  buscarClientePorNumero,
  listarClientesAtivos,
  adicionarCliente,
  criarPlanilhaCliente,
  ativarPlanoEspecialista,
} = require('./clientes');
const {
  jidParaFormatoPlanilha,
  enviarMensagemWhatsApp,
  buscarMidiaBase64,
  testarConexaoWhatsApp,
  extrairMensagemDoWebhook,
  interpretarMensagem,
  verificarWebhook,
} = require('./whatsapp');
const {
  validarVoucher,
  queimarVoucher,
  criarVoucher,
  registrarAssinatura,
  buscarAssinaturaPorSubscription,
  ativarAssinatura,
  buscarAssinaturaAtivaPorWhatsapp,
  marcarEspecialistaNaAssinatura,
} = require('./vendas');
const { buscarOuCriarCliente, criarAssinatura, buscarLinkPagamento, atualizarValorAssinatura } = require('./asaas');

const app = express();

// Log de TODA requisição que chega, antes de qualquer outra coisa — inclusive as que não vão
// bater em nenhuma rota. Sem isso, um caminho ou método inesperado não deixa rastro nenhum nos logs.
app.use((req, _res, next) => {
  console.log(`Requisição recebida: ${req.method} ${req.originalUrl}`);
  next();
});

// Assets estáticos da landing page (logo etc.) — ex.: public/logo.jpg fica em /logo.jpg.
app.use(express.static(path.join(__dirname, 'public')));

// type: '*/*' porque nem toda implementação de webhook manda o header Content-Type
// exatamente como "application/json" — sem isso, o body chegaria vazio silenciosamente.
// limit maior que o padrão (100kb): herdado da época da Evolution API (mandava thumbnail/base64
// no próprio payload); a Cloud API oficial só manda o id da mídia, mas não custa manter a folga.
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
    '💬 Pergunte "resumo do mês", "resumo da semana", "previsão" ou "DRE do mês" para ver seus relatórios — ou qualquer pergunta tipo "quanto eu gastei esse mês?".\n\n' +
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
  starter: { id: 'starter', nome: 'Pocket Starter', valor: 149.0, limite: 300 },
  pro: { id: 'pro', nome: 'Pocket Pro', valor: 249.0, limite: 600 },
  business: { id: 'business', nome: 'Pocket Business', valor: 399.0, limite: 1000 },
  teste: { id: 'teste', nome: 'Pocket Teste (Voucher)', valor: 49.9, limite: 300 },
};

const ESPECIALISTA_ADICIONAL = 200.0; // Análise Mensal com Especialista — soma ao valor de qualquer plano

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

// Trava de duplicidade em 3 níveis, olhando data + horário + valor + tipo (pedido do Aroldo,
// 08/08/2026: "sempre remova duplicidade... vai ler data, horário, valores... e se tiver dúvida,
// pergunte ao cliente"). Data+valor+tipo batendo já é um sinal forte de repetição — não exige que
// o estabelecimento bata também porque a leitura da IA pode variar levemente entre duas fotos do
// mesmo documento. O horário é o que decide entre os três níveis:
//   - "duplicado": achou candidato com o MESMO horário (quando os dois lados têm horário) → alta
//     confiança, não salva.
//   - "ambiguo": achou candidato com data+valor+tipo iguais, mas falta horário de um dos lados (ou
//     dos dois) pra confirmar ou descartar → não decide sozinho, pergunta pro cliente.
//   - "novo": ou não achou nenhum candidato, ou os candidatos batem em tudo menos no horário (os
//     dois lados TÊM horário e são diferentes) → confiança de que é um lançamento diferente mesmo.
function verificarDuplicidade(lancamentosExistentes, novo) {
  const candidatos = lancamentosExistentes.filter((lancamento) => (
    lancamento.data === novo.data &&
    Math.abs((lancamento.valor || 0) - (novo.valor || 0)) < 0.01 &&
    lancamento.tipo_movimentacao === novo.tipo_movimentacao
  ));

  if (candidatos.length === 0) return { status: 'novo' };

  const horarioNovo = (novo.hora || '').trim();

  for (const candidato of candidatos) {
    const horarioExistente = (candidato.hora || '').trim();

    if (horarioNovo && horarioExistente) {
      if (horarioNovo === horarioExistente) return { status: 'duplicado', candidato };
      continue; // horário dos dois lados presente e diferente — não é ESSE candidato, tenta o próximo
    }

    return { status: 'ambiguo', candidato }; // falta horário de pelo menos um lado — não dá pra decidir sozinho
  }

  return { status: 'novo' }; // todos os candidatos tinham horário e nenhum bateu
}

// Reconhece a resposta do cliente à pergunta de duplicidade ambígua ("é o mesmo comprovante ou é
// diferente?"). Heurística por palavra-chave, igual ao resto do bot — não exige resposta exata.
function interpretarRespostaDuplicidade(texto) {
  const t = (texto || '').toLowerCase();
  if (/duplicad|mesmo|j[áa]\s*registr|repetid|^sim\b/.test(t)) return 'duplicado';
  if (/diferente|n[ãa]o\s*[ée]|\bnovo\b|outro|distint/.test(t)) return 'diferente';
  return null;
}

// Comprovante em dúvida (duplicidade ambígua) aguardando o cliente confirmar — Map remetente →
// { dados, sheetId, criadoEm }. Em memória, reseta a cada deploy — aceitável no volume atual,
// igual ao cooldown de notificação de lead logo abaixo.
const PENDENCIAS_DUPLICIDADE = new Map();
const TIMEOUT_PENDENCIA_DUPLICIDADE_MS = 15 * 60 * 1000;

// Mesma data + mesmo valor + mesma descrição pra transação de extrato — o extrato inteiro é
// reenviado às vezes (ex.: duas pessoas mandam o mesmo PDF), então filtra item a item em vez de
// rejeitar o lote inteiro.
function filtrarTransacoesNovas(transacoesExtraidas, extratoExistente) {
  return transacoesExtraidas.filter((nova) => !extratoExistente.some((existente) => (
    existente.data === nova.data &&
    Math.abs((existente.valor || 0) - (nova.valor || 0)) < 0.01 &&
    existente.tipo === nova.tipo &&
    (existente.descricao || '') === (nova.descricao || '')
  )));
}

// Avisa uma vez ao cruzar ~90% do limite mensal do plano, e uma vez ao atingir/passar 100% —
// não repete o aviso a cada lançamento novo depois de já ter avisado naquele mês.
async function avisarSeLimiteProximo(remetente, cliente, totalLancamentosNoMes) {
  const limite = cliente.limiteLancamentos;
  if (!limite) return;

  const limiteAviso = Math.floor(limite * 0.9);

  if (totalLancamentosNoMes === limite) {
    await enviarMensagemWhatsApp(
      remetente,
      `⚠️ Você atingiu o limite de ${limite} lançamentos do seu plano este mês.\n\nLançamentos extras ainda são registrados normalmente, mas talvez valha a pena considerar um upgrade de plano — é só chamar o suporte.`
    ).catch(() => {});
  } else if (totalLancamentosNoMes === limiteAviso) {
    await enviarMensagemWhatsApp(
      remetente,
      `📊 Aviso: você já usou ${totalLancamentosNoMes} de ${limite} lançamentos do seu plano este mês.`
    ).catch(() => {});
  }
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

// Recalcula o Status_Conciliacao de todos os lançamentos (histórico inteiro) contra o extrato
// atual e reescreve só as linhas cujo status mudou. Chamada depois de salvar um comprovante novo
// ou um extrato novo — os dois lados que afetam o resultado da conciliação. Falha aqui não deve
// derrubar o fluxo principal (a mensagem pro cliente já foi decidida antes), então quem chama
// sempre engole erro com .catch().
async function sincronizarConciliacaoNaPlanilha(sheetId, lancamentosExistentes, extratoAtual) {
  const [lancamentos, extrato] = await Promise.all([
    lancamentosExistentes || buscarTodosLancamentos(sheetId),
    extratoAtual || buscarExtrato(sheetId),
  ]);

  const statusPorLinha = sincronizarConciliacao(lancamentos, extrato);
  const atualizacoes = lancamentos
    .map((lancamento) => ({ linha: lancamento.linha, status: statusPorLinha.get(lancamento.linha) || 'Pendente', statusAnterior: lancamento.status_conciliacao }))
    .filter(({ status, statusAnterior }) => status !== statusAnterior)
    .map(({ linha, status }) => ({ linha, status }));

  await atualizarStatusConciliacaoEmLote(sheetId, atualizacoes);
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

// Mesma ideia do cartão, mas pra conta bancária (ex.: "conta Itaú PJ") — só entra em ação se o
// cliente escrever isso na legenda; caso contrário fica com o que o Claude já identificou no
// próprio comprovante (campo banco_conta), ou vazio se nenhum dos dois achou nada.
function extrairNomeConta(legendaLower) {
  const match = legendaLower.match(/conta\s+([a-zà-ÿ0-9]+(?:\s+[a-zà-ÿ0-9]+){0,2})/i);
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

// Detecta se o cliente está respondendo ao upsell do Especialista (mensagem termina sempre
// com "Responda esta mensagem para ativar!"). Heurística por palavra-chave — "especialista"
// só aparece nesse contexto específico enviado pelo próprio bot, então é um sinal confiável
// sem precisar de reply/quote explícito.
function interpretarPedidoEspecialista(texto) {
  const t = (texto || '').toLowerCase();
  if (!t.includes('especialista')) return false;
  return /ativ|quero|sim|bora|pode|manda|isso/.test(t);
}

// Verificação do webhook exigida pela Meta ao configurar a URL no Business Manager — GET com
// "hub.mode=subscribe" e "hub.verify_token" batendo com WHATSAPP_WEBHOOK_VERIFY_TOKEN. Sem isso a
// Meta recusa salvar a URL do webhook. Mesma regex de caminho do POST, por consistência.
app.get(/^\/webhook(\/.*)?$/, (req, res) => {
  const desafio = verificarWebhook(req.query);

  if (desafio === null) {
    console.log('Verificação de webhook recusada — hub.verify_token não bateu com WHATSAPP_WEBHOOK_VERIFY_TOKEN.');
    return res.sendStatus(403);
  }

  return res.status(200).send(desafio);
});

app.post(/^\/webhook(\/.*)?$/, async (req, res) => {
  const body = req.body || {};

  // Log cru de tudo que chega — sem isso, um payload em formato inesperado não deixa rastro nos logs.
  console.log(`Webhook recebido | object=${body.object} | chaves do body=${Object.keys(body).join(',')}`);

  const msg = extrairMensagemDoWebhook(body);

  // Sem "messages" no payload (ex.: evento "statuses" — confirmação de entrega/leitura de uma
  // mensagem que o próprio bot mandou) — nada a processar, só confirma recebimento pra Meta.
  if (!msg) {
    return res.sendStatus(200);
  }

  const remetente = jidParaFormatoPlanilha(msg.from);
  const interpretado = interpretarMensagem(msg);

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

    // Cliente tinha um comprovante em dúvida (duplicidade ambígua) esperando resposta — checa
    // ANTES de qualquer outro processamento, senão a resposta ("diferente", "duplicado") cairia
    // no fluxo genérico de pergunta livre pro Claude em vez de resolver a pendência.
    if (!interpretado.tipoMidia && PENDENCIAS_DUPLICIDADE.has(remetente)) {
      const pendencia = PENDENCIAS_DUPLICIDADE.get(remetente);
      const expirou = Date.now() - pendencia.criadoEm > TIMEOUT_PENDENCIA_DUPLICIDADE_MS;

      if (!expirou) {
        const resposta = interpretarRespostaDuplicidade(interpretado.texto);

        if (resposta === 'duplicado') {
          PENDENCIAS_DUPLICIDADE.delete(remetente);
          await enviarMensagemWhatsApp(remetente, '👍 Combinado, não registrei de novo.');
          return res.sendStatus(200);
        }

        if (resposta === 'diferente') {
          PENDENCIAS_DUPLICIDADE.delete(remetente);
          await salvarComprovante(pendencia.sheetId, pendencia.dados);
          await enviarMensagemWhatsApp(remetente, `✅ Entendido, registrei como lançamento novo!\n\n${formatarResumoComprovante(pendencia.dados)}`);
          await sincronizarConciliacaoNaPlanilha(pendencia.sheetId).catch((erro) => console.error('Falha ao sincronizar conciliação:', erro.message));
          return res.sendStatus(200);
        }

        await enviarMensagemWhatsApp(remetente, 'Não entendi — responde só "duplicado" ou "diferente" pra eu saber o que fazer com aquele comprovante. 🙂');
        return res.sendStatus(200);
      }

      PENDENCIAS_DUPLICIDADE.delete(remetente); // expirou — segue o fluxo normal abaixo, trata como mensagem nova
    }

    const sheetId = cliente.sheetId;

    if (interpretado.tipoMidia && interpretado.legenda.includes('extrato')) {
      const { buffer, mimeType } = await buscarMidiaBase64(interpretado.mediaId);
      const transacoes = await extrairExtratoDeBuffer(buffer, mimeType);
      const extratoExistente = await buscarExtrato(sheetId);
      const transacoesNovas = filtrarTransacoesNovas(transacoes, extratoExistente);
      const duplicadas = transacoes.length - transacoesNovas.length;

      console.log(`Extrato processado: ${transacoes.length} transação(ões), ${duplicadas} já existente(s)`);

      const lancamentosExistentes = await buscarTodosLancamentos(sheetId);
      const orfas = encontrarTransacoesOrfas(transacoesNovas, lancamentosExistentes);

      await salvarExtrato(sheetId, transacoesNovas);
      // Recalcula o Status_Conciliacao de tudo agora que o extrato mudou — silencioso, não afeta a resposta.
      await sincronizarConciliacaoNaPlanilha(sheetId, lancamentosExistentes, [...extratoExistente, ...transacoesNovas]).catch((erro) => console.error('Falha ao sincronizar conciliação:', erro.message));

      const avisoDuplicadas = duplicadas > 0 ? ` (${duplicadas} já estavam registradas, ignorei pra não duplicar)` : '';
      const avisoOrfas = orfas.length > 0
        ? '\n\n🔎 ' + orfas.map((t) => `Identifiquei um recebimento de ${formatarNumero(t.valor)} em ${formatarDataBR(t.data)} no extrato sem comprovante vinculado. O que foi isso? Me conta que eu registro certinho.`).join('\n🔎 ')
        : '';
      await enviarMensagemWhatsApp(remetente, `✅ Extrato recebido! Registrei ${transacoesNovas.length} transação(ões)${avisoDuplicadas}.\n\nPergunte "resumo do mês" para ver o fechamento com conciliação.${avisoOrfas}`);
    } else if (interpretado.tipoMidia && (interpretado.legenda.includes('boleto') || interpretado.legenda.includes('fatura') || interpretado.legenda.includes('pagar') || interpretado.legenda.includes('cart'))) {
      const { buffer, mimeType } = await buscarMidiaBase64(interpretado.mediaId);
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
      const { buffer, mimeType } = await buscarMidiaBase64(interpretado.mediaId);
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
        // Legenda ("conta Itaú PJ") tem prioridade sobre o que o Claude leu na própria imagem —
        // só o cliente sabe com certeza qual das contas dele é, quando ele se dá o trabalho de dizer.
        dadosExtraidos.conta_bancaria = extrairNomeConta(interpretado.legenda) || dadosExtraidos.banco_conta || '';

        console.log('Dados extraídos:', JSON.stringify(dadosExtraidos, null, 2));

        const lancamentosExistentes = await buscarTodosLancamentos(sheetId);
        const resultadoDuplicidade = verificarDuplicidade(lancamentosExistentes, dadosExtraidos);

        if (resultadoDuplicidade.status === 'duplicado') {
          const c = resultadoDuplicidade.candidato;
          await enviarMensagemWhatsApp(
            remetente,
            `⚠️ Esse comprovante já está registrado (${formatarNumero(c.valor)} em ${c.data} às ${c.hora}) — não salvei de novo pra não contar duas vezes.\n\nSe não for duplicado, me avisa que eu registro mesmo assim.`
          );
        } else if (resultadoDuplicidade.status === 'ambiguo') {
          const c = resultadoDuplicidade.candidato;
          PENDENCIAS_DUPLICIDADE.set(remetente, { dados: dadosExtraidos, sheetId, criadoEm: Date.now() });
          await enviarMensagemWhatsApp(
            remetente,
            `🤔 Já tenho um lançamento parecido: ${formatarNumero(c.valor)} em ${c.data}${c.hora ? ` às ${c.hora}` : ''} (${c.estabelecimento_ou_pessoa || c.descricao || 'sem descrição'}).\n\n` +
            `Esse comprovante novo: ${formatarNumero(dadosExtraidos.valor)} em ${dadosExtraidos.data}${dadosExtraidos.hora ? ` às ${dadosExtraidos.hora}` : ''} (${dadosExtraidos.estabelecimento_ou_pessoa || 'sem descrição'}).\n\n` +
            `É o mesmo comprovante (duplicado) ou é um lançamento diferente? Responde "duplicado" ou "diferente".`
          );
        } else {
          await salvarComprovante(sheetId, dadosExtraidos);
          await enviarMensagemWhatsApp(remetente, formatarResumoComprovante(dadosExtraidos));

          const prefixoMesAtual = new Date().toISOString().slice(0, 7); // "AAAA-MM"
          const lancamentosDoMes = lancamentosExistentes.filter((l) => (l.data || '').startsWith(prefixoMesAtual));
          await avisarSeLimiteProximo(remetente, cliente, lancamentosDoMes.length + 1);

          // Se esse comprovante bater com uma transação do extrato que já estava na planilha,
          // marca conciliado agora — não precisa esperar o cliente mandar extrato de novo.
          await sincronizarConciliacaoNaPlanilha(sheetId).catch((erro) => console.error('Falha ao sincronizar conciliação:', erro.message));
        }
      }
    } else {
      const corpoLower = (interpretado.texto || '').toLowerCase();

      if (corpoLower.includes('resumo') || corpoLower.includes('fechamento')) {
        const periodo = corpoLower.includes('semana') ? 'semana' : corpoLower.includes('hoje') || corpoLower.includes('dia') ? 'dia' : 'mes';
        const [lancamentos, extrato] = await Promise.all([buscarTodosLancamentos(sheetId), buscarExtrato(sheetId)]);
        const resumo = gerarResumo(lancamentos, extrato, { periodo });
        const upsell = periodo === 'mes' && !cliente.planoEspecialista ? formatarUpsellEspecialista(resumo) : '';
        await enviarMensagemWhatsApp(remetente, formatarResumo(resumo) + upsell);
      } else if (/\bdre\b/.test(corpoLower) || corpoLower.includes('demonstra') || corpoLower.includes('resultado do exerc')) {
        const periodo = corpoLower.includes('semana') ? 'semana' : corpoLower.includes('hoje') || corpoLower.includes('dia') ? 'dia' : 'mes';
        const lancamentos = await buscarTodosLancamentos(sheetId);
        const dre = gerarDRE(lancamentos, { periodo });
        await enviarMensagemWhatsApp(remetente, formatarDRE(dre, cliente.nome));
      } else if (!cliente.planoEspecialista && interpretarPedidoEspecialista(interpretado.texto)) {
        const assinatura = await buscarAssinaturaAtivaPorWhatsapp(remetente);

        if (assinatura && assinatura.asaasSubscriptionId) {
          const novoValor = assinatura.valor + ESPECIALISTA_ADICIONAL;
          const novoNome = assinatura.plano.includes('Especialista') ? assinatura.plano : `${assinatura.plano} + Especialista`;

          await atualizarValorAssinatura(assinatura.asaasSubscriptionId, novoValor, `Interali Pocket - ${novoNome}`);
          await marcarEspecialistaNaAssinatura(assinatura.numeroLinha, novoNome, novoValor);
          await ativarPlanoEspecialista(remetente);

          await enviarMensagemWhatsApp(
            remetente,
            `🎉 Prontinho, ${cliente.nome || ''}! Sua Análise Mensal com Especialista foi ativada.\n\n` +
            `A partir da próxima cobrança, seu plano passa a ser ${novoNome} por R$ ${novoValor.toFixed(2)}/mês.\n\n` +
            '🧑‍💼 Alguém da equipe vai entrar em contato por aqui pra agendar a primeira Reunião Online de 50min.'
          );

          if (ADMIN_WHATSAPP_NUMBER) {
            await enviarMensagemWhatsApp(
              ADMIN_WHATSAPP_NUMBER,
              `🧑‍💼 Upgrade Especialista ativado sozinho via WhatsApp!\n\n👤 ${cliente.nome}\n📱 ${remetente}\n📋 ${novoNome} (R$ ${novoValor.toFixed(2)})\n\nAgendar a reunião de diagnóstico com esse cliente!`
            ).catch((erro) => console.error('Falha ao notificar admin sobre upgrade especialista:', erro.message));
          }
        } else {
          // Sem assinatura Asaas rastreada (ex.: cliente cadastrado manualmente, fora do
          // checkout online) — não dá pra ajustar cobrança sozinho, precisa do Aroldo.
          await enviarMensagemWhatsApp(
            remetente,
            `Show, ${cliente.nome || ''}! Registrei seu interesse na Análise Mensal com Especialista — a equipe vai entrar em contato por aqui pra confirmar o pagamento e agendar.`
          );
          if (ADMIN_WHATSAPP_NUMBER) {
            await enviarMensagemWhatsApp(
              ADMIN_WHATSAPP_NUMBER,
              `🧑‍💼 Cliente pediu upgrade do Especialista pelo WhatsApp, mas não achei assinatura Asaas rastreada pra esse número (provável cadastro manual) — precisa combinar a cobrança manual.\n\n👤 ${cliente.nome}\n📱 ${remetente}`
            ).catch((erro) => console.error('Falha ao notificar admin sobre pedido de especialista sem assinatura:', erro.message));
          }
        }
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
      const upsell = periodo === 'mes' && !cliente.planoEspecialista ? formatarUpsellEspecialista(resumo) : '';
      await enviarMensagemWhatsApp(cliente.numeroWhatsapp, formatarResumo(resumo) + upsell);
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
  const { nome, whatsapp, whatsappAtivacao, whatsappAtivacao2, documento, planoId, voucher, upgradeEspecialista } = req.body || {};
  const comEspecialista = upgradeEspecialista === true;

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
  const numeroAtivacao = (whatsappAtivacao || '').trim() ? normalizarWhatsapp(whatsappAtivacao) : numeroFormatado;
  const numeroAtivacao2 = (whatsappAtivacao2 || '').trim() ? normalizarWhatsapp(whatsappAtivacao2) : '';
  let planoFinal = planoOficial;
  let voucherAplicado = null;

  const codigoVoucher = (voucher || '').trim();
  if (codigoVoucher) {
    // Voucher só se aplica junto com o plano Starter — nos outros planos, o valor do voucher
    // não faz sentido (ex.: alguém pagando Business não deveria cair pro tier de teste).
    if (planoId !== 'starter') {
      return res.status(400).json({ ok: false, erro: 'O voucher só pode ser usado ao assinar o plano Pocket Starter (R$ 149,00).' });
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

  const valorFinal = planoFinal.valor + (comEspecialista ? ESPECIALISTA_ADICIONAL : 0);
  const nomePlanoCompleto = planoFinal.nome + (comEspecialista ? ' + Especialista' : '');

  let linkPagamento;
  let subscriptionId;

  try {
    const customerId = await buscarOuCriarCliente({ nome, cpfCnpj: documentoLimpo, telefone: numeroFormatado });
    const assinatura = await criarAssinatura({
      customerId,
      valor: valorFinal,
      descricao: `Interali Pocket - ${nomePlanoCompleto}`,
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
      whatsappAtivacao: numeroAtivacao,
      whatsappAtivacao2: numeroAtivacao2,
      documento: documentoLimpo,
      plano: nomePlanoCompleto,
      valor: valorFinal,
      voucher: voucherAplicado,
      asaasSubscriptionId: subscriptionId,
      planoEspecialista: comEspecialista,
      limiteLancamentos: planoFinal.limite,
    });
  } catch (error) {
    // A cobrança no Asaas já foi criada e o link já existe — não bloqueia o cliente por causa
    // de uma falha só no registro interno, só loga pra investigar depois.
    console.error('Erro ao registrar assinatura na planilha (cobrança no Asaas já foi criada):', error.message);
  }

  if (ADMIN_WHATSAPP_NUMBER) {
    const linhaVoucher = voucherAplicado ? `\n🎟️ Voucher: ${voucherAplicado}` : '';
    const linhaEspecialista = comEspecialista ? '\n🧑‍💼 Com Análise Mensal com Especialista' : '';
    const linhaAtivacao = numeroAtivacao !== numeroFormatado ? `\n📲 Ativação: ${numeroAtivacao}` : '';
    const linhaAtivacao2 = numeroAtivacao2 ? `\n📲 2º número de ativação: ${numeroAtivacao2}` : '';
    await enviarMensagemWhatsApp(
      ADMIN_WHATSAPP_NUMBER,
      `🛒 Novo checkout iniciado no site do Interali Pocket (aguardando pagamento)\n\n👤 ${nome}\n📱 ${numeroFormatado}\n📋 Plano: ${nomePlanoCompleto} (R$ ${valorFinal.toFixed(2)})${linhaVoucher}${linhaEspecialista}${linhaAtivacao}${linhaAtivacao2}\n\nVocê será avisado de novo automaticamente assim que o pagamento cair.`
    ).catch((erro) => console.error('Falha ao notificar admin sobre assinatura:', erro.message));
  }

  res.json({ ok: true, plano: { ...planoFinal, nome: nomePlanoCompleto, valor: valorFinal }, redirectUrl: linkPagamento });
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

    const numeroAtivacao = assinatura.whatsappAtivacao || assinatura.whatsapp;
    const sheetIdNovo = await criarPlanilhaCliente(assinatura.nome);

    await adicionarCliente(numeroAtivacao, assinatura.nome, sheetIdNovo, assinatura.planoEspecialista, assinatura.limiteLancamentos);
    if (assinatura.whatsappAtivacao2) {
      // Segundo número apontando pra MESMA planilha — os dois somam no mesmo limite mensal do plano.
      await adicionarCliente(assinatura.whatsappAtivacao2, assinatura.nome, sheetIdNovo, assinatura.planoEspecialista, assinatura.limiteLancamentos);
    }
    await ativarAssinatura(assinatura.numeroLinha, sheetIdNovo);

    if (assinatura.voucher) {
      await queimarVoucher(assinatura.voucher, `${assinatura.nome} (${numeroAtivacao})`);
    }

    const linhaReuniao = assinatura.planoEspecialista
      ? '\n\n🧑‍💼 Sua Análise Mensal com Especialista também foi ativada — em breve alguém da equipe entra em contato por aqui mesmo pra agendar a primeira Reunião Online de 50min.'
      : '';

    const numerosParaAvisar = [numeroAtivacao, assinatura.whatsappAtivacao2].filter(Boolean);
    for (const numero of numerosParaAvisar) {
      await enviarMensagemWhatsApp(
        numero,
        `🎉 Pagamento confirmado! Seu Interali Pocket (${assinatura.plano}) já está ativo.${linhaReuniao}\n\n` + montarMensagemBoasVindas(assinatura.nome)
      ).catch((erro) => console.error('Falha ao mandar boas-vindas pro cliente novo:', erro.message));
    }

    if (ADMIN_WHATSAPP_NUMBER) {
      const avisoEspecialista = assinatura.planoEspecialista ? '\n🧑‍💼 Com Especialista — agendar a reunião de diagnóstico com esse cliente!' : '';
      const linhaSegundoNumero = assinatura.whatsappAtivacao2 ? `\n📲 2º número ativado: ${assinatura.whatsappAtivacao2}` : '';
      await enviarMensagemWhatsApp(
        ADMIN_WHATSAPP_NUMBER,
        `✅ Pagamento confirmado e cliente ativado automaticamente!\n\n👤 ${assinatura.nome}\n📱 ${numeroAtivacao}${linhaSegundoNumero}\n📋 ${assinatura.plano}${avisoEspecialista}\n📄 Planilha: https://docs.google.com/spreadsheets/d/${sheetIdNovo}/edit`
      ).catch((erro) => console.error('Falha ao notificar admin sobre ativação automática:', erro.message));
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Erro ao processar webhook do Asaas:', error.message);
    res.sendStatus(200); // 200 mesmo em erro interno, pra evitar reenvio infinito do Asaas
  }
});

app.get('/health', async (_req, res) => {
  const envChecks = {
    whatsapp: {
      phoneNumberId: !!process.env.WHATSAPP_PHONE_NUMBER_ID,
      accessToken: !!process.env.WHATSAPP_ACCESS_TOKEN,
      webhookVerifyToken: !!process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    },
    anthropic: {
      key: !!process.env.ANTHROPIC_API_KEY,
    },
    google: {
      masterSheetId: !!process.env.GOOGLE_MASTER_SHEET_ID,
      serviceAccountEmail: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      privateKey: !!process.env.GOOGLE_PRIVATE_KEY,
    },
  };

  const services = {
    whatsapp: { configured: envChecks.whatsapp.phoneNumberId && envChecks.whatsapp.accessToken },
    anthropic: { configured: envChecks.anthropic.key },
  };

  if (services.whatsapp.configured) {
    try {
      const info = await testarConexaoWhatsApp();
      services.whatsapp.reachable = true;
      services.whatsapp.numero = info.display_phone_number;
      services.whatsapp.nomeVerificado = info.verified_name;
      services.whatsapp.qualidade = info.quality_rating;
    } catch (error) {
      services.whatsapp.reachable = false;
      services.whatsapp.error = error.message;
    }
  }

  if (services.anthropic.configured) {
    try {
      await testarAnthropic();
      services.anthropic.reachable = true;
    } catch (error) {
      services.anthropic.reachable = false;
      services.anthropic.error = error.message;
    }
  }

  res.json({ ok: true, envChecks, services });
});

app.listen(PORT, () => {
  console.log(`Servidor Interali Pocket rodando na porta ${PORT}`);
  console.log(`Webhook: POST http://localhost:${PORT}/webhook (verificação GET também nesse mesmo caminho)`);
  console.log(`Phone Number ID configurado: ${process.env.WHATSAPP_PHONE_NUMBER_ID}`);
});
