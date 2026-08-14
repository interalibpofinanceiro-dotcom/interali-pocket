require('dotenv').config();
const { google } = require('googleapis');

// Com FORMATTED_VALUE (o modo de leitura que usamos, ver buscarLinhas), o Sheets devolve número
// no padrão BR — "199,99", ou "1.234,56" pra valores maiores (ponto como milhar, vírgula como
// decimal). Number("199,99") vira NaN em JS puro, e todo `Number(x) || 0` do código virava
// silenciosamente 0. Bug real encontrado em 07/08/2026 no primeiro teste ponta a ponta: resumo,
// conciliação, previsão e DRE saíam todos zerados, mesmo com o valor certo gravado na planilha —
// o problema era só na leitura de volta. Esta função troca todo Number(linha[N]) por essa aqui.
function numeroBR(valor) {
  if (typeof valor === 'number') return valor;
  if (valor === null || valor === undefined || valor === '') return 0;
  const limpo = String(valor).trim().replace(/\./g, '').replace(',', '.');
  const numero = Number(limpo);
  return Number.isNaN(numero) ? 0 : numero;
}

const ABA_LANCAMENTOS = 'Lancamentos';
// Grupo_DRE, Conta_Bancaria e Status_Conciliacao foram ADICIONADAS no fim em 07/08/2026 (não
// inseridas no meio) de propósito — clientes que já tinham linhas gravadas com o cabeçalho antigo
// de 12 colunas continuam lendo certo, essas 3 colunas novas é que ficam em branco pra eles até o
// próximo lançamento/sincronização.
const CABECALHO_LANCAMENTOS = [
  'Data', 'Hora', 'Valor', 'Tipo', 'Descricao', 'Estabelecimento_Pessoa',
  'Documento', 'Forma_Pagamento', 'Categoria', 'Subcategoria', 'Observacoes', 'Registrado_Em',
  'Grupo_DRE', 'Conta_Bancaria', 'Status_Conciliacao',
];
const COLUNA_STATUS_CONCILIACAO = 'O'; // precisa bater com a posição de Status_Conciliacao acima (15ª coluna)

const ABA_EXTRATO = 'Extrato';
const CABECALHO_EXTRATO = ['Data', 'Descricao', 'Valor', 'Tipo', 'Saldo_Apos', 'Registrado_Em'];

const ABA_CONTAS_A_PAGAR = 'ContasAPagar';
// Grupo_DRE também adicionada no fim aqui, mesmo motivo do Lancamentos acima.
const CABECALHO_CONTAS_A_PAGAR = [
  'Vencimento', 'Valor', 'Cartao', 'Beneficiario', 'Descricao', 'Categoria', 'Parcela_Atual', 'Parcela_Total', 'Registrado_Em',
  'Grupo_DRE',
];

// Itens individuais de cada comprovante/nota (ex.: "Queijo Muçarela 5kg", "Azeitona Verde 2kg") —
// o Claude já extrai isso (campo `itens[]`, ver prompts.js) mas até 13/08/2026 era descartado na
// hora de salvar, só ficava a categoria geral do documento inteiro. Guardado numa aba separada
// (não dentro de Lancamentos, que é uma linha por documento) pra permitir responder perguntas tipo
// "quanto comprei de queijo esse mês?" com precisão. `Lancamento_Linha` liga cada item de volta
// pro lançamento pai (linha real na aba Lancamentos), só pra rastreabilidade/debug.
const ABA_ITENS = 'ItensComprovante';
const CABECALHO_ITENS = [
  'Data', 'Lancamento_Linha', 'Estabelecimento_Pessoa', 'Descricao', 'Quantidade', 'Valor_Unitario', 'Valor_Total', 'Registrado_Em',
];

