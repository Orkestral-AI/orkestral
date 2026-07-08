# SP2 — Pareamento + Descoberta — Spec

Data: 2026-06-22 · Parte de [Orkestral Mobile v1](../plans/2026-06-22-mobile-v1-local-mode.md)
Depende de: SP1 (servidor + auth).

## Problema

SP1 dá o servidor e o token. Falta a experiência de **conectar o celular ao
desktop**: o desktop precisa mostrar como parear, e o app precisa achar o desktop
na rede e fazer o redeem do código.

## Objetivo

- Desktop: painel no Settings com **código de pareamento + QR** (contém ip:porta+code)
  e lista de devices pareados (revogar).
- LAN: desktop anuncia o serviço por **mDNS** pro app achar sozinho na mesma wifi.
- App: tela de pareamento (escanear QR ou digitar ip+código) → redeem → guarda token.

## Decisões

- **Pareamento via código + QR.** QR codifica `{ host, port, code }`. Sem QR,
  entrada manual de ip + código de 6 dígitos. Reusa `qrcode` (já é dep do desktop).
- **Descoberta mDNS** (`_orkestral._tcp`) p/ o app listar desktops na wifi sem
  digitar IP. Lib de mDNS no desktop (publish) e no app (browse — módulo nativo →
  exige Expo Dev Client, ver SP3). Fallback sempre manual.
- **Device registry via Supabase = opcional, fora da v1.** Só necessário p/
  off-wifi. v1 mesma-wifi não usa nuvem.
- **Token no app** guardado em `expo-secure-store` (cifrado). Último device em MMKV.
- **Revogação** pelo Settings do desktop (lista de `paired_devices` → revoke).

## Interfaces novas (IPC, desktop)

```ts
'pairing:start'  -> { code, expiresAt, host, port, qrPayload }   // mostra no Settings
'device:list'    -> PairedDevice[]
'device:revoke'  -> { id } -> { ok }
```

(o `redeem` é HTTP puro `POST /api/pairing/redeem`, vem do app, já no SP1.)

## Fluxo

1. Desktop Settings → "Conectar celular" → `pairing:start` → mostra QR + código (TTL 120s).
2. App → tela parear → mDNS lista desktops OU usuário escaneia QR / digita ip+code.
3. App → `POST /api/pairing/redeem { code, deviceName, platform }` → recebe token.
4. App guarda token (secure-store) + host:porta (MMKV). Conexões seguintes = Bearer.
5. Desktop Settings mostra device na lista; pode revogar.

## Fora de escopo

- Off-wifi / relay / WebRTC.
- Auto-reconnect sofisticado (SP3 trata reconnect básico do WS).

## Riscos

- mDNS é chato em algumas redes (isolamento de cliente no roteador) → entrada
  manual por QR é o fallback garantido.
- QR vaza na tela = código curto-vivo (120s) + token só após redeem mitigam.

## Validação

`npm run typecheck` + `npm run lint`. Manual: Settings mostra código/QR; revogar
remove o device; (app side validado no SP3).
