# Orkestral — Review de Lançamento (2026-06-21)

Review multi-agente do codebase inteiro (15 unidades priorizadas por risco, 54 achados confirmados adversarialmente por 2 lentes, 165 agentes). Cobertura profunda no backend/IPC/DB/smart-exec/MCP; renderer com cobertura leve.

## Veredito

**Muito perto de pronto. Não lançar antes de fechar os 4 launch-blockers** (todos verificados na fonte, fix barato). Arquitetura sólida: escrita atômica de runs (better-sqlite3), spawn sem injeção de shell, scrub de env, migrations transacionais com bump atômico de `user_version`, auth do MCP com token em tempo constante + anti-DNS-rebinding, clone do GitHub com token fora do argv. **Sem data-loss garantido, sem SQL injection, sem eval.** Terminal (`pty.spawn`) spawna o shell direto (sem `sh -c`), sem injeção. `webPreferences`: `contextIsolation:true` + `nodeIntegration:false` corretos (`sandbox:false`/`webviewTag:true` são hardening, não blocker).

## 🚨 Launch-blockers (corrigir antes do release)

1. **Path traversal — criação de arquivo do smart-exec grava fora do repo.** `classifier.ts:431` só tira `./` inicial; `applyWholeFile` (`diff.ts:54`) honra `isAbsolute` e escreve sem conter. Fix: helper `isInsideRepo` como guarda final em `applyWholeFile/Morph/Lazy` + `rollbackSnapshot` + filtro na origem; rejeitar `..` e absoluto.
2. **Path traversal — `applyCommentSuggestion` escreve em `filePath` do LLM sem containment.** `code-review-service.ts:1089/1116`. Fix: `resolve`+`startsWith(root+sep)` antes do `writeFileSync`; tratar prefixo `[repo]`.
3. **MCP cross-workspace via UUID.** `kbPageRepo.get(id)` (`kb-page.repo.ts:85`) filtra só por id → agente do ws A lê/grava KB/QA do ws B. Fix: `getScoped(workspaceId,id)` / validar `resource.workspaceId===workspaceId` nas tools kb*\* e qa*\*.
4. **Crash do main por EPIPE.** `stdin` do child sem `on('error')` + `index.ts:387` só tem `unhandledRejection`. Fix: `child.stdin.on('error')` em issue-execution/chat-service/probe + `process.on('uncaughtException')` defensivo.

## Backlog P1 (pós-blockers, antes/logo após o release)

5. Temp de anexos + `mcp-config.json` (token process-wide) nunca limpos — `chat-service.ts:2185/2281` → cleanup em `onRunSettled`.
6. Re-análise de source hard-deleta a KB antes de run fire-and-forget — `kb-request-analysis.ts:48` → `isArchived=true`, purgar só após sucesso.
7. `attachment:open` abre path arbitrário no SO — `attachments.ts:64` → `openPathSafe(.., {withinRoot})`.
8. Cancelar code review sobrescrito por `finishSuccess` — `code-review.repo.ts:213` → guard de estado terminal em transação.
9. Fila de chat perde o scope de sources (despacha 'all') — `chat-service.ts:1999/2043` → coluna `scope` (migration) + persistir/ler.

## Backlog P2 (qualidade/robustez)

- Use-after-free por idle-unload mid-inference no `llama-runtime.ts:347` e no runtime de embedding → contador de operações em voo.
- Credenciais de MCP em texto claro no config da skill — `skills-issues.ts:530` → `toolSecretRepo` cifrado.
- `source:search/replace-all` rodam regex do usuário + 60k arquivos no main thread (ReDoS/freeze) — `sources.ts:568/621` → worker_threads + timeout.
- Probe passa `process.env` cru (fura o scrub) — `probe.ts:33` → `scrubSpawnEnv`.
- Escritas de arquivo do usuário não-atômicas — `sources.ts:490/655`, `git.ts:522` → `atomicWriteFileSync` (tmp+rename).
- TOCTOU no lock de download Forge — `model-download-service.ts:501` → `downloading=true` antes do await.
- `rollbackSnapshot` re-junta path absoluto (restaura no lugar errado) — `diff.ts:145` (resolvido junto do blocker 1).
- Tier de rewrite aceita no-op (`changedLines==0`) — `orchestrator.ts:1046`.
- Job de treino llama.cpp sem cancel/cleanup no shutdown — `forge-local-training.ts:301`.
- `workspace.delete` deixa órfãs em `forge_edit_examples` — `workspace.repo.ts:164`.

## Dependências (npm audit)

Empacotado no app (`--omit=dev`): **7 vulnerabilidades (1 high, 6 moderate)**. As "críticas/high" do Dependabot estão majoritariamente no **dev tooling** (vite, etc.), que não vai no instalável. Rodar `npm audit fix` (sem `--force`) e reavaliar.

## Cobertura honesta

A fundo + verificado na fonte: smart-exec, exec-core, chat, MCP (pontos de authz), model-lifecycle, DB (migrations/repos de maior risco), IPC, adapters. **Leve** (aceito do dossiê adversarial): maioria das páginas/stores do renderer, os 28 repos de DB individualmente, as ~30 tools do MCP fora dos pontos de authz citados. **Não revisado a fundo**: CSP/postura geral do BrowserWindow além do `webPreferences`, validação de origin em todos os handlers IPC. App não foi executado (avaliação estática).
