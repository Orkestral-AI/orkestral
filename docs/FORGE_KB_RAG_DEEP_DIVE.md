# Orkestral Forge, KB, RAG e aprendizado - deep dive

Este documento aprofunda o funcionamento do Orkestral Forge, da base de
conhecimento e do mecanismo de aprendizado atual do app.

Resumo curto: o Orkestral **nao faz fine-tuning de pesos** hoje. O que existe e
um sistema de aprendizado operacional: o app guarda memoria no SQLite/KB/skills,
recupera contexto por busca lexical/FTS/WarpGrep e injeta esse contexto nos
prompts seguintes. Isso gera efeito pratico de "o workspace aprende" sem treinar
o modelo local.

## 1. O que e o Orkestral Forge

Forge e o executor local embutido do app. Ele usa:

- Runtime: `node-llama-cpp`, que traz llama.cpp pre-compilado.
- Pesos: GGUF empacotado em `resources/forge/models/forge.gguf`.
- Modelo configurado no manifesto: Qwen2.5-Coder-1.5B-Instruct Q4_K_M.
- Arquivo real observado: `resources/forge/models/forge.gguf`, cerca de 1 GB.

Observacao: `resources/forge/README.md` ainda menciona em um trecho
Qwen2.5-Coder-0.5B, mas `scripts/forge-manifest.json`, comentarios atuais do
runtime e o tamanho do arquivo apontam para 1.5B. O README esta parcialmente
desatualizado.

`scripts/setup-forge.mjs` prepara o GGUF. Ele roda em `predev` e no build. Se o
download ou hash falhar, o build continua; o Forge fica indisponivel e o app
escala para premium em runtime.

## 1.1. Modelo local de embeddings

A busca semantica/RAG nao deve usar o GGUF instruct do Forge. O Forge e um
modelo de edicao/codigo; embeddings precisam de um modelo treinado para
similaridade.

A partir da etapa de embeddings locais, o app usa um pacote separado:

- Runtime: tambem `node-llama-cpp`.
- Pesos: `resources/embeddings/models/embedding.gguf`.
- Manifesto: `scripts/embeddings-manifest.json`.
- Setup: `scripts/setup-embeddings.mjs` / `npm run setup:embeddings`.
- Modelo padrao: `Qwen/Qwen3-Embedding-0.6B-GGUF`, arquivo
  `Qwen3-Embedding-0.6B-Q8_0.gguf`.

Ao contrario do Forge, embeddings sao infraestrutura obrigatoria para uma busca
local de qualidade. O build executa `npm run setup:models`, preparando Forge e
embeddings. Existe apenas um escape hatch de dev/CI:
`ORKESTRAL_SKIP_EMBEDDINGS=1`.

## 2. O Forge nao conversa: ele edita

O Forge (`orkestral_local`) nao e usado como chat conversacional normal. Em
`chat-service.ts`, se um agente tem adapter `orkestral_local`, o chat e roteado
para um agente premium do workspace, preferindo o orquestrador Claude/Codex.

O Forge atua no fluxo de execucao de issue:

```
issue todo
  -> issue-execution-service
  -> agente assignee = orkestral_local
  -> smart-exec/orchestrator
  -> modelo local gera lazy edit
  -> app aplica deterministicamente
  -> valida
  -> grava aprendizado
  -> revisao hierarquica
```

O modelo local nunca escreve arquivo diretamente. Ele gera texto. Quem aplica,
mede, valida e reverte e o app.

## 3. Runtime local

`smart-exec/llama-runtime.ts` controla o modelo:

- `isLocalConfigured` confere se o GGUF existe.
- `loadModel` usa `getLlama()` e `loadModel()`.
- `allowGpu` e `true` no macOS e false nos demais por seguranca.
- O modelo carrega sob demanda, nao no boot.
- `beginRun()` e `endRun()` mantem o modelo quente durante uma issue multi-arquivo.
- Idle unload descarrega depois de `idleUnloadSeconds`.
- Ha timeout para inicializar runtime, carregar modelo e inferir.
- Falhas viram `LlamaUnavailableError`, que causam fallback premium.

O prompt local usa `LlamaChatSession`, nao completion cru. Isso e importante
porque o GGUF e instruct/chat; com completion cru, ele tende a continuar o
documento e sujar a saida.

