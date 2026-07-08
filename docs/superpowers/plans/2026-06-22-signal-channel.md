# Signal Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar o Signal como canal (DM → agente), linkando a conta do usuário via QR e
falando com um `signal-cli` baixado sob demanda por JSON-RPC.

**Architecture:** `SignalConnection` (espelha `TelegramConnection`) gerencia um processo
`signal-cli jsonRpc` local: link via QR (reusa o fluxo de QR do WhatsApp), recebe via notificações
JSON-RPC, envia/edita por RPC. Sem webhook/túnel. Credenciais file-based (sem migration).

**Tech Stack:** Electron (main), `signal-cli` (JVM, baixado via `download-manager`), JSON-RPC sobre
stdio, React (renderer), vitest (módulos puros), drizzle (reuso de `channel_accounts`/`channel_sessions`).

**Gate de cada task:** `npm run typecheck:node` + `npm run typecheck:web` + `npx eslint <arquivos>`
limpos (convenção dos canais atuais). Tasks 2 e 3 também rodam `vitest`.

> ⚠️ Pré-requisito: o merge `main → feat/telegram-channel` precisa estar resolvido antes
> (conflitos em `channel-manager.ts`, `ChannelsPage.tsx`, `SessionPage.tsx`). Este plano assume
> a árvore já mergeada, com `ChannelType = 'whatsapp' | 'telegram' | 'discord' | 'msteams'`.

---

### Task 1: Registrar o tipo de canal `signal`

**Files:**

- Modify: `src/shared/types/index.ts:1704` (`ChannelType`)
- Modify: `src/renderer/src/components/chat/ChannelIcon.tsx`
- Modify: `src/renderer/src/pages/SessionPage.tsx` (`CHANNEL_LABEL`)

- [ ] **Step 1: Adicionar `'signal'` ao union**

```ts
export type ChannelType = 'whatsapp' | 'telegram' | 'discord' | 'msteams' | 'signal';
```

- [ ] **Step 2: Logo do Signal no `ChannelIcon` BRAND** (simple-icons "signal", cor `#3A76F0`)

```ts
signal: {
  color: '#3A76F0',
  path: 'M12 0C5.373 0 0 5.373 0 12c0 2.018.498 3.92 1.379 5.59L.04 22.46a1.2 1.2 0 0 0 1.5 1.5l4.87-1.34A11.95 11.95 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z',
},
```

> Nota: confirmar o path oficial em simple-icons (`signal.svg`) na hora — usar o `d` exato.

- [ ] **Step 3: Label no `CHANNEL_LABEL`** (SessionPage)

```ts
const CHANNEL_LABEL: Record<ChannelType, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  discord: 'Discord',
  msteams: 'Microsoft Teams',
  signal: 'Signal',
};
```

- [ ] **Step 4: Gate** — `npm run typecheck:web && npm run typecheck:node && npx eslint src/renderer/src/components/chat/ChannelIcon.tsx src/renderer/src/pages/SessionPage.tsx`
      Expected: 0 erros (vários arquivos podem reclamar de `Record<ChannelType,...>` não-exaustivo — corrigir todos que o tsc apontar adicionando a chave `signal`).

- [ ] **Step 5: Commit** — `feat(channels): register signal channel type + icon/label`

---

### Task 2: Parser do link-URI (puro + teste)

**Files:**

- Create: `src/main/services/channels/signal-link-uri.ts`
- Test: `src/main/services/channels/signal-link-uri.test.ts`

- [ ] **Step 1: Teste falhando**

```ts
import { describe, it, expect } from 'vitest';
import { extractLinkUri } from './signal-link-uri';

describe('extractLinkUri', () => {
  it('extrai o sgnl://linkdevice da saída do signal-cli', () => {
    const out = 'Some banner\nsgnl://linkdevice?uuid=abc&pub_key=xyz%3D\nmore logs';
    expect(extractLinkUri(out)).toBe('sgnl://linkdevice?uuid=abc&pub_key=xyz%3D');
  });
  it('retorna null quando não há URI', () => {
    expect(extractLinkUri('nada aqui')).toBeNull();
  });
  it('pega a primeira ocorrência e ignora espaços/quebras', () => {
    expect(extractLinkUri('  sgnl://linkdevice?uuid=1  \n')).toBe('sgnl://linkdevice?uuid=1');
  });
});
```