// Despesas/receitas fixas recorrentes (ex.: "todo dia 10 pago marketing R$1.000") — cadastradas
// uma vez pelo comando "recorrente:" (ver server.js) e lançadas automaticamente todo mês pelo
// endpoint /tarefas/despesas-fixas (chamado pelo cron diário do GitHub Actions). `Ultimo_Lancamento_Mes`
// guarda o "AAAA-MM" do último mês em que já foi lançada, pra não lançar duas vezes no mesmo mês.
const ABA_DESPESAS_FIXAS = 'DespesasFixas';
const CABECALHO_DESPESAS_FIXAS = [
  'Descricao', 'Valor', 'Dia_Do_Mes', 'Tipo', 'Estabelecimento_Pessoa', 'Categoria', 'Subcategoria', 'Grupo_DRE',
  'Ativo', 'Registrado_Em', 'Ultimo_Lancamento_Mes',
];

// Extrai o número da linha real a partir do "updatedRange" que a API do Sheets devolve depois de
// um append (ex.: "Lancamentos!A5:O5" -> 5) — usado pra ligar os itens de volta pro lançamento pai.
function extrairNumeroLinha(updatedRange) {
  const match = (updatedRange || '').match(/![A-Z]+(\d+):/);
  return match ? Number(match[1]) : null;
}

function getAuthClient() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuthClient() });
}

async function garantirAbaComCabecalho(sheets, spreadsheetId, nomeAba, cabecalho) {
  const planilha = await sheets.spreadsheets.get({ spreadsheetId });
  const abaExiste = planilha.data.sheets.some((aba) => aba.properties.title === nomeAba);

  if (!abaExiste) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: nomeAba } } }],
      },
    });
  }

  const ultimaColuna = String.fromCharCode('A'.charCodeAt(0) + cabecalho.length - 1);
  const resposta = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${nomeAba}!A1:${ultimaColuna}1`,
  });

  const cabecalhoAtual = (resposta.data.values && resposta.data.values[0]) || [];

  // Reescreve o cabeçalho quando a aba é nova (cabeçalho vazio) OU quando o cabeçalho já
  // existente é mais curto que o esperado — isso acontece pra clientes cadastrados antes de uma
  // coluna nova ser adicionada (ex.: Grupo_DRE/Status_Conciliacao, 07/08/2026). É seguro porque
  // `cabecalho` só ACRESCENTA colunas no fim, nunca reordena ou apaga as que já existem.
  if (cabecalhoAtual.length < cabecalho.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${nomeAba}!A1:${ultimaColuna}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [cabecalho] },
    });
  }
}

async function buscarLinhas(spreadsheetId, nomeAba, range) {
  const sheets = getSheetsClient();

  try {
    // Fica com FORMATTED_VALUE (padrão) de propósito — UNFORMATTED_VALUE resolveria o problema de
    // número (ver numeroBR abaixo) mas quebraria as colunas de DATA, que voltariam como número de
    // série do Sheets (ex.: 46238) em vez de "2026-08-03" — pior o remédio que a doença.
    const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${nomeAba}!${range}` });
    return resposta.data.values || [];
  } catch (error) {
    if (error.code === 400 || error.code === 404) {
      return [];
    }
    throw error;
  }
}

// Devolve o número da linha real onde o lançamento caiu (ver extrairNumeroLinha) — quem chama usa
// isso pra ligar os itens do documento (salvarItens) de volta a este lançamento específico.
async function salvarComprovante(spreadsheetId, dados) {
  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_LANCAMENTOS, CABECALHO_LANCAMENTOS);

  const linha = [
    dados.data || '',
    dados.hora || '',
    dados.valor || 0,
    dados.tipo_movimentacao || '',
    dados.descricao || '',
    dados.estabelecimento_ou_pessoa || '',
    dados.documento_identificacao || '',
    dados.forma_pagamento || '',
    dados.categoria || '',
    dados.subcategoria || '',
    dados.observacoes || '',
    new Date().toISOString(),
    dados.grupo_dre || '',
    dados.conta_bancaria || '',
    'Pendente', // status inicial — atualizado pra "Conciliado..." quando bater com o extrato (ver sincronizarConciliacao em reconciliacao.js)
  ];

  const resposta = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_LANCAMENTOS}!A:O`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [linha] },
  });

  return extrairNumeroLinha(resposta.data.updates && resposta.data.updates.updatedRange);
}

// Salva os itens individuais de um documento (campo `itens[]` da extração — ver prompts.js) numa
// aba própria, ligados ao lançamento pai por `lancamentoLinha`. Automático: não depende de
// configuração nenhuma por cliente/nicho, é só persistir o que o Claude já identifica sozinho.
async function salvarItens(spreadsheetId, itens, { data, estabelecimento, lancamentoLinha }) {
  if (!itens || itens.length === 0) {
    return;
  }

  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_ITENS, CABECALHO_ITENS);

  const registradoEm = new Date().toISOString();
  const linhas = itens.map((item) => [
    data || '',
    lancamentoLinha ?? '',
    estabelecimento || '',
    item.descricao || '',
    item.quantidade ?? '',
    item.valor_unitario ?? '',
    item.valor_total ?? '',
    registradoEm,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_ITENS}!A:H`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: linhas },
  });
}

