# SP2 — Pareamento + Descoberta — Plano

> Executar com superpowers:subagent-driven-development. Depende de SP1 pronto.
> Sem commit. Sem migrate. Gate = `npm run typecheck` + `npm run lint`.

**Goal:** Settings do desktop mostra código+QR pra parear, lista/revoga devices, e
anuncia o serviço por mDNS na LAN.

## File Structure

- **Create:** `src/main/ipc/handlers/pairing.ts` — handlers `pairing:start`, `device:list`, `device:revoke`.
- **Modify:** `src/shared/ipc-contract.ts` — tipos dos 3 canais.
- **Create:** `src/main/server/mdns.ts` — publica `_orkestral._tcp` (lib mdns/bonjour).
- **Modify:** `src/main/index.ts` — `startMdns()` junto do `startLocalServer()`.
- **Create:** `src/renderer/src/components/settings/panels/DevicesPanel.tsx` — UI:
  botão "Conectar celular" → QR + código (countdown TTL) + lista de devices + revogar.
- **Modify:** painel de Settings p/ incluir a aba Devices.

## Tasks

### Task 1 — Canais no contrato

- Em `ipc-contract.ts`: `pairing:start` → `{ code, expiresAt, host, port, qrPayload }`;
  `device:list` → `PairedDevice[]`; `device:revoke` `{ id }` → `{ ok: true }`.
- Tipo `PairedDevice` (id, name, platform, createdAt, lastSeenAt) em `shared/types`.
- Validar `typecheck:node` + `typecheck:web`.

### Task 2 — Handlers de pareamento

- `pairing.ts`: `pairing:start` chama `auth.startPairing()` (SP1) + resolve IP local
  da LAN (os.networkInterfaces, IPv4 não-interno) + porta do servidor; monta
  `qrPayload = JSON({ host, port, code })`. `device:list`/`device:revoke` via device.repo.
- Registrar em `ipc/index.ts`.
- Validar typecheck + lint.

### Task 3 — mDNS publish

- `server/mdns.ts`: publica serviço `_orkestral._tcp` na porta do servidor, TXT com
  `{ name: <hostname>, version }`. Lib: `bonjour-service` (dep nova, pura JS no desktop).
- `startMdns()` no boot; `stopMdns()` no quit. Falha de mDNS não derruba o app (try/catch + log).
- Validar typecheck + lint.

### Task 4 — DevicesPanel (UI desktop)

- `DevicesPanel.tsx`: botão "Conectar celular" → `pairing:start` → mostra QR
  (reusa `qrcode` p/ gerar dataURL do `qrPayload`) + código grande + countdown.
  Lista devices (`device:list`) com "Revogar" (`device:revoke`) → invalida query.
- Tokens de UI do design system (accent-purple/surface/border). Sem `secondary`.
- i18n: novas chaves em `pages.json` (settings.devices.\*).
- Validar typecheck + lint.

### Task 5 — Plug no Settings

- Adicionar aba/entrada "Dispositivos" no SettingsModal/painel.
- Validar typecheck + lint.

### Task 6 — Verificação

- `npm run typecheck` + `npm run lint`.
- Manual: Settings → Conectar celular mostra QR + código com countdown; revogar some
  da lista; `dns-sd -B _orkestral._tcp` (mac) acha o serviço.

## Riscos

- mDNS bloqueado por isolamento de cliente no roteador → entrada manual (QR/ip) cobre.
- IP local errado em máquinas multi-NIC → escolher IPv4 não-interno preferindo wifi/en0.
