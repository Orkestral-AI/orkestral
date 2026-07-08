# Orkestral Mobile v1 (modo local, mesma wifi) — Plano de Programa

> Decomposto em 3 sub-projetos. Cada um vira working software testável sozinho.
> Este doc: visão geral + **plano detalhado do SP1** (a fundação). SP2 e SP3
> ficam em outline até o SP1 fechar (o contrato real do servidor define o resto).

**Meta v1:** abrir o app no celular (na mesma wifi do desktop), parear com o
desktop por código, e usar 7 telas core (workspace switch, chat, issues, agents,
goals, routines, settings) falando direto com o desktop por HTTP/WebSocket.
**Zero infra externa.** Cloud mode = depois.

**Princípio:** o desktop (processo `main` do Electron) JÁ é o backend. Não
reescrever — **expor** os handlers que já existem pela rede, além do IPC.

---

## Decomposição

| Sub-projeto                         | O que entrega                                                 | Depende de                    | Posso tocar sem você?                                  |
| ----------------------------------- | ------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| **SP1 — Desktop vira servidor LAN** | HTTP+WS no `main` reusando handlers + eventos; auth por token | —                             | Sim, 100%                                              |
| **SP2 — Pareamento + descoberta**   | código de pareamento, mDNS na LAN, lista de devices           | SP1                           | Sim (Supabase você já tem p/ device registry opcional) |
| **SP3 — App Expo (7 telas)**        | app iOS/Android cliente fino                                  | SP1 (contrato) + SP2 (parear) | Sim p/ código; você: contas Apple/Google + device real |

**Sequência:** SP1 → SP2 → SP3. SP3 não começa de verdade antes do contrato do
SP1 estar rodando (senão a UI mobile é construída no ar).

---

## Contrato que cola tudo (a "cola")

O glue dos 3 é **um cliente de API transport-agnóstico**:

```
OrkestralApiClient   // invoke(channel, request) -> Promise<response>
OrkestralEventBus    // on(channel, listener) -> unsubscribe
```

- Desktop (renderer atual): implementação **IPC** (já existe de fato, só formalizar).
- Mobile/web futuro: implementação **HTTP+WS** apontando pro endereço do desktop.
- Ambos tipados pelo MESMO `src/shared/ipc-contract.ts`.

SP1 cria a versão servidor (HTTP/WS) desse contrato. SP3 consome via a impl HTTP.

---

## Modelo de segurança (v1, mesma wifi)

O servidor expõe um backend que roda shell e edita arquivos. Mesmo na LAN, **tem
que ter auth** — senão qualquer um na wifi dirige os agentes.

- Servidor escuta em `0.0.0.0:<porta fixa/aleatória>` na LAN (não só 127.0.0.1).
- **Pareamento:** desktop mostra um **código de 6 dígitos** (rotativo). Celular
  manda o código → servidor devolve um **device token** (longo, aleatório,
  persistido). Todo request HTTP/WS depois exige `Authorization: Bearer <token>`.
- Token por device, revogável (lista de devices no Settings do desktop).
- Sem token / código errado → 401. Rate-limit no endpoint de pareamento.
- Conexão em texto na LAN é aceitável p/ v1; TLS self-signed é opção depois.

---

# SP1 — Desktop vira servidor LAN (PLANO DETALHADO)

**Goal:** o `main` do Electron passa a servir os mesmos handlers IPC por HTTP, e
os mesmos eventos por WebSocket, protegidos por device token. O renderer atual
continua funcionando por IPC, sem regressão.

**Validação:** `npm run typecheck` + `npm run lint` verdes. Verificação funcional:
com o app aberto, um `curl` autenticado num handler read-only devolve o mesmo que
a UI; um cliente WS recebe um evento de stream.

**Sem commit** (regra do Luccas). Sem migrate/DB destrutivo.

## File Structure (SP1)

- **Modify:** `src/main/ipc/register.ts` — além de `ipcMain.handle`, guardar o
  handler num `Map<channel, handler>` exportado (registry agnóstico).
- **Create:** `src/main/server/event-bus.ts` — broadcaster central `emitEvent(channel, payload)`
  que faz fan-out pra (a) todas as BrowserWindows e (b) clientes WS conectados.
- **Modify:** ~23 arquivos que hoje fazem `webContents.send(...)` → trocar por
  `emitEvent(...)`. (mecânico; lista no Task 3)
