# Fundação headless — Plano de Implementação (Spec 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subir os serviços do `main` do Orkestral sem janela (headless), pra um CLI/daemon reusá-los, sem quebrar o app desktop.

**Architecture:** Uma camada de host (`src/main/platform/`) abstrai os acessos a `electron` (broadcast a janelas, cripto de segredos, paths/versão do app) com fallback headless. O boot Node-puro vira `bootstrapServices()`, chamado tanto pelo `index.ts` (Electron) quanto por um novo `cli.ts`. O CLI roda sob Electron como runtime headless `electron out/main/cli.js` (sem ELECTRON_RUN_AS_NODE; em Linux usar xvfb-run), reaproveitando o ABI do `better-sqlite3`.

**Tech Stack:** TypeScript, Electron, electron-vite, better-sqlite3, commander, vitest (node).

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---------|------------------|
| `src/main/platform/crypto-secret.ts` (criar) | cripto pura (aes-256-gcm) + resolução da chave; SEM import de electron → testável |
| `src/main/platform/crypto-secret.test.ts` (criar) | testes da cripto pura |
| `src/main/platform/host.ts` (criar) | seam de electron: `broadcast`, `secrets`, `appInfo` (guards headless) |
| `src/main/services/log-bus.ts` (modificar) | usar `host.broadcast` em vez de `BrowserWindow` direto |
| `src/main/services/*.ts` (modificar, lista na Task 4) | idem nos ~13 sites de broadcast |
| `src/main/bootstrap.ts` (criar) | `bootstrapServices({ headless })` com a sequência Node-pura |
| `src/main/index.ts` (modificar) | chamar `bootstrapServices({headless:false})` + manter parte Electron |
| `src/main/cli.ts` (criar) | entry CLI (commander); default = boot headless + manter vivo |
| `bin/orkestral` (criar) | shim que roda Electron como runtime headless `electron out/main/cli.js` (sem ELECTRON_RUN_AS_NODE; em Linux usar xvfb-run) |
| `electron.vite.config.ts` (modificar) | adicionar `cli` como entry do build do main |
| `package.json` (modificar) | `bin` + script `cli` |

---

## Task 1: Cripto pura de segredos (fallback sem Keychain)

**Files:**
- Create: `src/main/platform/crypto-secret.ts`
- Test: `src/main/platform/crypto-secret.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/main/platform/crypto-secret.test.ts
import { describe, it, expect } from 'vitest';
import { encryptWithKey, decryptWithKey } from './crypto-secret';

describe('crypto-secret', () => {
  const key = Buffer.alloc(32, 7); // chave determinística de teste

  it('roundtrip: decrypt(encrypt(x)) === x', () => {
    const blob = encryptWithKey('meu-token-secreto', key);
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(decryptWithKey(blob, key)).toBe('meu-token-secreto');
  });

  it('cada encrypt usa IV novo (blobs diferentes pro mesmo input)', () => {
    const a = encryptWithKey('x', key);
    const b = encryptWithKey('x', key);
    expect(a.equals(b)).toBe(false);
    expect(decryptWithKey(a, key)).toBe('x');
    expect(decryptWithKey(b, key)).toBe('x');
  });

  it('chave errada falha (authTag não bate)', () => {
    const blob = encryptWithKey('x', key);
    expect(() => decryptWithKey(blob, Buffer.alloc(32, 9))).toThrow();
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run src/main/platform/crypto-secret.test.ts`
Expected: FAIL — "Cannot find module './crypto-secret'".

- [ ] **Step 3: Implementar o mínimo**

```ts
// src/main/platform/crypto-secret.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Layout do blob: [iv(12) | authTag(16) | ciphertext]. aes-256-gcm.
const IV_LEN = 12;
const TAG_LEN = 16;

export function encryptWithKey(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptWithKey(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/platform/crypto-secret.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add src/main/platform/crypto-secret.ts src/main/platform/crypto-secret.test.ts
git commit -m "feat(cli): cripto pura de segredos (fallback aes-256-gcm)"
```

## Task 2: Resolução da chave de segredo (env > keyfile)

**Files:**
- Modify: `src/main/platform/crypto-secret.ts`
- Test: `src/main/platform/crypto-secret.test.ts`

- [ ] **Step 1: Adicionar teste que falha**

