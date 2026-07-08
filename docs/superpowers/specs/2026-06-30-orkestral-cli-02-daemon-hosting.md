# Spec 2 — Daemon / hosting (`orkestral serve`)

- **Data:** 2026-06-30 · **Status:** rascunho p/ revisão · **Parte:** 2/3
- **Objetivo:** rodar numa VPS headless, configurar **pelo terminal** (incl. QR), conectar
  um canal e conversar pelo canal, com um cockpit bonito.

## Comandos

| Comando | Faz |
|---------|-----|
| `orkestral init` | wizard de setup no terminal (workspace, agente+modelo, canal) |
| `orkestral serve` | sobe headless + cockpit ao vivo; reconecta canais salvos |
| `orkestral status` | imprime status atual e sai (pra scripts/systemd healthcheck) |

## `orkestral init` — setup no terminal (Ink)

Passos (todos persistem nos repos existentes; reusa as ações que a UI já chama):

1. **Workspace** — lista os existentes (`workspaceRepo`) p/ escolher, ou criar
   (nome + path local / repo). Marca um como ativo.
2. **Agente + modelo** — escolhe/cria agente (`agentRepo`): adapter
   (`claude_local` / `codex_local` / outro), modelo, autonomia. Lista os modelos
   disponíveis e **marca** o escolhido.
3. **Canal** — escolhe o tipo e conecta:
   - **WhatsApp** (baileys): dispara `openConnection`; o evento de pareamento
     emite o QR → renderiza no terminal via `qrcode-terminal`. Aguarda "conectado".
   - **Telegram / Discord**: cola o token; valida; conecta.
   - reusa `channelRepo` + o fluxo de `channel-manager`.
4. Resumo + "pronto, rode `orkestral serve`".

> Pareamento WhatsApp precisa surfacar o QR que hoje vai pro renderer. Na impl:
> assinar o evento de QR do `whatsapp-connection` (mesmo que o app emite) e
> imprimir com `qrcode-terminal` em vez de mandar pra janela.

## `orkestral serve` — cockpit (Ink)

Boot: `bootstrapServices({ headless: true })` → `initChannelService()` reconecta as
contas salvas → renderiza:

```
  ██████  orkestral · serve            v0.3.x · headless
  ─────────────────────────────────────────────────────
  DB        ~/.orkestral/...              ok
  MCP       127.0.0.1:xxxx                ok
  Workspace bluetube                      ativo
  Agente    Maestro · claude_local · sonnet-4-6
  Permissão default                       (–dangerously-skip = off)
  Canais    WhatsApp  ● conectado
            Telegram  ○ desconectado
  ─────────────────────────────────────────────────────
  Feed ao vivo
  10:24  wpp ◂ "cria uma issue pra revisar o PR"   (Luccas)
  10:24  run ▸ thinking…
  10:24  run ▸ tool: kb_search "PR"
  10:24  wpp ▸ "criei a issue ORK-42 …"
  ─────────────────────────────────────────────────────
  q sair · r reconectar canal · p permissões
```

- **Banner** = ASCII Orkestral + versão + modo (igual print de referência).
- **Status panel** lê estado (DB, MCP, workspace/agente/modelo, modos, canais).
- **Feed ao vivo** = `chatStreamBus.on('event')` + mensagens inbound/outbound dos
  canais, em ring buffer (cap N linhas), com origem (`wpp/tg`) e direção (◂ in / ▸ out).
- Read-only (conversa é pelo canal; chat-no-terminal é a spec 3).

## Chat via canal (já existe — só exibir)

`inbound → enqueueChatMessage → sendMessage → emit(...) → channel reply`
(channel-manager já assina `chatStreamBus`). O daemon só **observa e renderiza**.

## Permissões no daemon

Os agentes rodam spawnando o CLI do adapter (`claude_local`/`codex_local`); o **modo
de permissão mapeia pras flags passadas nesse spawn** (ex.: `dangerously-skip` →
`--dangerously-skip-permissions` no claude). O daemon lê o modo de uma config
(default conservador). Sem skip, ação sensível **pede aprovação pelo próprio canal**
("aprovar? responda sim") com timeout — fica como opção da v1.1; v1 entrega os modos
de flag. (Confirmar as flags exatas do adapter na implementação.)

## systemd / operação

- `orkestral serve` roda em foreground (cockpit). Pra serviço: unit de exemplo
  (`ExecStart=orkestral serve`, `Restart=always`) + flag `--no-tui`/`--log <file>`
  pra ambiente sem TTY (cockpit desliga, loga linhas).
- Healthcheck: `orkestral status` (exit 0 se DB+canais ok).

## Erros / bordas

- Sem canal configurado → `serve` avisa e sugere `orkestral init`.
- QR expira → re-emite; timeout do wizard com retry.
- Token de canal inválido → erro claro, não persiste.
- Conexão de canal cai → cockpit mostra `○` + tenta reconectar (já há lógica).

## Validação

- `orkestral init` num DB limpo → cria workspace+agente, pareia Telegram (token) e
  WhatsApp (QR), persiste.
- `orkestral serve` → cockpit sobe, canal `● conectado`; mandar msg no canal → ver
  no feed + resposta volta no canal.
- `--no-tui` loga sem render.

## Tarefas (implementação em partes)

1. commander: subcomandos `init` / `serve` / `status` (sobre o cli.ts da spec 1).
2. `init` wizard (Ink): workspace → agente/modelo → canal; reuso de repos.
3. QR do WhatsApp no terminal (`qrcode-terminal` + evento de pareamento).
4. `serve` cockpit (Ink): banner + status panel + feed (`chatStreamBus` + canais).
5. Plumbing do modo de permissão → flags do adapter spawn.
6. `--no-tui`/`--log` + `status` + unit systemd de exemplo.

## Fora de escopo

REPL de chat no terminal e slash commands de sessão (`/new`, `/compact`) → spec 3.
Aprovação-via-canal de ações sensíveis → v1.1.

## Limitações conhecidas

- ~~Segredos não persistem em servidor sem keychain~~ **RESOLVIDO**: todos os repos
  de segredo (`tool-secret.repo`, contas GitHub/Sentry/Azure DevOps/Cloud) roteiam
  pelo `host.secrets` — safeStorage quando disponível, senão fallback aes-256-gcm —
  então tokens de Telegram/Discord persistem normalmente numa VPS sem keychain.
  Blobs legados (safeStorage cru, sem byte de esquema) seguem decifráveis no desktop
  via `decryptCompat`. Em produção, recomenda-se definir `ORKESTRAL_SECRET_KEY`
  (32 bytes em base64); sem ela, um keyfile `<userData>/secret.key` (0600) é gerado
  automaticamente.