- **Create:** `src/main/server/http-server.ts` — servidor HTTP (Node `http`) que
  roteia `POST /api/:channel` → registry handler; healthcheck `GET /api/_ping`.
- **Create:** `src/main/server/ws-server.ts` — WebSocket server (lib `ws`) que
  autentica por token e assina o event-bus, repassando eventos pro cliente.
- **Create:** `src/main/server/auth.ts` — geração/validação de device token +
  código de pareamento (em memória + persistido via repo).
- **Create:** `src/main/db/repositories/device.repo.ts` + tabela `paired_devices`
  (migration nova — só CREATE TABLE IF NOT EXISTS, idempotente; NÃO rodar migrate,
  o boot aplica sozinho no app do Luccas).
- **Modify:** `src/main/index.ts` — no boot, `startLocalServer()` depois do DB.
- **Modify:** `src/shared/ipc-contract.ts` — adicionar canais de pareamento
  (`pairing:start`, `pairing:redeem`, `device:list`, `device:revoke`).

> Nota: SP1 entrega o transporte + auth. As TELAS de pareamento (UI) e a
> descoberta mDNS são SP2.

## Tasks (SP1)

### Task 1 — Registry agnóstico de handlers

- Em `register.ts`, criar `export const handlerRegistry = new Map<IpcChannel, IpcHandler<IpcChannel>>()`.
- Em `registerHandler`, após o guard de duplicado: `handlerRegistry.set(channel, handler as IpcHandler<IpcChannel>)` antes do `ipcMain.handle`.
- Exportar um helper `export async function invokeChannel(channel, request)` que
  pega do Map, roda com o mesmo try/catch, e devolve o resultado (reusado pelo HTTP).
- Validar: `npm run typecheck:node`.

### Task 2 — Event bus central

- Criar `src/main/server/event-bus.ts`:
  - `type AnyEvent = { channel: string; payload: unknown }`
  - lista de listeners WS (`Set<(e: AnyEvent) => void>`)
  - `export function emitEvent(channel, payload)`: faz `BrowserWindow.getAllWindows()...webContents.send(channel, payload)` (comportamento atual) **e** notifica cada listener WS.
  - `export function subscribeEvents(fn)` / `unsubscribe` p/ o WS server.
- Validar typecheck.

### Task 3 — Migrar emits pro event bus

- Trocar `win.webContents.send(c, p)` por `emitEvent(c, p)` nos 23 arquivos
  (lista: index.ts, system.ts, cloud-auth.ts, sentry.ts, sources.ts, chat-service.ts,
  terminal-service.ts, docker-service.ts, log-bus.ts, agent-trace.ts,
  code-review-service.ts, kb-repo-analyzer.ts, kb-embedding-queue.ts,
  forge-local-training.ts, voice-pack-manager.ts, channel-manager.ts,
  issue-execution-service.ts, onboarding.ts, git.ts, skills-issues.ts, updates.ts,
  source-team-sync.ts, mcp-server.ts).
- Casos especiais (broadcastModelProgress em index.ts) → reescrever via emitEvent.
- Validar typecheck + lint. Verificação: UI desktop ainda recebe eventos (chat
  stream, logs) — sem regressão.

### Task 4 — Tabela + repo de devices

- Migration nova em `src/main/db/migrations.ts` (próximo `user_version`):
  `paired_devices(id, name, platform, token_hash, created_at, last_seen_at)`.
  `CREATE TABLE IF NOT EXISTS` (idempotente). **NÃO rodar migrate** — boot aplica.
- `device.repo.ts`: `create`, `findByTokenHash`, `list`, `revoke`, `touch`.
- Token guardado como **hash** (sha256), nunca cru.
- Validar typecheck.

### Task 5 — Auth + pareamento

- `src/main/server/auth.ts`:
  - `startPairing()`: gera código 6 dígitos, TTL 120s, em memória; retorna código.
  - `redeemPairing(code, deviceName, platform)`: valida código → gera token
    aleatório (32 bytes hex) → grava hash via device.repo → retorna token cru (1x).
  - `verifyToken(authHeader)`: extrai Bearer, hash, `findByTokenHash`, `touch`.
  - rate-limit simples no redeem (N tentativas/min).
- Validar typecheck + lint.

### Task 6 — HTTP server

