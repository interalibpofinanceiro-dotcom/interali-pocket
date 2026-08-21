require('dotenv').config();
const path = require('path');
const express = require('express');
const {
  extrairComprovanteDeBuffer,
  extrairComprovanteDeTexto,
  extrairDespesaFixaDeTexto,
  extrairVendasDeBuffer,
  extrairExtratoDeBuffer,
  extrairContasAPagarDeBuffer,
  extrairContasAReceberDeBuffer,
  extrairContaAReceberDeTexto,
  extrairResumoFaturaDeBuffer,
  extrairResumoExtratoDeBuffer,
  consultarFluxoDeCaixa,
  testarAnthropic,
} = require('./index');
const {
  salvarComprovante,
  atualizarLancamento,
  buscarTodosLancamentos,
  atualizarStatusConciliacaoEmLote,
  salvarExtrato,
  buscarExtrato,
  salvarContasAPagar,
  buscarContasAPagar,
  salvarContasAReceber,
  buscarContasAReceber,
  salvarItens,
  buscarTodosItens,
  salvarDespesaFixa,
  buscarDespesasFixas,
  marcarDespesaFixaLancada,
} = require('./sheets');
const {
  gerarResumo,
  formatarResumo,
  formatarUpsellEspecialista,
  obterSaldoAtual,
  filtrarContasEmAberto,
  filtrarContasEmAbertoReceber,
  projetarFluxoDeCaixa,
  formatarProjecao,
  sincronizarConciliacao,
  encontrarTransacoesOrfas,
  reconciliar,
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
  enviarTemplateWhatsApp,
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
    '📸 Comprovante JÁ PAGO (recibo, nota, PIX enviado)? Só mandar a foto, sem precisar de legenda.\n' +
    '🧾 Boleto ou fatura de cartão AINDA NÃO PAGO? Precisa escrever "boleto", "fatura" ou "cartão + nome do banco" na legenda (ex.: "cartão Bradesco") — sem isso eu posso achar que já foi pago e lançar como gasto de hoje em vez de conta a pagar.\n' +
    '🏦 Mande o extrato do banco (foto ou PDF) escrevendo "extrato" na legenda, para eu conciliar.\n' +
    '📤 Tem dinheiro pra RECEBER de alguém (nota fiscal, venda parcelada)? Mande a foto escrevendo "receber" na legenda, ou escreva "receber: " + valor e vencimento (ex.: "receber: 500 do João dia 20") que eu incluo na sua previsão.\n' +
    '🛵 Mande o relatório de vendas do seu sistema/app de delivery (iFood, Rappi, PDV, etc.) escrevendo "vendas" ou "sistema" na legenda, para eu registrar cada venda certinha.\n' +
    '✍️ Não tem comprovante pra tirar foto (ex.: mensalidade, honorário)? Escreva "lançar: " + o que foi (ex.: "lançar: paguei 300 de contador hoje") que eu registro do mesmo jeito.\n' +
    '🔁 Entrada ou saída que se repete todo mês/semana, sem boleto nem extrato (ex.: mensalidade de cliente, aluguel)? Escreva "recorrente: " dizendo se é RECEBIMENTO ou PAGAMENTO + valor + dia (ex.: "recorrente: recebo 500 da Empresa X todo dia 10", ou "recorrente: pago 1000 de marketing todo dia 10") — se não disser "recebo" ou "pago", eu assumo pagamento (saída) por padrão, então melhor deixar claro.\n' +
    '💬 Pergunte "resumo do mês", "resumo da semana", "previsão" ou "DRE do mês" para ver seus relatórios — ou qualquer pergunta tipo "quanto eu gastei esse mês?".\n\n' +
    '💡 Dicas rápidas:\n' +
    '• Comprovante = já pago, só a foto. Boleto/fatura = ainda não pago, sempre com legenda.\n' +
    '• Uma foto por mensagem.\n' +
    '• Foto legível, sem cortar número.\n' +
    '• Se tiver mais de um cartão de crédito, sempre diga o nome do banco na legenda.\n' +
    '• Pode mandar "ajuda" ou "menu" a qualquer momento pra ver essa lista de novo.' +
    (SUPORTE_TEXTO ? `\n\n${SUPORTE_TEXTO}` : '')
  );
}

// Template de boas-vindas submetido pra aprovação da Meta em 13/08/2026 (WhatsApp Manager →
// Modelos de mensagem, ID 1949215835763557, categoria UTILITY). 1 variável: nome do cliente.
// 21/08/2026: auditoria encontrou o texto aprovado com acentos/emoji corrompidos (submetido com
// encoding errado em 13/08 — provavelmente um problema de codepage do Windows na ferramenta usada
// pra submeter). Corrigido via API (edita template aprovado, entra em revisão de novo) com o texto
// reconstruído abaixo — os emoji da linha 1 são um chute (🎉✅, o original tinha 2 emoji também,
// mas o texto cru corrompido não permite saber quais); esta linha do código dizia 🤖💰 mas não há
// garantia de que essa era a versão exata submetida — se a Meta aprovar com 🎉✅ e o Aroldo quiser
// trocar por 🤖💰, dá pra editar de novo depois de aprovado (não dá enquanto está PENDING). Ver
// HISTORICO-COMPLETO.md seção 26.
//   "Olá, {{1}}! Seu Interali Pocket já está ativo 🎉✅\n\n📸 Mande a foto de um comprovante...
//    🏦 Mande o extrato... 💳 Mande boleto ou fatura... 📊 Pergunte "resumo do mês", "resumo da
//    semana" ou "previsão"... Dúvidas? Suporte: (41) 98788-5732"
const TEMPLATE_BOAS_VINDAS = { nome: 'boas_vindas_pocket', idioma: 'pt_BR' };

// Templates de aviso pro ADMIN, submetidos em 13/08/2026 junto com o de boas-vindas — cobrem
// todo aviso que o bot manda pro admin (Aroldo) sem ele ter mandado mensagem recente (fora da
// janela de 24h, precisa de template pra garantir entrega). Dois dedicados (lead e pagamento
// confirmado, os eventos de maior valor) + um genérico (demais avisos administrativos).
// 21/08/2026: trocado de 'admin_novo_lead_pocket' pra '..._v2' — o original tinha 2 problemas
// achados numa auditoria: (1) texto aprovado com acentos/emoji corrompidos ("Interali Pocket ?
// novo lead" em vez de "— novo lead"), e (2) categoria MARKETING em vez de UTILITY (custa mais,
// sujeito a opt-out de marketing — errado pra um aviso interno de admin). Categoria de template
// aprovado não pode ser editada via API, e o token não tem permissão de apagar template — criado
// um novo com nome diferente em vez disso. O antigo ficou órfão na Meta (não apagado, só não usado
// mais). Ver HISTORICO-COMPLETO.md seção 26.
const TEMPLATE_ADMIN_NOVO_LEAD = { nome: 'admin_novo_lead_pocket_v2', idioma: 'pt_BR' }; // 1 var: número do lead
const TEMPLATE_ADMIN_PAGAMENTO_CONFIRMADO = { nome: 'admin_pagamento_confirmado_pocket', idioma: 'pt_BR' }; // 3 vars: nome, whatsapp, plano
const TEMPLATE_AVISO_ADMIN = { nome: 'aviso_admin_pocket', idioma: 'pt_BR' }; // 2 vars: tipo do aviso, detalhe (1 linha só — sem \n)

// "Avisador" dos relatórios proativos (resumo/previsão semanal ou mensal, disparados por
// /tarefas/relatorio e /tarefas/previsao) — o conteúdo de verdade (lista de categorias de despesa,
// linhas de previsão) tem tamanho variável demais pra caber num template rígido da Meta, então o
// bot manda só esse "avisador" fixo primeiro; quando o cliente responde qualquer coisa, abre a
// janela de 24h e AÍ SIM o relatório completo sai em texto livre (igual já funciona quando o
// cliente pede "resumo do mês" direto). 1 var: rótulo do que ficou pronto (ex.: "resumo da semana").
// 21/08/2026: trocado de 'relatorio_pronto_pocket' pra '..._v2' — mesmo motivo do
// TEMPLATE_ADMIN_NOVO_LEAD acima (acentos/emoji corrompidos no original + categoria MARKETING
// indevida). Ver HISTORICO-COMPLETO.md seção 26.
const TEMPLATE_RELATORIO_PRONTO = { nome: 'relatorio_pronto_pocket_v2', idioma: 'pt_BR' };

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

// Mesma ideia acima, aplicada a avisos de ERRO de processamento (17/08/2026 — antes não tinha
// cooldown nenhum: um cliente errando repetido no mesmo documento gerava um aviso de admin por
// tentativa). Chave por remetente + nome do erro, pra um erro diferente do mesmo cliente logo em
// seguida ainda avisar (não é o MESMO problema se repetindo).
const ULTIMA_NOTIFICACAO_ERRO = new Map();
const COOLDOWN_NOTIFICACAO_ERRO_MS = 15 * 60 * 1000;

// Envia um aviso administrativo pro Aroldo — SEMPRE o mesmo par de garantias (template cobre a
// entrega fora da janela de 24h, texto puro é o que ele realmente lê/copia), mas com 2 ajustes de
// 17/08/2026 (pedido do Aroldo, depois de um caso real de flood testando com o próprio número):
// 1) NUNCA notifica o admin sobre uma mensagem que o PRÓPRIO admin mandou — ele já vê a mensagem de
//    erro/confirmação do cliente na mesma conversa; notificar "admin sobre o admin" é 100% redundante.
// 2) TEXTO PRIMEIRO, template só como FALLBACK se o texto falhar (o caso normal é falhar por a
//    janela de 24h ter expirado) — no caso comum, cliente ativo/testando com o bot, evita pagar um
//    template à toa pra cada aviso.
async function avisarAdmin(remetente, template, parametrosTemplate, textoLivre) {
  if (!ADMIN_WHATSAPP_NUMBER || remetente === ADMIN_WHATSAPP_NUMBER) return;

  try {
    await enviarMensagemWhatsApp(ADMIN_WHATSAPP_NUMBER, textoLivre);
  } catch (erroTexto) {
    await enviarTemplateWhatsApp(ADMIN_WHATSAPP_NUMBER, template.nome, template.idioma, parametrosTemplate)
      .catch((erroTemplate) => console.error('Falha ao notificar admin (texto e template falharam):', erroTexto.message, '|', erroTemplate.message));
  }
}

async function notificarAdminSobreLead(remetente) {
  if (!ADMIN_WHATSAPP_NUMBER || remetente === ADMIN_WHATSAPP_NUMBER) return;

  const agora = Date.now();
  const ultimaNotificacao = ULTIMA_NOTIFICACAO_LEAD.get(remetente) || 0;
  if (agora - ultimaNotificacao < COOLDOWN_NOTIFICACAO_LEAD_MS) return;
  ULTIMA_NOTIFICACAO_LEAD.set(remetente, agora);

  await avisarAdmin(
    remetente,
    TEMPLATE_ADMIN_NOVO_LEAD,
    [remetente],
    `🔔 Novo lead no Interali Pocket: ${remetente} tentou mandar mensagem e ainda não está cadastrado.\n\nPra liberar: npm run cadastrar-cliente -- "${remetente}" "Nome" "ID_DA_PLANILHA"`
  );
}