- [ ] **Step 2: Rodar — deve falhar** — `npx vitest run src/main/services/channels/signal-link-uri.test.ts`
      Expected: FAIL ("extractLinkUri is not a function").

- [ ] **Step 3: Implementar**

```ts
/** Extrai o URI de device-link (`sgnl://linkdevice?...`) da saída do `signal-cli link`. */
export function extractLinkUri(stdout: string): string | null {
  const m = stdout.match(/sgnl:\/\/linkdevice\?\S+/);
  return m ? m[0].trim() : null;
}
```

- [ ] **Step 4: Rodar — deve passar.** Gate: `npx eslint src/main/services/channels/signal-link-uri.ts`

- [ ] **Step 5: Commit** — `feat(signal): link-uri parser`

---

### Task 3: Framing JSON-RPC sobre stdio (puro + teste)

**Files:**

- Create: `src/main/services/channels/signal-jsonrpc.ts`
- Test: `src/main/services/channels/signal-jsonrpc.test.ts`

- [ ] **Step 1: Teste falhando**

```ts
import { describe, it, expect } from 'vitest';
import { encodeRequest, parseLines, type SignalRpcMessage } from './signal-jsonrpc';

describe('signal-jsonrpc', () => {
  it('encodeRequest gera JSON-RPC 2.0 com id e \\n', () => {
    const line = encodeRequest(7, 'send', { recipient: ['+1'], message: 'oi' });
    expect(line.endsWith('\n')).toBe(true);
    const obj = JSON.parse(line);
    expect(obj).toMatchObject({ jsonrpc: '2.0', id: 7, method: 'send' });
  });
  it('parseLines separa por linha e decodifica notificações de receive', () => {
    const buf =
      '{"jsonrpc":"2.0","method":"receive","params":{"envelope":{}}}\n{"jsonrpc":"2.0","id":1,"result":{}}\n';
    const msgs: SignalRpcMessage[] = parseLines(buf).messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].method).toBe('receive');
    expect(msgs[1].id).toBe(1);
  });
  it('parseLines devolve o resto incompleto (sem \\n) pra próxima leitura', () => {
    const { messages, rest } = parseLines('{"a":1}\n{"b":2');
    expect(messages).toHaveLength(1);
    expect(rest).toBe('{"b":2');
  });
});
```

- [ ] **Step 2: Rodar — deve falhar.**

- [ ] **Step 3: Implementar**

```ts
export interface SignalRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Serializa uma request JSON-RPC 2.0 terminada em \n (framing por linha do signal-cli). */
export function encodeRequest(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

/** Decodifica um buffer de stdout em mensagens completas (1 por linha) + o resto incompleto. */
export function parseLines(buffer: string): { messages: SignalRpcMessage[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  const messages: SignalRpcMessage[] = [];
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as SignalRpcMessage);
    } catch {
      /* linha não-JSON (log do signal-cli) — ignora */
    }
  }
  return { messages, rest };
}
```

- [ ] **Step 4: Rodar — deve passar.** Gate eslint.

- [ ] **Step 5: Commit** — `feat(signal): json-rpc stdio framing`

---

### Task 4: Pack-manager do `signal-cli` (download sob demanda)

**Files:**

- Create: `src/main/services/channels/signal-cli-pack.ts`
- Reuse: `src/main/services/voice/download-manager.ts` (`downloadWithProgress`, `extractTarball`, `sha256File`)

- [ ] **Step 1: Manifest por plataforma** (no topo do arquivo)

```ts
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { app, BrowserWindow } from 'electron';
import { downloadWithProgress, extractTarball, sha256File } from '../voice/download-manager';

interface PackComponent {
  id: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  /** Caminho relativo (dentro de signalRoot()) do executável após extrair. */
  bin: string;
}

function signalRoot(): string {
  return join(app.getPath('userData'), 'tools', 'signal-cli');
}

