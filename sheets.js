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
  // 03/09/2026: depois da formatação de moeda (sheets-styler.js) o FORMATTED_VALUE volta como
  // "R$ 1.234,56" ou "-R$ 50,00" — tira TUDO que não é dígito/ponto/vírgula/sinal antes de parsear
  // (antes só tirava ".", e "R$ 89,00" virava NaN -> 0, zerando DRE/fechamento).
  let s = String(valor).trim().replace(/[^\d.,-]/g, '');
  if (!s || s === '-' || s === '.' || s === ',') return 0;
  s = s.replace(/\./g, '').replace(',', '.'); // ponto = milhar BR, vírgula = decimal
  const numero = Number(s);
  return Number.isNaN(numero) ? 0 : numero;
}

// ---------------------------------------------------------------------------------------------
// ABAS MENSAIS POR COMPETÊNCIA (02/09/2026, pedido do Aroldo)
// ---------------------------------------------------------------------------------------------
// Antes: uma aba única por tipo (`Lancamentos`, `Extrato`, ...), append-only, pra sempre.
// Agora: uma aba por MÊS DE COMPETÊNCIA, ex.: `2026-09 · Lançamentos`, `2026-08 · Extrato`.
// Competência = mês da DATA DO COMPROVANTE, sempre (nunca a data de envio) — cliente que manda o
// comprovante de agosto só em setembro continua caindo em agosto.
// A aba do mês mais novo fica na EXTREMA ESQUERDA (índice 0), meses antigos à direita.
//
// Abas de config/controle NÃO são mensais e continuam únicas: `DespesasFixas`, `Fechamento`
// (resumo por competência, ver fechamento.js), `Matriz` (comercio-matriz.js), e na planilha
// mestre `Clientes`, `Cache_CNPJ`, `Fechamentos`.
//
// LEGADO: as abas únicas antigas (`Lancamentos` etc., sem ` · `) continuam sendo LIDAS junto com
// as mensais até `scripts/migrar-competencia.js` mover as linhas e removê-las. Assim o deploy não
// precisa ser atômico com a migração — nada some no intervalo.

const SUFIXO = {
  LANCAMENTOS: 'Lançamentos',
  EXTRATO: 'Extrato',
  CONTAS_A_PAGAR: 'Contas a Pagar',
  CONTAS_A_RECEBER: 'Contas a Receber',
  ITENS: 'Itens',
};
const ORDEM_SUFIXO = [SUFIXO.LANCAMENTOS, SUFIXO.EXTRATO, SUFIXO.CONTAS_A_PAGAR, SUFIXO.CONTAS_A_RECEBER, SUFIXO.ITENS];
const RE_ABA_MENSAL = /^(\d{4}-\d{2}) · (.+)$/;

// Nome da aba legada (única, pré-partição) de cada tipo — lida como fallback até a migração.
const ABA_LEGADO = {
  [SUFIXO.LANCAMENTOS]: 'Lancamentos',
  [SUFIXO.EXTRATO]: 'Extrato',
  [SUFIXO.CONTAS_A_PAGAR]: 'ContasAPagar',
  [SUFIXO.CONTAS_A_RECEBER]: 'ContasAReceber',
  [SUFIXO.ITENS]: 'ItensComprovante',
};

// Compat: outros módulos ainda importam ABA_LANCAMENTOS / ABA_CONTAS_A_PAGAR como identificador
// simbólico (ex.: memória de correção em server.js). Mantidos como o SUFIXO — quem grava/apaga
// agora passa também a competência/aba real.
const ABA_LANCAMENTOS = SUFIXO.LANCAMENTOS;
const ABA_CONTAS_A_PAGAR = SUFIXO.CONTAS_A_PAGAR;

