# Daemon / hosting — Plano de Implementação (Spec 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `orkestral init` (setup no terminal, incl. QR do WhatsApp) e `orkestral serve` (cockpit ao vivo + canais headless) pra rodar numa VPS.

**Architecture:** Subcomandos no `cli.ts` (commander, da spec 1). UI em Ink (React p/ terminal). `init` reusa `channelRepo`/`agentRepo`/`workspaceRepo` + o connect dos canais (handler `onQr` já existe). `serve` chama `bootstrapServices({headless:true})`, assina `chatStreamBus` e renderiza banner + status + feed. Chat via canal já está cabeado (channel-manager assina o bus).

**Tech Stack:** Ink, qrcode-terminal, commander, EventEmitter (`chatStreamBus`), better-sqlite3.

**Depende de:** Spec 1 (host seam, `bootstrapServices`, `cli.ts`).

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---------|------------------|
| `src/main/cli/feed-buffer.ts` (criar) | ring buffer puro do feed ao vivo |
| `src/main/cli/feed-buffer.test.ts` (criar) | teste do ring buffer |
| `src/main/cli/status.ts` (criar) | coleta o snapshot de status (DB/MCP/workspace/agente/canais) |
| `src/main/cli/ui/Banner.tsx` (criar) | banner ASCII Orkestral + versão/modo |
| `src/main/cli/ui/Cockpit.tsx` (criar) | painel `serve`: banner + status + feed |
| `src/main/cli/ui/InitWizard.tsx` (criar) | wizard `init`: workspace → agente/modelo → canal |
| `src/main/cli/qr.ts` (criar) | renderiza QR no terminal (qrcode-terminal) |
| `src/main/cli.ts` (modificar) | registrar `init` / `serve` / `status` |

---

## Task 1: Instalar deps de TUI

- [ ] **Step 1: Instalar**

Run: `npm install ink qrcode-terminal && npm install -D @types/qrcode-terminal`
Expected: adicionadas. (Ink traz o reconciler React.)

> Confirmar a versão de Ink compatível com React 19 (já é dep). Se conflito de
> peer-deps, fixar a major de Ink que suporta React 19 antes de prosseguir.

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(cli): deps de TUI (ink, qrcode-terminal)"
```

## Task 2: Ring buffer do feed (puro, TDD)

**Files:**
- Create: `src/main/cli/feed-buffer.ts`
- Test: `src/main/cli/feed-buffer.test.ts`

- [ ] **Step 1: Teste que falha**

```ts
// src/main/cli/feed-buffer.test.ts
import { describe, it, expect } from 'vitest';
import { FeedBuffer } from './feed-buffer';

