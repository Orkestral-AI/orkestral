# SP3 — App Expo (7 telas core) — Spec

Data: 2026-06-22 · Parte de [Orkestral Mobile v1](../plans/2026-06-22-mobile-v1-local-mode.md)
Depende de: SP1 (contrato HTTP/WS) + SP2 (parear).

## Problema

Falta o cliente: um app iOS/Android que pareia com o desktop e usa as telas
principais, com a mesma cara (tema/tokens) do desktop, mobile-first e responsivo.

## Objetivo

App Expo (RN) cliente fino, 7 telas core, falando HTTP/WS com o desktop pareado,
tema dark/light idêntico ao desktop.

## Decisão de estrutura de repositório

Mobile mora **fora** do app desktop, irmão de `orkestral`, `docs`, `web`:

```
OrkestralAI/
  orkestral/            # desktop (Electron) — atual
  mobile/               # NOVO — app Expo
  packages/contract/    # NOVO — tipos + ipc-contract + OrkestralApiClient (compartilhado)
  docs/  web/ ...
```

- **npm workspaces** no root `OrkestralAI/` (packages: orkestral, mobile, packages/contract).
- **`packages/contract`** = extração de `orkestral/src/shared` (ipc-contract.ts,
  types, plan) + as interfaces `OrkestralApiClient` / `OrkestralEventBus`. Desktop e
  mobile importam o MESMO contrato → impossível divergir.
- Migração de baixo toque: criar o package, mover `src/shared` pra lá, apontar o
  desktop pra `@orkestral/contract`. (Pode ser faseado: começar copiando os tipos
  e formalizar depois — decisão de quanto refatorar o desktop agora.)

> Decisão pro Luccas: monorepo npm workspaces no root (recomendado) vs mobile como
> repo separado importando um `@orkestral/contract` publicado. Recomendo workspaces
> — zero publish, type-safety direta.

## Stack

| Camada    | Escolha                                                  |
| --------- | -------------------------------------------------------- |
| Framework | Expo + React Native (Expo Dev Client p/ mDNS nativo)     |
| Navegação | Expo Router (file-based) — bottom tabs + stacks          |
| UI        | NativeWind (Tailwind no RN)                              |
| Dados     | TanStack Query                                           |
| Rede      | `fetch` (HTTP) + WebSocket nativo                        |
| Storage   | expo-secure-store (token) + MMKV (host, settings, cache) |
| Conta     | Supabase JS (mesma do desktop)                           |

## Tema

Portar as CSS vars de `orkestral/src/renderer/src/styles/global.css` (bloco
`@theme` = dark default + `[data-theme='light']` = light) pra um theme NativeWind.
Mesmas cores exatas (accent-purple, surface-_, border, text-_). Toggle no Settings;
opção "seguir sistema". O toggle escreve no mesmo `settings:update` (appearance.theme).

## Navegação mobile

- **Header:** WorkspaceSwitcher (dropdown) + toggle tema + perfil.
- **Bottom tabs (5):** Chat · Issues · Agents · Goals · Mais.
- **Mais:** Routines, Settings (+ futuras: Inbox, Code reviews, Costs, Activity).

## As 7 telas + canais (contrato mínimo)

Mapa real extraído do desktop. **71 canais IPC + 6 eventos** no total.

### 1. Workspace switcher (header)

- Canais: `workspace:list`, `workspace:switch`, `app:logout`.
- Sem evento. Troca → invalida queries.

### 2. Chat (lista + thread streaming) — a tela mais rica

- Canais: `session:create`, `session:get`, `agent:list`, `user:get`,
  `chat:send`, `chat:enqueue`, `chat:cancel`, `chat:queue-list`,
  `chat:queue-set-kind`, `chat:queue-cancel`, `exec:stop-all`,
  `issue:list`, `issue:list-runs`, `issue:list-execution-events`,
  `issue:decide-plan`, `logs:list-agent-trace-events`, `kb:list-pages`,
  `channels:session-meta`.
- Eventos: `onChatStream`, `onChatQueueChanged`, `onChatSessionReady`,
  `onIssueExecutionEvent`, `onAgentTraceEvent`.
