# SP3 — App Expo (7 telas core) — Plano

> Executar com superpowers:subagent-driven-development. Depende de SP1 (contrato
> HTTP/WS rodando) + SP2 (parear). Sem commit.
> Gate: `npm run typecheck` + `npm run lint` no package `mobile`. App roda em device
> real / simulador (não Expo Go puro — dev build por causa do mDNS/secure-store).

**Goal:** app iOS/Android que pareia com o desktop e usa 7 telas core (workspace
switch, chat, issues, agents, goals, routines, settings) com tema dark/light igual
ao desktop, falando HTTP/WS.

## Estrutura de repositório (decisão estrutural — confirmar com Luccas)

Monorepo npm workspaces no root `OrkestralAI/`:

```
OrkestralAI/
  package.json            # workspaces: ["orkestral","mobile","packages/*"]
  orkestral/              # desktop atual
  mobile/                 # NOVO (Expo)
  packages/contract/      # NOVO: ipc-contract + types + interfaces de client/eventbus
```

## File Structure (mobile/)

- `mobile/app/` — Expo Router: `_layout.tsx` (tabs), `chat/`, `issues/`, `agents/`,
  `goals/`, `more/` (routines, settings), `pair.tsx` (onboarding/pareamento).
- `mobile/lib/api.ts` — `HttpApiClient` + `WsEventBus` (impl do contrato).
- `mobile/lib/auth.ts` — token em secure-store, host em MMKV, estado pareado.
- `mobile/lib/theme.ts` — tokens portados do `global.css` (dark/light) p/ NativeWind.
- `mobile/lib/query.ts` — QueryClient + helpers (queryFn via api.invoke).
- `mobile/components/` — UI nativa (AgentAvatar via DiceBear, cards, etc).
- `packages/contract/` — extração de `orkestral/src/shared`.

## Tasks

### Task 1 — Monorepo + package contract

- Criar `OrkestralAI/package.json` com workspaces.
- Criar `packages/contract`: mover/expor `ipc-contract.ts` + `types` + `plan`;
  adicionar interfaces `OrkestralApiClient` / `OrkestralEventBus`.
- Apontar `orkestral` p/ `@orkestral/contract` (faseável: começar reexportando).
- Validar: `typecheck` do desktop continua verde.

### Task 2 — Scaffold Expo

- `mobile/`: Expo + TypeScript + Expo Router + NativeWind + TanStack Query +
  expo-secure-store + react-native-mmkv. Configurar dev client (`expo prebuild`).
- App roda (tela em branco) no simulador.
- Validar: `typecheck` + lint do package mobile.

### Task 3 — Tema (port do global.css)

- `lib/theme.ts`: portar vars do `@theme` (dark) + `[data-theme=light]` p/ tokens
  NativeWind. Provider de tema + hook `useTheme`. Toggle persistido (segue sistema opcional).
- Tela de demo conferindo cores dark/light.
- Validar typecheck + lint.

### Task 4 — Cliente API + EventBus

- `lib/api.ts`: `HttpApiClient.invoke(channel, req)` (fetch + Bearer);
  `WsEventBus` (WebSocket `?token=`, parse `{channel,payload}`, dispatch, reconnect backoff).
- `lib/auth.ts`: get/set token (secure-store), host (MMKV), `isPaired`.
- `lib/query.ts`: QueryClient + wrapper que injeta o client.
- Validar typecheck + lint.

### Task 5 — Pareamento (tela pair)

- `app/pair.tsx`: mDNS browse (lista desktops) OU scan QR (expo-camera) OU ip+código.
  → `POST /api/pairing/redeem` → guarda token+host → navega pras tabs.
- Estado "não pareado" → redireciona pra pair.
- Validar typecheck + lint. Manual: parear com desktop real.

### Task 6 — Navegação (tabs + header)

- `app/_layout.tsx`: bottom tabs (Chat/Issues/Agents/Goals/Mais) + header com
  WorkspaceSwitcher (`workspace:list`/`workspace:switch`) + toggle tema + perfil.
- Validar typecheck + lint.

### Task 7 — Chat (a tela rica)

- Lista de sessões + thread. `session:get`/`session:create`/`chat:send`/`chat:enqueue`/
  `chat:cancel` + queue. Stream via `onChatStream` → store de mensagens (igual desktop).
  Render de partes (texto/tool-call). Picker nativo no lugar de attachment Electron.
- Validar typecheck + lint. Manual: mandar msg, ver streaming.

### Task 8 — Issues (lista + detalhe)

- Lista (status/filtros) + detalhe (comments, runs, execução, plano). Canais da spec.
  `onIssueExecutionEvent`/`onIssuesChanged`/`onAgentTraceEvent` p/ live. Kanban →
  lista com long-press; sem drag desktop.
- Validar typecheck + lint.

### Task 9 — Agents (lista + detalhe)

- Lista com status (idle/live/paused) + detalhe (config, pause/resume, skills,
  activity, instruções). Canais da spec. `confirm()` → Alert nativo.
- Validar typecheck + lint.

### Task 10 — Goals + Routines

- Goals: lista+detalhe, plan/verify, date picker nativo. `onIssuesChanged`.
- Routines: lista, toggle enabled, run-now, criar. `confirm()` → Alert.
- Validar typecheck + lint.

### Task 11 — Settings

- Tema (dark/light/sistema) via `settings:get`/`settings:update`; perfil
  (`user:get`/`user:update`); versão; **Dispositivos** (`device:list`/`device:revoke`)
  - "desparear" (limpa secure-store). Drop app:quit/update/datetime.
- Validar typecheck + lint.

### Task 12 — Verificação SP3

- `typecheck` + `lint` do mobile e do desktop verdes.
- Manual (device real): parear → trocar workspace → chat com streaming → criar/rodar
  issue → ver agent status → goal plan → toggle routine → trocar tema. Reconnect do WS
  ao perder/voltar wifi.
- (Release EAS + contas Apple/Play = Luccas, fora do código.)

## Riscos

- Streaming WS no RN (volume + reconnect) = parte mais técnica → Task 4/7 com cuidado.
- Monorepo/contract (Task 1) toca o desktop → fazer faseado, typecheck a cada passo.
- mDNS exige dev build; fallback QR/ip sempre presente.
- Componentes não reaproveitam do desktop (DOM) — só lógica/tipos.