async function buscarTodosItens(spreadsheetId) {
  const linhas = await buscarLinhas(spreadsheetId, ABA_ITENS, 'A2:H');

  return linhas.map((linha) => ({
    data: linha[0] || '',
    lancamento_linha: linha[1] || '',
    estabelecimento_ou_pessoa: linha[2] || '',
    descricao: linha[3] || '',
    quantidade: linha[4] ? numeroBR(linha[4]) : null,
    valor_unitario: linha[5] ? numeroBR(linha[5]) : null,
    valor_total: linha[6] ? numeroBR(linha[6]) : null,
  }));
}

async function salvarDespesaFixa(spreadsheetId, dados) {
  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_DESPESAS_FIXAS, CABECALHO_DESPESAS_FIXAS);

  const linha = [
    dados.descricao || '',
    dados.valor || 0,
    dados.dia_do_mes || '',
    dados.tipo_movimentacao || 'saida',
    dados.estabelecimento_ou_pessoa || '',
    dados.categoria || '',
    dados.subcategoria || '',
    dados.grupo_dre || '',
    'Sim', // Ativo — cadastro novo sempre começa ativo
    new Date().toISOString(),
    '', // Ultimo_Lancamento_Mes — vazio até o primeiro auto-lançamento
  ];

  const resposta = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_DESPESAS_FIXAS}!A:K`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [linha] },
  });

  return extrairNumeroLinha(resposta.data.updates && resposta.data.updates.updatedRange);
}

async function buscarDespesasFixas(spreadsheetId) {
  const linhas = await buscarLinhas(spreadsheetId, ABA_DESPESAS_FIXAS, 'A2:K');

  return linhas.map((linha, indice) => ({
    linha: indice + 2,
    descricao: linha[0] || '',
    valor: numeroBR(linha[1]),
    dia_do_mes: linha[2] ? Number(linha[2]) : null,
    tipo_movimentacao: linha[3] || 'saida',
    estabelecimento_ou_pessoa: linha[4] || '',
    categoria: linha[5] || '',
    subcategoria: linha[6] || '',
    grupo_dre: linha[7] || '',
    ativo: (linha[8] || '').toLowerCase() === 'sim',
    ultimo_lancamento_mes: linha[10] || '',
  }));
}

// Marca que a despesa fixa já foi lançada neste mês (AAAA-MM), pra /tarefas/despesas-fixas não
// lançar de novo se rodar mais de uma vez no mesmo mês.
async function marcarDespesaFixaLancada(spreadsheetId, linha, mesAno) {
  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ABA_DESPESAS_FIXAS}!K${linha}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[mesAno]] },
  });
}

async function buscarTodosLancamentos(spreadsheetId) {
  const linhas = await buscarLinhas(spreadsheetId, ABA_LANCAMENTOS, 'A2:O');

  return linhas.map((linha, indice) => ({
    linha: indice + 2, // número real da linha na planilha (cabeçalho ocupa a 1) — usado pra reescrever só o Status_Conciliacao depois, sem tocar no resto
    data: linha[0] || '',
    hora: linha[1] || '',
    valor: numeroBR(linha[2]),
    tipo_movimentacao: linha[3] || '',
    descricao: linha[4] || '',
    estabelecimento_ou_pessoa: linha[5] || '',
    documento_identificacao: linha[6] || '',
    forma_pagamento: linha[7] || '',
    categoria: linha[8] || '',
    subcategoria: linha[9] || '',
    observacoes: linha[10] || '',
    grupo_dre: linha[12] || '',
    conta_bancaria: linha[13] || '',
    status_conciliacao: linha[14] || '',
  }));
}

// Atualiza só a coluna Status_Conciliacao das linhas informadas, sem reescrever o resto do
// lançamento — chamada depois de rodar sincronizarConciliacao() (reconciliacao.js). Um único
// batchUpdate mesmo quando várias linhas mudam, pra não gastar uma chamada de API por linha.
async function atualizarStatusConciliacaoEmLote(spreadsheetId, atualizacoes) {
  if (!atualizacoes || atualizacoes.length === 0) return;

  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: atualizacoes.map(({ linha, status }) => ({
        range: `${ABA_LANCAMENTOS}!${COLUNA_STATUS_CONCILIACAO}${linha}`,
        values: [[status]],
      })),
    },
  });
}

async function salvarExtrato(spreadsheetId, transacoes) {
  if (!transacoes || transacoes.length === 0) {
    return;
  }

  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_EXTRATO, CABECALHO_EXTRATO);

  const registradoEm = new Date().toISOString();
  const linhas = transacoes.map((transacao) => [
    transacao.data || '',
    transacao.descricao || '',
    transacao.valor || 0,
    transacao.tipo || '',
    transacao.saldo_apos ?? '',
    registradoEm,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_EXTRATO}!A:F`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: linhas },
  });
}

