# Orkestral - Memoria tecnica do codebase

Este documento registra o contexto operacional do projeto para futuras mudancas.
Ele nao substitui a leitura do codigo no momento da alteracao, mas serve como
mapa fiel das responsabilidades, fluxos e pontos sensiveis.

## Resumo do produto

Orkestral e um app desktop local-first para orquestrar agentes de IA em cima de
workspaces de desenvolvimento. O produto une chat, agentes, issues/epicas,
execucao local/premium, code review, git, GitHub, rotinas, metas, marketplace de
skills/MCPs e knowledge base.

A ideia central e que o usuario conversa com um CEO/orquestrador; pedidos viram
trabalho rastreavel; especialistas executam ou revisam; e o conhecimento do
workspace fica persistido localmente em `~/.orkestral`.

## Stack e runtime

- Electron 39 + electron-vite 5, com `main`, `preload` e `renderer`.
- React 19, React Router 7, TanStack Query, Zustand, Tailwind CSS v4, Radix UI,
  Framer Motion, Lucide.
- SQLite local via `better-sqlite3` + Drizzle ORM.
- Modelos locais via `node-llama-cpp` (GGUF): **Forge** e **embeddings** baixam
  SOB DEMANDA do CDN proprio (R2) — NENHUM peso de modelo vem embutido (instalador
  fica pequeno). O Forge auto-atualiza pras versoes treinadas centralmente; os
  embeddings baixam no 1o uso da KB/busca semantica. Ver secao "Modelo local:
  distribuicao & sinais".
- Build/distribuicao com electron-builder. Os dois `.gguf` (Forge e embeddings)
  sao EXCLUIDOS do instalador (extraResources filter `!forge/models/*.gguf` +
  `!embeddings/models/*.gguf`). O build empacota recursos e unpack de binarios `.node`.
- Gate padrao do repo: `npm run typecheck`. Ha tambem testes unitarios em
  `vitest` (`npm test` / `npx vitest run`).

## Regras locais importantes

- Responder em portugues.
- Nunca rodar `git add`, `git commit`, `git push`, `git reset`, `git checkout`
  nem comandos que alterem estado git sem pedido explicito.
- Para UI, ler `docs/DESIGN_SYSTEM.md` antes de criar/mudar tela.
- Nunca hardcodar strings no JSX; usar `useT()` e adicionar chaves em `en` e
  `pt-BR`.
- Usar tokens do design system, `cn()` para classes compostas e componentes em
  `src/renderer/src/components/ui/` antes de criar primitives novas.
- Mudanca de schema exige nova migration versionada em
  `src/main/db/migrations.ts`; nao editar migration antiga.

## Estrutura principal

- `src/main`: processo principal Electron, banco, IPC, servicos, adapters,
  schedulers, GitHub/Git/MCP/execucao.
- `src/preload`: bridge segura que expoe `window.orkestral` e
  `window.orkestralEvents`.
- `src/renderer`: app React, rotas, paginas, componentes, stores, i18n e estilos.
- `src/shared`: contrato IPC e tipos compartilhados.
- `resources`: icones, background de DMG, arquivos do Forge.
- `docs`: design system e planos/specs.

## Boot do app

`src/main/index.ts`:

1. Ajusta `__dirname` para ESM.
2. Corrige PATH em producao via `fixPath()`.
3. Cria a janela Electron com context isolation, preload e spellcheck desligado.
4. Define nome/menu/icone do app.
5. Inicializa banco em `~/.orkestral/instances/default/db/orkestral.db`.
6. Roda migrations.
7. Limpa mensagens/runs/heartbeats orfaos.
8. Registra todos os IPC handlers.
9. Inicia scheduler de heartbeat e rotinas.
10. Sobe MCP HTTP local.

`src/preload/index.ts` constroi dinamicamente a API `window.orkestral` a partir
de `IPC_CHANNELS` e registra eventos de streaming: chat, code review, source
clone, KB analyze, issue execution, logs e mudancas de issues.

## IPC

O contrato unico vive em `src/shared/ipc-contract.ts`. Existem cerca de 193
canais, agrupados por dominios como `workspace`, `agent`, `session`, `chat`,
`issue`, `kb`, `source`, `git`, `github`, `code-review`, `marketplace`,
`routine`, `goal`, `logs`, `data`, `settings` e `system`.