/** Componentes (JRE mínima + signal-cli) por plataforma. PINAR versão + sha256 reais. */
function componentsForPlatform(): { jre: PackComponent; cli: PackComponent } {
  const platform = `${process.platform}-${process.arch}`; // ex.: darwin-arm64
  // TODO ao implementar: preencher URLs (Adoptium JRE 21 + signal-cli release) e sha256 por platform.
  const table: Record<string, { jre: PackComponent; cli: PackComponent }> = {
    'darwin-arm64': {
      jre: { id: 'jre', url: '...', sha256: '...', sizeBytes: 0, bin: 'jre/bin/java' },
      cli: {
        id: 'signal-cli',
        url: '...',
        sha256: '...',
        sizeBytes: 0,
        bin: 'signal-cli/bin/signal-cli',
      },
    },
    // darwin-x64, linux-x64, linux-arm64...
  };
  const entry = table[platform];
  if (!entry) throw new Error(`Signal não suportado nesta plataforma: ${platform}`);
  return entry;
}
```

- [ ] **Step 2: Status + caminhos**

```ts
export function javaBin(): string {
  return join(signalRoot(), componentsForPlatform().jre.bin);
}
export function signalCliBin(): string {
  return join(signalRoot(), componentsForPlatform().cli.bin);
}
export function isSignalCliInstalled(): boolean {
  return existsSync(javaBin()) && existsSync(signalCliBin());
}
```

- [ ] **Step 3: Install com progresso** (emit em `channels:signal-cli-progress`, mirror do voice pack)

```ts
let installing = false;

function emit(event: { type: string; percent?: number; error?: string }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('channels:signal-cli-progress', event);
  }
}

export async function installSignalCli(): Promise<{ ok: true }> {
  if (installing) throw new Error('Instalação do signal-cli já em andamento.');
  installing = true;
  try {
    const { jre, cli } = componentsForPlatform();
    const total = jre.sizeBytes + cli.sizeBytes;
    let base = 0;
    emit({ type: 'start', percent: 0 });
    for (const c of [jre, cli]) {
      const tmp = join(signalRoot(), `${c.id}.tar.gz`);
      await downloadWithProgress(c.url, tmp, (received) =>
        emit({ type: 'progress', percent: Math.round(((base + received) / total) * 100) }),
      );
      if ((await sha256File(tmp)) !== c.sha256) throw new Error(`sha256 do ${c.id} não confere`);
      await extractTarball(tmp, join(signalRoot(), c.id === 'jre' ? 'jre' : 'signal-cli'));
      base += c.sizeBytes;
    }
    // macOS: tira quarantine + garante +x (padrão do voice pack).
    chmodSync(signalCliBin(), 0o755);
    chmodSync(javaBin(), 0o755);
    if (process.platform === 'darwin') {
      try {
        execFileSync('xattr', ['-dr', 'com.apple.quarantine', signalRoot()]);
      } catch {
        /* best-effort */
      }
    }
    emit({ type: 'done', percent: 100 });
    return { ok: true };
  } catch (err) {
    emit({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    installing = false;
  }
}
```

- [ ] **Step 4: Gate** — `npm run typecheck:node && npx eslint src/main/services/channels/signal-cli-pack.ts`

- [ ] **Step 5: Commit** — `feat(signal): on-demand signal-cli pack manager`

---

### Task 5: `SignalConnection` (link + daemon + IO)

**Files:**

- Create: `src/main/services/channels/signal-connection.ts`
- Reference: `src/main/services/channels/telegram-connection.ts` (interface/shape a espelhar)

- [ ] **Step 1: Handlers + esqueleto** (mesma forma do `TelegramConnection`)

```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboundChannelMessage } from './channel-types';
import { signalCliBin, javaBin } from './signal-cli-pack';
import { encodeRequest, parseLines, type SignalRpcMessage } from './signal-jsonrpc';
import { extractLinkUri } from './signal-link-uri';

export interface SignalConnectionHandlers {
  onQr: (linkUri: string) => void;
  onConnected: (selfId: string | null) => void;
  onDisconnected: (loggedOut: boolean, error: string | null) => void;
  onMessage: (msg: InboundChannelMessage) => void;
}

export class SignalConnection {
  private daemon: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = '';
  private rpcId = 0;
  private stopped = false;

  constructor(
    private readonly configDir: string,
    private account: string | null, // número, se já linkado
    private readonly handlers: SignalConnectionHandlers,
  ) {}
```

- [ ] **Step 2: `start()` — linka (se preciso) e sobe o daemon**

```ts
  async start(): Promise<void> {
    this.stopped = false;
    mkdirSync(this.configDir, { recursive: true });
    if (!this.account) {
      await this.linkFlow(); // resolve quando o usuário escaneia o QR
    }
    if (this.stopped || !this.account) return;
    this.spawnDaemon();
    this.handlers.onConnected(this.account);
  }

  /** Roda `signal-cli link`, captura o sgnl:// pro QR e descobre o número ao concluir. */
  private linkFlow(): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = spawn(javaBin(), ['-jar', signalCliBin(), '--config', this.configDir, 'link', '-n', 'Orkestral']);
      let out = '';
      let emitted = false;
      const onData = (chunk: Buffer): void => {
        out += chunk.toString();
        if (!emitted) {
          const uri = extractLinkUri(out);
          if (uri) {
            emitted = true;
            this.handlers.onQr(uri);
          }
        }
      };
      p.stdout.on('data', onData);
      p.stderr.on('data', onData);
      p.on('close', (code) => {
        if (code === 0) {
          this.account = this.discoverAccount();
          resolve();
        } else {
          reject(new Error(`signal-cli link falhou (code ${code})`));
        }
      });
    });
  }

  /** `signal-cli listAccounts` → primeiro número linkado. */
  private discoverAccount(): string | null {
    try {
      const out = execFileSync(javaBin(), ['-jar', signalCliBin(), '--config', this.configDir, 'listAccounts']).toString();
      return out.match(/\+\d{6,}/)?.[0] ?? null;
    } catch {
      return null;
    }
  }
