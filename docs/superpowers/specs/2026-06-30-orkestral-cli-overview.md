# Orkestral CLI/TUI — Overview do conjunto de specs

- **Data:** 2026-06-30
- **Status:** aprovado (estrutura + stack) — specs em detalhamento
- **Entrega:** implementação em partes (3 specs sequenciais), **1 branch / 1 PR** no final

## Porquê

Hoje o Orkestral é um app desktop Electron. O objetivo é poder:

1. **Hospedar numa VPS** (sem tela) com um canal de mensageria conectado e usar o
   agente pelo WhatsApp/Telegram (o "porquê" principal).
2. **Usar pelo terminal** num CLI estilo Claude Code: banner bonito, REPL de chat,
   slash commands (`/new`, `/compact`, …), listar/trocar modelo e agente, editar
   configs, modos de permissão (`--dangerously-skip-permissions`).

Ambos compartilham uma base: rodar os serviços do `main` **sem janela** (headless).

## Viabilidade (resumo da auditoria)

Alta (~85%). O bootstrap do `main` já é quase todo Node puro; só `createWindow`/
`setupTray` são Electron-only. O reuso do chat é o **`chatStreamBus`** (EventEmitter
em `chat-service.ts`) — os **canais já o assinam headless**. Bloqueios contornáveis:

- `BrowserWindow.getAllWindows()` em ~14 serviços → guard de broadcast.
- `safeStorage` (cripto de tokens) → fallback Node `crypto`.
- `better-sqlite3` (ABI do Electron) → rodar sob Electron como runtime headless (sem ELECTRON_RUN_AS_NODE; em Linux usar xvfb-run).

## Decomposição

| # | Spec | Entrega | Depende |
|---|------|---------|---------|
| 1 | [Fundação headless](2026-06-30-orkestral-cli-01-headless-foundation.md) | serviços sobem sem janela; abstração de Electron; entry `cli` + launcher | — |
| 2 | [Daemon / hosting](2026-06-30-orkestral-cli-02-daemon-hosting.md) | `orkestral init` (setup terminal + QR) e `orkestral serve` (cockpit + canais) | 1 |
| 3 | [CLI/TUI interativo](2026-06-30-orkestral-cli-03-interactive-tui.md) | `orkestral` REPL: banner, slash commands, trocar modelo/agente, configs, permissões | 1, 2 |

## Stack (transversal, aprovada)

| Decisão | Escolha | Motivo |
|---------|---------|--------|
| Launcher | `bin/orkestral` → Electron como runtime headless `electron out/main/cli.js <cmd>` (sem ELECTRON_RUN_AS_NODE; em Linux usar xvfb-run) | ABI do better-sqlite3 sem rebuild; 1 binário |
| TUI | **Ink** (React p/ terminal) | time pensa em React; banner/cockpit/REPL/listas componentizados |
| Arg parsing | **commander** | padrão, leve |
| QR no terminal | **qrcode-terminal** | parear WhatsApp na VPS |
| Permissões | modos `default` / `acceptEdits` / `plan` / `dangerously-skip` | espelha Claude Code; mapeia p/ flags do adapter CLI |

## Arquitetura de reuso

O CLI **não usa IPC**. Chama os serviços do `main` direto:

- **Chat:** `sendMessage({...})` + assina `chatStreamBus.on('event', …)` p/ o streaming.
- **Dados:** repositórios (`agentRepo`, `sessionRepo`, `channelRepo`, `settings`) direto.
- **Canais:** `initChannelService()` + `openConnection()` (já headless).

```
bin/orkestral
   └─ electron out/main/cli.js <cmd> [flags]   (Electron como runtime headless; em Linux: xvfb-run)
        └─ cli.ts (commander)
             ├─ (default) → TUI REPL          (spec 3)
             ├─ serve     → daemon + cockpit   (spec 2)
             └─ init      → setup wizard        (spec 2)
                  └─ bootstrapServices({ headless: true })   (spec 1)
                       └─ DB · schedulers · MCP · canais · chatStreamBus
```

## Fora de escopo (deste conjunto)

- Reescrever a UI desktop (Electron segue como está; só ganha a abstração de host).
- Multi-tenant / vários daemons na mesma máquina.
- Painel web remoto (o controle remoto é via canal de mensageria).