Handlers ficam em `src/main/ipc/handlers/` e sao registrados por
`src/main/ipc/index.ts`. `registerHandler` em `src/main/ipc/register.ts` garante
canal unico, tipagem e serializacao de erro.

Regra de manutencao: quando uma feature atravessa main e renderer, normalmente
passa por `shared/types`, `shared/ipc-contract`, handler/repo/service no main e
query/store/pagina no renderer.

## Banco

`src/main/db/connection.ts` define:

- `ORKESTRAL_HOME = ~/.orkestral`
- instancia default em `~/.orkestral/instances/default`
- banco em `db/orkestral.db`
- attachments em `attachments`
- workspaces em `~/.orkestral/workspaces`

`schema.ts` tem 34 tabelas principais: users, workspaces, projects, settings,
agents, heartbeat runs, API keys, skills, issues, issue runs, comments,
activity, routines, goals, workspace sources, code reviews, onboarding,
sessions, messages, agent runs, GitHub accounts, KB pages/links/entities/
relations/chunks/token index, task executions, issue dependencies/reviewers e
trace logs.

`migrations.ts` usa `PRAGMA user_version`. No momento ha 36 migrations; a ultima
e `workspace_user_profile`.

Repos em `src/main/db/repositories/` encapsulam acesso aos dados. Evitar SQL em
handler IPC quando ja existe repo de dominio.

## Agentes e adapters

`src/main/adapters/registry.ts` registra adapters:

- Recomendados: `claude_local`, `codex_local`, `orkestral_local`.
- Outros locais visiveis: Gemini, OpenCode, Pi, Grok, Cursor, Hermes.
- Config-driven: Cursor Cloud e OpenClaw Gateway.

`claude_local` e `codex_local` possuem probes reais de CLI. `orkestral_local` e
o Forge executor local. Alguns adapters aparecem no onboarding/registry mas nao
executam issues; `adapter-availability.ts` produz mensagens honestas para esses
casos.

## Chat

`src/main/services/chat-service.ts` e o centro do chat:

- Persiste mensagem do usuario, cria `agent_run`, cria mensagem assistant em
  streaming.
- Resolve adapter efetivo; se o agente e `orkestral_local`, chat cai para um
  agente premium do workspace.
- Garante instructions padrao e skills bundled.
- Injeta diretiva global de idioma/foco.
- Junta instructions do agente, skills de instrucao, contexto de sources,
  issues abertas, perfil do usuario e historico recente da conversa.
- Salva anexos em disco temporario para leitura pelo CLI.
- Monta MCP config por run, incluindo server interno Orkestral, MCPs de
  marketplace e Playwright quando o toggle de browser esta ativo.
- Spawna Claude/Codex ou chama adapters de rede.
- Faz parser de stream JSON do Claude e Codex, emitindo partes de texto,
  thinking, tool calls e fases.
- Processa blocos `<orkestral:create-issue>` e hiring plans.
- Faz post-validation: se a intent parecia planejamento/bug e nenhuma issue foi
  criada, anexa aviso na resposta.

`intent-detector.ts` separa perguntas simples, planejamento, bug investigation e
hiring. O orquestrador deve criar/delegar issues; especialistas devem registrar
issue antes de executar.

## Issues e execucao

`src/main/services/issue-execution-service.ts` executa issues em background.

Fluxo:

1. Valida issue, assignee e adapter.
2. Atualiza issue para `in_progress`.
3. Cria `issue_run`.
4. Enfileira execucao com limite global de 3 runs.
5. Bloqueia concorrencia no mesmo source/repo.
6. Serializa Forge local.
7. Resolve cwd pelo source da issue, usando `metadata.sourceId` ou tokens de
   titulo/labels.
8. Para `orkestral_local`, tenta Smart Exec/Forge; em falha, registra escalacao
   e usa fallback premium.
9. Para Claude/Codex, spawna CLI com MCPs e parseia stream.
10. Conta tool calls, tokens e custo quando disponivel.
11. Usa watchdog global de 20 minutos e stall de 4 minutos sem atividade.
12. Grava comentarios, run summary, aprendizados na KB e possiveis skills.
13. Roteia para revisao hierarquica via `reportsTo`.