```

- [ ] **Step 3: Daemon jsonRpc + parse de receive**

```ts
  private spawnDaemon(): void {
    const d = spawn(javaBin(), ['-jar', signalCliBin(), '--config', this.configDir, '-a', this.account!, 'jsonRpc']);
    this.daemon = d;
    d.stdout.on('data', (chunk: Buffer) => {
      const { messages, rest } = parseLines(this.stdoutBuf + chunk.toString());
      this.stdoutBuf = rest;
      for (const m of messages) this.handleRpc(m);
    });
    d.on('close', () => {
      if (!this.stopped) this.handlers.onDisconnected(false, 'signal-cli daemon caiu');
    });
  }

  private handleRpc(m: SignalRpcMessage): void {
    if (m.method !== 'receive') return;
    const env = (m.params as { envelope?: Record<string, unknown> })?.envelope;
    const data = env?.dataMessage as { message?: string; groupInfo?: unknown } | undefined;
    if (!env || !data?.message || data.groupInfo) return; // só DM com texto
    const from = String(env.sourceNumber ?? env.sourceUuid ?? '');
    if (!from) return;
    this.handlers.onMessage({
      from,
      senderNumber: from.replace(/\D/g, ''),
      pushName: (env.sourceName as string) ?? null,
      text: data.message,
      attachments: [],
    });
  }
