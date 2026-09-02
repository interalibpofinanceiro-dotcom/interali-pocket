# Interali Pocket — Fase Competência / Fechamento / CNAE

> Spec de trabalho. Iniciado 02/09/2026 a pedido do Aroldo. NÃO commitado/deployado até o Aroldo
> pedir. Quando concluído, vira seção nova em `G:\...\CLAUDE.MD\HISTORICO-COMPLETO.md`.

## Escopo (fechado com o Aroldo em 02/09/2026)

Tudo aplicado na **planilha mestre + TODAS as planilhas de cliente** (rollout geral, sem piloto —
mas testado no cliente de teste do Aroldo antes de migrar os reais).

### 1. Abas mensais (partição real — nesta primeira entrega)
- Cada tipo de dado transacional vira **uma aba por competência**:
  - `2026-09 · Lançamentos`, `2026-09 · Extrato`, `2026-09 · Contas a Pagar`,
    `2026-09 · Contas a Receber`, `2026-09 · Itens`
- Abas de config/controle continuam únicas: `Clientes`, `Cache_CNPJ`, `Fechamentos` (mestre);
  `DespesasFixas`, `Fechamento`, `Matriz` (cliente).
- **Aba do mês mais novo fica na extrema esquerda** (índice 0), agrupada por mês; meses antigos
  à direita. Reordena as abas mensais toda vez que uma aba de mês novo é criada.
- `garantirAbaMensal(base, competencia)` cria a aba + cabeçalho + reordena.

### 2. Coluna `Competencia`
- Formato `YYYY-MM` (ex.: `2026-08`). Rótulo bonito ("Ago/2026") só nos relatórios/PDF.
- Valor = **mês da DATA DO COMPROVANTE, sempre**. Nunca a data de envio.
  - Lançamentos/Itens: `dados.data`. Extrato: `transacao.data`. Contas a pagar/receber:
    `vencimento` (é a única data confiável desses; parcelas futuras caem cada uma no seu mês).
  - Fallback (documento sem data): mês corrente.
- A aba de destino é derivada da competência → item 1 e 2 são a mesma mecânica.

### 3. Fechamento mensal
- Mês **não fecha sozinho**. Conciliação corrente (casar comprovante × extrato conforme chega)
  continua automática. O **fechamento** roda só quando o cliente **pede** ("fechar agosto",
  "fazer o fechamento do mês 08") — pode ser **comando solto**, a qualquer momento, sem precisar
  vir junto com os extratos (mas o ideal é o cliente ter mandado os extratos antes).
- Ao fechar o mês X:
  1. roda conciliação de X
  2. calcula: entradas, saídas, **resultado**, % conciliado, saldo do extrato, DRE resumida,
     pendências (sem comprovante / dúvida de conciliação)
  3. **gera PDF** de 1 página (pdfkit) e envia como documento no WhatsApp
  4. marca `X = FECHADO` na aba `Fechamento` (cliente) e `Fechamentos` (mestre)
- Totais do fechamento EXCLUEM: transferência entre contas, repasse a terceiros, investimento
  imobilizado (mesma regra que `gerarDRE` já usa pros dois últimos).

### 4. Lançamento retroativo em mês já FECHADO
- Entra normal na aba/competência da data do comprovante.
- `observacao`: `pós-fechamento`. Avisa o cliente: "esse lançamento é de agosto, que já foi
  fechado — me avise quando quiser que eu refaça o fechamento de agosto."
- Aba `Fechamento` marca `FECHADO (reaberto)` até refazer.

### 5. Abas de controle do fechamento
- **Mestre → `Fechamentos`**: `Cliente | Competencia | Status | Data_Fechamento | Entradas |
  Saidas | Resultado | Pct_Conciliado`
- **Cliente → `Fechamento`**: mesma coisa sem a coluna Cliente, **mais novo em cima**,
  status `ABERTO` / `FECHADO` / `FECHADO (reaberto)`

### 6. CNAE do fornecedor
- `cnae.js` (feito): consulta CNAE do CNPJ do comprovante — BrasilAPI (principal) + CNPJá aberto
  (fallback). Cache na aba `Cache_CNPJ` da mestre. Zero token de IA. Cache por CNPJ, TTL 120 dias,
  cresce sozinho; CNPJ novo dispara consulta grátis.
