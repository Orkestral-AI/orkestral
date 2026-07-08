# Spec 3 — CLI/TUI interativo (`orkestral`)

- **Data:** 2026-06-30 · **Status:** rascunho p/ revisão · **Parte:** 3/3
- **Objetivo:** REPL de chat no terminal estilo Claude Code — banner, slash commands,
  trocar modelo/agente, editar configs, modos de permissão.

## Comando

`orkestral` (sem subcomando) → REPL interativo. Flags:

| Flag | Faz |
|------|-----|
| `--dangerously-skip-permissions` | modo full-auto (passa a flag ao adapter) |
| `--permission-mode <m>` | `default` / `acceptEdits` / `plan` / `dangerously-skip` |
| `--agent <id>` · `--model <id>` · `--workspace <id>` | escopo inicial |
| `--cwd <path>` | diretório de trabalho (source) |

## Banner / welcome (ref. print)

ASCII do Orkestral + versão + workspace/cwd + dicas (`/help`, `/exit`). Linha de
"modo de permissão" quando não-default (aviso em destaque se `dangerously-skip`).

## REPL (Ink)

- Caixa de input (prompt `›`) + histórico rolável.
- Envio → `sendMessage({ sessionId, content, scope })`; render do streaming via
  `chatStreamBus`: `text-delta` (token a token), `tool-call` (bloco "› tool: x"),
  `phase` (spinner "thinking/tool/writing"), `message-end` (status).
- `Ctrl+C`/`Esc` interrompe o run ativo (cancelamento já existe por `runId`).
- **Status line** (rodapé): `agente · modelo · permissão · cwd · tokens/custo`.

## Slash commands

| Comando | Ação | Reuso |
|---------|------|-------|
| `/new` | nova sessão | `sessionRepo.create` |
| `/clear` | limpa a sessão atual | `messageRepo.deleteBySession` |
| `/compact` | compacta o contexto | `session-context-compaction` |
| `/help` | lista comandos | registry |
| `/model` | **lista modelos e troca** (marca o atual) | model routing + `agentRepo`/sessão |
| `/agent` | lista agentes e troca (marca o atual) | `agentRepo.listByWorkspace` |
| `/workspace` | troca workspace | `workspaceRepo` |
| `/config` | vê/edita configs curadas | `settings` + repos |
| `/permissions` | alterna o modo de permissão | config + flag do adapter |
| `/channels` | lista/conecta canais (compartilha c/ spec 2) | `channelRepo` |
| `/exit` | sai | — |

Parser: registry de comandos (`{ name, desc, run }`); `/` abre menu com filtro
(igual o autocomplete do app). Comandos desconhecidos → dica + `/help`.

## Seletor de modelo/agente (o "ir listando e marcar")

Lista navegável (Ink): cada item = nome + meta (adapter/preço-ref) + check no atual.
Enter seleciona e aplica (na sessão e/ou no agente). Mesma lista que o app usa
(fonte: model routing / `agentRepo`), pra não duplicar.

## `/config` — configs editáveis (curadas)

Só o que faz sentido no terminal e existe na UI:

- Agente/modelo default do workspace.
- Modo de permissão.
- Preset de performance (economic/moderate/high).
- Autonomia do agente.
- Modo de roteamento de modelo.

Cada um: mostra valor atual → editor (lista/toggle/input) → grava no `settings`/repo.
(Forge está desligado — não expor opções de Forge.)

## Permissões

`--permission-mode` / `--dangerously-skip-permissions` e `/permissions` definem o
modo; o modo mapeia pras **flags do spawn do adapter CLI** (claude/codex). Persistível
por sessão. Aviso visível quando em `dangerously-skip`.

## Erros / bordas

- Sem agente/workspace → oferece `orkestral init` (spec 2) ou cria inline.
- Offline + adapter premium → reusa o fallback existente (`isLikelyOffline`).
- Run em andamento + novo input → enfileira (igual app: `chat:enqueue`/fila).
- Terminal sem TTY → erro claro (REPL precisa de TTY; pra headless use `serve`).

## Validação

- `orkestral` abre banner + REPL; mandar msg → streaming token-a-token + status line.
- `/model` lista e troca (marca atual); próxima msg usa o novo modelo.
- `/new`, `/clear`, `/compact`, `/help` funcionam.
- `/config` edita uma config e persiste (confere no app desktop).
- `--dangerously-skip-permissions` reflete no aviso + na flag do adapter.

## Tarefas (implementação em partes)

1. Shell REPL (Ink) + banner + status line.
2. Render do streaming a partir do `chatStreamBus`.
3. Registry + parser de slash commands + menu `/`.
4. `/model` `/agent` `/workspace` (seletor com marca).
5. `/config` (editor das configs curadas).
6. `/new` `/clear` `/compact`.
7. Flags + `/permissions` + plumbing pro adapter.
8. Cancelamento (Ctrl+C) + fila de input.

## Fora de escopo

Setup inicial/QR e cockpit do daemon (spec 2). Aprovação-via-canal (v1.1).