// Grupo_DRE, Conta_Bancaria e Status_Conciliacao foram ADICIONADAS no fim em 07/08/2026,
// Observacao_Conciliacao em 14/08/2026, e Competencia + colunas de CNAE em 02/09/2026 — sempre no
// FIM, nunca no meio, pra não quebrar índice de coluna já em uso (ex.: COLUNA_STATUS_CONCILIACAO).
const CABECALHO_LANCAMENTOS = [
  'Data', 'Hora', 'Valor', 'Tipo', 'Descricao', 'Estabelecimento_Pessoa',
  'Documento', 'Forma_Pagamento', 'Categoria', 'Subcategoria', 'Observacoes', 'Registrado_Em',
  'Grupo_DRE', 'Conta_Bancaria', 'Status_Conciliacao', 'Observacao_Conciliacao',
  'Competencia', 'CNPJ_Fornecedor', 'Razao_Social_Fornecedor', 'CNAE_Codigo', 'CNAE_Descricao', 'Fonte_Categoria',
];
const COLUNA_STATUS_CONCILIACAO = 'O'; // 15ª coluna — Status_Conciliacao
const COLUNA_OBSERVACAO_CONCILIACAO = 'P'; // 16ª coluna — detalhe do Status_Conciliacao
const RANGE_LANCAMENTOS = 'A:V';

// 'Conta_Bancaria' aditiva no fim (09/09/2026) — nome do banco/conta lido do cabeçalho do extrato
// (ver PROMPT_EXTRATO/banco_conta em prompts.js), pra cliente com mais de uma conta saber de qual
// extrato cada transação veio. Abas mensais já existentes migram sozinhas (garantirAbaMensal).
const CABECALHO_EXTRATO = ['Data', 'Descricao', 'Valor', 'Tipo', 'Saldo_Apos', 'Registrado_Em', 'Competencia', 'Conta_Bancaria'];
const RANGE_EXTRATO = 'A:H';

const CABECALHO_CONTAS_A_PAGAR = [
  'Vencimento', 'Valor', 'Cartao', 'Beneficiario', 'Descricao', 'Categoria', 'Parcela_Atual', 'Parcela_Total', 'Registrado_Em',
  'Grupo_DRE', 'Competencia', 'Subcategoria', 'CNPJ_Fornecedor', 'CNAE_Codigo', 'Fonte_Categoria',
];
const RANGE_CONTAS_A_PAGAR = 'A:O';

const CABECALHO_CONTAS_A_RECEBER = [
  'Vencimento', 'Valor', 'Cliente_Devedor', 'Descricao', 'Categoria', 'Documento', 'Parcela_Atual', 'Parcela_Total', 'Registrado_Em',
  'Grupo_DRE', 'Competencia',
];
const RANGE_CONTAS_A_RECEBER = 'A:K';

const CABECALHO_ITENS = [
  'Data', 'Lancamento_Linha', 'Estabelecimento_Pessoa', 'Descricao', 'Quantidade', 'Valor_Unitario', 'Valor_Total', 'Registrado_Em',
  'Competencia', 'Lancamento_Aba',
];
const RANGE_ITENS = 'A:J';

// Despesas/receitas fixas recorrentes — NÃO é aba mensal (é config, uma regra que se repete).
const ABA_DESPESAS_FIXAS = 'DespesasFixas';
const CABECALHO_DESPESAS_FIXAS = [
  'Descricao', 'Valor', 'Dia_Do_Mes', 'Tipo', 'Estabelecimento_Pessoa', 'Categoria', 'Subcategoria', 'Grupo_DRE',
  'Ativo', 'Registrado_Em', 'Ultima_Data_Lancamento', 'Dia_Da_Semana',
];

// Orçamento por competência (09/09/2026, item DRE Orçado vs Realizado) — NÃO é aba mensal, é config:
// cada linha é 1 (Competencia, Grupo_DRE), upsert (a mesma dupla nunca se repete). Comando "orçamento:
// marketing 1000 esse mês" (ver prompts.js/server.js) grava uma linha por vez.
const ABA_ORCAMENTO = 'Orcamento';
const CABECALHO_ORCAMENTO = ['Competencia', 'Grupo_DRE', 'Valor_Orcado', 'Registrado_Em'];