function formatarNumero(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Formata o timestamp ISO de Registrado_Em (quando o Pocket de fato gravou o lançamento) pra
// "DD/MM/AAAA HH:mm" em pt-BR. Separado de formatarDataBR (reconciliacao.js) porque aquela função
// espera só "AAAA-MM-DD" (data do comprovante/compra) e quebra com um ISO completo — as duas datas
// são propositalmente diferentes (pedido do Aroldo, 14/08/2026, depois da confusão da Sirlene: ela
// leu "enviado em 13.08" como "você mandou isso em 13.08", quando na verdade era a data da compra
// no comprovante, não a data em que o Pocket registrou).
function formatarDataHoraBR(isoString) {
  if (!isoString) return '';
  const data = new Date(isoString);
  if (Number.isNaN(data.getTime())) return '';
  return data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// CNPJ/CPF identifica o ESTABELECIMENTO ou a PESSOA, não a transação — se repete em toda nota
// fiscal do mesmo lugar (prompts.js manda a IA preencher `documento_identificacao` com CNPJ/CPF
// quando não há um ID de transação de verdade). Não serve pro atalho "ID bate = duplicado" abaixo:
// bug real encontrado em 14/08/2026 — Aroldo mandou dois comprovantes do mesmo estabelecimento,
// R$4,50 e R$23,58 (compras diferentes), e o segundo foi descartado como duplicado só porque o
// CNPJ do documento batia com um lançamento já salvo daquele mesmo lugar. Só conta como ID forte de
// verdade um identificador que existe uma vez só POR TRANSAÇÃO: chave Pix (E2E), linha digitável de
// boleto, chave de acesso de NFC-e etc. — nenhum desses tem o formato de CPF (11 dígitos) ou CNPJ
// (14 dígitos).
function idEhTransacaoUnica(id) {
  const digitos = id.replace(/\D/g, '');
  return digitos.length !== 11 && digitos.length !== 14;
}

// Trava de duplicidade, olhando ID da transação + data + horário + valor + tipo (pedido do
// Aroldo, 08/08/2026 e reforçado em 14/08/2026: "verifique o ID_Transacao... se não houver ID,
// verifique Data+Hora+Valor+Tipo"). Dois níveis de checagem, na ordem:
//
// 1) ID_Transação (chave Pix, nº do boleto etc. — campo `documento_identificacao`, exceto quando
//    for CNPJ/CPF, ver idEhTransacaoUnica acima): se os dois lados TÊM um ID preenchido e ele bate,
//    é o sinal mais forte que existe — nem olha o resto.
// 2) Data+valor+tipo — sinal forte de repetição já sem precisar bater estabelecimento (a leitura
//    da IA pode variar levemente entre duas fotos do mesmo documento). O horário decide entre os
//    três níveis clássicos: "duplicado" (mesmo horário nos dois lados), "ambiguo" (falta horário
//    de um lado, não dá pra decidir sozinho) ou "novo" (horários diferentes nos dois lados).
//
// Em QUALQUER um dos dois níveis, se o candidato encontrado tiver Status_Conciliacao =
// PENDENTE_COMPROVANTE (nasceu do extrato, sem comprovante nenhum ainda — ver
// processarExtratoOrfaos), o resultado vira "completar" em vez de "duplicado"/"ambiguo": esse
// lançamento novo provavelmente É o comprovante que faltava, não uma repetição — melhor
// completar a linha existente com os detalhes certos do que rejeitar ou perguntar à toa.
function verificarDuplicidade(lancamentosExistentes, novo) {
  const idNovo = (novo.documento_identificacao || '').trim();
  if (idNovo && idEhTransacaoUnica(idNovo)) {
    const candidatoPorId = lancamentosExistentes.find((l) => (l.documento_identificacao || '').trim() === idNovo);
    if (candidatoPorId) {
      return candidatoPorId.status_conciliacao === 'PENDENTE_COMPROVANTE'
        ? { status: 'completar', candidato: candidatoPorId }
        : { status: 'duplicado', candidato: candidatoPorId };
    }
  }

  const candidatos = lancamentosExistentes.filter((lancamento) => (
    lancamento.data === novo.data &&
    Math.abs((lancamento.valor || 0) - (novo.valor || 0)) < 0.01 &&
    lancamento.tipo_movimentacao === novo.tipo_movimentacao
  ));

  if (candidatos.length === 0) return { status: 'novo' };

  const candidatoPendenteComprovante = candidatos.find((c) => c.status_conciliacao === 'PENDENTE_COMPROVANTE');
  if (candidatoPendenteComprovante) {
    return { status: 'completar', candidato: candidatoPendenteComprovante };
  }

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

// Lançamentos em dúvida (duplicidade ambígua) aguardando o cliente confirmar, um de cada vez —
// Map remetente → { fila: [{ dados, sheetId, candidato }], criadoEm }. É uma FILA (não um item só)
// porque um relatório de vendas do sistema (feature de 13/08/2026) pode gerar várias vendas
// ambíguas de uma vez — o cliente confirma uma, aí pergunta a próxima, até esvaziar. Em memória,
// reseta a cada deploy — aceitável no volume atual, igual ao cooldown de notificação de lead logo abaixo.
const PENDENCIAS_DUPLICIDADE = new Map();
const TIMEOUT_PENDENCIA_DUPLICIDADE_MS = 15 * 60 * 1000;

// Remetente → timestamp do último erro de processamento (catch geral do webhook, mais abaixo) —
// usado só pra reconhecer o padrão "documento deu erro, cliente reenviou o mesmo" e não chamar de
// duplicidade o que pro cliente é a primeira vez que deu certo (ver uso em processarLancamentoExtraido).
// Mesma lógica de expiração em memória das outras filas acima.
const ERROS_RECENTES_PROCESSAMENTO = new Map();
const TIMEOUT_ERRO_RECENTE_PROCESSAMENTO_MS = 15 * 60 * 1000;

// Adiciona um item ambíguo ao FIM da fila de confirmação do cliente — cria a fila se ainda não
// existir. `criadoEm` sempre atualiza pro do item mais recente, pra não expirar cedo demais uma
// fila que ainda está sendo alimentada (ex.: no meio do processamento de um relatório de vendas).
function enfileirarDuplicidadeAmbigua(remetente, dados, sheetId, candidato) {
  const pendencia = PENDENCIAS_DUPLICIDADE.get(remetente) || { fila: [], criadoEm: Date.now() };
  pendencia.fila.push({ dados, sheetId, candidato });
  pendencia.criadoEm = Date.now();
  PENDENCIAS_DUPLICIDADE.set(remetente, pendencia);
}

// Pergunta ao cliente sobre o item na frente da fila — mesmo texto usado tanto quando a pergunta é
// feita pela primeira vez quanto quando se avança pro próximo item da fila depois de resolver o anterior.
async function perguntarProximaDuplicidadeAmbigua(remetente, item) {
  const { dados, candidato: c } = item;
  await enviarMensagemWhatsApp(
    remetente,
    `🤔 Já tenho um lançamento parecido: ${formatarNumero(c.valor)} em ${c.data}${c.hora ? ` às ${c.hora}` : ''} (${c.estabelecimento_ou_pessoa || c.descricao || 'sem descrição'}).\n\n` +
    `Esse lançamento novo: ${formatarNumero(dados.valor)} em ${dados.data}${dados.hora ? ` às ${dados.hora}` : ''} (${dados.estabelecimento_ou_pessoa || 'sem descrição'}).\n\n` +
    `É o mesmo lançamento (duplicado) ou é diferente? Responde "duplicado" ou "diferente".`
  );
}

// Relatório proativo avisado (template) esperando o cliente responder qualquer coisa pra liberar
// o envio do conteúdo de verdade em texto livre — Map remetente → { tipo: 'resumo'|'previsao',
// periodo, dias, criadoEm }. Timeout bem mais folgado que o de duplicidade (7 dias) porque não é
// uma pergunta urgente, é só "quando você quiser ver, responde que eu mando".
const PENDENCIAS_RELATORIO = new Map();
const TIMEOUT_PENDENCIA_RELATORIO_MS = 7 * 24 * 60 * 60 * 1000;

// Fatura/cartão que falhou na leitura item-a-item mesmo depois de tudo (RespostaCortadaError, ver
// tratarErroProcessamento) — guarda o buffer da mídia já baixado pra poder tentar de novo sem
// pedir pro cliente reenviar o arquivo, e oferece a escolha "total" (rápido, seguro, ver
// processarFaturaComoResumo) ou "itens" (tenta o detalhe de novo, pode falhar de novo se a fatura
// for grande). Mesma mecânica de fila em memória das outras pendências acima — reseta a cada
// deploy, aceitável no volume atual.
const PENDENCIAS_ESCOLHA_FATURA = new Map();
const TIMEOUT_PENDENCIA_ESCOLHA_FATURA_MS = 15 * 60 * 1000;

// Documento (foto ou PDF) chegou sem NENHUMA pista de tipo — nem legenda, nem nome de arquivo
// reconhecível (ver inferirPistaPorNomeArquivo) — espera um pouco pra ver se o cliente manda um
// texto explicando logo em seguida (ex.: manda o PDF e só depois escreve "cartão de crédito pago")
// em vez de já arriscar a leitura genérica. Não é uma pergunta pro cliente, é só uma folga de
// alguns segundos antes de processar — se nada chegar, processa do jeito que já tinha vindo.
const DOCUMENTOS_AGUARDANDO_LEGENDA = new Map();
const JANELA_BUFFER_LEGENDA_MS = 7000;

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

// Mesma ideia de filtrarTransacoesNovas (extrato) acima, aplicada a conta a pagar/receber — ATÉ
// 14/08/2026 salvarContasAPagar/salvarContasAReceber gravavam direto, sem checar nada, então
// reenviar a mesma foto de boleto/fatura/nota (por engano, ou depois de um erro de leitura) duplicava
// a conta inteira na previsão de fluxo de caixa toda vez que chegasse de novo (pedido do Aroldo,
// 14/08/2026: "o cliente precisa ter certeza que vai ser lançado... 100% funcional"). Chave de
// comparação: Vencimento + Valor + Beneficiário/Cliente + Parcela_Atual — a parcela entra na
// comparação pra não confundir duas parcelas legítimas de vencimentos diferentes (isso já é coberto
// pelo Vencimento também, mas reforça o caso de reprocessar a fatura inteira de novo).
function filtrarContasAPagarNovas(contasExtraidas, contasExistentes) {
  return contasExtraidas.filter((nova) => !contasExistentes.some((existente) => (
    existente.vencimento === nova.vencimento &&
    Math.abs((existente.valor || 0) - (nova.valor || 0)) < 0.01 &&
    (existente.beneficiario || '').trim().toLowerCase() === (nova.beneficiario || '').trim().toLowerCase() &&
    (existente.parcela_atual || null) === (nova.parcela_atual || null)
  )));
}

function filtrarContasAReceberNovas(contasExtraidas, contasExistentes) {
  return contasExtraidas.filter((nova) => !contasExistentes.some((existente) => (
    existente.vencimento === nova.vencimento &&
    Math.abs((existente.valor || 0) - (nova.valor || 0)) < 0.01 &&
    (existente.cliente_devedor || '').trim().toLowerCase() === (nova.cliente_devedor || '').trim().toLowerCase() &&
    (existente.parcela_atual || null) === (nova.parcela_atual || null)
  )));
}

// Regra recorrente cadastrada duas vezes = a mesma despesa/receita lançada em dobro TODO MÊS (ou
// toda semana) pra sempre, até alguém notar — risco já citado no comentário de
// interpretarComandoDespesaFixa acima, mas até 14/08/2026 nada impedia de fato o recadastro. Chave
// de comparação: Descrição + Valor + Tipo + o mesmo dia de recorrência (mês OU semana — só uma das
// duas é preenchida por cadastro), e só entre as regras ainda ATIVAS (uma regra já desativada não
// deve travar um recadastro legítimo).
function existeDespesaFixaParecida(nova, despesasFixasExistentes) {
  return despesasFixasExistentes.some((existente) => (
    existente.ativo &&
    (existente.descricao || '').trim().toLowerCase() === (nova.descricao || '').trim().toLowerCase() &&
    Math.abs((existente.valor || 0) - (nova.valor || 0)) < 0.01 &&
    existente.tipo_movimentacao === (nova.tipo_movimentacao || 'saida') &&
    (existente.dia_do_mes || null) === (nova.dia_do_mes || null) &&
    (existente.dia_da_semana ?? null) === (nova.dia_da_semana ?? null)
  ));
}

// Salva o lançamento e, se o documento tinha itens detalhados (ex.: nota de fornecedor com
// "Queijo Muçarela", "Azeitona Verde"...), salva eles também numa aba própria, ligados a este
// lançamento — automático, sem precisar de configuração por cliente/nicho (o Claude já identifica
// os itens sozinho na extração, só precisava parar de descartar isso ao salvar). Falha ao salvar
// os itens não derruba o fluxo principal (o lançamento em si já está salvo) — só loga.
async function salvarComprovanteComItens(sheetId, dados) {
  const linhaLancamento = await salvarComprovante(sheetId, dados);

  if (Array.isArray(dados.itens) && dados.itens.length > 0) {
    await salvarItens(sheetId, dados.itens, {
      data: dados.data,
      estabelecimento: dados.estabelecimento_ou_pessoa,
      lancamentoLinha: linhaLancamento,
    }).catch((erro) => console.error('Falha ao salvar itens do comprovante:', erro.message));
  }

  return linhaLancamento;
}

// Classifica um lançamento contra uma lista de referência e executa a ação (salva direto, ou
// enfileira pra confirmação — nunca manda mensagem, quem chama decide como comunicar, já que o
// jeito certo de avisar é diferente pra 1 lançamento (foto/texto) vs. vários de uma vez (lote de
// vendas do sistema)). `lancamentosParaComparar` é passado de fora (não busca sozinho) pra permitir
// ir comparando contra uma lista que cresce durante um lote, pegando duplicata DENTRO do próprio lote.
async function classificarESalvarLancamento(remetente, sheetId, dadosExtraidos, lancamentosParaComparar) {
  const resultado = verificarDuplicidade(lancamentosParaComparar, dadosExtraidos);

  if (resultado.status === 'completar') {
    // Já existia um lançamento PENDENTE_COMPROVANTE (nasceu do extrato, sem detalhe nenhum) —
    // completa a linha existente com os dados reais do comprovante em vez de criar uma nova.
    await atualizarLancamento(sheetId, resultado.candidato.linha, {
      ...dadosExtraidos,
      status_conciliacao: 'CONCILIADO_OK',
      observacao_conciliacao: 'Comprovante recebido — completou o lançamento que tinha vindo do extrato/fatura.',
    });
    return { status: 'completar', linhaLancamento: resultado.candidato.linha };
  }

  if (resultado.status === 'duplicado') {
    return { status: 'duplicado', candidato: resultado.candidato };
  }

  if (resultado.status === 'ambiguo') {
    enfileirarDuplicidadeAmbigua(remetente, dadosExtraidos, sheetId, resultado.candidato);
    return { status: 'ambiguo', candidato: resultado.candidato };
  }

  const linhaLancamento = await salvarComprovanteComItens(sheetId, dadosExtraidos);
  return { status: 'novo', linhaLancamento };
}

// Processa um lançamento já extraído (de foto de comprovante OU do comando "lançar:" por texto) —
// checa duplicidade e decide se salva direto, avisa que já existe, ou pergunta pro cliente. Mesmo
// fluxo nos dois casos, só muda de onde veio o `dadosExtraidos` (imagem vs. texto).
async function processarLancamentoExtraido(remetente, cliente, sheetId, dadosExtraidos) {
  const lancamentosExistentes = await buscarTodosLancamentos(sheetId);
  const resultado = await classificarESalvarLancamento(remetente, sheetId, dadosExtraidos, lancamentosExistentes);

  if (resultado.status === 'completar') {
    await enviarMensagemWhatsApp(
      remetente,
      `🔗 *Conciliação:* esse comprovante já tinha um lançamento pendente vindo do extrato bancário — completei ele com os detalhes certos, sem duplicar!\n\n${formatarResumoComprovante(dadosExtraidos)}`
    );
    await sincronizarConciliacaoNaPlanilha(sheetId).catch((erro) => console.error('Falha ao sincronizar conciliação:', erro.message));
    return;
  }

  if (resultado.status === 'duplicado') {
    const c = resultado.candidato;

    // Reenvio do MESMO comprovante logo depois de um erro de leitura (pedido do Aroldo, 14/08/2026,
    // caso da Sirlene): a 1ª tentativa costuma ter salvo certinho antes de travar em outra etapa (ex.:
    // RespostaCortadaError na resposta ao cliente), então o cliente nunca viu a confirmação — só o
    // "não consegui processar". Manda de novo, a checagem de duplicidade bate (é o mesmo lançamento) e
    // aí, em vez de assustar com "duplicidade" (pro cliente é a 1ª vez que dá certo), confirma normal.
    const erroRecenteEm = ERROS_RECENTES_PROCESSAMENTO.get(remetente);
    if (erroRecenteEm && Date.now() - erroRecenteEm < TIMEOUT_ERRO_RECENTE_PROCESSAMENTO_MS) {
      ERROS_RECENTES_PROCESSAMENTO.delete(remetente);
      await enviarMensagemWhatsApp(remetente, formatarResumoComprovante(dadosExtraidos));
      return;
    }

    const dataLancamento = formatarDataHoraBR(c.registrado_em);
    await enviarMensagemWhatsApp(
      remetente,
      `⚠️ *Aviso de Conciliação:* Este comprovante de ${formatarNumero(dadosExtraidos.valor)} (${dadosExtraidos.estabelecimento_ou_pessoa || dadosExtraidos.descricao || 'sem descrição'}), com data de compra ${dadosExtraidos.data}, já está lançado no seu caixa${dataLancamento ? ` (lançado em ${dataLancamento})` : ''}. Para manter seu caixa correto, a duplicidade foi ignorada.\n\nSe não for duplicado, me avisa que eu registro mesmo assim.`
    );
    return;
  }

  if (resultado.status === 'ambiguo') {
    await perguntarProximaDuplicidadeAmbigua(remetente, { dados: dadosExtraidos, candidato: resultado.candidato });
    return;
  }

  await enviarMensagemWhatsApp(remetente, formatarResumoComprovante(dadosExtraidos));

  const prefixoMesAtual = new Date().toISOString().slice(0, 7); // "AAAA-MM"
  const lancamentosDoMes = lancamentosExistentes.filter((l) => (l.data || '').startsWith(prefixoMesAtual));
  await avisarSeLimiteProximo(remetente, cliente, lancamentosDoMes.length + 1);

  // Se esse lançamento bater com uma transação do extrato que já estava na planilha, marca
  // conciliado agora — não precisa esperar o cliente mandar extrato de novo.
  await sincronizarConciliacaoNaPlanilha(sheetId).catch((erro) => console.error('Falha ao sincronizar conciliação:', erro.message));
}

// Processa um LOTE de vendas extraídas de um relatório do sistema/PDV/app de delivery (ver
// PROMPT_VENDAS) — cada venda passa pela mesma checagem de duplicidade de um lançamento comum
// (pedido de 13/08/2026 do Aroldo: "quando ocorrer, informar que esse já foi lançado... se ele
// insistir que é pra lançar, lance"). Isso cobre o caso real de uma venda aparecer tanto no
// relatório do app quanto depois no extrato bancário ou da fatura do cartão. Diferente de um
// lançamento único, aqui manda um RESUMO agregado no final em vez de uma mensagem por venda — se
// sobrar item ambíguo, pergunta um de cada vez (mesma fila usada pra lançamento único).
async function processarLoteVendas(remetente, cliente, sheetId, vendas) {
  if (!vendas || vendas.length === 0) {
    await enviarMensagemWhatsApp(remetente, 'Não consegui identificar nenhuma venda nesse relatório. Confere se a imagem/PDF está legível e tenta de novo.');
    return;
  }

  const lancamentosExistentes = await buscarTodosLancamentos(sheetId);
  // Cópia local que cresce a cada venda salva — pega duplicata DENTRO do próprio lote também
  // (ex.: o mesmo pedido aparecendo 2x no relatório por engano do app).
  const lancamentosParaComparar = [...lancamentosExistentes];

  let novas = 0;
  let valorNovas = 0;
  let jaRegistradas = 0;
  let ambiguas = 0;
  let completadas = 0;

  for (const venda of vendas) {
    const dados = { ...venda, tipo_movimentacao: venda.tipo_movimentacao || 'entrada' };
    const resultado = await classificarESalvarLancamento(remetente, sheetId, dados, lancamentosParaComparar);

    if (resultado.status === 'novo') {
      novas += 1;
      valorNovas += dados.valor || 0;
      lancamentosParaComparar.push({ ...dados, hora: dados.hora || '' });
    } else if (resultado.status === 'completar') {
      completadas += 1;
      // Atualiza a cópia em memória (mesma linha, dados novos, status já CONCILIADO_OK) pra não
      // deixar o resto do lote comparando contra a versão antiga (PENDENTE_COMPROVANTE) dessa linha.
      const indiceExistente = lancamentosParaComparar.findIndex((l) => l.linha === resultado.linhaLancamento);
      if (indiceExistente >= 0) {
        lancamentosParaComparar[indiceExistente] = { ...dados, linha: resultado.linhaLancamento, hora: dados.hora || '', status_conciliacao: 'CONCILIADO_OK' };
      }
    } else if (resultado.status === 'duplicado') {
      jaRegistradas += 1;
    } else {
      ambiguas += 1;
    }
  }

  const partes = [
    `✅ Relatório de vendas processado! ${novas} venda(s) nova(s) registrada(s) (${formatarNumero(valorNovas)}).`,
    `🗓️ Lançado em: ${formatarDataHoraBR(new Date().toISOString())}`,
  ];
  if (completadas > 0) {
    partes.push(`${completadas} já tinha(m) vindo do extrato e foi(ram) completada(s) com os detalhes certos agora.`);
  }
  if (jaRegistradas > 0) {
    partes.push(`${jaRegistradas} já estava(m) registrada(s) (bateu com comprovante ou lançamento anterior) — ignorei pra não duplicar.`);
  }
  if (ambiguas > 0) {
    partes.push(`${ambiguas} parecida(s) com lançamento(s) existente(s) — vou te perguntar uma por vez pra confirmar.`);
  }
  await enviarMensagemWhatsApp(remetente, partes.join(' '));

  // Se sobrou pendência ambígua, já dispara a pergunta do primeiro item da fila — senão o cliente
  // não saberia que precisa responder algo.
  const pendencia = PENDENCIAS_DUPLICIDADE.get(remetente);
  if (pendencia && pendencia.fila.length > 0) {
    await perguntarProximaDuplicidadeAmbigua(remetente, pendencia.fila[0]);
  }

  await sincronizarConciliacaoNaPlanilha(sheetId).catch((erro) => console.error('Falha ao sincronizar conciliação (vendas):', erro.message));
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
    `📅 Data da compra: ${dados.data || 'não identificada'}`,
    `🗓️ Lançado em: ${formatarDataHoraBR(new Date().toISOString())}`,
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

// Confirmação enxuta do extrato pro cliente — SEM listar transação por transação, mesmo que sejam
// centenas (pedido do Aroldo, 19/08/2026: "não precisa ler tudo e escrever tudo aquilo pro
// cliente" — o mesmo princípio que já existia pra boleto/fatura, agora explícito pro extrato
// também). A planilha guarda o detalhe completo de cada transação (é lá que mora a verdade); a
// mensagem só confirma o essencial pra conferência rápida: quantas transações, quanto
// entrou/saiu, o período coberto pelos ITENS do extrato (data das transações) e quando o Pocket
// recebeu/lançou (data de envio no WhatsApp — timestamp de agora, mesmo padrão de
// formatarResumoComprovante). Isso também deixa a resposta mais rápida de gerar — não depende de
// formatar uma linha por transação.
function formatarResumoExtrato(transacoes, avisoDuplicadas) {
  if (transacoes.length === 0) {
    return `✅ Extrato recebido! Nenhuma transação nova pra lançar${avisoDuplicadas || ' — todas já estavam registradas'}.`;
  }

  const entradas = transacoes.filter((t) => t.tipo === 'entrada');
  const saidas = transacoes.filter((t) => t.tipo === 'saida');
  const totalEntradas = entradas.reduce((soma, t) => soma + (Number(t.valor) || 0), 0);
  const totalSaidas = saidas.reduce((soma, t) => soma + (Number(t.valor) || 0), 0);

  const datas = transacoes.map((t) => t.data).filter(Boolean).sort();
  const periodo = datas.length === 0
    ? 'não identificado'
    : datas[0] === datas[datas.length - 1]
      ? formatarDataBR(datas[0])
      : `${formatarDataBR(datas[0])} a ${formatarDataBR(datas[datas.length - 1])}`;

  // Saldo final = saldo_apos da transação mais recente (por data) que tiver esse campo — mesmo
  // critério de obterSaldoAtual (reconciliacao.js), só que restrito a este lote específico.
  const comSaldo = transacoes.filter((t) => t.data && t.saldo_apos !== null && t.saldo_apos !== undefined);
  const saldoFinal = comSaldo.length === 0
    ? null
    : comSaldo.reduce((maisRecente, t) => (t.data >= maisRecente.data ? t : maisRecente)).saldo_apos;

  const linhas = [
    `✅ Extrato recebido e lançado!${avisoDuplicadas || ''}`,
    '',
    `📅 Período dos itens: ${periodo}`,
    `🗓️ Lançado em: ${formatarDataHoraBR(new Date().toISOString())}`,
    `📊 ${transacoes.length} transação(ões) — ${entradas.length} entrada(s) (${formatarNumero(totalEntradas)}) / ${saidas.length} saída(s) (${formatarNumero(totalSaidas)})`,
  ];

  if (saldoFinal !== null) {
    linhas.push(`💰 Saldo final: ${formatarNumero(saldoFinal)}`);
  }

  linhas.push('', 'Pergunte "resumo do mês" para ver o fechamento com conciliação.');

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
    .map((lancamento) => {
      const novo = statusPorLinha.get(lancamento.linha) || { status: 'Pendente', observacao: '' };
      return { linha: lancamento.linha, status: novo.status, observacao: novo.observacao, statusAnterior: lancamento.status_conciliacao };
    })
    .filter(({ status, statusAnterior }) => status !== statusAnterior)
    .map(({ linha, status, observacao }) => ({ linha, status, observacao }));

  await atualizarStatusConciliacaoEmLote(sheetId, atualizacoes);
}

// Registra automaticamente na aba Lancamentos toda transação do EXTRATO que não tem nenhum
// lançamento correspondente (nem exato, nem dentro da tolerância) — pedido do Aroldo, 14/08/2026:
// "se não encontrar correspondência, registre a nova linha... Comprovante original pendente".
// Cobre entrada E saída (diferente do aviso "recebimento sem nota" no chat, que é só entrada —
// esse continua existindo do jeito que já era, só que agora a transação também fica REGISTRADA,
// não só perguntada). Cada uma nasce com status PENDENTE_COMPROVANTE — fica "congelada" nesse
// status pelo sincronizarConciliacao (ver reconciliacao.js) até o comprovante de verdade chegar e
// completar a linha (ver "completar" em classificarESalvarLancamento).
async function registrarOrfaosDoExtrato(sheetId, lancamentos, extratoTotal) {
  const { somenteNoExtrato } = reconciliar(lancamentos, extratoTotal);
  let registrados = 0;

  for (const transacao of somenteNoExtrato) {
    await salvarComprovanteComItens(sheetId, {
      data: transacao.data,
      hora: '',
      valor: transacao.valor,
      tipo_movimentacao: transacao.tipo,
      descricao: transacao.descricao || '',
      estabelecimento_ou_pessoa: transacao.descricao || '',
      categoria: 'Não Classificado',
      grupo_dre: 'nao_classificado',
      status_conciliacao: 'PENDENTE_COMPROVANTE',
      observacao_conciliacao: 'Lançado via extrato/fatura. Comprovante original pendente.',
    });
    registrados += 1;
  }

  return registrados;
}

async function gerarProjecao(sheetId, dias) {
  const [lancamentos, extrato, contasAPagar, contasAReceber] = await Promise.all([
    buscarTodosLancamentos(sheetId),
    buscarExtrato(sheetId),
    buscarContasAPagar(sheetId),
    buscarContasAReceber(sheetId),
  ]);

  const saldoAtual = obterSaldoAtual(extrato);
  const contasEmAberto = filtrarContasEmAberto(contasAPagar, lancamentos);
  const contasReceberEmAberto = filtrarContasEmAbertoReceber(contasAReceber, lancamentos);
  return projetarFluxoDeCaixa(saldoAtual, contasEmAberto, contasReceberEmAberto, dias);
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

// Autoidentificação pelo NOME DO ARQUIVO (17/08/2026) — fallback quando a legenda não diz nada:
// o app do banco às vezes já nomeia o PDF de forma descritiva (ex.: "credit-card-mp-statement.pdf",
// "extrato_santander_agosto.pdf", "boleto_energia.pdf"). Só entra em jogo quando a legenda não deu
// pista nenhuma (ver montarSinalRoteamento) — o que o cliente escreve na legenda sempre tem
// prioridade sobre uma dedução pelo nome do arquivo.
function inferirPistaPorNomeArquivo(nomeArquivo) {
  const nome = (nomeArquivo || '')
    .toLowerCase()
    .replace(/\.(pdf|jpe?g|png|webp|heic)$/i, '')
    .replace(/[._-]+/g, ' ');

  if (!nome.trim()) return '';
  // "credit card"/"cartao"/"fatura" checado ANTES de "statement/bank" de propósito: "credit card
  // statement" é o termo em inglês pra FATURA de cartão, não extrato bancário — se checasse
  // "statement" primeiro, "credit-card-mp-statement.pdf" (caso real reportado, 17/08/2026) cairia
  // errado em "extrato" só por causa da palavra "statement" solta no nome.
  if (/\b(credit\s?card|cartao|card|fatura)\b/.test(nome)) return 'fatura cartao';
  if (/\b(statement|extrato|bank)\b/.test(nome)) return 'extrato';
  if (/\b(boleto|dae|darf|guia)\b/.test(nome)) return 'boleto';
  if (/\b(vendas?|relatorio|fechamento|pdv|ifood|rappi)\b/.test(nome)) return 'vendas sistema';
  return '';
}

// Junta legenda (prioridade) + pista do nome do arquivo (fallback) num único texto pra alimentar
// as mesmas checagens de palavra-chave que já existiam só com a legenda — não muda a lógica de
// roteamento, só amplia de onde a pista pode vir.
function montarSinalRoteamento(legenda, nomeArquivo) {
  const pista = inferirPistaPorNomeArquivo(nomeArquivo);
  return `${(legenda || '').toLowerCase()} ${pista}`.trim();
}

// Estimativa best-effort do nº de páginas de um PDF (17/08/2026) — sem depender de biblioteca
// externa, conta ocorrências do objeto "/Type /Page" no binário bruto (exclui "/Type /Pages", que
// é o nó da árvore, não uma página em si). Funciona bem pra PDF "normal" (a maioria dos boletos e
// faturas gerados por banco); PDFs com stream de objeto comprimido podem subcontar — nesse caso
// retorna 0 (nem sempre confiável) e documentoPareceExtenso cai pro sinal auxiliar (tamanho do
// arquivo).
function contarPaginasPdfAproximado(buffer, mimeType) {
  if (mimeType !== 'application/pdf') return null;
  const texto = buffer.toString('latin1');
  const paginas = texto.match(/\/Type\s*\/Page(?!s)/g);
  return paginas ? paginas.length : 0;
}

// "Extenso" = provavelmente tem informação demais pra caber numa extração item-a-item de uma vez só
// (ver RespostaCortadaError em index.js) — 3+ páginas detectadas, OU (quando a contagem de páginas
// falhou, o que pode acontecer em PDF com stream comprimido) um arquivo grande de verdade — sinal
// auxiliar, tamanho típico de uma fatura de cartão de várias páginas gerada pelo banco.
const LIMITE_BYTES_PDF_PROVAVEL_EXTENSO = 350 * 1024;

function documentoPareceExtenso(buffer, mimeType) {
  if (mimeType !== 'application/pdf') return false;
  const paginas = contarPaginasPdfAproximado(buffer, mimeType);
  if (paginas >= 3) return true;
  if (paginas === 0 && buffer.length > LIMITE_BYTES_PDF_PROVAVEL_EXTENSO) return true;
  return false;
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

// Reconhece o comando de lançamento manual por texto: "lançar: gastei 500 com marketing hoje",
// "registrar - recebi 300 de fulano". Exige a palavra de comando bem no início da mensagem —
// diferente das outras heurísticas por palavra-chave deste arquivo (que só disparam leitura), aqui
// o resultado é GRAVAR um lançamento novo; confundir uma pergunta comum ("quanto eu gastei esse
// mês?") com um pedido de lançamento e criar um registro errado por engano é bem mais grave do que
// simplesmente responder a pergunta errada, então o gatilho precisa ser inequívoco.
function interpretarComandoLancamento(texto) {
  const match = (texto || '').trim().match(/^(?:lan[çc]ar|registrar|anotar)\s*[:\-]\s*(.+)$/i);
  return match ? match[1].trim() : null;
}

// Reconhece o comando de cadastro de despesa/receita FIXA recorrente: "recorrente: todo dia 10
// pago marketing 1000", "fixa - recebo 2000 de aluguel todo dia 5". Mesmo motivo da exigência de
// gatilho explícito do comando acima — aqui o risco é pior ainda, porque uma regra recorrente mal
// cadastrada continua lançando todo mês até alguém notar.
function interpretarComandoDespesaFixa(texto) {
  const match = (texto || '').trim().match(/^(?:recorrente|despesa\s*fixa|fixa)\s*[:\-]\s*(.+)$/i);
  return match ? match[1].trim() : null;
}

// Reconhece o comando de cadastro de conta a RECEBER por texto: "receber: 500 do João dia 20".
// Mesmo motivo de gatilho explícito das outras heurísticas de comando deste arquivo.
function interpretarComandoContaAReceber(texto) {
  const match = (texto || '').trim().match(/^(?:receber|a\s*receber|cobran[çc]a)\s*[:\-]\s*(.+)$/i);
  return match ? match[1].trim() : null;
}

function formatarResumoContaAReceber(dados) {
  const parcela = dados.parcela_atual && dados.parcela_total ? ` (${dados.parcela_atual}/${dados.parcela_total})` : '';
  return (
    '✅ Conta a receber registrada!\n\n' +
    `📅 Vencimento: ${dados.vencimento}${parcela}\n` +
    `💰 Valor: ${formatarNumero(dados.valor)}\n` +
    `👤 ${dados.cliente_devedor || 'Não identificado'}\n` +
    `📝 ${dados.descricao || ''}\n\n` +
    'Isso já entra na sua "previsão" — assim que o dinheiro cair (bater com um lançamento de entrada perto dessa data e valor), some sozinho da lista de pendências.'
  );
}

const NOMES_DIA_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

function formatarResumoDespesaFixa(dados) {
  const tipoTexto = dados.tipo_movimentacao === 'entrada' ? 'Entrada' : 'Saída';
  const recorrencia = dados.frequencia === 'semanal' && dados.dia_da_semana !== null && dados.dia_da_semana !== undefined
    ? `Toda ${NOMES_DIA_SEMANA[dados.dia_da_semana]}`
    : `Todo dia ${dados.dia_do_mes}`;
  const proximaVez = dados.frequencia === 'semanal' ? 'a partir dessa semana (ou hoje, se já for o dia certo)' : 'a partir do próximo mês (ou hoje, se já for o dia certo)';
  return (
    '✅ Despesa/receita fixa cadastrada!\n\n' +
    `📅 ${recorrencia}\n` +
    `💰 Valor: ${formatarNumero(dados.valor)}\n` +
    `↕️ Tipo: ${tipoTexto}\n` +
    `🏷️ Categoria: ${dados.categoria || 'Não Classificado'}\n` +
    `📝 ${dados.descricao || ''}\n\n` +
    `${proximaVez[0].toUpperCase()}${proximaVez.slice(1)}, eu lanço isso sozinho automaticamente, sem precisar mandar de novo.`
  );
}

// Registra uma fatura de cartão só pelo RESUMO (total, vencimento, banco, se já foi paga) — usado
// quando o documento é extenso demais pra ler item a item (ver documentoPareceExtenso) ou quando o
// cliente escolhe essa opção depois de uma leitura item a item falhar (ver PENDENCIAS_ESCOLHA_FATURA).
// `opts.semLegenda` acrescenta a dica de legenda na mesma mensagem, em vez de mandar uma mensagem
// extra só pra isso (o problema original era "mensagens demais" — não faz sentido resolver isso
// enviando mais uma mensagem).
async function processarFaturaComoResumo(remetente, cliente, sheetId, buffer, mimeType, legendaLower, opts = {}) {
  const resumo = await extrairResumoFaturaDeBuffer(buffer, mimeType);
  const cartao = extrairNomeCartao(legendaLower) || resumo.banco_emissor || '';
  const dicaLegenda = opts.semLegenda
    ? '\n\nDa próxima vez, pode escrever "fatura" ou "cartão <nome do banco>" na legenda pra eu já processar assim direto. 😉'
    : '';

  if (resumo.status_pagamento === 'paga') {
    const dadosExtraidos = {
      tipo_documento: 'fatura_cartao_credito',
      data: resumo.data_pagamento || new Date().toISOString().slice(0, 10),
      hora: null,
      valor: resumo.valor_total,
      tipo_movimentacao: 'saida',
      descricao: resumo.descricao || `Fatura de cartão de crédito${cartao ? ` ${cartao}` : ''}`,
      estabelecimento_ou_pessoa: cartao || resumo.banco_emissor || 'Cartão de crédito',
      documento_identificacao: null,
      forma_pagamento: 'cartao_credito',
      categoria: 'Fatura de Cartão de Crédito',
      subcategoria: cartao || resumo.banco_emissor || null,
      grupo_dre: 'admin_fatura_cartao_consolidada',
      banco_conta: resumo.banco_emissor || null,
      itens: [],
      observacoes: 'Lançamento consolidado (fatura extensa) — sem detalhamento item a item. Se precisar do detalhe, peça pra tentar ler os itens de novo.',
    };
    await processarLancamentoExtraido(remetente, cliente, sheetId, dadosExtraidos);
    if (dicaLegenda) await enviarMensagemWhatsApp(remetente, dicaLegenda.trim()).catch(() => {});
    return;
  }

  const conta = {
    vencimento: resumo.vencimento || new Date().toISOString().slice(0, 10),
    valor: resumo.valor_total,
    beneficiario: cartao || resumo.banco_emissor || 'Cartão de crédito',
    descricao: resumo.descricao || `Fatura de cartão de crédito${cartao ? ` ${cartao}` : ''}`,
    categoria: 'Fatura de Cartão de Crédito',
    grupo_dre: 'admin_fatura_cartao_consolidada',
    parcela_atual: null,
    parcela_total: null,
  };

  const contasExistentes = await buscarContasAPagar(sheetId);
  const contasNovas = filtrarContasAPagarNovas([conta], contasExistentes);
  await salvarContasAPagar(sheetId, contasNovas);

  const aviso = contasNovas.length === 0 ? ' (já estava registrada, ignorei pra não duplicar)' : '';
  await enviarMensagemWhatsApp(
    remetente,
    `✅ Registrei a fatura${cartao ? ` do cartão ${cartao}` : ''} como conta a pagar${aviso}: ${formatarNumero(conta.valor)}, vencimento ${conta.vencimento}.\n` +
    `🗓️ Lançado em: ${formatarDataHoraBR(new Date().toISOString())}\n\n` +
    'Ela veio consolidada (sem detalhar item a item) porque é um documento extenso — se quiser o detalhe por lançamento, me avisa que eu tento ler de novo.' +
    dicaLegenda
  );
}

// Rede de segurança de ÚLTIMO recurso pro extrato (19/08/2026) — só é chamada de dentro de
// tratarErroProcessamento, depois que a leitura transação a transação (extrairExtratoDeBuffer, já
// com max_tokens elevado pra 16000) MESMO ASSIM cortou de novo (RespostaCortadaError num extrato
// realmente fora do comum). Caso real: cliente Sirlene, extrato cortando repetidamente. Diferente
// da fatura (que vira 1 lançamento consolidado), o extrato não dá pra reconciliar sem as transações
// individuais — então isso NUNCA pede nada pro cliente (o produto promete "manda uma vez,
// funciona"): grava só uma linha consolidada em Extrato com o saldo final (mantém a previsão de
// caixa correta) e devolve o resumo pra quem chamou notificar o admin com prioridade, pra alguém do
// time completar o lançamento manualmente depois.
async function processarExtratoComoResumo(sheetId, buffer, mimeType) {
  const resumo = await extrairResumoExtratoDeBuffer(buffer, mimeType);

  if (resumo.saldo_final !== null && resumo.saldo_final !== undefined) {
    const banco = resumo.banco_conta ? ` (${resumo.banco_conta})` : '';
    const periodo = resumo.periodo_inicio && resumo.periodo_fim
      ? ` — período ${formatarDataBR(resumo.periodo_inicio)} a ${formatarDataBR(resumo.periodo_fim)}`
      : '';
    await salvarExtrato(sheetId, [{
      data: resumo.periodo_fim || new Date().toISOString().slice(0, 10),
      descricao: `Resumo consolidado do extrato${banco}${periodo} — extrato extenso demais pra detalhar transação a transação automaticamente, aguardando lançamento manual`,
      valor: 0,
      tipo: '',
      saldo_apos: resumo.saldo_final,
    }]);
  }

  return resumo;
}

// Registra uma fatura/boleto item a item (fluxo que já existia antes de 17/08/2026) — usado pra
// documento curto (não extenso) ou quando o cliente pede explicitamente o detalhe depois da
// escolha "total"/"itens" (ver PENDENCIAS_ESCOLHA_FATURA).
async function processarFaturaItemizada(remetente, cliente, sheetId, buffer, mimeType, legendaLower, opts = {}) {
  const contas = await extrairContasAPagarDeBuffer(buffer, mimeType);
  const cartao = extrairNomeCartao(legendaLower);
  if (cartao) contas.forEach((conta) => { conta.cartao = cartao; });

  console.log(`Contas a pagar processadas: ${contas.length} conta(s)${cartao ? ` | cartão: ${cartao}` : ''}`);

  const contasAPagarExistentes = await buscarContasAPagar(sheetId);
  const contasAPagarNovas = filtrarContasAPagarNovas(contas, contasAPagarExistentes);
  const contasAPagarDuplicadas = contas.length - contasAPagarNovas.length;

  await salvarContasAPagar(sheetId, contasAPagarNovas);
  const sufixoCartao = cartao ? ` no cartão ${cartao}` : '';
  const avisoContasAPagarDuplicadas = contasAPagarDuplicadas > 0 ? ` (${contasAPagarDuplicadas} já estava(m) registrada(s), ignorei pra não duplicar)` : '';
  // Total somado (não lista cada conta individualmente) — mesmo princípio do extrato: confirmação
  // geral pro cliente, detalhe completo por lançamento fica na planilha.
  const totalContasNovas = contasAPagarNovas.reduce((soma, c) => soma + (Number(c.valor) || 0), 0);
  const lancadoEm = `🗓️ Lançado em: ${formatarDataHoraBR(new Date().toISOString())}`;

  const prefixo = opts.semLegenda
    ? `✅ Esse documento é uma fatura de cartão com ${contasAPagarNovas.length} lançamento(s) (${formatarNumero(totalContasNovas)}) — registrei${sufixoCartao} como contas a pagar, não como um gasto único${avisoContasAPagarDuplicadas}.\n${lancadoEm}\n\nDa próxima vez, pode escrever "fatura" ou "cartão <nome do banco>" na legenda pra eu já processar assim direto. 😉`
    : `✅ Registrei ${contasAPagarNovas.length} conta(s) a pagar${sufixoCartao} (${formatarNumero(totalContasNovas)})${avisoContasAPagarDuplicadas}.\n${lancadoEm}`;

  await enviarMensagemWhatsApp(remetente, `${prefixo}\n\nPergunte "previsão" a qualquer momento para ver o fluxo de caixa projetado.`);
}

// Roteia e processa uma mídia (foto ou documento) já baixada — extraído do handler do webhook em
// 17/08/2026 pra poder ser chamado tanto no fluxo normal (legenda já veio junto) quanto depois de
// um buffer de espera (legenda chegou separada, ver DOCUMENTOS_AGUARDANDO_LEGENDA) ou de uma
// escolha do cliente após uma leitura item a item falhar (ver PENDENCIAS_ESCOLHA_FATURA). Lança
// (throw) em caso de erro — quem chama decide como avisar o cliente (ver tratarErroProcessamento).
async function processarMidiaRecebida(remetente, cliente, sheetId, { buffer, mimeType, nomeArquivo, legenda }) {
  const legendaLower = (legenda || '').toLowerCase();
  const sinal = montarSinalRoteamento(legenda, nomeArquivo);
  const extenso = documentoPareceExtenso(buffer, mimeType);
  const semLegendaExplicita = !legendaLower.trim();

  if (sinal.includes('extrato')) {
    const transacoes = await extrairExtratoDeBuffer(buffer, mimeType);
    const extratoExistente = await buscarExtrato(sheetId);
    const transacoesNovas = filtrarTransacoesNovas(transacoes, extratoExistente);
    const duplicadas = transacoes.length - transacoesNovas.length;

    console.log(`Extrato processado: ${transacoes.length} transação(ões), ${duplicadas} já existente(s)`);

    const lancamentosExistentes = await buscarTodosLancamentos(sheetId);
    const orfas = encontrarTransacoesOrfas(transacoesNovas, lancamentosExistentes);
    const extratoTotal = [...extratoExistente, ...transacoesNovas];

    await salvarExtrato(sheetId, transacoesNovas);

    // Registra automaticamente na planilha toda transação do extrato sem lançamento
    // correspondente (entrada OU saída — mais amplo que o aviso "recebimento sem nota" logo
    // abaixo, que é só entrada) — status PENDENTE_COMPROVANTE, completado depois se o comprovante
    // chegar. Precisa rodar ANTES do sincronizarConciliacaoNaPlanilha pra essas linhas novas
    // entrarem já na mesma passada de conciliação (senão ficariam órfãs de novo até o próximo extrato).
    const registrados = await registrarOrfaosDoExtrato(sheetId, lancamentosExistentes, extratoTotal).catch((erro) => {
      console.error('Falha ao registrar órfãos do extrato:', erro.message);
      return 0;
    });

    // Recalcula o Status_Conciliacao de tudo agora que o extrato (e os órfãos recém-registrados)
    // mudaram — sem argumentos, busca tudo de novo do zero, senão as linhas novas ficariam de fora.
    await sincronizarConciliacaoNaPlanilha(sheetId).catch((erro) => console.error('Falha ao sincronizar conciliação:', erro.message));

    const avisoDuplicadas = duplicadas > 0 ? ` (${duplicadas} já estava(m) registrada(s), ignorei pra não duplicar)` : '';
    const avisoRegistrados = registrados > 0 ? `\n📌 ${registrados} lançamento(s) sem comprovante foram registrados automaticamente como pendentes.` : '';
    const avisoOrfas = orfas.length > 0
      ? '\n\n🔎 ' + orfas.map((t) => `Identifiquei um recebimento de ${formatarNumero(t.valor)} em ${formatarDataBR(t.data)} no extrato sem comprovante vinculado. O que foi isso? Me conta que eu registro certinho.`).join('\n🔎 ')
      : '';
    await enviarMensagemWhatsApp(remetente, formatarResumoExtrato(transacoesNovas, avisoDuplicadas) + avisoRegistrados + avisoOrfas);
    return;
  }

  if (/\bvend|\bsistema\b|\bpdv\b|ifood|rappi|delivery|aiqfome/.test(sinal)) {
    // Relatório de vendas do sistema/PDV/app de delivery — não trava num app específico (ver
    // PROMPT_VENDAS), o gatilho é só a legenda (ou o nome do arquivo) mencionar "venda(s)",
    // "sistema", "pdv" ou o nome de algum app conhecido. Cada venda vira um lançamento normal,
    // passando pela mesma checagem de duplicidade de um comprovante — cobre o caso de a mesma
    // venda aparecer depois no extrato bancário ou na fatura do cartão.
    const vendas = await extrairVendasDeBuffer(buffer, mimeType);
    console.log(`Relatório de vendas processado: ${vendas.length} venda(s) identificada(s)`);
    await processarLoteVendas(remetente, cliente, sheetId, vendas);
    return;
  }

  if (sinal.includes('boleto') || sinal.includes('fatura') || sinal.includes('pagar') || sinal.includes('cart')) {
    if (extenso) {
      // PDF extenso (várias páginas) pedindo leitura de boleto/fatura — vai direto pro resumo em
      // vez de arriscar a extração item a item, que é justamente o que estourava antes (17/08/2026).
      await processarFaturaComoResumo(remetente, cliente, sheetId, buffer, mimeType, legendaLower);
    } else {
      await processarFaturaItemizada(remetente, cliente, sheetId, buffer, mimeType, legendaLower);
    }
    return;
  }

  if (/receber|cobran[çc]a/.test(sinal)) {
    // Conta a RECEBER (14/08/2026) — nota fiscal emitida, contrato, venda parcelada — dinheiro
    // que um terceiro ainda vai pagar PRO cliente. Espelha o fluxo de boleto/fatura acima, sentido
    // inverso: legenda "receber" ou "cobrança" aciona PROMPT_CONTA_A_RECEBER em vez do de contas
    // a pagar.
    const contas = await extrairContasAReceberDeBuffer(buffer, mimeType);
    console.log(`Contas a receber processadas: ${contas.length} conta(s)`);

    const contasAReceberExistentes = await buscarContasAReceber(sheetId);
    const contasAReceberNovas = filtrarContasAReceberNovas(contas, contasAReceberExistentes);
    const contasAReceberDuplicadas = contas.length - contasAReceberNovas.length;

    await salvarContasAReceber(sheetId, contasAReceberNovas);
    const avisoContasAReceberDuplicadas = contasAReceberDuplicadas > 0 ? ` (${contasAReceberDuplicadas} já estava(m) registrada(s), ignorei pra não duplicar)` : '';
    const totalContasAReceberNovas = contasAReceberNovas.reduce((soma, c) => soma + (Number(c.valor) || 0), 0);
    await enviarMensagemWhatsApp(remetente, `✅ Registrei ${contasAReceberNovas.length} conta(s) a receber (${formatarNumero(totalContasAReceberNovas)})${avisoContasAReceberDuplicadas}.\n🗓️ Lançado em: ${formatarDataHoraBR(new Date().toISOString())}\n\nPergunte "previsão" a qualquer momento para ver o fluxo de caixa projetado (já considera o que ainda vai entrar).`);
    return;
  }

  // Nenhuma pista bateu (nem legenda, nem nome do arquivo) — se for um PDF extenso, é bem mais
  // provável que seja uma fatura/extrato de várias páginas do que um comprovante único; tenta pelo
  // resumo (seguro, não estoura o limite de tokens) em vez de arriscar o formato de comprovante
  // único, que foi justamente o que causou a leitura cortada no meio (17/08/2026, caso real do
  // Aroldo com a fatura de cartão paga mandada sem legenda).
  if (extenso) {
    await processarFaturaComoResumo(remetente, cliente, sheetId, buffer, mimeType, legendaLower, { semLegenda: semLegendaExplicita });
    return;
  }

  const dadosExtraidos = await extrairComprovanteDeBuffer(buffer, mimeType);

  if (dadosExtraidos.tipo_documento === 'fatura_cartao_credito') {
    // Chegou sem legenda "fatura"/"boleto"/"cartão" (ex.: cliente só mandou o arquivo), mas o
    // Claude percebeu que é uma fatura com múltiplos lançamentos — reprocessa como contas a
    // pagar (item a item, com vencimento) em vez de salvar como um único comprovante, senão
    // os lançamentos individuais e as parcelas ficariam perdidos dentro de "itens".
    await processarFaturaItemizada(remetente, cliente, sheetId, buffer, mimeType, legendaLower, { semLegenda: true });
  } else {
    // Legenda ("conta Itaú PJ") tem prioridade sobre o que o Claude leu na própria imagem —
    // só o cliente sabe com certeza qual das contas dele é, quando ele se dá o trabalho de dizer.
    dadosExtraidos.conta_bancaria = extrairNomeConta(legendaLower) || dadosExtraidos.banco_conta || '';

    console.log('Dados extraídos:', JSON.stringify(dadosExtraidos, null, 2));

    await processarLancamentoExtraido(remetente, cliente, sheetId, dadosExtraidos);
  }
}

// Extrai a lógica do catch geral do webhook (14/08/2026, ampliada em 17/08/2026) pra poder ser
// chamada tanto de dentro do try/catch normal quanto de um processamento adiado (buffer de
// legenda) ou de uma escolha do cliente ("total"/"itens") — nenhum desses passa mais pelo catch
// original, então precisavam da mesma lógica de aviso disponível como função separada.
// `contexto` = { tipoMidia, legenda, buffer, mimeType } — buffer/mimeType só quando disponíveis
// (permite oferecer "total"/"itens" de novo sem pedir reenvio do arquivo).
async function tratarErroProcessamento(remetente, cliente, contexto, error) {
  console.error('Erro ao processar mensagem:', error.message);

  // Marca o horário do erro pra esse remetente — se ele reenviar o mesmo documento logo em
  // seguida e a checagem de duplicidade bater, processarLancamentoExtraido trata como confirmação
  // normal em vez de aviso de duplicidade (ver ERROS_RECENTES_PROCESSAMENTO acima).
  if (remetente) ERROS_RECENTES_PROCESSAMENTO.set(remetente, Date.now());

  // Cooldown ÚNICO por remetente+tipo de erro, checado ANTES de mandar qualquer mensagem — pro
  // CLIENTE e pro admin (19/08/2026, pedido do Aroldo: "o cliente não pode receber um monte de
  // mensagens" repetidas pro mesmo problema). Até aqui só o aviso de ADMIN tinha cooldown (e o
  // caminho de extrato nem isso tinha, de propósito) — o CLIENTE podia receber a mesma mensagem de
  // erro várias vezes se o mesmo problema se repetisse rápido. Caso real: antes da correção de ack
  // imediato do webhook (mesmo commit), a Meta redisparava a mesma mensagem várias vezes por
  // demora de resposta, e cada redisparo gerava uma mensagem de erro NOVA pro cliente. Agora nem
  // admin nem cliente recebem 2 avisos do mesmo problema dentro da janela de 15min — inclusive os
  // fluxos "autorresolvidos" de fatura/extrato, que antes eram exceção a qualquer cooldown.
  const chaveCooldownErro = `${remetente}|${error.name}`;
  const agoraErro = Date.now();
  const ultimoAvisoErro = ULTIMA_NOTIFICACAO_ERRO.get(chaveCooldownErro) || 0;
  if (agoraErro - ultimoAvisoErro < COOLDOWN_NOTIFICACAO_ERRO_MS) {
    console.log(`Erro repetido em cooldown pra ${remetente} (${error.name}) — não avisa de novo (nem cliente, nem admin): ${error.message}`);
    return;
  }
  ULTIMA_NOTIFICACAO_ERRO.set(chaveCooldownErro, agoraErro);

  const legendaLower = ((contexto && contexto.legenda) || '').toLowerCase();
  const jaEraExtrato = contexto && contexto.tipoMidia && legendaLower.includes('extrato');
  const pareceFatura = contexto && contexto.tipoMidia && /fatura|cart[ãa]o|boleto|pagar/.test(legendaLower);
  const nomeCliente = cliente ? cliente.nome : '(não identificado)';

  // RespostaCortadaError num documento que parece fatura/cartão, com o buffer ainda disponível —
  // em vez de só orientar reenvio, oferece pra registrar já (só o total, seguro) ou tentar de novo
  // o detalhe item a item (ver PENDENCIAS_ESCOLHA_FATURA e requisito 4 do pedido do Aroldo, 17/08/2026).
  const erroFaturaAutorresolvido = error.name === 'RespostaCortadaError' && pareceFatura && !jaEraExtrato && contexto.buffer;

  // RespostaCortadaError num EXTRATO, mesmo já com max_tokens elevado pra 32000 (ver
  // extrairExtratoDeBuffer em index.js) — caso real: cliente Sirlene, extrato cortando
  // repetidamente mesmo com a legenda certa (19/08/2026). O produto promete "manda uma vez,
  // funciona" — então, diferente da fatura, isso NUNCA pede nada pro cliente (nem "total"/"itens",
  // nem "manda em partes"). É tratado 100% automático: grava o resumo/saldo em segundo plano (ver
  // processarExtratoComoResumo) e escala pro admin resolver manualmente.
  const erroExtratoAutorresolvido = error.name === 'RespostaCortadaError' && jaEraExtrato && contexto.buffer;

  if (erroFaturaAutorresolvido) {
    PENDENCIAS_ESCOLHA_FATURA.set(remetente, {
      buffer: contexto.buffer,
      mimeType: contexto.mimeType,
      legendaLower,
      criadoEm: Date.now(),
    });
    await enviarMensagemWhatsApp(
      remetente,
      'Identifiquei que você mandou uma fatura de cartão, mas ela tem mais lançamentos do que eu consigo ler de uma vez.\n\n' +
      'Quer que eu registre só o *valor total* como uma despesa/conta única (rápido, sem detalhar item por item), ou prefere que eu *tente ler os itens* de novo (pode falhar de novo se a fatura for grande)?\n\n' +
      'Responde "total" ou "itens".'
    ).catch(() => {});
    console.log(`Erro autorresolvido (fatura extensa, cliente recebeu escolha total/itens) — sem avisar admin: ${remetente} — ${error.message}`);
    return;
  }

  if (erroExtratoAutorresolvido) {
    // Não pede nada pro cliente — registra o resumo/saldo sozinho e avisa que está resolvido do
    // lado dele. Se até o resumo falhar (raríssimo, é uma resposta pequena e fixa), ainda assim não
    // culpa o cliente por isso — só reforça pro admin que precisa de atenção manual.
    if (cliente && cliente.sheetId) {
      await processarExtratoComoResumo(cliente.sheetId, contexto.buffer, contexto.mimeType).catch((erroResumo) => {
        console.error('Falha até no resumo do extrato (rede de segurança):', erroResumo.message);
      });
    }
    await enviarMensagemWhatsApp(
      remetente,
      '📄 Recebi seu extrato! Ele é maior do que o normal, então nosso time vai revisar e completar o lançamento — você não precisa fazer nada nem reenviar. Te aviso por aqui assim que estiver tudo certo. 🙏'
    ).catch(() => {});
    await avisarAdmin(
      remetente,
      TEMPLATE_AVISO_ADMIN,
      ['AÇÃO NECESSÁRIA: extrato grande demais', `${nomeCliente} (${remetente}) — completar lançamento manualmente, resumo/saldo já registrado`],
      `🔴 AÇÃO NECESSÁRIA — extrato grande demais mesmo com limite ampliado\n\n👤 ${nomeCliente}\n📱 ${remetente}\n\nO extrato cortou de novo (RespostaCortadaError) mesmo com max_tokens em 32000. Já registrei o resumo/saldo final na planilha (Extrato) e já avisei o cliente que não precisa fazer nada — mas as transações individuais NÃO foram lançadas. Precisa completar manualmente (ou pedir o extrato em partes só pra uso interno, sem envolver o cliente de novo).`
    );
    return;
  }

  const mensagemErroCliente = error.name === 'RespostaCortadaError'
    ? SUPORTE_TEXTO
      ? `Recebi seu documento, mas tive um problema pra processar ele agora. Já estou olhando isso — se precisar, ${SUPORTE_TEXTO.charAt(0).toLowerCase()}${SUPORTE_TEXTO.slice(1)}`
      : 'Recebi seu documento, mas tive um problema pra processar ele agora. Já estou olhando isso, te aviso assim que resolver.'
    : SUPORTE_TEXTO
      ? `Ops, não consegui processar isso agora. Pode tentar de novo?\n\nSe continuar dando errado, ${SUPORTE_TEXTO.charAt(0).toLowerCase()}${SUPORTE_TEXTO.slice(1)}`
      : 'Ops, não consegui processar isso agora. Pode tentar de novo?';

  await enviarMensagemWhatsApp(remetente, mensagemErroCliente).catch(() => {});

  await avisarAdmin(
    remetente,
    TEMPLATE_AVISO_ADMIN,
    ['Erro processando mensagem', `${nomeCliente} (${remetente}) — tipo ${(contexto && contexto.tipoMidia) || 'texto'} — ${error.message}`],
    `⚠️ Erro processando mensagem no Interali Pocket\n\n👤 ${nomeCliente}\n📱 ${remetente}\n📎 Tipo: ${(contexto && contexto.tipoMidia) || 'texto'}\n❌ ${error.message}`
  );
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
  // Confirma recebimento pra Meta IMEDIATAMENTE, antes de processar qualquer coisa (19/08/2026).
  // Achado real: um documento grande (ex.: extrato de 350 transações) pode legitimamente levar
  // minutos pra processar (ver extrairExtratoDeBuffer em index.js) — e a Cloud API da Meta reenvia
  // o webhook se não receber 200 rápido, o que reprocessa a MESMA mensagem do zero e gera erros
  // duplicados (caso real: cliente Sirlene recebeu o mesmo erro várias vezes em poucos minutos pro
  // que ela mandou uma única vez). Daqui pra baixo, TODO o resto do handler roda depois da resposta
  // já ter ido pra Meta — nenhum outro `res.sendStatus` deve ser chamado neste handler.
  res.sendStatus(200);

  const body = req.body || {};

  // Log cru de tudo que chega — sem isso, um payload em formato inesperado não deixa rastro nos logs.
  console.log(`Webhook recebido | object=${body.object} | chaves do body=${Object.keys(body).join(',')}`);

  const msg = extrairMensagemDoWebhook(body);

  // Sem "messages" no payload (ex.: evento "statuses" — confirmação de entrega/leitura de uma
  // mensagem que o próprio bot mandou) — nada a processar.
  if (!msg) {
    return;
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
      return;
    }
  }

  let cliente;
  // Guarda o buffer/mimeType da mídia em processamento no escopo da função (não só dentro do bloco
  // `if (interpretado.tipoMidia)`) pra que o catch geral lá embaixo também tenha acesso a eles em
  // caso de erro — sem isso, tratarErroProcessamento não conseguia oferecer nenhuma recuperação
  // automática (fatura "total"/"itens", resumo de extrato) pro caminho comum (documento chega já
  // com legenda certa, sem passar pelo buffer de espera) — só funcionava nos caminhos que já
  // passavam o buffer manualmente. Achado em 19/08/2026, caso real: extrato da cliente Sirlene,
  // legendado "extrato" corretamente, nunca acionava a rede de segurança por causa disso.
  let bufferMidiaAtual = null;
  let mimeTypeMidiaAtual = null;

  try {
    cliente = await buscarClientePorNumero(remetente);

    if (!cliente) {
      await enviarMensagemWhatsApp(remetente, 'Esse número ainda não está cadastrado no Interali Pocket. Fale com a Interali para ativar seu acesso: (41) 98788-5732.');
      await notificarAdminSobreLead(remetente);
      return;
    }

    // Cliente tinha lançamento(s) em dúvida (duplicidade ambígua) esperando resposta — checa
    // ANTES de qualquer outro processamento, senão a resposta ("diferente", "duplicado") cairia
    // no fluxo genérico de pergunta livre pro Claude em vez de resolver a pendência. Resolve um
    // item da FILA por resposta — se sobrar mais algum (ex.: vieram vários de um relatório de
    // vendas), já pergunta o próximo em seguida, sem o cliente precisar mandar nada de novo.
    if (!interpretado.tipoMidia && PENDENCIAS_DUPLICIDADE.has(remetente)) {
      const pendencia = PENDENCIAS_DUPLICIDADE.get(remetente);
      const expirou = Date.now() - pendencia.criadoEm > TIMEOUT_PENDENCIA_DUPLICIDADE_MS;

      if (!expirou && pendencia.fila.length > 0) {
        const resposta = interpretarRespostaDuplicidade(interpretado.texto);
        const itemAtual = pendencia.fila[0];

        if (resposta === 'duplicado') {
          pendencia.fila.shift();
          await enviarMensagemWhatsApp(remetente, '👍 Combinado, não registrei de novo.');
        } else if (resposta === 'diferente') {
          pendencia.fila.shift();
          await salvarComprovanteComItens(itemAtual.sheetId, itemAtual.dados);
          await enviarMensagemWhatsApp(remetente, `✅ Entendido, registrei como lançamento novo!\n\n${formatarResumoComprovante(itemAtual.dados)}`);
          await sincronizarConciliacaoNaPlanilha(itemAtual.sheetId).catch((erro) => console.error('Falha ao sincronizar conciliação:', erro.message));
        } else {
          await enviarMensagemWhatsApp(remetente, 'Não entendi — responde só "duplicado" ou "diferente" pra eu saber o que fazer com aquele lançamento. 🙂');
          return;
        }

        if (pendencia.fila.length > 0) {
          await perguntarProximaDuplicidadeAmbigua(remetente, pendencia.fila[0]);
        } else {
          PENDENCIAS_DUPLICIDADE.delete(remetente);
        }

        return;
      }

      PENDENCIAS_DUPLICIDADE.delete(remetente); // expirou (ou fila já vazia) — segue o fluxo normal abaixo, trata como mensagem nova
    }

    const sheetId = cliente.sheetId;

    // Cliente tinha um relatório proativo avisado (template "seu resumo está pronto") esperando
    // ele responder qualquer coisa pra abrir a janela de 24h — checa ANTES do fluxo normal, senão
    // a resposta ("oi", "manda") cairia na pergunta livre pro Claude à toa. Resolve a pendência de
    // qualquer jeito (entregue ou expirada) pra não ficar reaparecendo em mensagens futuras.
    if (!interpretado.tipoMidia && PENDENCIAS_RELATORIO.has(remetente)) {
      const pendenciaRelatorio = PENDENCIAS_RELATORIO.get(remetente);
      const expirouRelatorio = Date.now() - pendenciaRelatorio.criadoEm > TIMEOUT_PENDENCIA_RELATORIO_MS;
      PENDENCIAS_RELATORIO.delete(remetente);

      if (!expirouRelatorio) {
        if (pendenciaRelatorio.tipo === 'previsao') {
          const projecao = await gerarProjecao(sheetId, pendenciaRelatorio.dias);
          await enviarMensagemWhatsApp(remetente, formatarProjecao(projecao));
        } else {
          const [lancamentos, extrato] = await Promise.all([buscarTodosLancamentos(sheetId), buscarExtrato(sheetId)]);
          const resumo = gerarResumo(lancamentos, extrato, { periodo: pendenciaRelatorio.periodo });
          const upsell = pendenciaRelatorio.periodo === 'mes' && !cliente.planoEspecialista ? formatarUpsellEspecialista(resumo) : '';
          await enviarMensagemWhatsApp(remetente, formatarResumo(resumo) + upsell);
        }
        return;
      }
      // expirou (mais de 7 dias sem resposta) — segue o fluxo normal abaixo, trata como mensagem nova
    }

    // Cliente tinha um documento aguardando legenda (chegou sem pista nenhuma — nem legenda, nem
    // nome de arquivo reconhecível — ver DOCUMENTOS_AGUARDANDO_LEGENDA) e mandou um texto agora:
    // trata como a legenda que faltava e processa junto, cancelando o timer do buffer (senão
    // processaria a mídia duas vezes).
    if (!interpretado.tipoMidia && DOCUMENTOS_AGUARDANDO_LEGENDA.has(remetente)) {
      const pendente = DOCUMENTOS_AGUARDANDO_LEGENDA.get(remetente);
      clearTimeout(pendente.timer);
      DOCUMENTOS_AGUARDANDO_LEGENDA.delete(remetente);
      await processarMidiaRecebida(remetente, cliente, sheetId, {
        buffer: pendente.buffer,
        mimeType: pendente.mimeType,
        nomeArquivo: pendente.nomeArquivo,
        legenda: interpretado.texto || '',
      }).catch((erro) => tratarErroProcessamento(remetente, cliente, { tipoMidia: 'document', legenda: interpretado.texto || '', buffer: pendente.buffer, mimeType: pendente.mimeType }, erro));
      return;
    }

    // Cliente tinha uma fatura que falhou na leitura item a item (RespostaCortadaError), esperando
    // escolher "total" (registra só o valor total, rápido e seguro) ou "itens" (tenta detalhar de
    // novo) — ver PENDENCIAS_ESCOLHA_FATURA/tratarErroProcessamento.
    if (!interpretado.tipoMidia && PENDENCIAS_ESCOLHA_FATURA.has(remetente)) {
      const pendenciaEscolha = PENDENCIAS_ESCOLHA_FATURA.get(remetente);
      const expirouEscolha = Date.now() - pendenciaEscolha.criadoEm > TIMEOUT_PENDENCIA_ESCOLHA_FATURA_MS;
      PENDENCIAS_ESCOLHA_FATURA.delete(remetente);

      if (!expirouEscolha) {
        const escolha = (interpretado.texto || '').toLowerCase();

        if (/total/.test(escolha)) {
          await processarFaturaComoResumo(remetente, cliente, sheetId, pendenciaEscolha.buffer, pendenciaEscolha.mimeType, pendenciaEscolha.legendaLower)
            .catch((erro) => tratarErroProcessamento(remetente, cliente, { tipoMidia: 'document', legenda: pendenciaEscolha.legendaLower }, erro));
          return;
        }
        if (/item/.test(escolha)) {
          await processarFaturaItemizada(remetente, cliente, sheetId, pendenciaEscolha.buffer, pendenciaEscolha.mimeType, pendenciaEscolha.legendaLower)
            .catch((erro) => tratarErroProcessamento(remetente, cliente, { tipoMidia: 'document', legenda: pendenciaEscolha.legendaLower }, erro));
          return;
        }

        // Não entendeu a escolha — devolve a pendência (com o buffer) pra não obrigar reenvio.
        PENDENCIAS_ESCOLHA_FATURA.set(remetente, pendenciaEscolha);
        await enviarMensagemWhatsApp(remetente, 'Não entendi — responde "total" ou "itens" pra eu saber como registrar essa fatura. 🙂');
        return;
      }
      // expirou (mais de 15min sem resposta) — segue o fluxo normal abaixo, trata como mensagem nova
    }

    if (interpretado.tipoMidia) {
      const { buffer, mimeType } = await buscarMidiaBase64(interpretado.mediaId);
      bufferMidiaAtual = buffer;
      mimeTypeMidiaAtual = mimeType;
      const legenda = interpretado.legenda || '';
      const pistaArquivo = inferirPistaPorNomeArquivo(interpretado.nomeArquivo);

      if (!legenda.trim() && !pistaArquivo) {
        // BUFFER DE ESPERA (17/08/2026): nem legenda nem nome do arquivo deram pista nenhuma —
        // espera alguns segundos pra ver se o cliente manda um texto explicando logo em seguida
        // (ex.: manda o PDF e só depois escreve "cartão de crédito pago") em vez de já arriscar a
        // leitura genérica. Não precisa segurar resposta nenhuma pro webhook (já foi mandada no
        // topo do handler); o processamento de verdade roda quando o timer disparar OU quando o
        // texto chegar antes (ver checagem de DOCUMENTOS_AGUARDANDO_LEGENDA logo acima).
        const timer = setTimeout(() => {
          DOCUMENTOS_AGUARDANDO_LEGENDA.delete(remetente);
          processarMidiaRecebida(remetente, cliente, sheetId, { buffer, mimeType, nomeArquivo: interpretado.nomeArquivo, legenda: '' })
            .catch((erro) => tratarErroProcessamento(remetente, cliente, { tipoMidia: interpretado.tipoMidia, legenda: '', buffer, mimeType }, erro).catch(() => {}));
        }, JANELA_BUFFER_LEGENDA_MS);

        DOCUMENTOS_AGUARDANDO_LEGENDA.set(remetente, { buffer, mimeType, nomeArquivo: interpretado.nomeArquivo, timer, criadoEm: Date.now() });
        return;
      }

      await processarMidiaRecebida(remetente, cliente, sheetId, { buffer, mimeType, nomeArquivo: interpretado.nomeArquivo, legenda });
    } else {
      const corpoLower = (interpretado.texto || '').toLowerCase();
      const comandoLancamento = interpretarComandoLancamento(interpretado.texto);
      const comandoDespesaFixa = interpretarComandoDespesaFixa(interpretado.texto);
      const comandoContaAReceber = interpretarComandoContaAReceber(interpretado.texto);

      if (comandoLancamento) {
        // Lançamento manual por texto — sem foto, então não passa pela extração de imagem; usa
        // extrairComprovanteDeTexto (mesma categorização dinâmica por nicho, mesmo grupo_dre) e
        // depois entra no MESMO fluxo de checagem de duplicidade/salvamento que a foto usa.
        const dadosExtraidos = await extrairComprovanteDeTexto(comandoLancamento);
        console.log('Lançamento manual extraído do texto:', JSON.stringify(dadosExtraidos, null, 2));
        await processarLancamentoExtraido(remetente, cliente, sheetId, dadosExtraidos);
      } else if (comandoDespesaFixa) {
        const dadosDespesaFixa = await extrairDespesaFixaDeTexto(comandoDespesaFixa);
        console.log('Despesa fixa cadastrada:', JSON.stringify(dadosDespesaFixa, null, 2));

        const despesasFixasExistentes = await buscarDespesasFixas(sheetId);
        if (existeDespesaFixaParecida(dadosDespesaFixa, despesasFixasExistentes)) {
          await enviarMensagemWhatsApp(
            remetente,
            `Você já tem uma recorrência ativa igual a essa cadastrada — não criei outra, pra não lançar em dobro todo mês/semana.\n\n${formatarResumoDespesaFixa(dadosDespesaFixa)}`
          );
        } else {
          await salvarDespesaFixa(sheetId, dadosDespesaFixa);
          await enviarMensagemWhatsApp(remetente, formatarResumoDespesaFixa(dadosDespesaFixa));
        }
      } else if (comandoContaAReceber) {
        const dadosContaAReceber = await extrairContaAReceberDeTexto(comandoContaAReceber);
        console.log('Conta a receber cadastrada:', JSON.stringify(dadosContaAReceber, null, 2));

        const contasAReceberExistentes = await buscarContasAReceber(sheetId);
        if (filtrarContasAReceberNovas([dadosContaAReceber], contasAReceberExistentes).length === 0) {
          await enviarMensagemWhatsApp(
            remetente,
            `Essa conta a receber já está registrada — não dupliquei.\n\n${formatarResumoContaAReceber(dadosContaAReceber)}`
          );
        } else {
          await salvarContasAReceber(sheetId, [dadosContaAReceber]);
          await enviarMensagemWhatsApp(remetente, formatarResumoContaAReceber(dadosContaAReceber));
        }
      } else if (corpoLower.includes('resumo') || corpoLower.includes('fechamento')) {
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

          await avisarAdmin(
            remetente,
            TEMPLATE_AVISO_ADMIN,
            ['Upgrade Especialista ativado', `${cliente.nome} (${remetente}) — ${novoNome}, R$ ${novoValor.toFixed(2)} — agendar reunião de diagnóstico`],
            `🧑‍💼 Upgrade Especialista ativado sozinho via WhatsApp!\n\n👤 ${cliente.nome}\n📱 ${remetente}\n📋 ${novoNome} (R$ ${novoValor.toFixed(2)})\n\nAgendar a reunião de diagnóstico com esse cliente!`
          );
        } else {
          // Sem assinatura Asaas rastreada (ex.: cliente cadastrado manualmente, fora do
          // checkout online) — não dá pra ajustar cobrança sozinho, precisa do Aroldo.
          await enviarMensagemWhatsApp(
            remetente,
            `Show, ${cliente.nome || ''}! Registrei seu interesse na Análise Mensal com Especialista — a equipe vai entrar em contato por aqui pra confirmar o pagamento e agendar.`
          );
          await avisarAdmin(
            remetente,
            TEMPLATE_AVISO_ADMIN,
            ['Pedido de Especialista sem assinatura rastreada', `${cliente.nome} (${remetente}) — combinar cobrança manual`],
            `🧑‍💼 Cliente pediu upgrade do Especialista pelo WhatsApp, mas não achei assinatura Asaas rastreada pra esse número (provável cadastro manual) — precisa combinar a cobrança manual.\n\n👤 ${cliente.nome}\n📱 ${remetente}`
          );
        }
      } else if (corpoLower.includes('previsao') || corpoLower.includes('previsão') || corpoLower.includes('projecao') || corpoLower.includes('projeção')) {
        const dias = corpoLower.includes('semana') ? 7 : 30;
        const projecao = await gerarProjecao(sheetId, dias);
        await enviarMensagemWhatsApp(remetente, formatarProjecao(projecao));
      } else if (/^(ajuda|menu|comandos?|como\s*funciona|instru[çc][õo]es|oi|ol[áa]|e\s*a[íi]|bom\s*dia|boa\s*tarde|boa\s*noite)\b/i.test(corpoLower.trim())) {
        // Pedido do Aroldo, 14/08/2026: o guia de uso (montarMensagemBoasVindas) já existia, mas só
        // disparava com o corpo da mensagem literalmente vazio — na prática inalcançável, então
        // "oi"/"bom dia"/"ajuda" caíam direto na pergunta livre pra IA (o mesmo caminho propenso ao
        // bug da resposta vazia, ver acima). Checado por ÚLTIMO antes da pergunta livre — depois de
        // resumo/previsão/especialista — pra não roubar prioridade de "oi, quero o resumo do mês".
        await enviarMensagemWhatsApp(remetente, montarMensagemBoasVindas(cliente.nome));
      } else if (corpoLower.length > 0) {
        // `itensComprovantes` entra como 4ª fonte de dados — permite responder perguntas
        // específicas de item (ex.: "quanto comprei de queijo esse mês?", "quantas pizzas
        // vendemos hoje?") com precisão, em vez de só a categoria geral do documento inteiro.
        const [lancamentos, extrato, contasAPagar, itensComprovantes] = await Promise.all([
          buscarTodosLancamentos(sheetId),
          buscarExtrato(sheetId),
          buscarContasAPagar(sheetId),
          buscarTodosItens(sheetId),
        ]);
        // pendenciasDuvida: quantos lançamentos estão PENDENTE_DUVIDA agora — o prompt usa isso
        // pra fechar a resposta com a "Nota do Consultor" lembrando da reunião mensal (ver REGRA
        // DA NOTA DO CONSULTOR em prompts.js).
        const pendenciasDuvida = lancamentos.filter((l) => l.status_conciliacao === 'PENDENTE_DUVIDA').length;
        const resposta = await consultarFluxoDeCaixa(interpretado.texto, { lancamentos, extrato, contasAPagar, itensComprovantes, pendenciasDuvida });

        // Bug real encontrado em 14/08/2026 (caso do Aroldo, mensagem sobre recebimento recorrente
        // da Verc Contabilidade): consultarFluxoDeCaixa pode voltar com texto vazio quando a
        // mensagem não é uma PERGUNTA de verdade (é um comando que não bateu com nenhum gatilho
        // determinístico acima — ex.: cadastro de recorrente sem escrever "recorrente:" no início).
        // Mandar body vazio pro WhatsApp Cloud API derruba com 400 ("text.body is required") e
        // estoura pro catch genérico. Em vez de deixar quebrar, cai num fallback que já orienta o
        // comando certo pra cadastro recorrente (entrada OU saída, sem precisar de extrato/boleto).
        await enviarMensagemWhatsApp(
          remetente,
          resposta && resposta.trim()
            ? resposta
            : 'Não consegui entender isso como uma pergunta sobre o seu caixa. Se é pra CADASTRAR um lançamento recorrente (entrada ou saída que se repete todo mês ou toda semana, sem precisar de boleto nem extrato — ex.: um cliente que paga sempre no mesmo dia), escreve assim: "recorrente: recebo R$500 da Empresa X todo dia 10". Se é outra coisa, me explica de outro jeito que eu tento de novo.'
        );
      } else {
        await enviarMensagemWhatsApp(remetente, montarMensagemBoasVindas(cliente.nome));
      }
    }
  } catch (error) {
    // Lógica de aviso extraída pra tratarErroProcessamento (17/08/2026) — reaproveitada também
    // pelos caminhos que já respondem 200 antes de terminar de processar (buffer de legenda,
    // escolha "total"/"itens"), que não passam mais por este catch.
    await tratarErroProcessamento(remetente, cliente, { tipoMidia: interpretado.tipoMidia, legenda: interpretado.legenda, buffer: bufferMidiaAtual, mimeType: mimeTypeMidiaAtual }, error);
  }
  // Sem res.sendStatus aqui — a resposta pra Meta já foi enviada no topo do handler (ver comentário
  // no início da função). Todo o resto acima é fire-and-forget do ponto de vista do webhook.
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

    // Não manda o resumo completo direto — é o bot falando primeiro, sem o cliente ter mandado
    // nada, e o conteúdo (lista de categorias de tamanho variável) não cabe num template rígido.
    // Manda só o "avisador" (template) e guarda a pendência; o resumo de verdade sai em texto
    // livre assim que o cliente responder qualquer coisa (ver bloco PENDENCIAS_RELATORIO no webhook).
    const rotulo = periodo === 'semana' ? 'resumo da semana' : periodo === 'dia' ? 'resumo do dia' : 'resumo do mês';
    const resultados = [];
    for (const cliente of alvo) {
      PENDENCIAS_RELATORIO.set(cliente.numeroWhatsapp, { tipo: 'resumo', periodo, criadoEm: Date.now() });
      await enviarTemplateWhatsApp(cliente.numeroWhatsapp, TEMPLATE_RELATORIO_PRONTO.nome, TEMPLATE_RELATORIO_PRONTO.idioma, [rotulo])
        .catch((erro) => console.error(`Falha ao avisar ${cliente.numeroWhatsapp} sobre relatório pronto:`, erro.message));
      resultados.push(cliente.numeroWhatsapp);
    }

    res.json({ ok: true, periodo, avisados: resultados });
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

    // Mesma lógica do relatório acima: só o "avisador" via template, a previsão de verdade sai
    // em texto livre quando o cliente responder (lista de contas a pagar também é variável demais
    // pra caber num template).
    const rotulo = `previsão de ${dias} dias`;
    const resultados = [];
    for (const cliente of alvo) {
      PENDENCIAS_RELATORIO.set(cliente.numeroWhatsapp, { tipo: 'previsao', dias, criadoEm: Date.now() });
      await enviarTemplateWhatsApp(cliente.numeroWhatsapp, TEMPLATE_RELATORIO_PRONTO.nome, TEMPLATE_RELATORIO_PRONTO.idioma, [rotulo])
        .catch((erro) => console.error(`Falha ao avisar ${cliente.numeroWhatsapp} sobre previsão pronta:`, erro.message));
      resultados.push(cliente.numeroWhatsapp);
    }

    res.json({ ok: true, dias, avisados: resultados });
  } catch (error) {
    console.error('Erro ao enviar previsão proativa:', error.message);
    res.status(500).json({ erro: error.message });
  }
});

// Endpoint pro cron DIÁRIO (diferente dos dois acima, semanal/mensal) — chamado todo dia pelo
// GitHub Actions, lança automaticamente toda despesa/receita fixa (ver comando "recorrente:")
// cujo Dia_Do_Mes bate com hoje e que ainda não foi lançada neste mês (Ultimo_Lancamento_Mes).
// Não manda template de aviso pro cliente — é opcional/best-effort (só chega se já houver sessão
// aberta), porque isso sozinho não justifica pedir aprovação de mais um template só pra isso; o
// essencial (o lançamento em si, refletido no resumo/DRE) já acontece de qualquer forma.
app.all('/tarefas/despesas-fixas', async (req, res) => {
  if (!RELATORIO_SECRET || req.query.chave !== RELATORIO_SECRET) {
    return res.status(403).json({ erro: 'Não autorizado' });
  }

  const hoje = new Date();
  const diaHoje = hoje.getDate();
  const diaSemanaHoje = hoje.getDay(); // 0=domingo...6=sábado, igual ao "dia_da_semana" do prompt
  const hojeISO = hoje.toISOString().slice(0, 10); // "AAAA-MM-DD"

  try {
    const clientes = await listarClientesAtivos({ ignorarCache: true });
    const alvo = req.query.numero
      ? clientes.filter((cliente) => cliente.numeroWhatsapp === req.query.numero)
      : clientes;

    const lancados = [];

    for (const cliente of alvo) {
      const despesasFixas = await buscarDespesasFixas(cliente.sheetId);
      // Devida se: está ativa, ainda não foi lançada HOJE (mesma checagem serve pra mensal e
      // semanal — cada uma só bate no dia certo dela mesmo, uma vez por ciclo), e o dia bate —
      // seja por Dia_Do_Mes (mensal) ou Dia_Da_Semana (semanal, ex.: "toda segunda-feira").
      const devidas = despesasFixas.filter((d) => {
        if (!d.ativo || d.ultima_data_lancamento === hojeISO) return false;
        if (d.dia_do_mes && d.dia_do_mes === diaHoje) return true;
        if (d.dia_da_semana !== null && d.dia_da_semana === diaSemanaHoje) return true;
        return false;
      });

      for (const despesa of devidas) {
        const dados = {
          data: hojeISO,
          hora: null,
          valor: despesa.valor,
          tipo_movimentacao: despesa.tipo_movimentacao,
          descricao: despesa.descricao,
          estabelecimento_ou_pessoa: despesa.estabelecimento_ou_pessoa,
          categoria: despesa.categoria,
          subcategoria: despesa.subcategoria,
          grupo_dre: despesa.grupo_dre,
          observacoes: 'Lançado automaticamente (despesa/receita fixa recorrente).',
        };

        await salvarComprovanteComItens(cliente.sheetId, dados);
        await marcarDespesaFixaLancada(cliente.sheetId, despesa.linha, hojeISO);

        await enviarMensagemWhatsApp(
          cliente.numeroWhatsapp,
          `⚙️ Lancei automaticamente sua despesa fixa: ${formatarResumoComprovante(dados)}`
        ).catch(() => {});

        lancados.push({ cliente: cliente.numeroWhatsapp, descricao: despesa.descricao, valor: despesa.valor });
      }

      if (devidas.length > 0) {
        await sincronizarConciliacaoNaPlanilha(cliente.sheetId).catch((erro) => console.error('Falha ao sincronizar conciliação (despesas fixas):', erro.message));
      }
    }

    res.json({ ok: true, dia: diaHoje, lancados });
  } catch (error) {
    console.error('Erro ao lançar despesas fixas:', error.message);
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

  {
    const linhaVoucher = voucherAplicado ? `\n🎟️ Voucher: ${voucherAplicado}` : '';
    const linhaEspecialista = comEspecialista ? '\n🧑‍💼 Com Análise Mensal com Especialista' : '';
    const linhaAtivacao = numeroAtivacao !== numeroFormatado ? `\n📲 Ativação: ${numeroAtivacao}` : '';
    const linhaAtivacao2 = numeroAtivacao2 ? `\n📲 2º número de ativação: ${numeroAtivacao2}` : '';

    const detalheUmaLinha = `${nome} (${numeroFormatado}) — ${nomePlanoCompleto}, R$ ${valorFinal.toFixed(2)}`
      + (voucherAplicado ? ` | voucher ${voucherAplicado}` : '')
      + (comEspecialista ? ' | com Especialista' : '')
      + (numeroAtivacao !== numeroFormatado ? ` | ativação ${numeroAtivacao}` : '');

    // numeroFormatado como "remetente" pro avisarAdmin — se for o próprio Aroldo testando o
    // checkout com o número de admin, não se autonotifica (mesma regra dos demais avisos).
    await avisarAdmin(
      numeroFormatado,
      TEMPLATE_AVISO_ADMIN,
      ['Novo checkout iniciado (aguardando pagamento)', detalheUmaLinha],
      `🛒 Novo checkout iniciado no site do Interali Pocket (aguardando pagamento)\n\n👤 ${nome}\n📱 ${numeroFormatado}\n📋 Plano: ${nomePlanoCompleto} (R$ ${valorFinal.toFixed(2)})${linhaVoucher}${linhaEspecialista}${linhaAtivacao}${linhaAtivacao2}\n\nVocê será avisado de novo automaticamente assim que o pagamento cair.`
    );
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
      // Esse é o PRIMEIRO contato do bot com esse número (cliente pagou pelo site, nunca mandou
      // mensagem antes) — fora da janela de 24h de atendimento, a Cloud API rejeita texto livre
      // nesse caso. Só um template pré-aprovado consegue "abrir" a conversa. Ver TEMPLATE_BOAS_VINDAS.
      await enviarTemplateWhatsApp(numero, TEMPLATE_BOAS_VINDAS.nome, TEMPLATE_BOAS_VINDAS.idioma, [assinatura.nome || 'cliente'])
        .catch((erro) => console.error('Falha ao mandar template de boas-vindas pro cliente novo:', erro.message));

      // Detalhe do plano/upsell Especialista — best-effort, texto livre. Só chega de fato se já
      // existir uma janela de 24h aberta com esse número (ex.: cliente mandou mensagem antes de
      // pagar); caso contrário falha silenciosamente, sem prejuízo — o essencial (ativação + como
      // usar o bot) já foi garantido pelo template acima.
      await enviarMensagemWhatsApp(
        numero,
        `🎉 Pagamento confirmado! Seu plano: ${assinatura.plano}.${linhaReuniao}`
      ).catch(() => {});
    }

    {
      // Pagamento confirmado é o evento mais importante do sistema — avisarAdmin ainda garante a
      // entrega (cai pro template se o texto falhar, ver função), só inverteu a ORDEM padrão
      // (texto primeiro) pra não pagar template à toa quando o admin já está com sessão aberta.
      // numeroAtivacao como "remetente": se for o próprio Aroldo testando com o número de admin,
      // ele já viu a confirmação de pagamento acima — não duplica.
      const avisoEspecialista = assinatura.planoEspecialista ? '\n🧑‍💼 Com Especialista — agendar a reunião de diagnóstico com esse cliente!' : '';
      const linhaSegundoNumero = assinatura.whatsappAtivacao2 ? `\n📲 2º número ativado: ${assinatura.whatsappAtivacao2}` : '';

      await avisarAdmin(
        numeroAtivacao,
        TEMPLATE_ADMIN_PAGAMENTO_CONFIRMADO,
        [assinatura.nome || 'cliente', numeroAtivacao, assinatura.plano],
        `✅ Pagamento confirmado e cliente ativado automaticamente!\n\n👤 ${assinatura.nome}\n📱 ${numeroAtivacao}${linhaSegundoNumero}\n📋 ${assinatura.plano}${avisoEspecialista}\n📄 Planilha: https://docs.google.com/spreadsheets/d/${sheetIdNovo}/edit`
      );
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