Auto-exec dispara quando a issue tem label `auto-exec`, metadata de KB analysis
com `autoExec`, ou status `todo`. Se reporter e assignee sao o mesmo agente, nao
auto-executa para evitar duplicidade.

## Smart Exec / Forge

Arquivos em `src/main/services/smart-exec/`.

Responsabilidades:

- `classifier.ts`: heuristica deterministica de risco, arquivos afetados e modo
  de execucao.
- `warpgrep.ts`: busca local por linguagem natural para achar arquivos/linhas
  provaveis.
- `local-patcher.ts`: prompta o modelo local para gerar lazy edits.
- `morph.ts`: aplica SEARCH/REPLACE e lazy edits com ancoras de forma
  deterministica; rejeita ambiguidades.
- `diff.ts`: snapshots, apply, rollback e validacao de seguranca.
- `llama-runtime.ts`: carrega o GGUF sob demanda, mantem modelo quente durante
  runs e descarrega por ociosidade.
- `orchestrator.ts`: classifica, explora repo, gera edit local, aplica, valida,
  tenta correcao, usa assistencia premium por arquivo e escala quando necessario.
- `premium-edit.ts`: Claude pode gerar so o lazy edit para um arquivo quando o
  local falha, antes de cair para run premium completa.

Principio-chave: o modelo nunca edita arquivo diretamente. Ele gera texto; o app
aplica com snapshot/rollback/limites/validacao.

## Modelo local: distribuicao & sinais (Forge)

NENHUM peso de modelo vem embutido no instalador (pra ele ficar leve/baixar
rapido). Tanto o **Forge** quanto os **embeddings** baixam sob demanda do CDN
proprio (R2). O Forge auto-atualiza pras versoes treinadas centralmente.

- `model-download-service.ts`: download dos GGUF pro diretorio de dados
  (`~/.orkestral/models/{forge,embeddings}`), validacao por tamanho, .part +
  rename atomico. `ensureForgeDownloaded` (via manifesto), `checkForgeUpdate`
  (auto-update no boot + a cada 24h, troca o GGUF no lugar) e
  `ensureModelsDownloaded(..., {only:['embeddings']})` pros embeddings.
- `forge-manifest.ts`: busca `forge/manifest.json` no CDN
  (`ORKESTRAL_FORGE_CDN`, default `forge.orkestral.pro`) e rastreia a versao
  instalada em `version.json`.
- **Forge** = modelo de codigo local; default, sob demanda, treinado centralmente
  a partir dos sinais e entregue como nova versao (trocada no lugar).
- **Embeddings**: baixam PREGUICOSAMENTE no 1o `embedTextLocal` (KB/busca
  semantica). `local-embedding-runtime.ts` resolve do data dir primeiro; se
  faltar, chama `ensureModelsDownloaded` e re-resolve. O broadcaster de progresso
  e injetado no boot via `setEmbeddingDownloadProgress` (DI, pra nao puxar
  electron pro grafo de testes).
- IPC `models:forge-status` / `models:download-forge` (app.ts); card em
  `IntegrationsPage` (`LocalModelCard`, padrao do Whisper). Recusar o download
  do Forge = roda no premium (fallback de runtime ja existente).

Sinais de treino (code-free) que melhoram o Forge:

- `forge-signals-service.ts` (PURO; deps injetadas no boot via `initForgeSignals`
  pra nao puxar electron pro grafo de testes) usa `@orkestral-ai/forge-sync`.
  Captura em `stampVerifiedVerdict` (issue-execution-service): veredito do review,
  Forge-vs-premium, tipo de correcao — NUNCA codigo.
- Endpoint via `getForgeSignalsEndpoint()` (cloud-auth) → Edge Function
  `forge-signals` (Supabase) → tabela `forge_signals` (RLS, service-role only).

Injecao de config no build: o `define` do `electron.vite.config` baka
`ORKESTRAL_SUPABASE_URL`/`FORGE_CDN` no bundle do main em build-time
(app empacotado nao tem `process.env`). Fonte: `.env` local (gitignored) ou
secret/env do CI. Source sem URL (env-only, sem exposicao no open-source).