async function buscarExtrato(spreadsheetId) {
  const linhas = await buscarLinhas(spreadsheetId, ABA_EXTRATO, 'A2:F');

  return linhas.map((linha) => ({
    data: linha[0] || '',
    descricao: linha[1] || '',
    valor: numeroBR(linha[2]),
    tipo: linha[3] || '',
    saldo_apos: linha[4] ? numeroBR(linha[4]) : null,
  }));
}

async function salvarContasAPagar(spreadsheetId, contas) {
  if (!contas || contas.length === 0) {
    return;
  }

  const sheets = getSheetsClient();

  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_CONTAS_A_PAGAR, CABECALHO_CONTAS_A_PAGAR);

  const registradoEm = new Date().toISOString();
  const linhas = contas.map((conta) => [
    conta.vencimento || '',
    conta.valor || 0,
    conta.cartao || '',
    conta.beneficiario || '',
    conta.descricao || '',
    conta.categoria || '',
    conta.parcela_atual ?? '',
    conta.parcela_total ?? '',
    registradoEm,
    conta.grupo_dre || '',
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_CONTAS_A_PAGAR}!A:J`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: linhas },
  });
}

async function buscarContasAPagar(spreadsheetId) {
  const linhas = await buscarLinhas(spreadsheetId, ABA_CONTAS_A_PAGAR, 'A2:J');

  return linhas.map((linha) => ({
    vencimento: linha[0] || '',
    valor: numeroBR(linha[1]),
    cartao: linha[2] || '',
    beneficiario: linha[3] || '',
    descricao: linha[4] || '',
    categoria: linha[5] || '',
    parcela_atual: linha[6] ? numeroBR(linha[6]) : null,
    parcela_total: linha[7] ? numeroBR(linha[7]) : null,
    grupo_dre: linha[9] || '',
  }));
}

module.exports = {
  salvarComprovante,
  buscarTodosLancamentos,
  atualizarStatusConciliacaoEmLote,
  salvarExtrato,
  buscarExtrato,
  salvarContasAPagar,
  buscarContasAPagar,
  salvarItens,
  buscarTodosItens,
  salvarDespesaFixa,
  buscarDespesasFixas,
  marcarDespesaFixaLancada,
};