// Datas: guardadas na PLANILHA como data de verdade que o Sheets exibe "01/09/2026" (padrão BR,
// 02/09/2026, pedido do Aroldo), mas o CÓDIGO trabalha sempre com ISO "2026-09-01" (ordenação,
// comparação, competência). paraDataBR() na escrita, normalizarDataISO() na leitura.
function normalizarDataISO(valor) {
  const s = String(valor == null ? '' : valor).trim();
  if (!s) return '';
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  // Número de série do Sheets (dias desde 1899-12-30) — caso o cliente formate a coluna e o
  // FORMATTED_VALUE volte numérico.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return s;
}

function paraDataBR(valor) {
  const iso = normalizarDataISO(valor);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(valor || '');
}

// "2026-08-14" ou "14/08/2026" -> "2026-08". Sem data -> mês corrente.
function competenciaDe(data) {
  const m = normalizarDataISO(data).match(/^(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  return new Date().toISOString().slice(0, 7);
}

function competenciaDaAba(titulo) {
  const m = String(titulo || '').match(RE_ABA_MENSAL);
  return m ? m[1] : null;
}

function colunaLetra(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const resto = (x - 1) % 26;
    s = String.fromCharCode(65 + resto) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

// Extrai o número da linha real a partir do "updatedRange" que a API do Sheets devolve depois de
// um append (ex.: "'2026-09 · Lançamentos'!A5:V5" -> 5) — casa a partir do "!", então funciona
// mesmo com o nome da aba entre aspas e com espaços.
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

// Reordena as abas: mensais primeiro (mês desc = mais novo à esquerda, depois ordem fixa de tipo),
// abas de controle depois. Chamada só quando uma aba de mês novo é criada (raro).
async function reordenarAbas(sheets, spreadsheetId) {
  const planilha = await sheets.spreadsheets.get({ spreadsheetId });
  const props = planilha.data.sheets.map((s) => s.properties);

  const mensais = [];
  const controle = [];
  for (const p of props) {
    const m = p.title.match(RE_ABA_MENSAL);
    if (m) mensais.push({ ...p, competencia: m[1], sufixo: m[2] });
    else controle.push(p);
  }

  mensais.sort((a, b) => {
    if (a.competencia !== b.competencia) return b.competencia.localeCompare(a.competencia); // desc
    const ia = ORDEM_SUFIXO.indexOf(a.sufixo);
    const ib = ORDEM_SUFIXO.indexOf(b.sufixo);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const desejada = [...mensais, ...controle];
  const requests = [];
  desejada.forEach((p, idx) => {
    if (p.index !== idx) {
      requests.push({ updateSheetProperties: { properties: { sheetId: p.sheetId, index: idx }, fields: 'index' } });
    }
  });

  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }
}

// Garante a aba mensal `<competencia> · <sufixo>` com o cabeçalho certo. Cria + reordena se for
// nova. Migração leve de cabeçalho curto, igual garantirAbaComCabecalho fazia. Devolve o título.
// `opts.pularReordenar` — a migração cria dezenas de abas em sequência e reordena uma vez só no
// fim (senão são N chamadas de get+batchUpdate a mais, risco de rate limit).
async function garantirAbaMensal(sheets, spreadsheetId, competencia, sufixo, cabecalho, opts = {}) {
  const titulo = `${competencia} · ${sufixo}`;
  const planilha = await sheets.spreadsheets.get({ spreadsheetId });
  const existe = planilha.data.sheets.some((s) => s.properties.title === titulo);

  if (!existe) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: titulo } } }] },
    });
  }

  const ultima = colunaLetra(cabecalho.length);
  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${titulo}!A1:${ultima}1` });
  const cabecalhoAtual = (resposta.data.values && resposta.data.values[0]) || [];

  if (cabecalhoAtual.length < cabecalho.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${titulo}!A1:${ultima}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [cabecalho] },
    });
  }

  if (!existe && !opts.pularReordenar) {
    await reordenarAbas(sheets, spreadsheetId).catch((erro) => console.error('Falha ao reordenar abas:', erro.message));
  }

  return titulo;
}

// Aba de config/controle (não-mensal) — mesma garantia de cabeçalho de antes.
async function garantirAbaComCabecalho(sheets, spreadsheetId, nomeAba, cabecalho) {
  const planilha = await sheets.spreadsheets.get({ spreadsheetId });
  const abaExiste = planilha.data.sheets.some((aba) => aba.properties.title === nomeAba);

  if (!abaExiste) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: nomeAba } } }] },
    });
  }

  const ultimaColuna = colunaLetra(cabecalho.length);
  const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${nomeAba}!A1:${ultimaColuna}1` });
  const cabecalhoAtual = (resposta.data.values && resposta.data.values[0]) || [];

  if (cabecalhoAtual.length < cabecalho.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${nomeAba}!A1:${ultimaColuna}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [cabecalho] },
    });
  }
}

