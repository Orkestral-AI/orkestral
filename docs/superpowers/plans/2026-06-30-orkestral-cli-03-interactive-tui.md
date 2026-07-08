# CLI/TUI interativo — Plano de Implementação (Spec 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `orkestral` (sem subcomando) abre um REPL de chat estilo Claude Code — banner, streaming, slash commands (`/new` `/compact` `/model` `/agent` `/config` `/permissions`), status line.

**Architecture:** Default command do commander → Ink REPL. Input via Ink; envio chama `sendMessage({sessionId, content})` e renderiza o streaming assinando `chatStreamBus`. Slash commands num registry puro (parser testável) que despacha pra ações sobre os repos/serviços. Reusa o module de permissão e o Banner da spec 2.

**Tech Stack:** Ink, commander, `chatStreamBus`, repos (`sessionRepo`/`agentRepo`/`messageRepo`), `session-context-compaction`.

**Depende de:** Specs 1 e 2 (host, `bootstrapServices`, `cli.ts`, Ink, Banner, permission module).

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---------|------------------|
| `src/main/cli/commands.ts` (criar) | registry + parser de slash commands (puro) |
| `src/main/cli/commands.test.ts` (criar) | testes do parser |
| `src/main/cli/ui/Repl.tsx` (criar) | shell REPL: histórico + input + status line |
| `src/main/cli/ui/stream-render.ts` (criar) | mapeia `ChatStreamEvent` → linhas de saída |
| `src/main/cli/ui/Selector.tsx` (criar) | lista navegável (modelo/agente/workspace) com marca |
| `src/main/cli/actions.ts` (criar) | ações dos comandos (new/clear/compact/model/agent/config) |
| `src/main/cli.ts` (modificar) | default action → render do Repl + flags |

---

## Task 1: Parser de slash commands (puro, TDD)

**Files:**
- Create: `src/main/cli/commands.ts`
- Test: `src/main/cli/commands.test.ts`

- [ ] **Step 1: Teste que falha**

```ts
// src/main/cli/commands.test.ts
import { describe, it, expect } from 'vitest';
import { parseInput, COMMANDS } from './commands';

describe('parseInput', () => {
  it('texto normal → mensagem', () => {
    expect(parseInput('oi tudo bem')).toEqual({ kind: 'message', text: 'oi tudo bem' });
  });
  it('/new → comando new sem args', () => {
    expect(parseInput('/new')).toEqual({ kind: 'command', name: 'new', args: '' });
  });
  it('/model gpt-5 → comando model com args', () => {
    expect(parseInput('/model gpt-5')).toEqual({ kind: 'command', name: 'model', args: 'gpt-5' });
  });
  it('comando desconhecido → unknown', () => {
    expect(parseInput('/wat')).toEqual({ kind: 'unknown', name: 'wat' });
  });
  it('COMMANDS expõe os nomes esperados', () => {
    const names = COMMANDS.map((c) => c.name);
    for (const n of ['new', 'clear', 'compact', 'help', 'model', 'agent', 'workspace', 'config', 'permissions', 'exit']) {
      expect(names).toContain(n);
    }
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/cli/commands.test.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Implementar**

```ts
// src/main/cli/commands.ts
export interface CommandDef {
  name: string;
  desc: string;
}

export const COMMANDS: CommandDef[] = [
  { name: 'new', desc: 'nova conversa' },
  { name: 'clear', desc: 'limpa a conversa atual' },
  { name: 'compact', desc: 'compacta o contexto' },
  { name: 'help', desc: 'lista comandos' },
  { name: 'model', desc: 'lista/troca o modelo' },
  { name: 'agent', desc: 'lista/troca o agente' },
  { name: 'workspace', desc: 'troca o workspace' },
  { name: 'config', desc: 'edita configs' },
  { name: 'permissions', desc: 'modo de permissão' },
  { name: 'exit', desc: 'sai' },
];

export type ParsedInput =
  | { kind: 'message'; text: string }
  | { kind: 'command'; name: string; args: string }
  | { kind: 'unknown'; name: string };