```ts
// adicionar ao crypto-secret.test.ts
import { resolveSecretKey } from './crypto-secret';

it('resolveSecretKey: usa ORKESTRAL_SECRET_KEY (base64 de 32 bytes)', () => {
  const raw = Buffer.alloc(32, 3);
  const key = resolveSecretKey({ envKey: raw.toString('base64'), keyfilePath: '/tmp/none' });
  expect(key.equals(raw)).toBe(true);
});

it('resolveSecretKey: gera e persiste keyfile quando sem env', () => {
  const p = `/tmp/ork-secret-${process.pid}.key`;
  const k1 = resolveSecretKey({ envKey: undefined, keyfilePath: p });
  const k2 = resolveSecretKey({ envKey: undefined, keyfilePath: p });
  expect(k1.length).toBe(32);
  expect(k1.equals(k2)).toBe(true); // segunda chamada lê o mesmo arquivo
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/platform/crypto-secret.test.ts`
Expected: FAIL — "resolveSecretKey is not a function".

- [ ] **Step 3: Implementar**

```ts
// adicionar ao crypto-secret.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function resolveSecretKey(opts: { envKey?: string; keyfilePath: string }): Buffer {
  if (opts.envKey) {
    const buf = Buffer.from(opts.envKey, 'base64');
    if (buf.length !== 32) throw new Error('ORKESTRAL_SECRET_KEY deve ser 32 bytes em base64');
    return buf;
  }
  if (existsSync(opts.keyfilePath)) {
    const buf = readFileSync(opts.keyfilePath);
    if (buf.length === 32) return buf;
  }
  const key = randomBytes(32);
  mkdirSync(dirname(opts.keyfilePath), { recursive: true });
  writeFileSync(opts.keyfilePath, key, { mode: 0o600 });
  return key;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/platform/crypto-secret.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add src/main/platform/crypto-secret.ts src/main/platform/crypto-secret.test.ts
git commit -m "feat(cli): resolveSecretKey (env > keyfile 0600)"
```

## Task 3: Host seam (`broadcast` / `secrets` / `appInfo`)

**Files:**
- Create: `src/main/platform/host.ts`

> Não tem teste unitário: `host.ts` toca `electron` (não carrega no vitest node).
> A lógica pura testável já vive em `crypto-secret.ts`. Validação = smoke (Task 9).

- [ ] **Step 1: Implementar `host.ts`**

```ts
// src/main/platform/host.ts
import { app, BrowserWindow, safeStorage } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { encryptWithKey, decryptWithKey, resolveSecretKey } from './crypto-secret';

/** Envia um evento ao renderer. No-op headless (sem janela) — os EventEmitters
 *  (ex.: chatStreamBus) seguem por conta própria, então nada é perdido no daemon. */
export function broadcast(channel: string, payload: unknown): void {
  if (!BrowserWindow?.getAllWindows) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function fallbackKey(): Buffer {
  return resolveSecretKey({
    envKey: process.env.ORKESTRAL_SECRET_KEY,
    keyfilePath: join(appInfo.path('userData'), 'secret.key'),
  });
}

/** Cripto de segredos: Keychain do SO (Electron) quando dá; senão aes-256-gcm local. */
export const secrets = {
  encrypt(plain: string): Buffer {
    if (safeStorage?.isEncryptionAvailable?.()) return safeStorage.encryptString(plain);
    return encryptWithKey(plain, fallbackKey());
  },
  decrypt(blob: Buffer): string {
    if (safeStorage?.isEncryptionAvailable?.()) return safeStorage.decryptString(blob);
    return decryptWithKey(blob, fallbackKey());
  },
};

/** Versão e paths do app — com fallback headless. */
export const appInfo = {
  version(): string {
    return app?.getVersion?.() ?? process.env.APP_VERSION ?? '0.0.0-headless';
  },
  path(name: 'userData' | 'home'): string {
    if (app?.getPath) {
      return name === 'userData' ? app.getPath('userData') : app.getPath('home');
    }
    return name === 'home' ? homedir() : join(homedir(), '.orkestral');
  },
};
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:node`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add src/main/platform/host.ts
git commit -m "feat(cli): host seam (broadcast/secrets/appInfo) com guards headless"
```

## Task 4: Migrar sites de broadcast pro `host.broadcast`

**Files (modify):** `src/main/services/log-bus.ts` e os demais sites abaixo.

Padrão a substituir (todos idênticos):

```ts
// ANTES
for (const win of BrowserWindow.getAllWindows()) {
  if (!win.isDestroyed()) win.webContents.send('<channel>', <payload>);
}
// DEPOIS
broadcast('<channel>', <payload>);
```

- [ ] **Step 1: log-bus.ts**

Em `src/main/services/log-bus.ts`: remover `import { BrowserWindow } from 'electron';`,
adicionar `import { broadcast } from '../platform/host';`, e trocar o corpo de
`broadcast(entry)` (linhas 34-40) por:

```ts
function broadcast(entry: TraceEntry): void {
  hostBroadcast('logs:entry', entry);
}
```

(importar como `import { broadcast as hostBroadcast } from '../platform/host';` pra não
colidir com a função local — ou renomear a função local pra `emitTrace`.)

- [ ] **Step 2: Demais sites**

Aplicar o mesmo padrão (trocar o loop por `broadcast(channel, payload)` do host) em:

- `src/main/services/chat-service.ts` (na `emit()` ~291-293) — **manter** o
  `chatStreamBus.emit('event', event)`; trocar SÓ o loop de janelas.
- `src/main/services/preview-manager.ts:31`
- `src/main/services/issue-broadcast.ts`
- `src/main/services/docker-service.ts`
- `src/main/services/terminal-service.ts`
- `src/main/services/kb-embedding-queue.ts`
- `src/main/services/issue-execution-service.ts`
- `src/main/services/source-team-sync.ts`
- `src/main/services/agent-trace.ts`
- `src/main/services/code-review-service.ts`
- `src/main/services/kb-repo-analyzer.ts`
- `src/main/services/mcp-server.ts`
- `src/main/services/cloud-auth.ts`

Pra cada arquivo: localizar `BrowserWindow.getAllWindows()`, trocar o loop pelo
`broadcast(...)`, remover o import de `BrowserWindow` se ficar sem uso.

- [ ] **Step 3: Verificar que sobrou nenhum loop perdido**

Run: `grep -rn "getAllWindows" src/main/services`
Expected: zero ocorrências (ou só dentro de `host.ts` se movido). `index.ts` pode
manter os seus (auto-update, model progress) — fora de escopo desta task.

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck:node && npx eslint src/main/services/log-bus.ts src/main/services/chat-service.ts`
Expected: sem erros novos.