- `cnae-categorias.js` (feito): mapa CNAE → categoria/grupo_dre. Só sugere pra `saida`. Confiança
  "alta" só pra atividades inequívocas (contador, advogado, energia, telecom, agência de
  publicidade, SaaS/hospedagem).
- `prompts.js`: campo novo `cnpj_fornecedor` (emitente, separado do pagador).
- `server.js` (`enriquecerLancamentoComCnae`), rodando em `processarLancamentoExtraido`:
  - preenche colunas de metadado sempre: `CNPJ_Fornecedor`, `Razao_Social_Fornecedor`,
    `CNAE_Codigo`, `CNAE_Descricao`, `Fonte_Categoria`
  - **memória de fornecedor** (prioridade): se o cliente já tem lançamento anterior com o mesmo
    CNPJ e categoria não-genérica → reusa aquela categoria/subcategoria/grupo_dre.
    `Fonte_Categoria = memoria_fornecedor`
  - senão, se a IA classificou genérico/`nao_classificado` E o CNAE tem sugestão "alta" → aplica.
    `Fonte_Categoria = cnae`
  - senão mantém o que a IA decidiu. `Fonte_Categoria = ia`
  - **nunca** faz 2ª chamada ao Claude por causa do CNAE
  - append em `observacoes`: nota da atividade do fornecedor (sempre, informativo)

### 7. Tarifas e rendimentos do extrato — classificação automática
- Classificador determinístico por palavra-chave no fluxo de extrato. Não pergunta, não gasta token.
  - "tarifa", "cesta de serviços", "manutenção de conta", "tar TED/DOC/PIX", "IOF", "anuidade",
    "pacote de serviços" → `financeiro_tarifas` · "Tarifas Bancárias" · saída
  - "rendimento", "rend pago", "remuneração", "juros s/ saldo", "aplic. automática – rendimento"
    → `financeiro_rendimentos` · "Rendimentos de Aplicações" · entrada
- Marca `CONCILIADO_OK` na hora (nunca chega comprovante). Pula a pergunta "recebimento sem nota".

### 8. Transferência entre contas do mesmo titular
- Pix/TED/transferência em que **pagador e recebedor são o mesmo CPF/CNPJ/titular** (cliente
  movendo dinheiro entre os próprios bancos) → **não conta como entrada nem saída no resultado**.
- `categoria` = "Transferência entre Contas", `grupo_dre` = `transferencia_entre_contas` (chave
  nova em `dre.js`, bloco próprio que `gerarDRE` e o fechamento NUNCA somam — igual INVESTIMENTO /
  REPASSE_TERCEIROS).
- Detecção: regra no `PROMPT_EXTRACAO`, `PROMPT_EXTRACAO_TEXTO` e `PROMPT_EXTRATO` (mesmo titular
  nos dois lados, ou descrição "transferência entre contas"/"aplicação"/"resgate" mesma
  titularidade) + fallback por palavra-chave no extrato.

## Ordem de implementação

1. ✅ `cnae.js`, `cnae-categorias.js`
2. `dre.js` — chave `transferencia_entre_contas` (bloco novo, não somado)
3. `sheets.js` — camada de abas mensais + coluna `Competencia` + colunas CNAE. `buscarTodos*` lê
   todas as abas do tipo (batchGet). Row tracking vira `{aba, linha}`.
4. `reconciliacao.js` — chavear status por `${aba}#${linha}` em vez de só `linha`
5. `prompts.js` — `cnpj_fornecedor`, regra transferência mesmo titular
6. `fechamento.js` (novo) — cálculo + PDF (pdfkit) + upload/envio documento WhatsApp
7. `whatsapp.js` — `enviarDocumentoWhatsApp` (upload media + send type=document)
8. `server.js` — enriquecimento CNAE, classificador tarifa/rendimento, comando "fechar mês",
   aviso retroativo, memória de correção com `{aba, linha}`
9. `dashboard.js` — ler abas mensais (ou filtro de mês)
10. `scripts/migrar-competencia.js` — pra cada cliente: cria abas mensais, move linhas das abas
    únicas antigas pras mensais pela data, preenche `Competencia`. Idempotente. Roda no cliente de
    teste → confere → roda nos reais.