- Drop/replace: `attachment:add-files`/`attachment:open` → picker nativo;
  `git:discard` → fora da v1 mobile; `localStorage` (draft) → MMKV.

### 3. Issues (lista + detalhe)

- Canais: `issue:list`, `issue:get`, `issue:get-by-key`, `issue:children`,
  `issue:list-comments`, `issue:list-runs`, `issue:list-execution-events`,
  `issue:create-full`, `issue:update`, `issue:delete`, `issue:bulk-delete`,
  `issue:bulk-set-status`, `issue:execute`, `issue:cancel-execution`,
  `issue:decide-plan`, `issue:add-comment`, `issue:delete-comment`,
  `qa:get-latest-validation`, `agent:list`, `logs:list-agent-trace-events`.
- Eventos: `onIssueExecutionEvent`, `onIssuesChanged`, `onAgentTraceEvent`.
- Drop/replace: Kanban drag-drop → long-press/reorder; attachments → picker.

### 4. Agents (lista + detalhe/config)

- Canais: `agent:list`, `agent:get`, `agent:delete`, `agent:update`,
  `agent:pause`, `agent:resume`, `agent:run-heartbeat`, `agent:reset-sessions`,
  `agent:get-activity`, `agent:get-activity-stats`, `agent:list-instructions`,
  `agent:read-instruction`, `agent:write-instruction`, `agent:delete-instruction`,
  `agent:list-api-keys`, `agent:create-api-key`, `agent:revoke-api-key`,
  `adapter:list-models`, `skill:list`, `skill:list-by-agent`, `skill:attach`,
  `skill:detach`, `issue:list`, `issue:create-full`.
- Sem evento (polling 4-15s).
- Drop/replace: `confirm()` → Alert; clipboard → RN Clipboard. Editor de
  instruções é `<textarea>` simples (ok no mobile).

### 5. Goals (lista + detalhe)

- Canais: `goal:list`, `goal:create`, `goal:update`, `goal:delete`,
  `goal:plan`, `goal:verify`, `issue:list`, `agent:list`.
- Evento: `onIssuesChanged`.
- Drop/replace: DatePicker HTML → date picker nativo.

### 6. Routines

- Canais: `routine:list`, `routine:create`, `routine:update`, `routine:delete`,
  `routine:run-now`, `agent:list`.
- Sem evento.
- Drop/replace: `confirm()` → Alert.

### 7. Settings (tema + conta + devices)

- Canais: `settings:get`, `settings:update`, `user:get`, `user:update`,
  `workspace:list`, `workspace:update`, `app:get-version`,
  `device:list`, `device:revoke` (SP2).
- Sem evento.
- Drop: `app:quit`, `update:check/open`, `system:open-datetime-settings`,
  window chrome.

## Contrato de cliente (impl HTTP/WS)

```ts
class HttpApiClient implements OrkestralApiClient {
  invoke(channel, request) {
    return fetch(`${base}/api/${channel}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
      .then((r) => r.json())
      .then((j) => j.data);
  }
}
class WsEventBus implements OrkestralEventBus {
  // WebSocket(`${base}/ws?token=`), parse { channel, payload }, dispatch listeners
  // reconnect com backoff
}
```

Tipados pelo `@orkestral/contract`. As telas usam o MESMO padrão TanStack Query
do desktop (queryFn = `api.invoke('issue:list', {workspaceId})`).

## Fora de escopo (v1)

- Telas 🟡 (Inbox, Code reviews, Costs, Activity, Channels, Sentry, Observability).
- IDE/terminal/docker/logs/sources/MCP-config/knowledge-graph.
- Off-wifi, push notifications, offline pesado (SQLite no phone).

## Release (Luccas)

EAS Build + Submit. Apple Developer US$99/ano. Google Play US$25 (1x). Device real
p/ testar (mDNS/secure-store não rodam no Expo Go puro → dev build).

## Riscos

- Chat streaming por WS no RN (volume de tokens + reconnect) — a parte mais técnica.
- Reaproveitar componentes do desktop = não dá (DOM). Reaproveita só lógica/tipos.
- mDNS exige dev build; fallback manual (QR/ip) sempre disponível.
