# HORIZON — Orquestração recursiva de horizonte longo

> A tese: "um prompt → um sistema do porte de uma AWS interna" não é geração mágica.
> É **recursão** (planos que planejam planos) + **verificação** (nenhum nó fecha sem
> evidência executável) + **memória** (cada projeto deixa o sistema melhor) + **tempo**
> (runs de dias, não de minutos). O gargalo de sistemas gerados por IA nunca foi gerar
> código — é verificar e integrar as COSTURAS entre subsistemas. Este documento é o
> desenho executável disso em cima do que o Orkestral JÁ tem, com âncoras de arquivo.

## Por que o Orkestral consegue e um CLI solto não

Um CLI (Claude Code puro) tem um contexto, uma thread, uma sessão. Morreu o contexto,
morreu o projeto. O Orkestral tem o que um run de dias exige e um CLI não tem:

- **Estado durável fora do contexto**: issues/goals/runs em SQLite (`src/main/db/schema.ts`)
  sobrevivem a restart, crash e troca de modelo.
- **Times com papéis e hierarquia**: `agents.reports_to`, orquestrador vs. executor
  (`mcp-tool-scope.ts`), contratação dinâmica (hiring).
- **Gates de qualidade por nó**: QA opera a UI e captura screenshot
  (`issue-execution-service.ts`, modo QA VALIDATION), review com caps, replan limitado.
- **Checkpoint por entrega**: commit automático por issue (`commitIssueCheckpoint`).
- **Memória composta**: KB por workspace (BM25), `agent-memory`, `skill_create`,
  e tabelas dormentes de aprendizado (`forge_edit_examples`, `ai_training_examples`).

## Fase 1 — Recursão de planos (o fractal)

**Hoje:** um plano é 1 épica + N sub-issues folha. `runnablePlanIssueWave`
(`issue-plan-sequencing.ts`) opera só nos filhos diretos de uma épica.

**Alvo:** sub-issue pode ser uma SUB-ÉPICA com plano próprio. "Construir um clone da
AWS" vira: épica-raiz → sub-épicas (Compute, Storage, IAM, Billing, Console) → cada uma
com seu próprio Conselho, seu próprio time e suas próprias folhas.

Mudanças (todas pequenas — o schema já aninha via `parent_issue_id` sem limite):

1. **Scheduler recursivo**: `startRunnablePlanIssueWave` desce a árvore — sub-épica
   "runnable" = disparar a onda dos filhos DELA; sub-épica "done" = todos os filhos
   done (o rollup `syncEpicStatus` já existe, conferir profundidade > 1).
2. **Sub-orquestrador**: sub-épica com assignee orquestrador (TechLead tem
   `isOrchestrator` na classificação de `classifyAgentToolRole`) roda um TURNO DE
   PLANEJAMENTO em vez de execução: Conselho local → `create_issue_plan` com
   `parent_issue_key` da sub-épica. O protocolo do CEO ganha 1 parágrafo: "escopo
   MEGA → planeje épicas-de-épicas e delegue o detalhamento ao sub-orquestrador".
3. **Contratos entre sub-épicas**: cada sub-épica publica no KB uma página
   `CONTRACT: <nome>` (API/eventos/tabelas que expõe). Sub-épicas vizinhas dependem
   dela via `add_issue_dependency` (implementada em 2026-07-04) e o executor recebe o
   contrato no `planSpecBlock` — é isso que faz as costuras baterem.

## Fase 2 — Horizonte longo (dias, não minutos)

**Hoje:** goal existe e auto-verifica no 100% (`maybeAutoVerifyGoal`); replan em
divergência existe com cap 2 (`issue-replanning.ts`); heartbeat existe
(`heartbeat-service.ts`).

**Alvo:** loop de convergência com orçamento honesto:

- `goals` ganha `token_budget` e `deadline` (migration nova). O agregado de custo já
  existe por run (`issue_runs.tokens_*`, `agent_runs`).
- Goal não atingido + orçamento sobrando → o heartbeat acorda o CEO com o DELTA
  ("o que falta entre o estado atual e o goal") — um turno de replanejamento que abre
  as issues do gap. Goal atingido OU orçamento estourado → para e reporta com número.
- Retomada fria: app reiniciou no meio → a fila reconstrói das issues `in_progress`
  sem run ativo (hoje ficam órfãs até intervenção manual).

## Fase 3 — Verificação como cidadã de primeira classe

**Hoje (2026-07-04):** folha só fecha com build+verify do executor; QA opera a UI e
anexa screenshot; controle morto reprova.

**Alvo — subir a régua pro nível das costuras:**

- Ao fechar uma sub-épica, gerar automaticamente uma issue `[INTEGRATION]` que valida
  o CONTRACT dela contra os consumidores (teste de contrato executável, não leitura).
- E2e smoke por épica-raiz: o QA roda o fluxo principal ponta-a-ponta no preview
  (`capture_preview` + interação) antes do goal poder fechar.