## Testes obrigatórios antes de avisar "pronto"
- Chamada real BrasilAPI com CNPJ de verdade (cache grava/lê)
- Chamada real Anthropic: comprovante com CNPJ → categoria + colunas CNAE
- Extrato sintético com linha de tarifa + rendimento → classificados sozinhos
- Comprovante Pix mesmo titular → `transferencia_entre_contas`, fora do resultado
- Fluxo "fechar mês" no cliente de teste → PDF gerado e recebido no WhatsApp
- Migração no cliente de teste → nenhuma linha perdida, competências certas
- `git diff` de `dre.js` (confirmar aditivo)

## HOTFIX paralelo — linhas "SALDO DO DIA" (02/09/2026)

Caso real: planilha da Sirlene com 29 lançamentos "SALDO DO DIA" como entrada (valores 4409,03 /
3004,45 / 2973,46...), inflando o resultado. Bloqueia a venda do sistema ("precisa ficar redondo").
- Causa: `PROMPT_EXTRATO` não mandava ignorar linhas de saldo do extrato -> viraram órfãos -> viraram
  lançamento de entrada.
- Corrigido: regra explícita no `PROMPT_EXTRATO` + `removerLinhasDeSaldo()` no `server.js` (rede de
  segurança antes de salvar/registrar).
- Faxina: `scripts/limpar-linhas-saldo.js` (dry-run por padrão, `--apagar` pra valer). Rodado dry-run
  02/09: 29 linhas na Sirlene, 0 nos demais. Falta rodar `--apagar` (bloqueado pelo classificador de
  segurança do harness — o Aroldo roda).

## FASE 3 — Motor Cartão de Crédito 3 camadas (pedido do Aroldo 02/09/2026, NÃO iniciado)

Depende da Fase 1/2 estável (compartilha prompts.js/server.js/sheets.js).

### 3 camadas: COMPRA -> FATURA -> EXTRATO
- **A) Comprovante de compra no cartão**: se `forma_pagamento` = cartão de crédito e for parcelado
  (Nx), classificar como `DESPESA_CARTAO_PROVISIONADA`, gerar N parcelas nas competências futuras
  (M+1, M+2... ou nas datas de vencimento). NÃO debitar caixa bancário na hora (a saída no banco
  ainda não aconteceu).
- **B) Fatura consolidada**: reconhecer que é fatura (não comprovante avulso). Cruzar cada parcela
  da fatura com as provisões já lançadas (chave: fornecedor normalizado + valor da parcela +
  parcela X/N). Parcela já provisionada -> só muda status pra `FATURADO`, não duplica. Compra na
  fatura sem provisão anterior -> registra como `FATURADO_DIRETO`.
- **C) Extrato (pagamento da fatura)**: débito com descrição "Pgto Fatura Cartão" / "Pagamento de
  Fatura" / "Débito Automático Fatura" -> classificar como `PAGAMENTO_FATURA_CARTAO`, associar à
  fatura do mês. NUNCA reclassificar como despesa operacional nova (senão duplica todos os itens da
  fatura no DRE). Débito automático sem comprovante -> lançar via a fatura do cartão.

### Motor anti-duplicidade por chave
- `chave = [data_aproximada, valor_exato, fornecedor_normalizado, metodo_pagamento]`
- Match: mesmo valor (idêntico da parcela ou ±1%), data ±5 dias, mesmo estabelecimento -> NÃO cria
  linha nova, responde "Lançamento já identificado! ... Atualizei o status para conciliado sem
  duplicar no seu DRE."

### DRE vs Fluxo de Caixa
- DRE: despesa na competência da compra (ou rateada por mês de parcela faturada).
- Fluxo de caixa: saída afeta o saldo só no dia do pagamento da fatura no extrato.

Retrocompatível com as planilhas existentes.

## Pendências / decisões em aberto
- Nome exato das abas: `2026-09 · Lançamentos` (com ` · `) — confirmar com Aroldo se ok
- Contas a pagar/receber: competência pelo `vencimento` — confirmar
- Limite de abas do Google Sheets (~200) — ~5 abas/mês = 60/ano/cliente, ok por anos