- [ ] **Step 5: Commit**

```bash
git add src/main/services
git commit -m "refactor(cli): broadcast via host seam (guard headless)"
```

## Task 5: Extrair `bootstrapServices`

**Files:**
- Create: `src/main/bootstrap.ts`
- Modify: `src/main/index.ts:370-453`

- [ ] **Step 1: Criar `bootstrap.ts`**

Mover pra cá a sequência Node-pura (hoje inline no `index.ts`). Importa o que o
`index.ts` já importa (initDatabase, recoverInterruptedWork, schedulers,
initChannelService, resumeEmbeddingQueueOnBoot, ensureMcpServerStarted,
resumeInterruptedWork, repos de recovery, sync de sources).

```ts
// src/main/bootstrap.ts
import { initDatabase } from './db/connection';
import { recoverInterruptedWork, resumeInterruptedWork } from './services/recovery'; // ajustar import real
// ... demais imports que hoje estão no topo do index.ts pra esses símbolos

export function bootstrapServices(opts: { headless: boolean }): void {
  initDatabase();
  recoverInterruptedWork();
  // ...todo o miolo Node-puro das linhas 375-434 do index.ts (recovery, orphans,
  // backfill, sync de sources, schedulers, initChannelService, resumeEmbeddingQueueOnBoot,
  // ensureMcpServerStarted)...
  resumeInterruptedWork();
}
```

> Nota: copiar os blocos try/catch exatos das linhas 375-453 do `index.ts`. NÃO mover
> `buildApplicationMenu`, `dock.setIcon`, `registerAllIpcHandlers`, `createWindow`,
> `setupTray`, `initAutoUpdater`, nem os broadcasts de model-progress — esses ficam
> no `index.ts` (Electron-only). `opts.headless` fica disponível pra, no futuro,
> pular algo se precisar (hoje o miolo é igual nos dois).

- [ ] **Step 2: Religar `index.ts`**