```

- [ ] **Step 4: Envio / edição / typing / media / stop / logout**

```ts
  private rpc(method: string, params: unknown): void {
    this.daemon?.stdin.write(encodeRequest(++this.rpcId, method, params));
  }

  async sendText(to: string, text: string): Promise<number | null> {
    const ts = Date.now(); // timestamp local como chave de edição (signal-cli usa o ts do envio)
    this.rpc('send', { recipient: [to], message: text });
    return ts;
  }
  async editText(to: string, key: unknown, text: string): Promise<void> {
    this.rpc('sendEditMessage', { recipient: [to], message: text, targetTimestamp: key });
  }
  async sendTyping(to: string): Promise<void> {
    this.rpc('sendTyping', { recipient: [to] });
  }
  async sendMedia(to: string, buffer: Buffer, mime: string, caption?: string, filename = 'file'): Promise<void> {
    const path = join(tmpdir(), `ork-signal-${Date.now()}-${filename}`);
    writeFileSync(path, buffer);
    try {
      this.rpc('send', { recipient: [to], message: caption ?? '', attachments: [path] });
    } finally {
      // limpa após dar tempo do signal-cli ler (best-effort) — ver nota no spec sobre cleanup.
    }
  }
  async fetchProfilePhoto(): Promise<string | null> { return null; }
  async stop(): Promise<void> { this.stopped = true; this.daemon?.kill(); this.daemon = null; }
  async logout(): Promise<void> { this.stopped = true; this.daemon?.kill(); this.daemon = null; }
}
```

> Nota de edição: `targetTimestamp` real do Signal é o timestamp que o **próprio signal-cli**
> atribui no envio (retornado no `result` da request `send`). Ao implementar, capturar o
> `result.timestamp` casando pelo `id` da request (manter um `Map<id, resolve>`); o `Date.now()`
> acima é placeholder. Se a captura ficar complexa, usar o fallback (sem streaming) do spec §5.4.

- [ ] **Step 5: Gate** — `npm run typecheck:node && npx eslint src/main/services/channels/signal-connection.ts`

- [ ] **Step 6: Commit** — `feat(signal): SignalConnection (link + jsonRpc daemon)`

---

### Task 6: Fiação no `channel-manager`

**Files:**

- Modify: `src/main/services/channels/channel-manager.ts`

- [ ] **Step 1: `signalConfigDir` + `readSignalAccount`** (mirror de `telegramTokenFile`)

```ts
function signalConfigDir(accountId: string): string {
  return join(app.getPath('userData'), 'channels', 'signal', accountId);
}
/** Número já linkado (se houver) — `signal-cli listAccounts` ou um arquivo `account` cacheado. */
function readSignalAccount(accountId: string): string | null {
  /* ler do dir/cache; null se não linkado */
}
```

- [ ] **Step 2: `buildSignalConnection`** (mirror de `buildTelegramConnection`, com onQr → QR como WhatsApp)

```ts
function buildSignalConnection(accountId: string): ChannelConnection | null {
  if (!isSignalCliInstalled()) {
    channelRepo.updateAccount(accountId, {
      status: 'connecting',
      lastError: 'Baixando signal-cli…',
    });
    emitAccountUpdate(accountId);
    void installSignalCli()
      .then(() => openConnection(accountId)) // re-tenta após instalar
      .catch((e) => {
        channelRepo.updateAccount(accountId, { status: 'disconnected', lastError: String(e) });
        emitAccountUpdate(accountId);
      });
    return null;
  }
  return new SignalConnection(signalConfigDir(accountId), readSignalAccount(accountId), {
    onQr: (uri) => {
      void QRCode.toDataURL(uri, { margin: 1, width: 264 }).then((dataUrl) => {
        qrByAccount.set(accountId, dataUrl);
        channelRepo.updateAccount(accountId, { status: 'qr', lastError: null });
        emitAccountUpdate(accountId);
      });
    },
    onConnected: (selfId) => {
      qrByAccount.delete(accountId);
      channelRepo.updateAccount(accountId, {
        status: 'connected',
        selfId,
        lastConnectedAt: new Date().toISOString(),
        lastError: null,
      });
      emitAccountUpdate(accountId);
    },
    onDisconnected: (loggedOut, error) => {
      if (loggedOut) {
        connections.delete(accountId);
        channelRepo.updateAccount(accountId, {
          status: 'disconnected',
          selfId: null,
          lastError: error,
        });
      } else channelRepo.updateAccount(accountId, { status: 'connecting', lastError: error });
      emitAccountUpdate(accountId);
    },
    onMessage: (msg) => handleInbound(accountId, msg),
  });
}
```

- [ ] **Step 3: Branch no `openConnection`**

```ts
const conn =
  account.channelType === 'telegram'
    ? buildTelegramConnection(accountId)
    : account.channelType === 'signal'
      ? buildSignalConnection(accountId)
      : account.channelType === 'discord'
        ? buildDiscordConnection(accountId)
        : account.channelType === 'msteams'
          ? buildTeamsConnection(accountId)
          : buildWhatsAppConnection(accountId);
```

- [ ] **Step 4: Cleanup no `deleteAccount`** — `rmSync(signalConfigDir(accountId), { recursive: true, force: true })`.

- [ ] **Step 5: Boot relink** — em `initChannelService`, religar contas `signal` com conta já linkada (mirror do Telegram com token).

- [ ] **Step 6: Gate** — `npm run typecheck:node && npx eslint src/main/services/channels/channel-manager.ts`

- [ ] **Step 7: Commit** — `feat(signal): wire SignalConnection into channel-manager`

---

### Task 7: IPC — status/install do signal-cli

**Files:**

- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/main/ipc/handlers/channels.ts`

- [ ] **Step 1: Contrato**

```ts
'channels:signal-cli-status': { request: undefined; response: { installed: boolean; installing: boolean } };
'channels:install-signal-cli': { request: undefined; response: { ok: true } };
```

(e adicionar ambos ao array `IPC_CHANNELS`).

- [ ] **Step 2: Handlers**

