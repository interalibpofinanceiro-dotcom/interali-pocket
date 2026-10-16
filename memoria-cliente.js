// Memória de classificação POR CLIENTE (14/10/2026, pedido do Aroldo: "o especialista atualiza a
// categoria e já pode ficar pronta para os próximos — é isso que faremos com nossos clientes").
//
// Processo de BPO: o especialista revisa o mês e ajusta SÓ a coluna "Categoria" da planilha. A partir
// daí o Pocket aprende sozinho, sem tabela de regras pra manter:
//   1. por contraparte — "Futebol", "Beatriz", "Casa de Ferragens" já classificados uma vez entram
//      iguais da próxima vez (registrarOrfaosDoExtrato em server.js), sem IA e sem perguntar;
//   2. por categoria — categoria escrita pelo especialista num lançamento ainda "nao_classificado"
//      vira o grupo_dre que essa mesma categoria já tem em outros lançamentos do cliente
//      (preencherGrupoPelaCategoria, rodado todo dia antes de reescrever a aba DRE).
// A DRE em si nunca é editada à mão — sempre recalculada a partir dos lançamentos.
const { porChave } = require('./dre');

const PALAVRAS_IGNORADAS = new Set([
  'pix', 'enviado', 'enviada', 'recebido', 'recebida', 'compra', 'com', 'cartao', 'cartão', 'pgto', 'qr', 'code', 'transf',
  'transferencia', 'transferência', 'pagamento', 'para', 'de', 'da', 'do', 'das', 'dos', 'via', 'por', 'debito', 'débito',
  'credito', 'crédito', 'deb', 'autor', 'pag', 'boleto', 'ltda', 'me', 'sa', 'eireli', 'instituicao', 'instituição',
  'retirada', 'titular', 'compras', 'no', 'na', 'em', 'e',
]);

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/g, ' ') // datas
    .replace(/\d{1,2}:\d{2}/g, ' ') // horas
    .replace(/[\d.\-/]{5,}/g, ' ') // CPF/CNPJ/códigos
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Pix - Enviado - 23/09 18:22 MARIA CHIARELO DO" -> "maria chiarelo"
function chaveContraparte(texto) {
  const palavras = normalizar(texto).split(' ').filter((p) => p.length >= 3 && !PALAVRAS_IGNORADAS.has(p));
  return palavras.slice(0, 2).join(' ') || null;
}

const valida = (l) => l.grupo_dre && l.grupo_dre !== 'nao_classificado' && porChave(l.grupo_dre)
  && l.categoria && l.categoria !== 'Não Classificado';

// Map chave -> { categoria, grupo_dre, tipo } — só quando o histórico é CONSISTENTE (a mesma
// contraparte sempre no mesmo grupo); contraparte com histórico conflitante não entra (não chuta).
function aprenderPorContraparte(lancamentos) {
  const vistos = new Map();
  for (const l of lancamentos.filter(valida).sort((a, b) => String(a.data).localeCompare(String(b.data)))) {
    const tipo = l.tipo_movimentacao === 'entrada' ? 'entrada' : 'saida';
    for (const fonte of [l.estabelecimento_ou_pessoa, l.descricao]) {
      const chave = chaveContraparte(fonte);
      if (!chave) continue;
      const k = `${tipo}|${chave}`;
      const atual = vistos.get(k);
      if (atual && atual.grupo_dre !== l.grupo_dre) atual.conflito = true;
      else vistos.set(k, { categoria: l.categoria, subcategoria: l.subcategoria || '', grupo_dre: l.grupo_dre, tipo, conflito: atual ? atual.conflito : false });
    }
  }
  for (const [k, v] of vistos) if (v.conflito) vistos.delete(k);
  return vistos;
}

function sugerirPelaMemoria(memoria, transacao) {
  const tipo = transacao.tipo === 'entrada' ? 'entrada' : 'saida';
  const chave = chaveContraparte(transacao.descricao);
  if (!chave) return null;
  const achado = memoria.get(`${tipo}|${chave}`);
  return achado ? { categoria: achado.categoria, subcategoria: achado.subcategoria || '', grupo_dre: achado.grupo_dre } : null;
}

// Map categoria (normalizada) + tipo -> grupo_dre, só quando a categoria é usada sempre com o mesmo grupo.
function aprenderPorCategoria(lancamentos) {
  const mapa = new Map();
  for (const l of lancamentos.filter(valida)) {
    const tipo = l.tipo_movimentacao === 'entrada' ? 'entrada' : 'saida';
    // Categoria sozinha e categoria + subcategoria (o detalhe do especialista desempata).
    const chaves = [`${tipo}|${normalizar(l.categoria)}`];
    if (l.subcategoria) chaves.push(`${tipo}|${normalizar(`${l.categoria} ${l.subcategoria}`)}`);
    for (const k of chaves) {
      const atual = mapa.get(k);
      if (atual && atual !== l.grupo_dre) mapa.set(k, 'CONFLITO');
      else if (!atual) mapa.set(k, l.grupo_dre);
    }
  }
  for (const [k, v] of mapa) if (v === 'CONFLITO') mapa.delete(k);
  return mapa;
}

// Exemplos curtos pro prompt da IA ("o especialista deste cliente classifica assim").
function exemplosParaIA(lancamentos, limite = 40) {
  const vistos = new Set();
  const exemplos = [];
  for (const l of lancamentos.filter(valida).reverse()) {
    const k = `${normalizar(l.categoria)}|${normalizar(l.subcategoria || '')}|${l.grupo_dre}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    const origem = l.fonte_categoria === 'especialista' ? ' [especialista]' : l.fonte_categoria === 'cliente' ? ' [cliente]' : '';
    exemplos.push(`"${l.categoria}"${l.subcategoria ? ` / "${l.subcategoria}"` : ''} (${l.tipo_movimentacao === 'entrada' ? 'entrada' : 'saída'}) -> ${l.grupo_dre}${origem}`);
    if (exemplos.length >= limite) break;
  }
  return exemplos;
}

module.exports = { chaveContraparte, aprenderPorContraparte, sugerirPelaMemoria, aprenderPorCategoria, exemplosParaIA, normalizar };