## 4. Smart Exec: como uma issue vira patch local

O orquestrador local fica em `smart-exec/orchestrator.ts`.

Fluxo detalhado:

1. `classifyIssue` analisa titulo, descricao, metadata e arquivos afetados.
2. Se ha arquivos explicitos em `metadata.affectedFiles`, eles viram alvo.
3. Se nao ha alvo, `warpGrepSearch` explora o repo por linguagem natural.
4. Arquivos grandes demais para o contexto local sao pulados ou vao para
   assistencia premium por arquivo.
5. Para cada arquivo alvo, o modelo local recebe:
   - objetivo da issue;
   - instrucao;
   - path;
   - conteudo do arquivo;
   - dica de foco com linhas provaveis;
   - restricoes de seguranca.
6. O modelo gera um "lazy edit": trecho alterado com linhas ancora reais e
   `// ... existing code ...` para partes inalteradas.
7. O app tenta aplicar o edit por `mergeLazyEdit`.
8. Se falhar, tenta retry local com arquivo numerado.
9. Se ainda falhar e houver Claude premium disponivel, `generatePremiumEdit`
   pede ao premium so o lazy edit daquele arquivo.
10. Se isso tambem falhar, escala a issue inteira para premium.
11. Se aplica, mede linhas mudadas, roda validacao detectada (`npm run typecheck`
    / `npm run lint` quando existem scripts).
12. Se validacao falha, tenta uma correcao local bounded.
13. Se falhar, rollback e premium.
14. Se passar, registra `task_executions`, `issue_runs`, comentario e aprendizado.

## 5. Aplicacao deterministica: Morph local

`smart-exec/morph.ts` e o aplicador deterministico. Existem dois estilos:

- SEARCH/REPLACE classico: `<<<<<<< SEARCH`, `=======`, `>>>>>>> REPLACE`.
- Lazy edit: snippet com anchors + `// ... existing code ...`.

Garantias importantes:

- Match exato primeiro.
- Depois normalizacao de whitespace.
- Depois fuzzy ancorado com limiar alto e apenas se houver exatamente um match.
- Multi-match ou ambiguidade falham.
- Lazy edit preserva head/gaps/tail do arquivo.
- Guarda contra encolhimento drastico de arquivo.
- Snapshot permite rollback.

Tambem existe `morphFastApply` via API externa `MORPH_API_KEY`, mas e opcional e
desligado por padrao. Sem chave, o caminho real e local/deterministico.

## 6. Fallback premium

O Forge escala para premium quando:

- modelo local nao esta empacotado;
- runtime/model load/inferencia falha;
- issue mira arquivo critico ou grande demais;
- exploracao local nao acha alvo acionavel;
- lazy edit nao aplica com seguranca;
- mudanca passa limite de linhas;
- validacao falha apos retry;
- handoff premium por arquivo nao consegue gerar/aplicar edit.

O fallback premium prefere o adapter do orquestrador do workspace; senao pega
qualquer agente Claude/Codex; se nao houver, cai para `claude_local` default.

## 7. O que o Forge "aprende"

O SLM nao altera seus pesos. Ele nao faz fine-tuning online, LoRA, distillation
nem treinamento incremental.

O que aprende, na pratica:

1. Aprende pelo **prompt atual**: contexto de issue, arquivos, KB, comments,
   instructions, skills e learnings.
2. Aprende pelo **historico persistente**: execucoes passadas viram paginas
   `agent-memory`.
3. Aprende por **skills**: playbooks criados/melhorados depois de runs.
4. Aprende por **perfil do usuario**: `workspace.user_profile`.
5. Aprende por **session_search**: conversas antigas indexadas por FTS5.

Esse e um modelo de aprendizado por memoria externa + RAG + in-context learning.
O modelo local continua o mesmo GGUF.

## 8. Base de conhecimento: estrutura

Tabelas principais:

- `kb_pages`: paginas hierarquicas, com `kind`:
  - `doc`
  - `index`
  - `auto-generated`
  - `agent-memory`