// 03/09/2026: fica com FORMATTED_VALUE (padrão) de propósito. Tentei UNFORMATTED_VALUE pra number
// voltar como number, mas aí campo de TEXTO que é só dígito (ex.: "Documento" = NFC-e "000021485")
// volta como number e quebra `.trim()`/`.replace()` no código. FORMATTED_VALUE + numeroBR robusto
// (tira "R$", ".", etc.) + normalizarDataISO cobrem tudo sem esse efeito colateral.

async function buscarLinhas(spreadsheetId, nomeAba, range) {
  const sheets = getSheetsClient();
  try {
    const resposta = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${nomeAba}!${range}` });
    return resposta.data.values || [];
  } catch (error) {
    if (error.code === 400 || error.code === 404) return [];
    throw error;
  }
}

// Lê TODAS as abas mensais de um tipo (`sufixo`) + a aba legada única, num único batchGet.
// Devolve [{ aba, competencia, valores: [[...linha...]] }] em ordem cronológica (mês asc).
async function lerAbasDoTipo(spreadsheetId, sufixo, rangeCorpo) {
  const sheets = getSheetsClient();
  const planilha = await sheets.spreadsheets.get({ spreadsheetId });
  const titulos = planilha.data.sheets.map((s) => s.properties.title);

  const mensais = titulos
    .filter((t) => { const m = t.match(RE_ABA_MENSAL); return m && m[1] && m[2] === sufixo; })
    .sort();

  const legado = ABA_LEGADO[sufixo];
  const temLegado = legado && titulos.includes(legado);
  const alvos = [...mensais];
  if (temLegado) alvos.push(legado);

  if (alvos.length === 0) return [];

  const resposta = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: alvos.map((t) => `${t}!${rangeCorpo}`),
  });

  return (resposta.data.valueRanges || []).map((vr, i) => ({
    aba: alvos[i],
    competencia: competenciaDaAba(alvos[i]),
    valores: vr.values || [],
  }));
}

// -------------------------------------------------------------------------------------------
// LANÇAMENTOS
// -------------------------------------------------------------------------------------------

function linhaLancamento(dados, competencia) {
  return [
    paraDataBR(dados.data),
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
    dados.status_conciliacao || 'Pendente',
    dados.observacao_conciliacao || '',
    competencia,
    dados.cnpj_fornecedor || '',
    dados.razao_social_fornecedor || '',
    dados.cnae_codigo || '',
    dados.cnae_descricao || '',
    dados.fonte_categoria || '',
  ];
}

// Devolve { aba, linha } — quem chama liga os itens do documento (salvarItens) e a memória de
// correção de curto prazo (server.js) a esse lançamento específico (aba + linha).
async function salvarComprovante(spreadsheetId, dados) {
  const sheets = getSheetsClient();
  const competencia = competenciaDe(dados.data);
  const aba = await garantirAbaMensal(sheets, spreadsheetId, competencia, SUFIXO.LANCAMENTOS, CABECALHO_LANCAMENTOS);

  const resposta = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${aba}!${RANGE_LANCAMENTOS}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [linhaLancamento(dados, competencia)] },
  });

  return { aba, linha: extrairNumeroLinha(resposta.data.updates && resposta.data.updates.updatedRange) };
}

// Reescreve a linha inteira (A:V) de um lançamento JÁ EXISTENTE, na aba dele — usado quando um
// comprovante de verdade chega depois pra "completar" um lançamento que nasceu do extrato.
async function atualizarLancamento(spreadsheetId, aba, linha, dados) {
  const sheets = getSheetsClient();
  const competencia = competenciaDaAba(aba) || competenciaDe(dados.data);
  const valores = linhaLancamento(dados, competencia);
  valores[14] = dados.status_conciliacao || 'CONCILIADO_OK'; // Status_Conciliacao

  const ultima = colunaLetra(CABECALHO_LANCAMENTOS.length);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${aba}!A${linha}:${ultima}${linha}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [valores] },
  });
}

function mapearLancamento(linha, aba, competenciaAba, indiceZero) {
  const numeroLinha = indiceZero + 2;
  return {
    aba,
    linha: numeroLinha,
    chave: `${aba}#${numeroLinha}`, // identificador único entre abas — conciliação chaveia por isso
    competencia: linha[16] || competenciaAba || competenciaDe(linha[0]),
    data: normalizarDataISO(linha[0]),
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
    registrado_em: linha[11] || '',
    grupo_dre: linha[12] || '',
    conta_bancaria: linha[13] || '',
    status_conciliacao: linha[14] || '',
    observacao_conciliacao: linha[15] || '',
    cnpj_fornecedor: linha[17] || '',
    razao_social_fornecedor: linha[18] || '',
    cnae_codigo: linha[19] || '',
    cnae_descricao: linha[20] || '',
    fonte_categoria: linha[21] || '',
  };
}

