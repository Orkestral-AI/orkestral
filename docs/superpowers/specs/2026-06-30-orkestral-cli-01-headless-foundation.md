# Spec 1 — Fundação headless

- **Data:** 2026-06-30 · **Status:** rascunho p/ revisão · **Parte:** 1/3
- **Objetivo:** subir os serviços do `main` **sem janela**, pra um CLI/daemon reusá-los.

## Resultado esperado

Um entry `cli.ts` que, rodado sob Electron como runtime headless `electron out/main/cli.js`
(sem ELECTRON_RUN_AS_NODE; em Linux usar xvfb-run),
inicializa DB + schedulers + MCP + canais e expõe `chatStreamBus`/`sendMessage`, **sem**
abrir `BrowserWindow`. Nenhum serviço quebra por falta de janela.

## Componentes

### 1. Camada de host (`src/main/platform/host.ts`)
Abstrai o que hoje é acessado direto do `electron`, com fallback headless:

- **`broadcast(channel, payload)`** — substitui os ~14 sites que fazem
  `BrowserWindow.getAllWindows()` (log-bus.ts:35, chat-service.ts:291-293,
  preview-manager.ts:31, issue-broadcast, docker-service, terminal-service,
  kb-embedding-queue, issue-execution-service, agent-trace, code-review-service,
  kb-repo-analyzer, mcp-server, cloud-auth, source-team-sync). Guard: se não há
  janela, vira no-op (os eventos seguem indo pro `chatStreamBus`/EventEmitters).
- **`secrets`** — `encrypt/decrypt`. Usa `safeStorage` quando disponível; senão
  `crypto` (aes-256-gcm) com chave de `ORKESTRAL_SECRET_KEY` ou keyfile gerado em
  `~/.orkestral/secret.key` (0600). Consumidores: sentry.ts, github.ts:761,
  azure-devops.ts, channels/signal-cli-pack.ts.
- **`appInfo`** — `version()` e `path(name)`. Usa `app` quando disponível; senão
  `process.env.APP_VERSION` (do package.json no build) e `~/.orkestral`.
  Consumidores: update-service, channels/tunnel-manager, channel-manager:1003.

> **Segurança:** o fallback `crypto` é menos forte que o Keychain do SO. Documentar:
> numa VPS, recomenda-se setar `ORKESTRAL_SECRET_KEY` (de um secrets manager) em vez
> do keyfile. Sem chave, gera keyfile local e avisa no boot.

### 2. Bootstrap reutilizável (`bootstrapServices`)
Extrair de `src/main/index.ts` (linhas ~349-450) a sequência Node-pura para
`src/main/bootstrap.ts`:

```
bootstrapServices({ headless }):
  initDatabase()
  recoverInterruptedWork()
  startHeartbeatScheduler() / startRoutineScheduler() / startMonitorScheduler()
  ensureMcpServerStarted()
  initChannelService()
  resumeInterruptedWork()
```

`index.ts` (Electron) chama `bootstrapServices({ headless: false })` e segue com
`buildApplicationMenu` + `createWindow` + `setupTray` + `registerAllIpcHandlers`
(ipcMain só faz sentido com renderer). O `cli.ts` chama
`bootstrapServices({ headless: true })` e **pula** menu/janela/tray/IPC.

### 3. Entry CLI (`src/main/cli.ts`) — stub nesta fase
Nesta spec, só: parse mínimo (commander), `bootstrapServices({headless:true})`,
imprime "ok, serviços no ar", e mantém o processo vivo (ou sai). UX real vem nas
specs 2 e 3.

### 4. Launcher (`bin/orkestral`) + build
- `bin/orkestral` (shim Node): re-exec `electron <appMain> "$@"` (Electron como runtime
  headless, sem ELECTRON_RUN_AS_NODE; em Linux usar xvfb-run).
- `package.json`: `"bin": { "orkestral": "bin/orkestral" }` + script
  `"cli": "electron out/main/cli.js"`.
- electron-vite: garantir que `cli.ts` entra no build do main (`out/main/cli.js`).

## Fluxo de dados

Sem mudança no fluxo dos serviços. Só o **broadcast** passa pelo `host.broadcast`
(no-op headless) em vez de tocar `BrowserWindow` direto. EventEmitters
(`chatStreamBus`) seguem iguais — é por onde o CLI/canais escutam.

## Erros / bordas

- `electron` ausente no PATH → o `bin` falha com mensagem clara (precisa do app instalado/buildado).
- DB travado por outra instância (app desktop aberto) → better-sqlite3 já usa
  `busy_timeout`; documentar "não rode daemon + desktop no mesmo `~/.orkestral`".
- Schedulers (heartbeat/routine/monitor) rodando headless: ok, são Node puros.

## Validação

- `npm run typecheck && npm run lint`.
- Rodar `npm run cli` → serviços sobem, log "headless ok", sem abrir janela.
- App desktop continua subindo normal (regressão zero no `index.ts`).

## Tarefas (implementação em partes)

1. `host.ts` (broadcast/secrets/appInfo) + trocar os sites de broadcast.
2. Fallback de `secrets` (crypto + keyfile/env).
3. Extrair `bootstrapServices` + religar `index.ts`.
4. `cli.ts` stub + commander.
5. `bin/orkestral` + scripts + build do `cli.js`.
6. Smoke test headless + checar regressão desktop.

## Fora de escopo

Setup wizard, cockpit, REPL, slash commands, permissões (specs 2 e 3).
