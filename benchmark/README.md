# Orkestral Benchmark — Claude Code puro vs. Orkestral

> Objetivo: medir, com honestidade e sem achismo, se o Orkestral orquestrando
> entrega **melhor e/ou mais barato** que o `claude` (Claude Code) puro, no mesmo
> prompt e na mesma máquina. Este harness existe pra responder a pergunta do dono
> antes de cortar/limpar o produto.
>
> Princípio (aprendizado-mestre): **medir antes de afirmar superioridade.**

## A hipótese sob teste

Prior honesto (do audit de código): no **custo**, o Claude Code puro deve ganhar
(o Orkestral prepende ~30k chars de scaffolding por turno do orquestrador,
reenviados sem cache). Na **qualidade**, é não-comprovado. Este benchmark falsifica
ou confirma isso com dados.

> **Nota (2026-07-04):** o prior acima foi medido ANTES da reforma de prompts.
> Hoje o scaffolding do orquestrador é ~13k chars (protocolos cortados ~55%, KB
> opt-in, skills viraram índice) e a execução roda até 3 issues em paralelo no
> mesmo repo. O benchmark agora mede a arquitetura nova — rodar o N=1 dá o número
> pós-reforma.

## Os dois braços

|                  | Braço A — `claude` puro               | Braço B — Orkestral                             |
| ---------------- | ------------------------------------- | ----------------------------------------------- |
| Driver           | `claude -p` agêntico (headless)       | App Orkestral (GUI) orquestrando                |
| Contexto inicial | Pasta vazia + `CLAUDE.md` mínimo      | Workspace novo + pasta vazia como source        |
| Permissões       | `--dangerously-skip-permissions`      | igual (o Orkestral usa `--yolo` por padrão)     |
| Modelo           | **o mesmo dos dois lados, EXPLÍCITO** | o mesmo, selecionado no wizard (nunca "Padrão") |

> **Fairness é tudo.** Mesmo modelo (explícito — "Padrão"/default deixa cada braço
> resolver um modelo diferente), mesma máquina, mesmo prompt (o texto de `PROMPT.md`
> **sem** o comentário HTML do topo, nos dois braços), mesmas permissões. A única
> variável é "tem orquestração no meio ou não".

## Como capturar custo/tokens (apples-to-apples)

Os dois braços acabam dirigindo o binário `claude`, então medimos no nível do CLI:

- **Braço A:** o runner (`run-raw-arm.sh`) salva o `stream-json` completo e extrai
  do evento final `result`: `total_cost_usd`, `usage` (input/output/cache), `num_turns`,
  `duration_ms`. O summary sobrevive a falha/Ctrl-C (`claude_exit_code` registra como
  o run terminou) e grava o modelo **resolvido** pelo CLI (`model_used`).
- **Braço B:** custo em TRÊS tabelas do SQLite do app — `issue_runs` (executores),
  `agent_runs` (turnos do orquestrador no chat; capturado desde o fix v81 de
  jul/2026) **e** `kb_analysis_jobs` (runs LLM do analisador de repo; capturado
  desde o fix v82 — o analyzer dispara na ingestão do source e RE-dispara a cada
  issue executada via `ensureSourceFresh` quando o workspace muda, então num run
  de benchmark ele roda várias vezes). Total B = soma das três. Query pronta em
  `RESULTS.template.md`.
- **Custo fora do DB (Braço B):** o `skill-review` dispara um `claude --print` extra
  após runs não-triviais e esse gasto não é persistido. Para o benchmark, lance o app
  pelo shell com `ORKESTRAL_SKILL_REVIEW_DISABLE=1` e registre isso no RESULTS — ou
  aceite o gasto invisível e anote que o custo do braço B está subestimado.

## Métricas (por braço, agregadas sobre N runs)

1. **$ custo total** (mediana + min/max) — métrica primária (tokens subcontam cache)
2. **Tokens** input/output (cache: só o braço A tem a decomposição completa no `usage`)
3. **Wall-clock** até "terminou" (no braço B, descontar/anotar o tempo humano de aprovação)
4. **% de runs que produzem um MVP rodável** (buildou + typecheck + fluxo core funciona)
5. **Score de qualidade** (rubrica cega, `RUBRIC.md`, 0–100)
6. **Terminou dentro de UMA sessão de budget?** (sim/não) — o sintoma que o dono relatou

## Assimetrias conhecidas (registrar no RESULTS — não "corrigir")

O braço B mede o Orkestral **como ele é**. Estes comportamentos do produto divergem do
braço A por design; o protocolo é registrá-los, não mascará-los:

- **Watchdog do executor:** cada run de issue morre em 20min (e em 4min sem evento do
  CLI — um tool-call único longo, ex. test suite de 5+ min, conta como stall). O braço A
  roda sem teto. `issue_runs.exit_code` distingue: `-2` = timeout, `-3` = stall — a query
  do RESULTS expõe isso pra separar "falhou" de "foi cortado".
- **Turno leve do CEO downgrada pra Sonnet:** com modelo Opus/Fable/default, turnos
  não-pesados do orquestrador rodam `claude-sonnet-4-6` hardcoded (economia por
  design). Usar um modelo explícito de tier médio nos dois braços (ex.: sonnet)
  elimina a mistura; com Opus/Fable, anote que o braço B mistura modelos nos turnos
  de orquestração.
- **Effort dos executores:** agentes executores (frontend/backend/…) nascem com
  `fastMode=true` → rodam `--effort low`; o braço A roda no effort default do CLI.
  Registrar o effort efetivo por braço no RESULTS. (Para neutralizar: desligar fastMode
  e deixar thinkingEffort/adapterConfig.effort em "auto" em TODOS os agentes — trabalho
  manual por agente na GUI; a opção padrão é medir as-built e registrar.)