export function parseInput(raw: string): ParsedInput {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return { kind: 'message', text: trimmed };
  const [token, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = token.toLowerCase();
  if (!COMMANDS.some((c) => c.name === name)) return { kind: 'unknown', name };
  return { kind: 'command', name, args: rest.join(' ') };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/cli/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/cli/commands.ts src/main/cli/commands.test.ts
git commit -m "feat(cli): parser de slash commands (puro)"
```

## Task 2: Render do streaming (mapa ChatStreamEvent → linhas)

**Files:**
- Create: `src/main/cli/ui/stream-render.ts`
- Test: `src/main/cli/ui/stream-render.test.ts`

- [ ] **Step 1: Teste que falha**

```ts
// src/main/cli/ui/stream-render.test.ts
import { describe, it, expect } from 'vitest';
import { StreamAccumulator } from './stream-render';

describe('StreamAccumulator', () => {
  it('concatena text-delta no texto do assistant', () => {
    const acc = new StreamAccumulator();
    acc.apply({ type: 'message-start', runId: 'r', messageId: 'm', sessionId: 's' } as never);
    acc.apply({ type: 'text-delta', runId: 'r', messageId: 'm', delta: 'Olá' } as never);
    acc.apply({ type: 'text-delta', runId: 'r', messageId: 'm', delta: ' mundo' } as never);
    expect(acc.text()).toBe('Olá mundo');
    expect(acc.done()).toBe(false);
  });
  it('message-end marca done', () => {
    const acc = new StreamAccumulator();
    acc.apply({ type: 'message-end', runId: 'r', messageId: 'm', status: 'done' } as never);
    expect(acc.done()).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/cli/ui/stream-render.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

```ts
// src/main/cli/ui/stream-render.ts
import type { ChatStreamEvent } from '../../../shared/types';

export class StreamAccumulator {
  private buf = '';
  private finished = false;
  private toolLines: string[] = [];
  apply(e: ChatStreamEvent): void {
    if (e.type === 'text-delta') this.buf += e.delta;
    else if (e.type === 'tool-call') this.toolLines.push(`› tool: ${(e as { part?: { toolName?: string } }).part?.toolName ?? 'tool'}`);
    else if (e.type === 'message-end' || e.type === 'error') this.finished = true;
  }
  text(): string {
    return this.buf;
  }
  tools(): readonly string[] {
    return this.toolLines;
  }
  done(): boolean {
    return this.finished;
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/cli/ui/stream-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/cli/ui/stream-render.ts src/main/cli/ui/stream-render.test.ts
git commit -m "feat(cli): StreamAccumulator (ChatStreamEvent → texto/tools)"
```

## Task 3: Ações dos comandos

**Files:**
- Create: `src/main/cli/actions.ts`

- [ ] **Step 1: Implementar (reuso direto de repos/serviços)**

```ts
// src/main/cli/actions.ts
import { SessionRepository } from '../db/repositories/session.repo';
import { MessageRepository } from '../db/repositories/message.repo';
import { AgentRepository } from '../db/repositories/agent.repo';
import { maybeCompactSessionContext } from '../services/session-context-compaction';

const sessionRepo = new SessionRepository();
const messageRepo = new MessageRepository();
const agentRepo = new AgentRepository();

export function newSession(workspaceId: string, agentId: string): string {
  return sessionRepo.create({ workspaceId, agentId }).id;
}

export function clearSession(sessionId: string): void {
  // confirmar o método real de apagar mensagens por sessão no MessageRepository
  messageRepo.deleteBySession(sessionId);
}

export async function compactSession(sessionId: string): Promise<void> {
  await maybeCompactSessionContext({ sessionId, force: true }); // confirmar assinatura/flag force
}

export function listAgents(workspaceId: string) {
  return agentRepo.listByWorkspace(workspaceId);
}
```

> Confirmar na impl: `messageRepo.deleteBySession` (nome exato) e a assinatura de
> `maybeCompactSessionContext` (o `/compact` força a compactação).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:node`
Expected: ajustar nomes reais até passar.

- [ ] **Step 3: Commit**

```bash
git add src/main/cli/actions.ts
git commit -m "feat(cli): ações dos comandos (new/clear/compact/list)"
```

## Task 4: Selector navegável (modelo/agente/workspace)

**Files:**
- Create: `src/main/cli/ui/Selector.tsx`

- [ ] **Step 1: Implementar (Ink + useInput)**

```tsx
// src/main/cli/ui/Selector.tsx
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface SelectItem {
  id: string;
  label: string;
  meta?: string;
  current?: boolean;
}

export function Selector({
  title,
  items,
  onPick,
}: {
  title: string;
  items: SelectItem[];
  onPick: (id: string) => void;
}): React.ReactElement {
  const [idx, setIdx] = useState(Math.max(0, items.findIndex((i) => i.current)));
  useInput((_input, key) => {
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    if (key.downArrow) setIdx((i) => Math.min(items.length - 1, i + 1));
    if (key.return) onPick(items[idx].id);
  });
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {items.map((it, i) => (
        <Text key={it.id} color={i === idx ? 'magenta' : undefined}>
          {i === idx ? '› ' : '  '}
          {it.current ? '✓ ' : '  '}
          {it.label}
          {it.meta ? ` · ${it.meta}` : ''}
        </Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:node`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add src/main/cli/ui/Selector.tsx
git commit -m "feat(cli): Selector (lista navegável com marca do atual)"
```

## Task 5: REPL shell (Ink)

**Files:**
- Create: `src/main/cli/ui/Repl.tsx`
- Modify: `src/main/cli.ts`

- [ ] **Step 1: Repl (Ink)**

Estado: `sessionId`, `messages` (histórico), `streaming` (StreamAccumulator atual),
`overlay` (selector/config quando ativo). Input: enquanto sem overlay, captura linha;
ao Enter → `parseInput`. `message` → `sendMessage` + assina `chatStreamBus`. `command`
→ despacha (Task 3 + overlays). Status line no rodapé (agente·modelo·permissão·cwd).

```tsx
// esqueleto — render condicional: overlay ? <Selector/.../> : <histórico + input + status>
import { parseInput, COMMANDS } from '../commands';
import { StreamAccumulator } from './stream-render';
import { sendMessage, chatStreamBus } from '../../services/chat-service';
import { getPermissionMode } from '../permission';
// envio: const acc = new StreamAccumulator(); subscrever onEvent(e){ acc.apply(e); rerender; if(acc.done()) finalize }
// status line: <Text dimColor>{agent} · {model} · {getPermissionMode()} · {cwd}</Text>
```

Comandos → efeito:
- `new` → `newSession(ws, agent)` e troca `sessionId`.
- `clear` → `clearSession(sessionId)` + limpa histórico local.
- `compact` → `await compactSession(sessionId)` + nota "contexto compactado".
- `help` → lista `COMMANDS`.
- `model`/`agent`/`workspace` → abre `Selector` (overlay) com os itens + `current`.
- `config` → abre editor (Task 6).
- `permissions` → `Selector` dos modos → `setPermissionMode`.
- `exit` → `useApp().exit()`.

- [ ] **Step 2: Default command no cli.ts**

```ts
import { render } from 'ink';
import React from 'react';
import { Repl } from './cli/ui/Repl';

program
  .option('--dangerously-skip-permissions', 'modo full-auto')
  .option('--permission-mode <m>', 'default|acceptEdits|plan|dangerously-skip')
  .option('--agent <id>')
  .option('--model <id>')
  .option('--workspace <id>');

program.action((opts) => {
  bootstrapServices({ headless: true });
  if (opts.dangerouslySkipPermissions) setPermissionMode('dangerously-skip');
  else if (opts.permissionMode) setPermissionMode(opts.permissionMode);
  if (!process.stdout.isTTY) {
    console.error('orkestral (REPL) precisa de TTY. Pra headless use `orkestral serve`.');
    process.exit(1);
  }
  render(React.createElement(Repl, { initial: opts }));
});
```

(substitui o `action` stub da spec 1.)

- [ ] **Step 3: Build + smoke**

Run: `npx electron-vite build && npm run cli`
Expected: banner + REPL; digitar texto → resposta em streaming token-a-token; status
line no rodapé. `/help` lista; `/exit` sai.

- [ ] **Step 4: Commit**

```bash
git add src/main/cli/ui/Repl.tsx src/main/cli.ts
git commit -m "feat(cli): REPL interativo (Ink) + streaming + slash dispatch"
```

## Task 6: `/config` — editor das configs curadas

**Files:**
- Create: `src/main/cli/config-editor.ts` (lista das configs editáveis + get/set)
- Modify: `src/main/cli/ui/Repl.tsx` (overlay de config)

- [ ] **Step 1: Definir as configs curadas**

```ts
// src/main/cli/config-editor.ts
// Só o que faz sentido no terminal E existe na UI. Forge está desligado: não expor.
export interface EditableConfig {
  key: string;
  label: string;
  kind: 'enum' | 'agentModel';
  options?: string[];
  get(): string;
  set(v: string): void;
}
// Implementar com o repositório de settings (mesma chave que a UI usa) + agentRepo:
//  - agente/modelo default do workspace
//  - modo de permissão (reusa permission.ts)
//  - preset de performance (economic|moderate|high)
//  - autonomia do agente
//  - modo de roteamento de modelo
export function listEditableConfigs(workspaceId: string): EditableConfig[] {
  /* ... ler settings/agent e montar a lista ... */
  return [];
}
```

> Confirmar na impl as chaves reais no `settings` repo (as que a UI grava) pra cada item.

- [ ] **Step 2: Overlay no Repl**

`/config` → `Selector` das configs → escolher uma → `Selector`/input do valor → `set` →
toast "salvo". Persistência no `settings`/repo (mesma fonte da UI).

- [ ] **Step 3: Build + smoke**

Run: `npx electron-vite build && npm run cli` → `/config` → editar o preset de performance →
conferir no app desktop que mudou.

- [ ] **Step 4: Commit**

```bash
git add src/main/cli/config-editor.ts src/main/cli/ui/Repl.tsx
git commit -m "feat(cli): /config (editor das configs curadas)"
```

## Task 7: Cancelamento + fila de input

**Files:** Modify `src/main/cli/ui/Repl.tsx`

- [ ] **Step 1: Cancelar run ativo (Ctrl+C / Esc)**

Quando há run em andamento, `Ctrl+C` cancela via a função de cancelamento do
chat-service (por `runId`). Confirmar o nome (o renderer usa um `chat:cancel`/abort por
runId — reusar a função do serviço, não o IPC).

- [ ] **Step 2: Enfileirar input durante run**

Se o usuário envia enquanto há run ativo, enfileirar (igual app: a fila vive no MAIN —
`chat:enqueue`/`chatQueue`). Confirmar a função de enfileirar do serviço.

- [ ] **Step 3: Build + smoke**

Run: `npx electron-vite build && npm run cli` → mandar msg longa → `Ctrl+C` cancela;
mandar 2ª msg durante run → entra na fila e dispara ao terminar.

- [ ] **Step 4: Commit**

```bash
git add src/main/cli/ui/Repl.tsx
git commit -m "feat(cli): cancelar run (Ctrl+C) + fila de input no REPL"
```

## Task 8: Smoke final + gate

- [ ] **Step 1: Build**

Run: `npx electron-vite build`
Expected: `out/main/cli.js` ok.

- [ ] **Step 2: Roteiro de smoke**

`orkestral` → banner + REPL. Sequência: mandar msg (streaming) → `/model` (troca, marca
atual) → `/agent` → `/new` → `/clear` → `/compact` → `/config` (edita 1) →
`/permissions` → `/help` → `/exit`. Conferir persistência no desktop onde aplicável.

- [ ] **Step 3: Gate**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: ok; testes (commands, stream-render, feed-buffer, crypto-secret) passam.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(cli): smoke do REPL + ajustes finais"
```

---

## Self-review (cobertura da spec 3)

- REPL + banner + status line → Tasks 5. ✓
- Streaming render → Task 2, 5. ✓
- Slash commands (new/clear/compact/help/model/agent/workspace/config/permissions/exit) → Tasks 1, 3, 5, 6. ✓
- Selector com marca do atual → Task 4. ✓
- `/config` curado → Task 6. ✓
- Flags + modo de permissão → Task 5 (reusa permission.ts da spec 2). ✓
- Cancelamento + fila → Task 7. ✓
- Pontos abertos declarados: `messageRepo.deleteBySession`, assinatura de
  `maybeCompactSessionContext` force, chaves do settings p/ `/config`, funções de
  cancelar/enfileirar do chat-service — confirmados na implementação.