- `kb_links`: wikilinks e links explicitos entre paginas/entidades.
- `kb_entities`: entidades tecnicas/conceituais extraidas.
- `kb_relations`: relacoes entre entidades.
- `kb_chunks`: chunks gzip para BKF.
- `kb_token_index`: indice invertido para BM25.

`KbPageRepository` cuida de slug, tree, resolve wikilink, create/update/delete.
`kb-service.ts` orquestra pagina, link, entity, search, chunks e snapshots.

## 9. Como a KB cresce

Ha quatro vias principais.

### 9.1 Analise de source

`kb-request-analysis.ts` cria uma issue `Analisar source @label` com metadata:

```json
{ "kind": "kb-analysis", "sourceId": "...", "autoExec": true }
```

Essa issue auto-executa o orquestrador. O agente deve:

- criar root page `Repo: <source.label>`;
- ler arquivos do repo via tools nativas;
- criar paginas como Overview, Architecture, Stack, Dependencies, Directory
  structure, Critical flows, Pain points, Conventions, Setup;
- usar `kb_create_page`;
- linkar paginas via wikilinks ou `kb_link_pages`.

`kb-repo-analyzer.ts` tem uma rota anterior/alternativa que varre arquivos,
extrai deps/imports e spawna CEO para criar KB. O fluxo mais novo descrito em
`kb-request-analysis.ts` transforma isso em issue rastreavel.

### 9.2 Agentes criando memoria via MCP

O MCP interno expoe `kb_create_page`, `kb_search`, `kb_get_page`,
`kb_get_page_tree`, `kb_get_backlinks` e `kb_link_pages`.

As instructions injetadas em `AGENTS.md` mandam o agente:

- consultar `kb_search` antes de responder perguntas tecnicas;
- gravar descobertas nao-obvias como `kind='agent-memory'`;
- criar wikilinks `[[Titulo]]` para formar grafo.

### 9.3 Aprendizado automatico por execucao

`kb-learning.ts` grava uma pagina `agent-memory` ao fim de execucoes:

- sucesso local Forge;
- sucesso premium;
- falha/bloqueio fatal.

Titulo:

- `Learning: <issue.title> (<issueKey>)`
- `Blocker: <issue.title> (<issueKey>)`

Conteudo inclui issue, agente, outcome, resumo, arquivos tocados, detalhes e
objetivo. A mesma issue atualiza a pagina existente pelo slug, evitando duplicar.

Na proxima execucao, `buildIssueContext` chama `getRelevantLearnings`, que usa
BM25 para recuperar ate 3 memorias relevantes, priorizando blockers.

### 9.4 Skills e auto-curadoria

`bundled-skills.ts` semeia skills padrao em cada workspace.

`skill-review.ts` roda em background depois de execucoes nao-triviais. Um modelo
premium avalia se surgiu uma tecnica reutilizavel:

- `DECISION: NONE`
- `DECISION: CREATE`
- `DECISION: IMPROVE`

Skills criadas por agente sao auto-attachadas em todos os agentes. Skills do
usuario/marketplace sao protegidas contra alteracao por agente.

## 10. RAG atual

O RAG atual e lexical, nao vetorial:

- KB: BM25 proprio em `kb-search.ts`.
- Conversas: SQLite FTS5 em `messages_fts`.
- Codigo: WarpGrep deterministico em `warpgrep.ts`.

Nao ha embeddings, vector DB ou reranker neural hoje.

### 10.1 KB BM25

`kb-search.ts`:

- tokeniza PT/EN;
- remove stopwords;
- indexa titulo e body em `kb_token_index`;
- titulo tem boost 3x;
- body tem boost 1x;
- query expande termos com sinonimos/stems via `expandKeywords`;
- calcula BM25 on-the-fly;
- retorna pageId, title, slug, excerpt, score, parentId e kind.

### 10.2 Session search

`session-search.ts` cria/reconstroi lazy o indice `messages_fts`.

Ele extrai apenas partes `text` de mensagens `done` e busca por FTS5. Serve para
o agente recuperar decisoes/conversas passadas sem perguntar de novo ao usuario.

### 10.3 Code search

`code_search` no MCP chama `warpGrepSearch`, que:

- deriva keywords da query;
- expande sinonimos PT/EN;
- busca em arquivos de codigo;
- pesa match no path e em linhas estruturais;
- devolve arquivos e snippets com numeros de linha.