async function buscarTodosLancamentos(spreadsheetId) {
  const blocos = await lerAbasDoTipo(spreadsheetId, SUFIXO.LANCAMENTOS, RANGE_LANCAMENTOS.replace('A:', 'A2:'));
  const saida = [];
  for (const bloco of blocos) {
    bloco.valores.forEach((linha, i) => saida.push(mapearLancamento(linha, bloco.aba, bloco.competencia, i)));
  }
  return saida;
}

// Atualiza Status_Conciliacao + Observacao_Conciliacao de várias linhas, possivelmente em abas
// mensais diferentes — um único batchUpdate. `atualizacoes` = [{ aba, linha, status, observacao }].
async function atualizarStatusConciliacaoEmLote(spreadsheetId, atualizacoes) {
  if (!atualizacoes || atualizacoes.length === 0) return;
  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: atualizacoes.flatMap(({ aba, linha, status, observacao }) => {
        const celulas = [{ range: `${aba}!${COLUNA_STATUS_CONCILIACAO}${linha}`, values: [[status]] }];
        if (observacao !== undefined) {
          celulas.push({ range: `${aba}!${COLUNA_OBSERVACAO_CONCILIACAO}${linha}`, values: [[observacao]] });
        }
        return celulas;
      }),
    },
  });
}

// -------------------------------------------------------------------------------------------
// ITENS DO COMPROVANTE
// -------------------------------------------------------------------------------------------

async function salvarItens(spreadsheetId, itens, { data, estabelecimento, lancamentoLinha, lancamentoAba }) {
  if (!itens || itens.length === 0) return;

  const sheets = getSheetsClient();
  const competencia = competenciaDe(data);
  const aba = await garantirAbaMensal(sheets, spreadsheetId, competencia, SUFIXO.ITENS, CABECALHO_ITENS);

  const registradoEm = new Date().toISOString();
  const linhas = itens.map((item) => [
    paraDataBR(data),
    lancamentoLinha ?? '',
    estabelecimento || '',
    item.descricao || '',
    item.quantidade ?? '',
    item.valor_unitario ?? '',
    item.valor_total ?? '',
    registradoEm,
    competencia,
    lancamentoAba || '',
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${aba}!${RANGE_ITENS}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: linhas },
  });
}