Substituir as linhas ~370-434 (miolo Node-puro) por `bootstrapServices({ headless: false });`
mantendo, na ordem original: `registerAllIpcHandlers()` (Electron), `createWindow()`,
`setupTray()`, smoke gate, `initAutoUpdater(...)`, model-progress. (Decidir se
`registerAllIpcHandlers` entra antes ou depois do bootstrap — manter a ordem atual:
hoje vem logo após o sync de sources, então chamá-lo após `bootstrapServices`.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:node`
Expected: sem erros.

- [ ] **Step 4: Regressão desktop**

Run: `npm run dev`
Expected: app abre normal (janela, canais reconectam, logs no terminal). Fechar.

- [ ] **Step 5: Commit**

```bash
git add src/main/bootstrap.ts src/main/index.ts
git commit -m "refactor(cli): extrair bootstrapServices (boot Node-puro reusável)"
```

## Task 6: Entry `cli.ts` (commander, stub headless)

**Files:**
- Create: `src/main/cli.ts`

- [ ] **Step 1: Implementar o stub**

```ts
// src/main/cli.ts
import { Command } from 'commander';
import { bootstrapServices } from './bootstrap';
import { appInfo } from './platform/host';

const program = new Command();
program
  .name('orkestral')
  .description('Orkestral CLI (headless)')
  .version(appInfo.version());

// Default: sobe os serviços headless e mantém vivo (UX real vem nas specs 2/3).
program.action(() => {
  bootstrapServices({ headless: true });
  console.log('[orkestral] serviços headless no ar. Ctrl+C pra sair.');
  setInterval(() => {}, 1 << 30); // mantém o event loop vivo
});

program.parseAsync(process.argv).catch((err) => {
  console.error('[orkestral] erro:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Instalar commander**

Run: `npm install commander`
Expected: adicionado em dependencies.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:node`
Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/main/cli.ts package.json package-lock.json
git commit -m "feat(cli): entry cli.ts (commander) com boot headless stub"
```

## Task 7: Build do `cli.js` (electron-vite)

**Files:**
- Modify: `electron.vite.config.ts`

- [ ] **Step 1: Adicionar `cli` como entry do main**

No bloco `main` do `electron.vite.config.ts`, adicionar `build.rollupOptions.input`
com os dois entries:

```ts
    main: {
      plugins: [externalizeDepsPlugin()],
      define,
      build: {
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/main/index.ts'),
            cli: resolve(__dirname, 'src/main/cli.ts'),
          },
        },
      },
      resolve: {
        alias: {
          '@main': resolve('src/main'),
          '@shared': resolve('src/shared'),
        },
      },
    },
```

- [ ] **Step 2: Build do main e conferir o artefato**

Run: `npx electron-vite build`
Expected: gera `out/main/index.js` E `out/main/cli.js`.

Run: `ls out/main/cli.js`
Expected: arquivo existe.

- [ ] **Step 3: Commit**

```bash
git add electron.vite.config.ts
git commit -m "build(cli): empacotar src/main/cli.ts em out/main/cli.js"
```

## Task 8: Launcher `bin/orkestral` + scripts

**Files:**
- Create: `bin/orkestral`
- Modify: `package.json`

- [ ] **Step 1: Criar o shim**

```bash
#!/usr/bin/env node
// bin/orkestral — roda o cli.js sob o Electron como RUNTIME headless (sem abrir janela).
// NÃO usa ELECTRON_RUN_AS_NODE: sob RUN_AS_NODE o `import { BrowserWindow } from 'electron'`
// do bundle não tem export nomeado e quebra. Como runtime, a API existe e o ABI do
// better-sqlite3 casa. Em Linux headless, rode via `xvfb-run -a orkestral ...`.
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const electron = require('electron');
const cliEntry = join(__dirname, '..', 'out', 'main', 'cli.js');
const res = spawnSync(electron, [cliEntry, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(res.status ?? 0);
```

- [ ] **Step 2: Tornar executável + registrar bin/script**

Run: `chmod +x bin/orkestral`

No `package.json` adicionar:

```json
  "bin": { "orkestral": "bin/orkestral" },
```

e no bloco `scripts`:

```json
    "cli": "electron out/main/cli.js",
```

- [ ] **Step 3: Commit**

```bash
git add bin/orkestral package.json
git commit -m "feat(cli): launcher bin/orkestral (Electron runtime headless) + script cli"
```

## Task 9: Smoke headless + regressão final

- [ ] **Step 1: Build atualizado**

Run: `npx electron-vite build`
Expected: sucesso; `out/main/cli.js` presente.

- [ ] **Step 2: Rodar headless**

Run: `npm run cli`
Expected: imprime "[orkestral] serviços headless no ar." sem abrir janela; logs de
boot (recovery, canais) aparecem; sem crash de `getAllWindows`/`safeStorage`. Ctrl+C sai.

- [ ] **Step 3: Regressão desktop**

Run: `npm run dev`
Expected: app abre normal; canais reconectam; nenhum erro novo no console. Fechar.

- [ ] **Step 4: Gate completo**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: typecheck ok; lint sem erros novos; testes (incl. crypto-secret) passam.

- [ ] **Step 5: Commit (se algo ajustado no smoke)**

```bash
git add -A
git commit -m "chore(cli): smoke headless + ajustes da fundação"
```

---

## Self-review (cobertura da spec 1)

- Abstração de Electron (broadcast/secrets/appInfo) → Tasks 3-4. ✓
- Fallback de cripto (env/keyfile) → Tasks 1-2. ✓
- `bootstrapServices` + religar index → Task 5. ✓
- Entry `cli.ts` + build + launcher → Tasks 6-8. ✓
- Validação headless + regressão desktop → Task 9. ✓
- Ponto aberto declarado: imports reais de recovery/símbolos no `bootstrap.ts`
  (Task 5 Step 1) são copiados 1:1 do topo atual do `index.ts` — o engenheiro
  confirma os caminhos ao mover.
