# SP1 — Desktop vira servidor LAN — Spec

Data: 2026-06-22 · Parte de [Orkestral Mobile v1](../plans/2026-06-22-mobile-v1-local-mode.md)

## Problema

O `main` do Electron já é o backend (DB, agentes, MCP, eventos), mas só fala com
o renderer por IPC in-process. Pra um app mobile na mesma wifi consumir isso,
o desktop precisa **atender pela rede** (HTTP + WebSocket), reusando os handlers
e eventos que já existem, com autenticação.

## Objetivo

Servidor local no `main` que:

- expõe os ~342 handlers IPC como `POST /api/:channel`;
- faz streaming dos 36 eventos por WebSocket;
- exige device token (Bearer) em tudo, exceto healthcheck e redeem de pareamento;
- não regride o desktop (IPC continua igual).

## Decisões

- **Reuso, não reescrita.** Os handlers e a lógica de evento são os mesmos do IPC.
- **Registry agnóstico.** `registerHandler` passa a guardar `Map<channel, handler>`;
  HTTP e IPC consomem o mesmo Map.
- **Event bus central.** `emitEvent(channel, payload)` substitui os
  `webContents.send` espalhados (23 arquivos) e adiciona fan-out pros clientes WS.
  O comportamento desktop (webContents.send) é preservado idêntico.
- **Sem framework HTTP.** Node `http` + lib `ws` (dep nova pequena). Evita peso.
- **Auth por device token.** Código de pareamento de 6 dígitos (TTL 120s, em
  memória) → token aleatório 32 bytes → guardado como **hash sha256** em
  `paired_devices`. Token cru retornado 1x. Revogável.
- **LAN bind.** `0.0.0.0:<porta>` (default 7777, configurável em settings via
  `localServerEnabled`). Texto puro na LAN aceitável p/ v1; TLS depois.
- **Sem allowlist de canais.** v1 expõe tudo autenticado — canais de
  filesystem/terminal rodam no desktop de propósito (é o host). Só loga acesso.

## Interfaces

```ts
// register.ts
export const handlerRegistry: Map<IpcChannel, IpcHandler<IpcChannel>>;
export async function invokeChannel(channel: IpcChannel, request: unknown): Promise<unknown>;

// server/event-bus.ts
export function emitEvent(channel: string, payload: unknown): void; // janelas + WS
export function subscribeEvents(fn: (e: { channel: string; payload: unknown }) => void): () => void;

// server/auth.ts
export function startPairing(): { code: string; expiresAt: number };
export function redeemPairing(
  code: string,
  deviceName: string,
  platform: string,
): { token: string };
export function verifyToken(authHeader?: string): PairedDevice | null;
```

## Rotas HTTP

| Rota                       | Auth         | Função                                     |
| -------------------------- | ------------ | ------------------------------------------ |
| `GET /api/_ping`           | não          | `{ ok, app, version }` — descoberta/health |
| `POST /api/pairing/redeem` | não (código) | troca código por token                     |
| `POST /api/:channel`       | Bearer       | `invokeChannel` → `{ data }` / `{ error }` |
| `GET /ws?token=` (upgrade) | Bearer       | stream de eventos                          |

## Modelo de dados (migration nova, idempotente)

`paired_devices(id TEXT PK, name TEXT, platform TEXT, token_hash TEXT UNIQUE,
created_at TEXT, last_seen_at TEXT)` via `CREATE TABLE IF NOT EXISTS` no próximo
`user_version`. **Não rodar migrate** — o boot aplica.

## Fora de escopo (SP1)

- UI de pareamento (código/QR no Settings) → SP2.
- Descoberta mDNS → SP2.
- Acesso fora da wifi / relay → pós-v1.
- Cliente HTTP/WS (consumidor) → SP3.

## Riscos

- Auth fraca = qualquer um na wifi dirige agentes. Token sólido + rate-limit no redeem.
- Refactor dos 23 emits pode quebrar evento do desktop. Mitiga: `emitEvent` mantém
  o `webContents.send` idêntico.
- Throughput de streaming (chat/terminal) por WS — testar volume.

## Validação

`npm run typecheck` + `npm run lint` verdes. Manual: `curl` autenticado em handler
read-only == UI; cliente WS recebe evento; desktop sem regressão.