async function buscarTodosItens(spreadsheetId) {
  const blocos = await lerAbasDoTipo(spreadsheetId, SUFIXO.ITENS, 'A2:J');
  const saida = [];
  for (const bloco of blocos) {
    for (const linha of bloco.valores) {
      saida.push({
        data: normalizarDataISO(linha[0]),
        lancamento_linha: linha[1] || '',
        estabelecimento_ou_pessoa: linha[2] || '',
        descricao: linha[3] || '',
        quantidade: linha[4] ? numeroBR(linha[4]) : null,
        valor_unitario: linha[5] ? numeroBR(linha[5]) : null,
        valor_total: linha[6] ? numeroBR(linha[6]) : null,
        competencia: linha[8] || bloco.competencia || competenciaDe(linha[0]),
      });
    }
  }
  return saida;
}

// -------------------------------------------------------------------------------------------
// DESPESAS FIXAS (config, aba única)
// -------------------------------------------------------------------------------------------

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
    'Sim',
    new Date().toISOString(),
    '',
    dados.dia_da_semana ?? '',
  ];

  const resposta = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ABA_DESPESAS_FIXAS}!A:L`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [linha] },
  });

  return extrairNumeroLinha(resposta.data.updates && resposta.data.updates.updatedRange);
}

async function buscarDespesasFixas(spreadsheetId) {
  const linhas = await buscarLinhas(spreadsheetId, ABA_DESPESAS_FIXAS, 'A2:L');

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
    ultima_data_lancamento: linha[10] || '',
    dia_da_semana: linha[11] !== undefined && linha[11] !== '' ? Number(linha[11]) : null,
  }));
}

// -------------------------------------------------------------------------------------------
// ORÇAMENTO (config, aba única — upsert por Competencia+Grupo_DRE)
// -------------------------------------------------------------------------------------------

async function salvarOrcamento(spreadsheetId, dados) {
  const sheets = getSheetsClient();
  await garantirAbaComCabecalho(sheets, spreadsheetId, ABA_ORCAMENTO, CABECALHO_ORCAMENTO);

  const linhas = await buscarLinhas(spreadsheetId, ABA_ORCAMENTO, 'A2:D');
  const semEssa = linhas.filter((l) => !((l[0] || '') === dados.competencia && (l[1] || '') === dados.grupo_dre));

  const nova = [dados.competencia, dados.grupo_dre, dados.valor_orcado || 0, new Date().toISOString()];
  const todas = [nova, ...semEssa].sort((a, b) => String(b[0]).localeCompare(String(a[0])));

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ABA_ORCAMENTO}!A2:D${todas.length + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: todas },
  });
}

async function buscarOrcamento(spreadsheetId) {
  const linhas = await buscarLinhas(spreadsheetId, ABA_ORCAMENTO, 'A2:D');
  return linhas
    .filter((l) => l[0] && l[1])
    .map((l) => ({ competencia: l[0], grupo_dre: l[1], valor_orcado: numeroBR(l[2]) }));
}

async function marcarDespesaFixaLancada(spreadsheetId, linha, dataISO) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ABA_DESPESAS_FIXAS}!K${linha}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[dataISO]] },
  });
}

// -------------------------------------------------------------------------------------------
// EXTRATO
// -------------------------------------------------------------------------------------------

// Um extrato pode cobrir mais de um mês (ex.: 15/08 a 14/09) — cada transação vai pra aba da sua
// própria competência (data da transação).
async function salvarExtrato(spreadsheetId, transacoes) {
  if (!transacoes || transacoes.length === 0) return;
  const sheets = getSheetsClient();

  const porCompetencia = new Map();
  for (const t of transacoes) {
    const comp = competenciaDe(t.data);
    if (!porCompetencia.has(comp)) porCompetencia.set(comp, []);
    porCompetencia.get(comp).push(t);
  }

  const registradoEm = new Date().toISOString();
  for (const [competencia, lote] of porCompetencia) {
    const aba = await garantirAbaMensal(sheets, spreadsheetId, competencia, SUFIXO.EXTRATO, CABECALHO_EXTRATO);
    const linhas = lote.map((transacao) => [
      paraDataBR(transacao.data),
      transacao.descricao || '',
      transacao.valor || 0,
      transacao.tipo || '',
      transacao.saldo_apos ?? '',
      registradoEm,
      competencia,
      transacao.conta_bancaria || '',
    ]);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${aba}!${RANGE_EXTRATO}`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: linhas },
    });
  }
}