```ts
registerHandler('channels:signal-cli-status', () => ({
  installed: isSignalCliInstalled(),
  installing: false, // ou expor o flag do pack-manager
}));
registerHandler('channels:install-signal-cli', () => installSignalCli());
```

- [ ] **Step 3: Gate** — `npm run typecheck:node && npx eslint src/main/ipc/handlers/channels.ts`

- [ ] **Step 4: Commit** — `feat(signal): ipc for signal-cli status/install`

---

### Task 8: UI — card Signal + `SignalModal` + i18n

**Files:**

- Modify: `src/renderer/src/pages/ChannelsPage.tsx`
- Modify: `src/renderer/src/i18n/locales/pt-BR/pages.json` + `.../en/pages.json`

- [ ] **Step 1: Brand `SIGNAL`** (igual `TELEGRAM`, cor `#3A76F0`, path do `ChannelIcon`) e incluir em `allBrands` como conectável.

- [ ] **Step 2: `SignalModal`** — espelha `TelegramModal`, mas:
  - sem campo de token; em vez disso, ao **Conectar** chama `channels:connect`;
  - se `channels:signal-cli-status` = não instalado, mostra barra de progresso (assina
    `channels:signal-cli-progress`, igual a UI do voice pack);
  - quando `status === 'qr'`, mostra o **QR** (reusa o mesmo componente de QR do `WhatsAppModal`)
    - instrução: _"Signal > Configurações > Dispositivos vinculados > Vincular novo dispositivo"_;
  - campo allowlist = números de telefone (E.164) / `uuid:<id>`.

- [ ] **Step 3: i18n** — `channels.desc.signal` + `channels.signal.{qrTitle, qrHint, downloadHint, allowlistHint, connectedAs}` (pt-BR + en).

- [ ] **Step 4: Gate** — `npm run typecheck:web && npx eslint src/renderer/src/pages/ChannelsPage.tsx` + validar JSON dos locales.

- [ ] **Step 5: Commit** — `feat(signal): channels UI (card + modal + qr + i18n)`

---

### Task 9: Teste manual ponta-a-ponta

- [ ] **Step 1:** Restart completo do app (mexeu no main).
- [ ] **Step 2:** Canais → card **Signal** → Conectar → aguarda download do signal-cli (barra) → QR aparece.
- [ ] **Step 3:** No celular: Signal > Dispositivos vinculados > Vincular novo → escaneia. Status vai a `connected` com o número.
- [ ] **Step 4:** Manda DM pro próprio número (de outro contato/dispositivo) → cai no agente; resposta volta (streaming por edição ou texto final).
- [ ] **Step 5:** Verifica `/help`, `/new`, `/workspace`, allowlist e ícone Signal nos recentes.
- [ ] **Step 6:** Gate final: `npm run typecheck:node && npm run typecheck:web && npx eslint <todos os arquivos tocados> && npx vitest run src/main/services/channels/signal-*.test.ts`.

---

## Self-Review (cobertura do spec)

- §4.1 componentes → Tasks 2–5. §4.2 mudanças → Tasks 1,6,7,8. §5 fluxos → Tasks 5,6,8,9.
- §6 sem migration → confirmado (file-based dir; nenhuma task toca schema/migration).
- §7 segurança (chmod/xattr/sha256/1-daemon) → Task 4 (chmod/xattr/sha) + Task 6 (1 conn por accountId).
- §8 riscos (JRE, quarantine, edição) → Tasks 4 e 5 (nota de fallback de edição).
- Tipos consistentes: `InboundChannelMessage` (do `channel-types` pós-merge) usado em 5 e 6;
  `ChannelConnection.sendChoices?` já é opcional → Signal não precisa implementar (cai no
  fallback numerado de workspace, como WhatsApp).

## Pendências a resolver na implementação (não-placeholders — decisões factuais)

1. **URLs + sha256 + tamanhos** reais do JRE (Adoptium 21) e do `signal-cli` por plataforma (Task 4).
2. **Path SVG oficial** do logo Signal (simple-icons) (Task 1).
3. **Captura do `result.timestamp`** do `send` pra `targetTimestamp` da edição (Task 5) — ou
   assumir o fallback sem-streaming do spec §5.4.
4. Confirmar nomes exatos dos métodos JSON-RPC do `signal-cli` na versão pinada
   (`send`, `sendEditMessage`, `sendTyping`, `listAccounts`, `link`, `jsonRpc`).