- Toda evidência vira comentário na issue → o CEO valida o goal contra EVIDÊNCIA,
  não contra status.

## Fase 4 — Memória que compõe (o sistema melhora a cada projeto)

- `skill_create` já cura playbooks; o índice enxuto (2026-07-04) os expõe barato.
- Ativar `forge_edit_examples`/`ai_training_examples` como RAG de edits aceitos:
  few-shot do estilo REAL do usuário no fast-apply (o campo `examples` de
  `LocalPatchInput` já existe, dormante).
- Gotchas de stack (`agent-memory`) entram no `planSpecBlock` das issues da mesma
  stack — o segundo projeto Next.js nunca repete o erro do primeiro
  (ex.: "next build quebra com NODE_ENV=development", salvo pelo QA em 2026-07-04).

## Economia — o que existe de verdade (sem moto-perpétuo)

| Alavanca                                         | Estado           | Efeito                          |
| ------------------------------------------------ | ---------------- | ------------------------------- |
| Cache de prefixo (`--append-system-prompt`)      | ligado           | prefixo estável entre runs      |
| Protocolos enxutos                               | feito 2026-07-04 | −55% de scaffolding/turno       |
| Skills por índice + `skill_view`                 | feito            | −vários k/run                   |
| Fast-apply (`edit_file`, morph + GGUF local)     | ligado           | edits sem retypar o arquivo     |
| Effort routing (`--effort low` no executor)      | ligado           | raciocínio caro só onde precisa |
| Roteamento por risco (`model-routing-policy.ts`) | **dormante**     | folhas triviais em modelo menor |
| Paralelismo 8 global / 3 por repo                | feito            | wall-clock, não tokens          |

"Bypass do modelo" não existe; o que existe é nunca pagar duas vezes pelo mesmo
contexto e nunca usar raciocínio caro em tarefa barata. As duas últimas linhas da
tabela são o que ainda dá pra colher.

## Ordem de execução (cada fase é um PR revisável)

Status em 2026-07-04 (implementado nesta base, aguardando restart do app + validação):

1. ✅ Fase 1.1 — scheduler recursivo + rollup profundo. `startRunnablePlanIssueWave`
   desce a árvore (sub-épica com plano → onda dos filhos; já ativa → re-bombeada);
   `maybeStartNextPlanIssue` sobe quando a sub-épica assenta; `syncEpicStatus`
   cascateia o reopen pros avós; `isSubEpicIssue` puro + testado.
2. ✅ Fase 1.2 — turno de planejamento do sub-orquestrador. Placeholder `[EPIC]` sem
   filhos → `requestSubEpicPlanTurn` (prompt oculto `[[SUB_PLAN_HIDDEN]]`);
   `create_issue_plan` ganhou `parent_epic_key` (sub-plano nasce sob a sub-épica,
   raiz aprovada → filhos em `todo`, sem novo gate); parágrafo "MEGA scope" no
   protocolo do CEO; dedup de sub-issues escopado por pai (títulos genéricos entre
   sub-épicas não colidem mais).
3. ✅ Fase 1.3 — páginas CONTRACT. O turno de sub-plano publica `CONTRACT: <nome>` no
   KB; `buildContractsBlock` injeta no executor o contrato da própria cadeia (o que
   expor) + os das dependências (o que consumir), com clamp.
4. ✅ Fase 2 — migration v83 (`token_budget`, `convergence_count`,
   `last_convergence_at` em goals; deadline reusa `due_date`);
   `maybeRequestGoalConvergence` (plano assentou + goal <100% → CEO re-entra com o
   delta; orçamento estourado/cap de 5 turnos → REPORT honesto com número);
   `sweepStalledGoals` no boot; retomada fria de issues `in_progress` órfãs no
   `resumeInterruptedWork`; `token_budget` exposto no `create_goal`.
5. ◐ Fase 3 — issues `[INTEGRATION]` automáticas: sub-épica com CONTRACT fecha →
   `maybeCreateIntegrationIssue` cria a validação executável sob o avô e re-ancora
   os consumidores ainda parados nela (gate NA costura). PENDENTE: e2e smoke por
   épica-raiz antes do goal fechar (extensão do goal-verify; hoje o QA VALIDATION
   MODE cobre por issue).
6. ✅ Fase 4 — RAG de edits aceitos reativado: `forge_edit_examples` de volta ao
   schema/repo real; `edit_file` grava candidato a cada merge aplicado e usa top-3
   aceitos como few-shot no tier GGUF; `stampVerifiedVerdict` assenta os candidatos
   de TODOS os runs da issue (verificada → aceitos). Gotchas de stack
   (`getRelevantLearnings`) agora entram TAMBÉM no turno de planejamento do
   sub-orquestrador (antes só no executor).

Pré-requisito de honestidade continua: rodar o benchmark N=1 (baseline) e re-rodar
após validar as fases em produção. Medir antes de afirmar superioridade.
