# Resultados do benchmark — preencha por run

> Copie este arquivo para `RESULTS.md` e preencha. Mantenha o template limpo.
> Modelo usado (explícito, o mesmo nos 2 braços): `__________` · Data: `__________` · Máquina: `__________`
> Effort efetivo — Braço A: `__________` (default do CLI) · Braço B executores: `__________` (fastMode → low, salvo neutralizado)
> `ORKESTRAL_SKILL_REVIEW_DISABLE=1`? `__________` (se não, o custo do braço B está subestimado)

## Captura de custo do Braço B (Orkestral)

O custo do braço B vive em TRÊS tabelas: `issue_runs` (executores), `agent_runs`
(turnos do orquestrador no chat) e `kb_analysis_jobs` (runs LLM do analisador de
repo — dispara na ingestão do source e a cada reanálise por mudança de
fingerprint durante a execução). Tudo capturado desde os fixes de jul/2026
(v81/v82); runs anteriores têm `cost_usd` NULL. DB SQLite do app (caminho fixo):
`~/.orkestral/instances/default/db/orkestral.db`
(pode existir um DB stale antigo em `~/Library/Application Support/Orkestral/` — ignore).

```sql
-- Custo + tokens do benchmark. Troque <t0> pelo started_at ISO do início do run
-- (as tabelas não têm created_at; a coluna temporal é started_at).
SELECT
  (SELECT COUNT(*)                    FROM issue_runs WHERE started_at >= '<t0>') AS executor_runs,
  (SELECT COALESCE(SUM(cost_usd),0)   FROM issue_runs WHERE started_at >= '<t0>') AS executor_cost_usd,
  (SELECT COALESCE(SUM(tokens_in),0)  FROM issue_runs WHERE started_at >= '<t0>') AS executor_tokens_in,
  (SELECT COALESCE(SUM(tokens_out),0) FROM issue_runs WHERE started_at >= '<t0>') AS executor_tokens_out,
  (SELECT COUNT(*)                    FROM agent_runs WHERE started_at >= '<t0>') AS orchestrator_turns,
  (SELECT COALESCE(SUM(cost_usd),0)   FROM agent_runs WHERE started_at >= '<t0>') AS orchestrator_cost_usd,
  (SELECT COALESCE(SUM(tokens_in),0)  FROM agent_runs WHERE started_at >= '<t0>') AS orchestrator_tokens_in,
  (SELECT COALESCE(SUM(tokens_out),0) FROM agent_runs WHERE started_at >= '<t0>') AS orchestrator_tokens_out,
  (SELECT COUNT(*)                    FROM kb_analysis_jobs WHERE created_at >= '<t0>') AS analyzer_runs,
  (SELECT COALESCE(SUM(cost_usd),0)   FROM kb_analysis_jobs WHERE created_at >= '<t0>') AS analyzer_cost_usd,
  (SELECT COALESCE(SUM(cost_usd),0)   FROM issue_runs WHERE started_at >= '<t0>')
    + (SELECT COALESCE(SUM(cost_usd),0) FROM agent_runs WHERE started_at >= '<t0>')
    + (SELECT COALESCE(SUM(cost_usd),0) FROM kb_analysis_jobs WHERE created_at >= '<t0>') AS total_cost_usd;

-- Runs cortados pelo watchdog (não confundir "foi cortado" com "falhou sozinho"):
-- exit_code -2 = timeout 20min · -3 = stall 4min sem evento do CLI.
SELECT issue_id, exit_code, error_message
FROM issue_runs
WHERE started_at >= '<t0>' AND exit_code IN (-2, -3);
```

Caveats de leitura:

- **Use CUSTO como métrica primária.** `tokens_in/out` seguem a convenção do `usage`
  da API (excluem cache); `total_cost_usd` já inclui tudo. No braço A, use
  `usage.input_tokens` do `summary.json` (não input+cache) pra coluna "in".
- `tokens_in/out` são NULL quando o run não emitiu `result` (cancelado/morto) e o
  código coage 0→NULL — `SUM()` pula NULLs, então tokens podem subcontar; custo idem.
- `kb_analysis_jobs.cost_usd` é NULL quando a análise rodou via Codex (o stream do
  codex não emite custo) — nesse caso o custo do analyzer fica invisível de novo;
  anote o adapter do orquestrador no RESULTS.
- Benchmark em workspace dedicado + filtro temporal basta. Pra filtrar por workspace:
  `issue_runs JOIN issues ON issues.id = issue_runs.issue_id` /
  `agent_runs JOIN chat_sessions ON chat_sessions.id = agent_runs.session_id`,
  filtrando `workspace_id`.

## Tabela de runs

| Run | Braço | MVP rodável? | $ custo | Tokens (in/out) | Wall-clock | Score (0–100) | Acabou no budget? |
| --- | ----- | ------------ | ------- | --------------- | ---------- | ------------- | ----------------- |
| 1   | raw   |              |         |                 |            |               |                   |
| 1   | ork   |              |         |                 |            |               |                   |
| 2   | raw   |              |         |                 |            |               |                   |
| 2   | ork   |              |         |                 |            |               |                   |

## Gates por run (G1–G9)

| Run | Braço | G1  | G2  | G3  | G4  | G5  | G6  | G7  | G8  | G9  |
| --- | ----- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1   | raw   |     |     |     |     |     |     |     |     |     |
| 1   | ork   |     |     |     |     |     |     |     |     |     |

## Justificativas (2–3 linhas honestas por run)

- **Run 1 / raw:** …
- **Run 1 / ork:** …

## Veredito

- Custo: quem ganhou e por quanto (braço B = executores + orquestrador; anotar se o
  skill-review estava desligado).
- Qualidade: quem ganhou e por quanto.
- % MVP rodável por braço (runs do braço B cortados por watchdog: anotar à parte).
- **Decisão:** lean mode obrigatório? manter orquestração no build? rodar de novo no
  commit pré-fix pra isolar o efeito do bug do executor?