describe('FeedBuffer', () => {
  it('mantém só as últimas N linhas (cap)', () => {
    const f = new FeedBuffer(3);
    for (let i = 1; i <= 5; i++) f.push({ ts: i, text: `l${i}` });
    expect(f.lines().map((l) => l.text)).toEqual(['l3', 'l4', 'l5']);
  });

  it('lines() devolve em ordem cronológica', () => {
    const f = new FeedBuffer(10);
    f.push({ ts: 1, text: 'a' });
    f.push({ ts: 2, text: 'b' });
    expect(f.lines().map((l) => l.text)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/cli/feed-buffer.test.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Implementar**

```ts
// src/main/cli/feed-buffer.ts
export interface FeedLine {
  ts: number;
  text: string;
}

export class FeedBuffer {
  private buf: FeedLine[] = [];
  constructor(private cap: number) {}
  push(line: FeedLine): void {
    this.buf.push(line);
    if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap);
  }
  lines(): readonly FeedLine[] {
    return this.buf;
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/cli/feed-buffer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/cli/feed-buffer.ts src/main/cli/feed-buffer.test.ts
git commit -m "feat(cli): FeedBuffer (ring buffer do feed ao vivo)"
```

## Task 3: Coletor de status

**Files:**
- Create: `src/main/cli/status.ts`

- [ ] **Step 1: Implementar**

Reúne o estado pro cockpit/`status`. Usa repos existentes + `appInfo` do host.

```ts
// src/main/cli/status.ts
import { appInfo } from '../platform/host';
import { ChannelRepository } from '../db/repositories/channel.repo'; // ajustar nome real
import { WorkspaceRepository } from '../db/repositories/workspace.repo';
import { AgentRepository } from '../db/repositories/agent.repo';

export interface DaemonStatus {
  version: string;
  dbPath: string;
  workspace: { id: string; name: string } | null;
  agent: { name: string; adapter: string; model: string | null } | null;
  channels: { type: string; status: string }[];
}

export function collectStatus(activeWorkspaceId: string | null): DaemonStatus {
  const channelRepo = new ChannelRepository();
  const wsRepo = new WorkspaceRepository();
  const agentRepo = new AgentRepository();
  const ws = activeWorkspaceId ? wsRepo.get(activeWorkspaceId) : null;
  const agent = ws ? (agentRepo.listByWorkspace(ws.id).find((a) => a.isOrchestrator) ?? null) : null;
  return {
    version: appInfo.version(),
    dbPath: appInfo.path('userData'),
    workspace: ws ? { id: ws.id, name: ws.name } : null,
    agent: agent ? { name: agent.name, adapter: agent.adapterType ?? '—', model: agent.model } : null,
    channels: channelRepo.listAccounts().map((a) => ({ type: a.channelType, status: a.status })),
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:node`
Expected: sem erros (ajustar imports reais de repos/campos se o typecheck reclamar).

- [ ] **Step 3: Commit**

```bash
git add src/main/cli/status.ts
git commit -m "feat(cli): coletor de status do daemon"
```

## Task 4: QR no terminal

**Files:**
- Create: `src/main/cli/qr.ts`

- [ ] **Step 1: Implementar**

```ts
// src/main/cli/qr.ts
import qrcode from 'qrcode-terminal';

/** Imprime o QR (string crua do canal) no terminal, pra escanear no celular. */
export function printQr(data: string): void {
  qrcode.generate(data, { small: true });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/cli/qr.ts
git commit -m "feat(cli): render de QR no terminal"
```

## Task 5: Banner (Ink)

**Files:**
- Create: `src/main/cli/ui/Banner.tsx`

- [ ] **Step 1: Implementar**

```tsx
// src/main/cli/ui/Banner.tsx
import React from 'react';
import { Box, Text } from 'ink';

export function Banner({ subtitle }: { subtitle: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="magenta" bold>
        ███  orkestral
      </Text>
      <Text dimColor>{subtitle}</Text>
    </Box>
  );
}
```

> O ASCII final (logo bonito) é ajustado por olho no smoke. Mantém curto pra caber.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:node`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add src/main/cli/ui/Banner.tsx
git commit -m "feat(cli): Banner (Ink)"
```

## Task 6: `orkestral serve` (cockpit)

**Files:**
- Create: `src/main/cli/ui/Cockpit.tsx`
- Modify: `src/main/cli.ts`

- [ ] **Step 1: Cockpit (Ink)**

Assina `chatStreamBus` + eventos de canal; alimenta `FeedBuffer`; render banner +
status + feed. `useEffect` p/ subscrever no mount e limpar no unmount.

```tsx
// src/main/cli/ui/Cockpit.tsx
import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Banner } from './Banner';
import { FeedBuffer } from '../feed-buffer';
import { collectStatus, type DaemonStatus } from '../status';
import { chatStreamBus } from '../../services/chat-service';
import type { ChatStreamEvent } from '../../../shared/types';

const feed = new FeedBuffer(12);

export function Cockpit({ workspaceId }: { workspaceId: string | null }): React.ReactElement {
  const { exit } = useApp();
  const [, force] = useState(0);
  const [status] = useState<DaemonStatus>(() => collectStatus(workspaceId));
  useInput((input) => {
    if (input === 'q') exit();
  });
  useEffect(() => {
    const onEvent = (e: ChatStreamEvent): void => {
      if (e.type === 'text-delta') return; // não floodar o feed com tokens
      feed.push({ ts: Date.now(), text: `run ▸ ${e.type}` });
      force((n) => n + 1);
    };
    chatStreamBus.on('event', onEvent);
    return () => {
      chatStreamBus.off('event', onEvent);
    };
  }, []);
  return (
    <Box flexDirection="column">
      <Banner subtitle={`serve · v${status.version} · headless`} />
      <Text>DB        {status.dbPath}</Text>
      <Text>
        Workspace {status.workspace?.name ?? '—'} · Agente {status.agent?.name ?? '—'} ·{' '}
        {status.agent?.model ?? '—'}
      </Text>
      {status.channels.map((c) => (
        <Text key={c.type}>
          Canal {c.type} {c.status === 'connected' ? '● conectado' : `○ ${c.status}`}
        </Text>
      ))}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Feed ao vivo (q sai)</Text>
        {feed.lines().map((l, i) => (
          <Text key={i}>{l.text}</Text>
        ))}
      </Box>
    </Box>
  );
}
```

> Mensagens inbound/outbound dos canais: adicionar listeners do channel-manager
> (ou um broadcast novo `channels:message`) ao feed na impl — confirmar o evento.

- [ ] **Step 2: Registrar o subcomando**

Em `src/main/cli.ts`, adicionar:

```ts
import { render } from 'ink';
import React from 'react';
import { bootstrapServices } from './bootstrap';
import { Cockpit } from './cli/ui/Cockpit';
// resolver workspace ativo (settings ou 1º workspace) — função util:
import { resolveActiveWorkspaceId } from './cli/active-workspace'; // criar util simples

program
  .command('serve')
  .description('sobe o Orkestral headless + cockpit')
  .option('--no-tui', 'sem painel (loga linhas; pra systemd/sem TTY)')
  .action((opts: { tui: boolean }) => {
    bootstrapServices({ headless: true });
    const wsId = resolveActiveWorkspaceId();
    if (opts.tui && process.stdout.isTTY) {
      render(React.createElement(Cockpit, { workspaceId: wsId }));
    } else {
      console.log('[orkestral] serve headless (sem TUI). Ctrl+C pra sair.');
      setInterval(() => {}, 1 << 30);
    }
  });
```

`src/main/cli/active-workspace.ts`: lê o workspace ativo do `settings` (chave que a UI
usa) com fallback pro 1º de `WorkspaceRepository().listAll()`.

- [ ] **Step 3: Build + smoke**

Run: `npx electron-vite build && npm run cli -- serve`
Expected: banner + status + feed; `q` sai. (Precisa de DB já com workspace/canal —
senão mostra `—`; o `init` da Task 8 preenche.)

- [ ] **Step 4: Commit**

```bash
git add src/main/cli/ui/Cockpit.tsx src/main/cli/active-workspace.ts src/main/cli.ts
git commit -m "feat(cli): orkestral serve (cockpit Ink + chatStreamBus)"
```

## Task 7: `orkestral status`

**Files:** Modify `src/main/cli.ts`

- [ ] **Step 1: Implementar**

```ts
program
  .command('status')
  .description('imprime status e sai (healthcheck)')
  .action(() => {
    bootstrapServices({ headless: true });
    const s = collectStatus(resolveActiveWorkspaceId());
    const okChannel = s.channels.some((c) => c.status === 'connected');
    console.log(JSON.stringify(s, null, 2));
    process.exit(okChannel ? 0 : 1);
  });
```

- [ ] **Step 2: Build + smoke**

Run: `npx electron-vite build && npm run cli -- status; echo "exit=$?"`
Expected: imprime JSON; exit 0 se algum canal conectado, senão 1.

- [ ] **Step 3: Commit**

```bash
git add src/main/cli.ts
git commit -m "feat(cli): orkestral status (healthcheck)"
```

## Task 8: `orkestral init` (wizard)

**Files:**
- Create: `src/main/cli/ui/InitWizard.tsx`
- Modify: `src/main/cli.ts`

- [ ] **Step 1: Wizard (Ink) — passos sequenciais**

Estado `step: 'workspace' | 'agent' | 'channel' | 'done'`. Cada passo lista opções
(`ink` SelectInput-like, ou navegação com `useInput`) e persiste via repos. No passo
`channel`, ao conectar WhatsApp, passa `onQr: (qr) => printQr(qr)` pro connect e
aguarda `status === 'connected'`.

```tsx
// esqueleto — render por passo; reusa repos + connect de canal
import { printQr } from '../qr';
import { connectChannel } from '../../services/channels/channel-manager'; // confirmar nome do connect público
// workspace: WorkspaceRepository (listAll/create) · agente: AgentRepository (listByWorkspace/create)
// canal: ChannelRepository.createAccount + connectChannel(accountId, { onQr })
```

> Confirmar na impl: o nome da função pública de connect (hoje o fluxo vive no
> channel-manager com `onQr` em channel-types.ts:35; pode ser `openConnection`) e
> como obter o `status === 'connected'` (evento/poll do `channelRepo.getAccount`).

- [ ] **Step 2: Registrar subcomando**

```ts
program
  .command('init')
  .description('setup no terminal (workspace, agente, canal)')
  .action(() => {
    bootstrapServices({ headless: true });
    render(React.createElement(InitWizard));
  });
```

- [ ] **Step 3: Build + smoke (DB limpo de teste)**

Run: `npx electron-vite build && npm run cli -- init`
Expected: percorre os passos; cria workspace+agente; no canal, QR aparece no terminal
(WhatsApp) ou aceita token (Telegram); persiste. Conferir no app desktop que aparece.

- [ ] **Step 4: Commit**

```bash
git add src/main/cli/ui/InitWizard.tsx src/main/cli.ts
git commit -m "feat(cli): orkestral init (wizard de setup + QR)"
```

## Task 9: Modo de permissão → flag do adapter

**Files:** Modify onde o adapter é spawnado (confirmar: `spawn-policy.ts` / `chat-service` / engine spawn).

- [ ] **Step 1: Mapear modo → flag**

Adicionar uma opção global `--permission-mode <m>` / `--dangerously-skip-permissions`
no `program` (commander), guardar num módulo `src/main/cli/permission.ts`
(`getPermissionMode()/setPermissionMode()`), e no ponto de spawn do adapter
(claude_local/codex_local) anexar a flag correspondente quando `dangerously-skip`.

```ts
// src/main/cli/permission.ts
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dangerously-skip';
let mode: PermissionMode = 'default';
export const getPermissionMode = (): PermissionMode => mode;
export const setPermissionMode = (m: PermissionMode): void => { mode = m; };
```

> Confirmar na impl as flags exatas que cada adapter CLI aceita (ex.: claude
> `--dangerously-skip-permissions`) e o ponto de montagem dos args do spawn.

- [ ] **Step 2: Typecheck + build + smoke**

Run: `npx electron-vite build && npm run cli -- serve --dangerously-skip-permissions`
Expected: sobe; o modo reflete no status/log; spawn do adapter leva a flag.

- [ ] **Step 3: Commit**

```bash
git add src/main/cli/permission.ts src/main/cli.ts
git commit -m "feat(cli): modo de permissão → flag do adapter"
```

## Task 10: systemd + smoke final

**Files:**
- Create: `docs/deploy/orkestral.service` (exemplo)

- [ ] **Step 1: Unit de exemplo**

```ini
# docs/deploy/orkestral.service
[Unit]
Description=Orkestral daemon
After=network-online.target

[Service]
ExecStart=/usr/bin/orkestral serve --no-tui
Restart=always
Environment=ELECTRON_RUN_AS_NODE=1
# Environment=ORKESTRAL_SECRET_KEY=...  (de um secrets manager)

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Smoke ponta-a-ponta**

`init` (criar workspace+agente, parear Telegram via token) → `serve` → mandar msg no
canal → ver no feed + resposta volta no canal. `status` retorna exit 0.

- [ ] **Step 3: Gate**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: ok; testes (feed-buffer, crypto-secret) passam.

- [ ] **Step 4: Commit**

```bash
git add docs/deploy/orkestral.service
git commit -m "docs(cli): unit systemd de exemplo"
```

---

## Self-review (cobertura da spec 2)

- init wizard (workspace/agente/modelo/canal + QR) → Tasks 4, 8. ✓
- serve cockpit (banner + status + feed) → Tasks 3, 5, 6. ✓
- status/healthcheck → Task 7. ✓
- `--no-tui` / systemd → Tasks 6, 10. ✓
- modo de permissão → Task 9. ✓
- Pontos abertos declarados: versão de Ink vs React 19 (T1); nome do connect público
  + leitura de status conectado (T8); evento de mensagem de canal pro feed (T6);
  flags exatas do adapter (T9). Todos confirmados na implementação.