async function buscarExtrato(spreadsheetId) {
  const blocos = await lerAbasDoTipo(spreadsheetId, SUFIXO.EXTRATO, 'A2:H');
  const saida = [];
  for (const bloco of blocos) {
    for (const linha of bloco.valores) {
      saida.push({
        data: normalizarDataISO(linha[0]),
        descricao: linha[1] || '',
        valor: numeroBR(linha[2]),
        tipo: linha[3] || '',
        saldo_apos: linha[4] ? numeroBR(linha[4]) : null,
        competencia: linha[6] || bloco.competencia || competenciaDe(linha[0]),
        conta_bancaria: linha[7] || '',
      });
    }
  }
  return saida;
}

// -------------------------------------------------------------------------------------------
// CONTAS A PAGAR / A RECEBER — competência pelo VENCIMENTO
// -------------------------------------------------------------------------------------------

async function salvarContasAPagar(spreadsheetId, contas) {
  if (!contas || contas.length === 0) return null;
  const sheets = getSheetsClient();

  const porCompetencia = new Map();
  for (const c of contas) {
    const comp = competenciaDe(c.vencimento);
    if (!porCompetencia.has(comp)) porCompetencia.set(comp, []);
    porCompetencia.get(comp).push(c);
  }

  const registradoEm = new Date().toISOString();
  let primeiraLinha = null;

  for (const [competencia, lote] of porCompetencia) {
    const aba = await garantirAbaMensal(sheets, spreadsheetId, competencia, SUFIXO.CONTAS_A_PAGAR, CABECALHO_CONTAS_A_PAGAR);
    const linhas = lote.map((conta) => [
      paraDataBR(conta.vencimento),
      conta.valor || 0,
      conta.cartao || '',
      conta.beneficiario || '',
      conta.descricao || '',
      conta.categoria || '',
      conta.parcela_atual ?? '',
      conta.parcela_total ?? '',
      registradoEm,
      conta.grupo_dre || '',
      competencia,
      conta.subcategoria || '',
      conta.cnpj_fornecedor || '',
      conta.cnae_codigo || '',
      conta.fonte_categoria || '',
    ]);
    const resposta = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${aba}!${RANGE_CONTAS_A_PAGAR}`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: linhas },
    });
    if (primeiraLinha === null) {
      primeiraLinha = { aba, linha: extrairNumeroLinha(resposta.data.updates && resposta.data.updates.updatedRange) };
    }
  }

  // Compat: processarFaturaComoResumo (pendente) chama com 1 conta só e usa o retorno pra memória
  // de correção — devolve { aba, linha } da primeira. Com lote, quem chama não usa o retorno.
  return primeiraLinha;
}

async function buscarContasAPagar(spreadsheetId) {
  const blocos = await lerAbasDoTipo(spreadsheetId, SUFIXO.CONTAS_A_PAGAR, 'A2:O');
  const saida = [];
  for (const bloco of blocos) {
    for (const linha of bloco.valores) {
      saida.push({
        vencimento: normalizarDataISO(linha[0]),
        valor: numeroBR(linha[1]),
        cartao: linha[2] || '',
        beneficiario: linha[3] || '',
        descricao: linha[4] || '',
        categoria: linha[5] || '',
        parcela_atual: linha[6] ? numeroBR(linha[6]) : null,
        parcela_total: linha[7] ? numeroBR(linha[7]) : null,
        grupo_dre: linha[9] || '',
        competencia: linha[10] || bloco.competencia || competenciaDe(linha[0]),
        subcategoria: linha[11] || '',
        cnpj_fornecedor: linha[12] || '',
        cnae_codigo: linha[13] || '',
        fonte_categoria: linha[14] || '',
      });
    }
  }
  return saida;
}

async function salvarContasAReceber(spreadsheetId, contas) {
  if (!contas || contas.length === 0) return;
  const sheets = getSheetsClient();

  const porCompetencia = new Map();
  for (const c of contas) {
    const comp = competenciaDe(c.vencimento);
    if (!porCompetencia.has(comp)) porCompetencia.set(comp, []);
    porCompetencia.get(comp).push(c);
  }

  const registradoEm = new Date().toISOString();
  for (const [competencia, lote] of porCompetencia) {
    const aba = await garantirAbaMensal(sheets, spreadsheetId, competencia, SUFIXO.CONTAS_A_RECEBER, CABECALHO_CONTAS_A_RECEBER);
    const linhas = lote.map((conta) => [
      paraDataBR(conta.vencimento),
      conta.valor || 0,
      conta.cliente_devedor || '',
      conta.descricao || '',
      conta.categoria || '',
      conta.documento || '',
      conta.parcela_atual ?? '',
      conta.parcela_total ?? '',
      registradoEm,
      conta.grupo_dre || '',
      competencia,
    ]);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${aba}!${RANGE_CONTAS_A_RECEBER}`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: linhas },
    });
  }
}