## N (número de runs)

LLM tem variância alta; 1 run não prova nada. Mas 5×2 builds de SaaS é caro
(horas + $). Plano pragmático:

- **Piloto: N=1 por braço.** Valida o harness e dá leitura direcional.
- Se a diferença for clara (ex: um braço falha em rodar, ou custa 3×), **pare** —
  a resposta já apareceu.
- Se ambígua, **escale pra N=3** e, se ainda ambíguo, N=5.

## Procedimento

### Braço A (automatizável)

```bash
# pré-requisitos: claude logado, jq instalado
cd benchmark
./run-raw-arm.sh 1 <modelo>     # modelo OBRIGATÓRIO (ex.: claude-opus-4-8)
./run-raw-arm.sh 2 <modelo>     # se for escalar N
```

Cada run gera `runs/raw/run-N/{workspace/, output.jsonl, summary.json}`.
O summary é escrito mesmo se o `claude` falhar ou o run for interrompido.

### Braço B (semi-manual — GUI)

> O fluxo do Orkestral tem **dois gates de aprovação humana** e exige uma pasta
> anexada. Pular qualquer um destes passos invalida o run (o plano fica parado em
> backlog pra sempre, ou os executores rodam no diretório errado).

1. Crie uma **pasta local vazia** pro run (análogo do `workspace/` do braço A), ex.:
   `benchmark/runs/orkestral/run-N/workspace/`.
2. Abra o Orkestral e crie um **workspace novo** com o mesmo provider e o **modelo
   EXPLÍCITO** usado no braço A (nunca "Padrão" — "Padrão" cai no default global do
   CLI e quebra a paridade). Anexe a pasta do passo 1 como **source** do workspace
   (sem source, o executor spawna com cwd herdado do processo Electron e escreve o
   app no lugar errado).
3. **Aprove o plano de hiring** do time inicial que o CEO propõe (card no Inbox/chat).
   Sem time aprovado, as sub-issues ficam sem assignee e o plano trava em silêncio —
   com uma mensagem enganosa de "Execução iniciada".
4. Cole no chat do orquestrador o conteúdo de `PROMPT.md` **sem o comentário HTML do
   topo** (o mesmo texto que o `run-raw-arm.sh` extrai). Anote o horário de início.
5. Quando o plano (épica + sub-issues) aparecer, clique **"Aprovar e executar"** (o
   botão, não uma mensagem "approve" no chat — o botão não gasta tokens; uma mensagem
   custaria mais um turno de orquestrador). Anote o tempo humano entre colar o prompt
   e aprovar, pra descontar do wall-clock.
6. Deixe rodar até o fim (ou até estourar a sessão). Anote o fim.
7. O output é a própria pasta source do passo 1 — se necessário, copie pra
   `runs/orkestral/run-N/workspace/`. Leia custo/tokens com a query do
   `RESULTS.template.md` (soma `issue_runs` + `agent_runs`).

### Julgamento (cego)

Para cada par de outputs, aplique `RUBRIC.md`. Use um 3º agente como juiz **sem
saber qual braço é qual**:

1. Copie APENAS os dois `workspace/` (nunca `summary.json`/`output.jsonl`, que
   nomeiam o braço) para pastas `output-X`/`output-Y` (ordem sorteada).
2. No output do braço A, **remova o `CLAUDE.md` semeado pelo harness se ele não foi
   modificado pelo run** (conteúdo ainda igual ao `printf` do `run-raw-arm.sh`) — o
   arquivo idêntico em todo run raw fingerprinta o braço e fura a cegueira.
3. Rode o juiz com `judge-prompt.md` + `RUBRIC.md`. Registre em `RESULTS.template.md`.

## O que este benchmark decide

- Se A ganha em custo **e** empata/perde em qualidade → o "lean mode" deixa de ser
  opcional: o valor do Orkestral tem que vir de **memória persistente + integrações +
  separação por agentes**, não de "rodar o build".
- Se B ganha em qualidade o suficiente pra justificar o custo → vale manter
  orquestração no caminho de build, e o foco vira cortar o overhead sem perder o ganho.

> Nota histórica: o audit identificou um bug que sabotava o braço B —
> `globalAgentDirective()` chamado sem argumento no executor
> (`src/main/services/issue-execution-service.ts`), injetando regras de ORQUESTRADOR
> ("crie issues, delegue") em todo executor. **Corrigido em jul/2026**
> (`globalAgentDirective(false)`), junto com a captura de custo do orquestrador em
> `agent_runs` e a remoção do comentário falso "Forge escalou" em toda issue. Rode o
> benchmark **pós-fix**; pra isolar o efeito do bug, rode também no commit anterior ao fix.
>
> Otimizações de custo de jul/2026 (o benchmark mede o produto COM elas): (1) o chat
> do orquestrador reusa a sessão do CLI entre turnos (`claude --resume`) — o
> scaffolding estático (~40k chars: diretiva + AGENTS.md + skills + sources) vai só
> no 1º turno e os seguintes mandam apenas o delta (kill-switch:
> `ORKESTRAL_CHAT_RESUME_DISABLE=1` pra medir o comportamento antigo); (2) executores
> mandam o contexto estável via `--append-system-prompt` — prefixo idêntico entre
> sub-issues consecutivas acerta o prompt cache do provider; (3) custo do analyzer de
> repo persistido em `kb_analysis_jobs` (v82).