- `src/main/server/http-server.ts` (Node `http`, sem framework):
  - `GET /api/_ping` → `{ ok: true, app, version }` (sem auth, p/ descoberta).
  - `POST /api/pairing/redeem` → body `{ code, deviceName, platform }` → auth.redeem.
  - `POST /api/:channel` → exige Bearer; `verifyToken`; parse JSON body;
    `invokeChannel(channel, body)`; devolve `{ data }` ou `{ error }` (status 200/400/401/500).
  - **Bloquear canais local-only** numa allowlist? Não — v1 expõe tudo autenticado;
    canais de filesystem/terminal rodam no desktop mesmo (é o ponto). Só logar.
  - CORS liberado p/ o app (origin do Expo).
- Validar typecheck + lint.

### Task 7 — WebSocket server

- `src/main/server/ws-server.ts` (lib `ws` — adicionar dep):
  - upgrade autentica por token (query `?token=` ou header).
  - ao conectar: `subscribeEvents` → manda cada evento como `{ channel, payload }` JSON.
  - cliente pode mandar `{ subscribe: [channels] }` p/ filtrar (opcional v1: manda tudo).
  - cleanup no close.
- Validar typecheck + lint.

### Task 8 — Boot + toggle

- `src/main/index.ts`: após DB + handlers, `startLocalServer({ port })`.
- Porta: fixa (ex: 7777) ou configurável em settings. Guardar a porta + IP local
  p/ exibir no Settings (SP2 mostra o QR/código).
- Setting `localServerEnabled` (default true) p/ ligar/desligar.
- Validar typecheck + lint. Verificação manual: `curl localhost:7777/api/_ping`.

### Task 9 — Canais de pareamento no contrato

- Em `ipc-contract.ts`: `pairing:start` (→ código+ip+porta), `device:list`,
  `device:revoke`. (o redeem é HTTP puro, não IPC — vem de fora.)
- Registrar handlers (`src/main/ipc/handlers/pairing.ts`).
- Validar typecheck + lint.

### Task 10 — Verificação SP1

- `npm run typecheck` + `npm run lint` (0 erro).
- Manual: app aberto → `curl -H "Authorization: Bearer <token>" -X POST localhost:7777/api/workspace:list -d '{}'`
  devolve o mesmo que a UI. Cliente WS recebe `logs:entry`/`chat:stream`.
- Sem regressão no desktop (IPC intacto).

---

# SP2 — Pareamento + descoberta (OUTLINE)

- **Desktop UI:** tela/painel no Settings com código de pareamento + QR (ip:porta+code).
- **mDNS:** publicar serviço `_orkestral._tcp` na LAN (lib bonjour/mdns) p/ o app
  achar o desktop sozinho. (módulo nativo → no mobile exige dev build).
- **Device registry (opcional, off-wifi futuro):** desktop registra "estou online
  em X" no Supabase; app lista "seus devices". v1 mesma-wifi não precisa.
- **App side:** tela de pareamento (escanear QR ou digitar ip+código).

# SP3 — App Expo (OUTLINE)

- **Setup:** Expo + Expo Router + NativeWind + TanStack Query + expo-secure-store.
- **Theme:** portar vars do `global.css` (`@theme` dark + `[data-theme=light]`)
  pro NativeWind; toggle no Settings; segue sistema.
- **API:** impl HTTP+WS do `OrkestralApiClient`/`EventBus` apontando pro device pareado.
- **7 telas core:** Workspace switch (header) · Chat (lista+thread streaming) ·
  Issues (lista+detalhe) · Agents (lista+status) · Goals (lista+detalhe) ·
  Routines (toggle) · Settings (tema + pareamento/devices).
- **Nav:** bottom tabs (Chat/Issues/Agents/Goals/Mais) + header com workspace.
- **Build/Release (você):** EAS Build + Submit; Apple Dev US$99/ano; Play US$25.

---

## Riscos (v1)

- **Segurança do servidor exposto** — auth por token tem que ser sólida (Task 5/6).
  Erro aqui = qualquer um na wifi dirige os agentes.
- **Refactor de emits (Task 3)** — 23 arquivos; risco de quebrar evento do desktop.
  Mitiga: `emitEvent` mantém o `webContents.send` idêntico + adiciona WS.
- **Streaming pesado por WS** (chat tokens, terminal) — volume alto; testar throughput.
- **Dep nova `ws`** — pequena, madura. mDNS (SP2) é módulo nativo → dev build no Expo.