## MCP interno

`src/main/services/mcp-server.ts` sobe um server HTTP local autenticado por token
e workspace header. Ferramentas principais expostas aos agentes:

- Workspace/contexto: `get_workspace_info`, `list_sources`, `list_agents`.
- Issues: `list_issues`, `search_issues`, `get_issue`, `create_issue`,
  `update_issue`, `update_issue_status`, `assign_issue`, `comment_on_issue`,
  `get_open_work_summary`.
- KB: `kb_search`, `kb_create_page`, `kb_get_page`, `kb_get_page_tree`,
  `kb_get_backlinks`, `kb_link_pages`.
- Skills: `skill_list`, `skill_view`, `skill_create`, `skill_improve`.
- Outros: `session_search`, `code_search`, `update_goal_status`,
  `get_user_profile`, `update_user_profile`.

Esse MCP e o mecanismo que transforma decisoes de agentes em estado persistente
sem depender de parsing de prosa.

## Knowledge base

`kb-service.ts` orquestra paginas, links, entidades, busca e snapshots.

`kb-search.ts` implementa BM25 simples em SQL usando `kb_token_index`, com
tokens PT/EN, stopwords, boost de titulo e expansao via `warpgrep`.

`kb-binary-storage.ts` gera BKF, um formato binario proprietario com chunks gzip
hierarquicos e index no final. Tambem persiste chunks no SQLite.

`kb-repo-analyzer.ts` varre um source, cria pagina raiz, extrai entidades
tecnicas de package/imports, gera sumario base e entao spawna o CEO via
Claude/Codex com MCP para criar paginas profundas da KB. A analise e cancelavel
e emite eventos para a UI.

## Git/GitHub

`git-service.ts` encapsula comandos git via `execFile` com timeout/buffer:
status, diff, branches, checkout/create branch, stage/unstage, commit, push,
fetch, pull, log, show commit, discard e ignore.

O repo tem regra humana de nunca mexer em git sem pedido. Isso vale mesmo que os
canais IPC tenham suporte a git.

`github.ts` implementa Device Flow, criptografa token com `safeStorage`, lista
repos/PRs, busca diff/PR, posta review, cria PR e clona repo.

## Renderer

`src/renderer/src/main.tsx` define tema dark inicial e monta React.

`App.tsx` envolve QueryClient, TooltipProvider, OnboardingGate, Router, modais
globais, CommandPalette e Toaster. Tambem liga bridges globais de eventos:

- chat stream para `chatStore`;
- issues changed para invalidar queries e notificar;
- source clone concluido para disparar KB analysis pendente;
- issue execution para `executionStore`;
- KB analyze done/error para invalidar arvore/grafo.

`router.tsx` usa HashRouter. Rotas centrais ficam eager; rotas pesadas usam
`React.lazy` para nao inflar o chunk inicial.

Paginas mais pesadas/sensiveis:

- `CodeReviewsPage.tsx`
- `AgentPage.tsx`
- `IssueDetailPage.tsx`
- `CodeChangesPage.tsx`
- `IssuesPage.tsx`
- `InboxPage.tsx`

Stores principais:

- `chatStore`: estado de sessoes/mensagens e streaming.
- `settingsStore`: hidrata settings e aplica tema/accent/fonte/densidade.
- `workspaceStore`, `scopeStore`, `uiStore`: contexto global e UI.
- `executionStore`: trace vivo por issue.
- stores de read/dismiss/view para inbox/issues/sessions.

## i18n e design

`src/renderer/src/i18n/index.ts` e um i18n leve com `import.meta.glob` para
locales `en` e `pt-BR`. Chave sempre no formato `<area>.<path>`.

`global.css` define tokens Tailwind v4 em `@theme`, tema light, accent por
workspace, densidade, tamanho de fonte, wide chat, code wrap, scrollbars e
classes globais.

Antes de mexer em UI:

- usar tokens (`bg-background`, `text-text-secondary`, etc.);
- usar componentes primitives;
- usar Lucide para icones;
- nao usar emoji em UI;
- nao usar cor crua estatica;
- adicionar traducoes nos dois locales.