Esse e um RAG de codigo deterministicamente rankeado. Ele ajuda o CEO a criar
issues com arquivos reais e ajuda executores a nao editar por chute.

## 11. BKF: snapshot binario da KB

`kb-binary-storage.ts` implementa BKF:

- cada pagina vira um chunk gzip;
- chunk guarda pageId, parentChunkId, depth, tamanho, checksum;
- `kb_chunks` e a fonte persistida no SQLite;
- `writeBkfSnapshot` serializa tudo em arquivo `.bkf` agregado;
- snapshot e reconstruido em debounce quando paginas mudam;
- `rebuildSnapshots` reconstrui chunks, BM25 e BKF explicitamente.

Na arquitetura atual, o BKF existe como formato compacto/hierarquico para consumo
futuro/rapido por agentes, mas o RAG efetivamente usado nos MCP tools e prompts
e o BM25/FTS/WarpGrep textual.

## 12. Como o contexto entra no prompt

### Chat

`chat-service.ts` injeta:

- diretiva global de idioma/foco;
- `AGENTS.md` do agente;
- guidance por familia de modelo;
- skills instrucionais atachadas;
- sources em escopo;
- issues abertas recentes;
- diretiva de intent quando aplicavel;
- perfil persistente do usuario;
- historico recente da conversa;
- mensagem atual e anexos.

### Execucao de issue

`issue-execution-service.ts` injeta:

- diretiva global;
- instructions do agente;
- guidance por adapter/modelo;
- skills atachadas;
- contexto de sources;
- contexto da issue;
- aprendizados relevantes da KB;
- comentarios recentes da issue;
- objetivo vinculado;
- instrucoes de execucao ou modo review.

Ou seja: a memoria entra como texto recuperado e instrucoes no prompt, nao como
pesos treinados.

## 13. Telemetria e economia

`task_executions` registra:

- execution mode;
- modelo usado;
- risco;
- arquivos alterados;
- summary;
- validacao;
- fallback;
- tentativas;
- duracao;
- tokens premium evitados estimados;
- plano.

`issue_runs` tambem registra tokens/custo/tool count e `exitReason`:

- `local_resolved`
- `escalated_to_premium`

`exec-stats.repo.ts` e `task-execution.repo.ts` alimentam dashboards de economia.

## 14. Limitacoes atuais

- Sem fine-tuning real de pesos.
- Sem embeddings/vector search.
- Sem reranking neural.
- Sem treinamento incremental do SLM.
- BKF ainda parece mais snapshot/protocolo do que canal principal de RAG.
- Skills geradas dependem de Claude; se fallback premium for Codex, o review de
  skill e pulado.
- Handoff premium por arquivo tambem so suporta Claude.
- README do Forge tem mencao desatualizada ao 0.5B.

## 15. O que seria fine-tuning real neste projeto

Para virar fine-tuning de verdade, seria preciso adicionar um pipeline novo:

1. Coletar exemplos: issue, contexto, arquivo antes, lazy edit correto,
   validacao, arquivo depois.
2. Filtrar apenas execucoes bem-sucedidas e revisadas.
3. Gerar dataset supervisionado no formato do modelo instruct.
4. Rodar LoRA/QLoRA fora do app ou em job dedicado.
5. Avaliar em benchmark local de patches.
6. Empacotar novo adapter/modelo GGUF.
7. Versionar modelo e rollback.

Hoje o Orkestral faz algo mais seguro para app local-first: guarda memoria,
recupera contexto e melhora prompts/skills sem mexer nos pesos.

## 16. Modelo mental correto

```
Pesos do Forge
  = fixos, pequenos, especializados em edicao localizada

KB
  = memoria factual e historica do workspace

Skills
  = memoria procedural reutilizavel

Session search
  = memoria conversacional

User profile
  = memoria sobre preferencias do usuario

RAG
  = recuperacao lexical desses armazenamentos

Aprendizado
  = in-context learning alimentado por memoria persistente
```

O valor do sistema esta menos em "o SLM ficou mais inteligente" e mais em "o SLM
recebe cada vez mais contexto certo, mais cedo, e com menos chance de mirar no
arquivo errado".