async function buscarContasAReceber(spreadsheetId) {
  const blocos = await lerAbasDoTipo(spreadsheetId, SUFIXO.CONTAS_A_RECEBER, 'A2:K');
  const saida = [];
  for (const bloco of blocos) {
    for (const linha of bloco.valores) {
      saida.push({
        vencimento: normalizarDataISO(linha[0]),
        valor: numeroBR(linha[1]),
        cliente_devedor: linha[2] || '',
        descricao: linha[3] || '',
        categoria: linha[4] || '',
        documento: linha[5] || '',
        parcela_atual: linha[6] ? numeroBR(linha[6]) : null,
        parcela_total: linha[7] ? numeroBR(linha[7]) : null,
        grupo_dre: linha[9] || '',
        competencia: linha[10] || bloco.competencia || competenciaDe(linha[0]),
      });
    }
  }
  return saida;
}

// -------------------------------------------------------------------------------------------
// REMOVER LINHA (memória de correção "apaga o último")
// -------------------------------------------------------------------------------------------

async function obterSheetIdNumerico(sheets, spreadsheetId, nomeAba) {
  const planilha = await sheets.spreadsheets.get({ spreadsheetId });
  const aba = planilha.data.sheets.find((a) => a.properties.title === nomeAba);
  return aba ? aba.properties.sheetId : null;
}

// ⚠️ Só é seguro pra a linha MAIS RECENTE da aba (ver comentário original) — o chamador
// (aplicarCorrecaoUltimoDocumento em server.js) só usa dentro da janela de 10min da memória.
async function removerLinha(spreadsheetId, nomeAba, numeroLinha) {
  if (!numeroLinha) return false;
  const sheets = getSheetsClient();
  const sheetId = await obterSheetIdNumerico(sheets, spreadsheetId, nomeAba);
  if (sheetId === null) return false;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: numeroLinha - 1, endIndex: numeroLinha },
        },
      }],
    },
  });
  return true;
}

module.exports = {
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
  salvarOrcamento,
  buscarOrcamento,
  removerLinha,
  competenciaDe,
  normalizarDataISO,
  paraDataBR,
  garantirAbaMensal,
  garantirAbaComCabecalho,
  reordenarAbas,
  getSheetsClient,
  buscarLinhas,
  SUFIXO,
  RE_ABA_MENSAL,
  ABA_LEGADO,
  CABECALHO_LANCAMENTOS,
  CABECALHO_EXTRATO,
  CABECALHO_CONTAS_A_PAGAR,
  CABECALHO_CONTAS_A_RECEBER,
  CABECALHO_ITENS,
  ABA_LANCAMENTOS,
  ABA_CONTAS_A_PAGAR,
};