## Onboarding

`onboarding.ts` cria user, workspace, primeiro agente CEO, source primario,
instructions default e pode disparar hiring plan. Para GitHub, o fluxo cria o
workspace antes do clone e `workspace:finalize-github` atualiza o path e dispara
o plano apos clone.

O primeiro agente nasce como orquestrador, com permissoes amplas e
`runtimeConfig.bypassSandbox = true` por padrao para evitar travas de permissao
em analise/execucao.

## Code review

`code-review-service.ts` roda reviews de PR via agente, captura diff do GitHub,
gera achados estruturados, comentarios, walkthrough, severidade/recomendacao e
pode postar no GitHub. A UI grande fica em `CodeReviewsPage.tsx`.

## Rotinas, metas e heartbeat

`heartbeat-service.ts` roda heartbeat manual ou agendado de agentes.
`routine-service.ts` roda rotinas recorrentes.
`routine-goal.repo.ts` guarda rotinas/metas e recalcula progresso de metas.
Goals tambem podem ser planejadas/verificadas via IPC.

## Observabilidade

`log-bus.ts` grava trace logs e transmite eventos para o renderer.
`trace-log.repo.ts` limita historico por cap.
`run-diagnostics.ts`, `exec-stats.repo.ts` e `task-execution.repo.ts` alimentam
diagnosticos, economia local vs premium e historico de smart-exec.

## Pontos de risco para futuras mudancas

- `chat-service.ts`, `issue-execution-service.ts`, `mcp-server.ts` e
  `code-review-service.ts` sao arquivos grandes com muita regra de negocio.
- `skills-issues.ts` registra muitos dominios em um unico handler.
- Mudancas em issue status podem afetar Inbox, Dashboard, Goals, execution queue,
  MCP e chat de origem.
- Mudancas em `workspace_sources` afetam cwd de agentes, concorrencia de runs,
  KB analysis, Git/GitHub e scope de chat.
- Mudancas em renderer devem respeitar i18n e design system.
- Smart Exec altera arquivos reais; sempre considerar snapshot/rollback,
  validacao e fallback premium.
- Canais Git existem, mas o operador humano controla git no workspace.

## Checklist de manutencao

1. Entender o dominio pelo contrato IPC e pelos repos antes de editar UI.
2. Se mudar dados persistidos: `schema.ts` + migration nova + repo + tipos.
3. Se mudar UI: i18n nos dois idiomas + tokens do design system.
4. Se mudar chat/execucao: verificar eventos do preload, stores e invalidações.
5. Se mudar issues: verificar auto-exec, revisao hierarquica, metas, inbox e MCP.
6. Se mudar KB: verificar BM25, BKF snapshot, graph links e analyze events.
7. Rodar `npm run typecheck` quando a mudanca for de codigo.

## Features planejadas / parciais (NAO sao dead code)

Alguns modulos existem mas ainda nao estao 100% ligados na UI. Sao **roadmap**,
nao lixo — nao apagar sem combinar:

- **Integracoes de observabilidade** — repos/servicos de `observability`,
  `sentry`, `azure-devops`: o backend (repos, rules, automation) existe; a
  ligacao completa na UI esta em andamento.
- **Secret store** (`tool-secret.repo.ts`) — guarda chaves de ferramentas
  cifradas via Electron `safeStorage`; usado pela central de Ferramentas.
- **Repos de KB avancada** (`kb-embedding-job`, `kb-analysis-job`,
  `multi-agent`, `ai-learning`): infra de RAG/treino que cresce com o roadmap.
- **Rotinas** (`RoutinesPage` + nav `/routines`) — a pagina existe mas a **rota
  ainda nao esta registrada no `App.tsx`**; feature em construcao.

## Seguranca (resumo — ver `SECURITY.md`)

Os agentes podem **executar codigo/comandos na maquina do usuario** por design
(`bypassSandbox` default `true` em `spawn-policy.ts`/`onboarding.ts` = autonomia
do produto). A superficie de ataque principal e prompt-injection. O codigo do
usuario nunca sai da maquina; segredos de ferramentas ficam cifrados via
`safeStorage`. Detalhes e como reportar vulnerabilidade: `SECURITY.md`.
