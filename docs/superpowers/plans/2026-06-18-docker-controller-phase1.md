# Docker Controller — Fase 1 (Controlador) — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development ou superpowers:executing-plans pra rodar task-a-task. Steps usam checkbox (`- [ ]`).

**Goal:** Painel de containers dentro do Orkestral (mac/win/linux) que conecta em qualquer engine Docker existente: listar (agrupado por compose), start/stop/restart/remove, logs em tempo real, stats CPU/RAM e exec (shell) — reusando o padrão do terminal integrado.

**Architecture:** `dockerode` no processo main fala com o socket/named pipe do engine. Streaming (logs/stats) vai pro renderer por `webContents.send` (broadcast), igual ao terminal. Lógica pura (cálculo de stats, demux de log, agrupamento compose) isolada em módulos testáveis. UI nova em `components/docker`, navegação por react-router + sidebar.

**Tech Stack:** Electron, dockerode, TypeScript, React, zustand, @tanstack/react-query, lucide-react, vitest (só lógica pura).

---

## ⚠️ Regras deste repo (sobrepõem a skill)

- **NUNCA commitar.** Este plano NÃO tem `git commit`. Cada task fecha num **Checkpoint** (typecheck + verificação). O Luccas commita quando quiser.
- **TDD só em função pura.** vitest é node-only (`src/**/*.test.ts`, environment node). UI/IPC/React → gate = `npm run typecheck` + teste manual. NÃO criar teste de DOM/React.
- **Gate de tipos:** `npm run typecheck` (node + web) tem que passar em toda task que toca `.ts/.tsx`.
- **Lint** nos arquivos tocados; sem regressão. Ícones lucide-react, zero emoji. Reusar componentes do design system (`docs/DESIGN_SYSTEM.md`), nada de div+Tailwind cru.
- **Spec de referência:** `docs/superpowers/specs/2026-06-18-docker-controller-design.md`.

---

## File Structure

**Novos (main):**

- `src/main/services/docker-stats.ts` — puro: calcula CPU%/MB a partir do payload bruto. **testável**
- `src/main/services/docker-log-demux.ts` — puro: demux do stream multiplexado do Docker. **testável**
- `src/main/services/docker-service.ts` — dockerode: conexão, list/actions/inspect, streams logs/stats/exec, killAll.
- `src/main/ipc/handlers/docker.ts` — handlers tipados.

**Novos (renderer):**

- `src/renderer/src/lib/dockerGrouping.ts` — puro: agrupa containers por projeto compose. **testável**
- `src/renderer/src/stores/dockerStore.ts` — zustand (status, containers, logs/stats por id, seleção).
- `src/renderer/src/components/docker/DockerPanel.tsx` — página/painel raiz (lista + detalhe).
- `src/renderer/src/components/docker/ContainerList.tsx` — lista agrupada por compose.
- `src/renderer/src/components/docker/ContainerDetail.tsx` — abas Logs | Stats | Inspect | Exec.

**Modificados:**

- `src/shared/ipc-contract.ts` — canais `docker:*` (no `IpcContract` + no array `IPC_CHANNELS`).
- `src/preload/index.ts` — eventos `onDocker*` em `OrkestralEvents` + `buildEvents()`.
- `src/main/ipc/index.ts` — importar e chamar `registerDockerHandlers()`.
- `src/main/index.ts` — `killAllDockerStreams()` no `before-quit` (junto do `killAllTerminals()`).
- `src/renderer/src/components/layout/Sidebar.tsx` — novo `NavGroupDef` "docker".
- rota `/docker` no router do renderer (onde as outras rotas são declaradas).
- i18n: chave `layout.section.docker` em todos os `messages/*.json`.
- `package.json` — `dockerode` + `@types/dockerode`.

---

## Task 1: Adicionar dependência dockerode

**Files:** Modify `package.json`

- [ ] **Step 1: Instalar (sem rodar nada que escreva no projeto além do install)**

Run:

```bash
npm install dockerode && npm install -D @types/dockerode
```

Expected: `dockerode` em `dependencies`, `@types/dockerode` em `devDependencies`. dockerode é JS puro — **não** dispara rebuild nativo.

- [ ] **Step 2: Confirmar typecheck ainda passa**

Run: `npm run typecheck`
Expected: PASS (sem uso ainda, só a dep instalada).

- [ ] **Checkpoint:** dep instalada, typecheck verde. (Sem commit.)

---

## Task 2: Cálculo de stats (função pura, TDD)

**Files:**

- Create: `src/main/services/docker-stats.ts`
- Test: `src/main/services/docker-stats.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/main/services/docker-stats.test.ts
import { describe, it, expect } from 'vitest';
import { computeContainerStats } from './docker-stats';

describe('computeContainerStats', () => {
  it('calcula CPU% e memória a partir do payload bruto do Docker', () => {
    const raw = {
      cpu_stats: {
        cpu_usage: { total_usage: 2_000_000 },
        system_cpu_usage: 20_000_000,
        online_cpus: 2,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 1_000_000 },
        system_cpu_usage: 10_000_000,
      },
      memory_stats: { usage: 200 * 1024 * 1024, limit: 1024 * 1024 * 1024 },
    };
    const out = computeContainerStats(raw);
    // cpuDelta=1e6, sysDelta=1e7 → (0.1)*2*100 = 20
    expect(out.cpuPercent).toBeCloseTo(20, 5);
    expect(out.memUsedMb).toBeCloseTo(200, 1);
    expect(out.memLimitMb).toBeCloseTo(1024, 1);
  });

  it('retorna 0% de CPU quando systemDelta é 0 (primeira amostra)', () => {
    const raw = {
      cpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
      memory_stats: { usage: 0, limit: 0 },
    };
    const out = computeContainerStats(raw);
    expect(out.cpuPercent).toBe(0);
    expect(out.memLimitMb).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/services/docker-stats.test.ts`
Expected: FAIL ("computeContainerStats is not defined" / módulo não existe).

- [ ] **Step 3: Implementar o mínimo**

```ts
// src/main/services/docker-stats.ts

/** Payload bruto relevante de `container.stats()` do dockerode. */
export interface RawDockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number; limit?: number };
}

export interface ContainerStats {
  cpuPercent: number;
  memUsedMb: number;
  memLimitMb: number;
}

const MB = 1024 * 1024;

/** Calcula CPU% e memória (MB) a partir do payload bruto do Docker.
 *  Fórmula oficial do `docker stats`. Robusto a amostra inicial (systemDelta=0). */
export function computeContainerStats(raw: RawDockerStats): ContainerStats {
  const cpu = raw.cpu_stats;
  const pre = raw.precpu_stats;
  const cpuDelta = (cpu?.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (cpu?.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0);
  const numCpus = cpu?.online_cpus ?? cpu?.cpu_usage?.percpu_usage?.length ?? 1;
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;
  return {
    cpuPercent,
    memUsedMb: (raw.memory_stats?.usage ?? 0) / MB,
    memLimitMb: (raw.memory_stats?.limit ?? 0) / MB,
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/services/docker-stats.test.ts`
Expected: PASS (2 testes).

- [ ] **Checkpoint:** `npm run typecheck` verde. (Sem commit.)

---

## Task 3: Demux do stream de log (função pura, TDD)

O Docker, quando o container **não** tem TTY, multiplexa stdout/stderr em frames:
`[stream(1 byte)][0,0,0][size(4 bytes big-endian)][payload]`. Com TTY, é texto cru.

**Files:**

- Create: `src/main/services/docker-log-demux.ts`
- Test: `src/main/services/docker-log-demux.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/main/services/docker-log-demux.test.ts
import { describe, it, expect } from 'vitest';
import { demuxDockerStream } from './docker-log-demux';

function frame(stream: number, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream; // 1=stdout, 2=stderr
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('demuxDockerStream', () => {
  it('extrai texto de frames multiplexados', () => {
    const buf = Buffer.concat([frame(1, 'hello\n'), frame(2, 'oops\n')]);
    expect(demuxDockerStream(buf)).toBe('hello\noops\n');
  });

  it('trata stream com TTY (sem header) como texto cru', () => {
    const buf = Buffer.from('plain tty line\n', 'utf8');
    expect(demuxDockerStream(buf, { tty: true })).toBe('plain tty line\n');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/services/docker-log-demux.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar o mínimo**

```ts
// src/main/services/docker-log-demux.ts

/** Converte um buffer do stream de logs do Docker em texto.
 *  - tty=true: stream é texto cru.
 *  - tty=false (default): frames multiplexados [stream(1)][000][size(4 BE)][payload]. */
export function demuxDockerStream(buf: Buffer, opts: { tty?: boolean } = {}): string {
  if (opts.tty) return buf.toString('utf8');
  let out = '';
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buf.length) break; // frame incompleto — para (chunk parcial)
    out += buf.subarray(start, end).toString('utf8');
    offset = end;
  }
  return out;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/services/docker-log-demux.test.ts`
Expected: PASS (2 testes).

- [ ] **Checkpoint:** `npm run typecheck` verde.

> Nota de implementação: na Task 6 os logs serão pedidos com `follow:true`; chunks podem cortar frames no meio. O `break` em frame incompleto aceita perda de borda em chunk parcial — aceitável pra logs. Buffer de borda fica como melhoria futura (não bloqueia F1).

---

## Task 4: Agrupamento por Compose (função pura, TDD)

**Files:**

- Create: `src/renderer/src/lib/dockerGrouping.ts`
- Test: `src/renderer/src/lib/dockerGrouping.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/renderer/src/lib/dockerGrouping.test.ts
import { describe, it, expect } from 'vitest';
import { groupByCompose, type DockerContainer } from './dockerGrouping';

const c = (id: string, labels: Record<string, string>): DockerContainer => ({
  id,
  name: id,
  image: 'img',
  state: 'running',
  status: 'Up',
  labels,
});

describe('groupByCompose', () => {
  it('agrupa por projeto compose e ordena serviços', () => {
    const list = [
      c('a', { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'web' }),
      c('b', { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'db' }),
    ];
    const groups = groupByCompose(list);
    expect(groups).toHaveLength(1);
    expect(groups[0].project).toBe('app');
    expect(groups[0].containers.map((x) => x.id)).toEqual(['b', 'a']); // db antes de web
  });

  it('containers sem label vão pro grupo "Avulsos" por último', () => {
    const list = [
      c('solo', {}),
      c('a', { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'web' }),
    ];
    const groups = groupByCompose(list);
    expect(groups.map((g) => g.project)).toEqual(['app', null]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/renderer/src/lib/dockerGrouping.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar o mínimo**

```ts
// src/renderer/src/lib/dockerGrouping.ts

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string; // running | exited | paused | restarting | created
  status: string;
  labels: Record<string, string>;
}

export interface ComposeGroup {
  /** null = containers avulsos (sem compose). */
  project: string | null;
  containers: DockerContainer[];
}

const PROJECT = 'com.docker.compose.project';
const SERVICE = 'com.docker.compose.service';

/** Agrupa containers por projeto compose. Projetos em ordem alfabética,
 *  "Avulsos" (null) por último; dentro do grupo, ordena por nome do serviço. */
export function groupByCompose(containers: DockerContainer[]): ComposeGroup[] {
  const byProject = new Map<string | null, DockerContainer[]>();
  for (const ct of containers) {
    const key = ct.labels[PROJECT] ?? null;
    const arr = byProject.get(key) ?? [];
    arr.push(ct);
    byProject.set(key, arr);
  }
  const projects = [...byProject.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b);
  });
  return projects.map((project) => ({
    project,
    containers: (byProject.get(project) ?? []).sort((x, y) =>
      (x.labels[SERVICE] ?? x.name).localeCompare(y.labels[SERVICE] ?? y.name),
    ),
  }));
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/renderer/src/lib/dockerGrouping.test.ts`
Expected: PASS (2 testes).

- [ ] **Checkpoint:** `npm run typecheck` verde.

---

## Task 5: Contrato IPC (canais docker:\*)

**Files:** Modify `src/shared/ipc-contract.ts`

- [ ] **Step 1: Adicionar os canais no `IpcContract`**

Logo após o bloco `// ---- Terminal integrado ----` (perto da linha 1668), adicionar:

```ts
  // ---- Docker (controlador de containers, Fase 1) ----
  /** Status do engine: connected | no-engine | error. */
  'docker:ping': { request: void; response: { status: 'connected' | 'no-engine' | 'error'; message?: string } };
  'docker:list-containers': {
    request: void;
    response: {
      containers: Array<{
        id: string;
        name: string;
        image: string;
        state: string;
        status: string;
        labels: Record<string, string>;
      }>;
    };
  };
  'docker:list-images': {
    request: void;
    response: { images: Array<{ id: string; tags: string[]; sizeMb: number }> };
  };
  'docker:container-action': {
    request: { id: string; action: 'start' | 'stop' | 'restart' | 'remove' };
    response: { ok: true };
  };
  'docker:inspect': { request: { id: string }; response: { json: string } };
  'docker:logs-start': { request: { id: string }; response: { ok: true } };
  'docker:logs-stop': { request: { id: string }; response: { ok: true } };
  'docker:stats-start': { request: { id: string }; response: { ok: true } };
  'docker:stats-stop': { request: { id: string }; response: { ok: true } };
  /** Abre um exec (shell) no container. Retorna o id do "terminal" pra reuso do xterm. */
  'docker:exec-start': { request: { id: string; cols: number; rows: number }; response: { execId: string } };
  'docker:exec-input': { request: { execId: string; data: string }; response: { ok: true } };
  'docker:exec-resize': { request: { execId: string; cols: number; rows: number }; response: { ok: true } };
  'docker:exec-kill': { request: { execId: string }; response: { ok: true } };
```

- [ ] **Step 2: Adicionar os mesmos canais no array `IPC_CHANNELS`**

Logo após `'terminal:kill',` (perto da linha 2430):

```ts
  'docker:ping',
  'docker:list-containers',
  'docker:list-images',
  'docker:container-action',
  'docker:inspect',
  'docker:logs-start',
  'docker:logs-stop',
  'docker:stats-start',
  'docker:stats-stop',
  'docker:exec-start',
  'docker:exec-input',
  'docker:exec-resize',
  'docker:exec-kill',
```

- [ ] **Step 3: Verificar tipos**

Run: `npm run typecheck`
Expected: PASS. (O `OrkestralApi` deriva os métodos automaticamente; o preload monta via `IPC_CHANNELS`.)

- [ ] **Checkpoint:** contrato compila. (Sem commit.)

---

## Task 6: Serviço Docker no main

**Files:** Create `src/main/services/docker-service.ts`

Espelha `terminal-service.ts` (broadcast + Map de instâncias + killAll). Usa `docker-stats.ts` e `docker-log-demux.ts`.

- [ ] **Step 1: Implementar o serviço**

```ts
// src/main/services/docker-service.ts
import { BrowserWindow } from 'electron';
import Docker from 'dockerode';
import { computeContainerStats, type RawDockerStats } from './docker-stats';
import { demuxDockerStream } from './docker-log-demux';

/** Resolve o endpoint do engine por SO (mac/linux=unix socket, win=named pipe).
 *  Respeita DOCKER_HOST quando setado (Colima/Podman em caminho alternativo). */
function makeDocker(): Docker {
  if (process.env.DOCKER_HOST) return new Docker(); // dockerode lê DOCKER_HOST
  if (process.platform === 'win32') return new Docker({ socketPath: '\\\\.\\pipe\\docker_engine' });
  return new Docker({ socketPath: '/var/run/docker.sock' });
}

let docker: Docker | null = null;
function client(): Docker {
  if (!docker) docker = makeDocker();
  return docker;
}

type DockerEventChannel =
  | 'docker:logs-data'
  | 'docker:stats-data'
  | 'docker:exec-data'
  | 'docker:exec-exit'
  | 'docker:containers-changed';

function broadcast(channel: DockerEventChannel, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

const logStreams = new Map<string, NodeJS.ReadableStream>();
const statStreams = new Map<string, NodeJS.ReadableStream>();
const execStreams = new Map<string, NodeJS.ReadWriteStream>();

export async function ping(): Promise<{
  status: 'connected' | 'no-engine' | 'error';
  message?: string;
}> {
  try {
    await client().ping();
    return { status: 'connected' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ENOENT / ECONNREFUSED = sem engine; resto = erro real.
    if (/ENOENT|ECONNREFUSED|connect/i.test(msg)) return { status: 'no-engine', message: msg };
    return { status: 'error', message: msg };
  }
}

export async function listContainers() {
  const list = await client().listContainers({ all: true });
  return {
    containers: list.map((c) => ({
      id: c.Id,
      name: (c.Names?.[0] ?? c.Id).replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status,
      labels: c.Labels ?? {},
    })),
  };
}

export async function listImages() {
  const list = await client().listImages();
  return {
    images: list.map((i) => ({
      id: i.Id,
      tags: i.RepoTags?.filter((t) => t && t !== '<none>:<none>') ?? [],
      sizeMb: (i.Size ?? 0) / (1024 * 1024),
    })),
  };
}

export async function containerAction(id: string, action: 'start' | 'stop' | 'restart' | 'remove') {
  const c = client().getContainer(id);
  if (action === 'start') await c.start();
  else if (action === 'stop') await c.stop();
  else if (action === 'restart') await c.restart();
  else if (action === 'remove') await c.remove({ force: true });
  broadcast('docker:containers-changed', { reason: action });
  return { ok: true as const };
}

export async function inspect(id: string) {
  const data = await client().getContainer(id).inspect();
  return { json: JSON.stringify(data, null, 2) };
}

export async function startLogs(id: string) {
  stopLogs(id);
  const c = client().getContainer(id);
  const info = await c.inspect();
  const tty = Boolean(info.Config?.Tty);
  const stream = (await c.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: 500,
  })) as unknown as NodeJS.ReadableStream;
  stream.on('data', (chunk: Buffer) =>
    broadcast('docker:logs-data', { id, chunk: demuxDockerStream(chunk, { tty }) }),
  );
  stream.on('error', () => stopLogs(id));
  logStreams.set(id, stream);
  return { ok: true as const };
}

export function stopLogs(id: string) {
  const s = logStreams.get(id) as (NodeJS.ReadableStream & { destroy?: () => void }) | undefined;
  s?.destroy?.();
  logStreams.delete(id);
  return { ok: true as const };
}

export async function startStats(id: string) {
  stopStats(id);
  const stream = (await client()
    .getContainer(id)
    .stats({ stream: true })) as unknown as NodeJS.ReadableStream;
  let acc = '';
  stream.on('data', (chunk: Buffer) => {
    acc += chunk.toString('utf8');
    let nl: number;
    while ((nl = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, nl).trim();
      acc = acc.slice(nl + 1);
      if (!line) continue;
      try {
        const stats = computeContainerStats(JSON.parse(line) as RawDockerStats);
        broadcast('docker:stats-data', { id, ...stats });
      } catch {
        // linha parcial/inválida — ignora
      }
    }
  });
  stream.on('error', () => stopStats(id));
  statStreams.set(id, stream);
  return { ok: true as const };
}

export function stopStats(id: string) {
  const s = statStreams.get(id) as (NodeJS.ReadableStream & { destroy?: () => void }) | undefined;
  s?.destroy?.();
  statStreams.delete(id);
  return { ok: true as const };
}

export async function startExec(id: string, cols: number, rows: number) {
  const exec = await client()
    .getContainer(id)
    .exec({
      Cmd: ['/bin/sh'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
  const stream = (await exec.start({
    hijack: true,
    stdin: true,
  })) as unknown as NodeJS.ReadWriteStream;
  const execId = `exec_${id.slice(0, 12)}_${Date.now().toString(36)}`;
  stream.on('data', (chunk: Buffer) =>
    broadcast('docker:exec-data', { execId, data: chunk.toString('utf8') }),
  );
  stream.on('end', () => {
    execStreams.delete(execId);
    broadcast('docker:exec-exit', { execId });
  });
  try {
    await exec.resize({ h: rows, w: cols });
  } catch {
    // resize pode falhar logo no start — ignora
  }
  execStreams.set(execId, stream);
  return { execId };
}

export function execInput(execId: string, data: string) {
  execStreams.get(execId)?.write(data);
  return { ok: true as const };
}

export async function execResize(execId: string, _cols: number, _rows: number) {
  // resize do exec exige guardar o handle do exec; na F1 o TTY se ajusta no cliente.
  // No-op seguro (mantém assinatura do contrato).
  return { ok: true as const };
}

export function execKill(execId: string) {
  const s = execStreams.get(execId) as
    | (NodeJS.ReadWriteStream & { destroy?: () => void })
    | undefined;
  s?.destroy?.();
  execStreams.delete(execId);
  return { ok: true as const };
}

/** Cleanup global — chamado no before-quit do app. */
export function killAllDockerStreams(): void {
  for (const id of [...logStreams.keys()]) stopLogs(id);
  for (const id of [...statStreams.keys()]) stopStats(id);
  for (const id of [...execStreams.keys()]) execKill(id);
}
```

- [ ] **Step 2: Verificar tipos**

Run: `npm run typecheck`
Expected: PASS. Se `@types/dockerode` reclamar de algum campo, ajustar com cast pontual (`as unknown as ...`) — sem `any` solto.

- [ ] **Checkpoint:** serviço compila. (Sem commit.)

> Nota: `execResize` é no-op consciente na F1 (dockerode exige reter o objeto `Exec` pra resize; o xterm cliente lida com fit visual). Resize real do PTY remoto = melhoria F1.5.

---

## Task 7: Handlers IPC

**Files:**

- Create: `src/main/ipc/handlers/docker.ts`
- Modify: `src/main/ipc/index.ts`

- [ ] **Step 1: Criar os handlers**

```ts
// src/main/ipc/handlers/docker.ts
import { registerHandler } from '../register';
import {
  ping,
  listContainers,
  listImages,
  containerAction,
  inspect,
  startLogs,
  stopLogs,
  startStats,
  stopStats,
  startExec,
  execInput,
  execResize,
  execKill,
} from '../../services/docker-service';

export function registerDockerHandlers(): void {
  registerHandler('docker:ping', () => ping());
  registerHandler('docker:list-containers', () => listContainers());
  registerHandler('docker:list-images', () => listImages());
  registerHandler('docker:container-action', ({ id, action }) => containerAction(id, action));
  registerHandler('docker:inspect', ({ id }) => inspect(id));
  registerHandler('docker:logs-start', ({ id }) => startLogs(id));
  registerHandler('docker:logs-stop', ({ id }) => stopLogs(id));
  registerHandler('docker:stats-start', ({ id }) => startStats(id));
  registerHandler('docker:stats-stop', ({ id }) => stopStats(id));
  registerHandler('docker:exec-start', ({ id, cols, rows }) => startExec(id, cols, rows));
  registerHandler('docker:exec-input', ({ execId, data }) => execInput(execId, data));
  registerHandler('docker:exec-resize', ({ execId, cols, rows }) => execResize(execId, cols, rows));
  registerHandler('docker:exec-kill', ({ execId }) => execKill(execId));
}
```

- [ ] **Step 2: Registrar no agregador**

Em `src/main/ipc/index.ts`: adicionar o import junto dos outros

```ts
import { registerDockerHandlers } from './handlers/docker';
```

e a chamada dentro de `registerAllIpcHandlers()` (depois de `registerTerminalHandlers();`):

```ts
registerDockerHandlers();
```

- [ ] **Step 3: Verificar tipos**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Checkpoint:** handlers registrados. (Sem commit.)

---

## Task 8: Eventos no preload + cleanup no quit

**Files:**

- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Declarar os eventos na interface `OrkestralEvents`**

Junto dos `onTerminal*` (perto do fim da interface):

```ts
  onDockerLogsData: (listener: (event: { id: string; chunk: string }) => void) => () => void;
  onDockerStatsData: (
    listener: (event: { id: string; cpuPercent: number; memUsedMb: number; memLimitMb: number }) => void,
  ) => () => void;
  onDockerExecData: (listener: (event: { execId: string; data: string }) => void) => () => void;
  onDockerExecExit: (listener: (event: { execId: string }) => void) => () => void;
  onDockerContainersChanged: (listener: (event: { reason: string }) => void) => () => void;
```

- [ ] **Step 2: Implementar em `buildEvents()`**

Seguindo o padrão `onTerminalData`:

```ts
    onDockerLogsData(listener) {
      const wrapped = (_e: IpcRendererEvent, p: { id: string; chunk: string }) => listener(p);
      ipcRenderer.on('docker:logs-data', wrapped);
      return () => ipcRenderer.removeListener('docker:logs-data', wrapped);
    },
    onDockerStatsData(listener) {
      const wrapped = (
        _e: IpcRendererEvent,
        p: { id: string; cpuPercent: number; memUsedMb: number; memLimitMb: number },
      ) => listener(p);
      ipcRenderer.on('docker:stats-data', wrapped);
      return () => ipcRenderer.removeListener('docker:stats-data', wrapped);
    },
    onDockerExecData(listener) {
      const wrapped = (_e: IpcRendererEvent, p: { execId: string; data: string }) => listener(p);
      ipcRenderer.on('docker:exec-data', wrapped);
      return () => ipcRenderer.removeListener('docker:exec-data', wrapped);
    },
    onDockerExecExit(listener) {
      const wrapped = (_e: IpcRendererEvent, p: { execId: string }) => listener(p);
      ipcRenderer.on('docker:exec-exit', wrapped);
      return () => ipcRenderer.removeListener('docker:exec-exit', wrapped);
    },
    onDockerContainersChanged(listener) {
      const wrapped = (_e: IpcRendererEvent, p: { reason: string }) => listener(p);
      ipcRenderer.on('docker:containers-changed', wrapped);
      return () => ipcRenderer.removeListener('docker:containers-changed', wrapped);
    },
```

- [ ] **Step 3: Cleanup no quit**

Em `src/main/index.ts`: adicionar o import junto do `killAllTerminals`

```ts
import { killAllDockerStreams } from './services/docker-service';
```

e dentro do handler `app.on('before-quit', ...)` (perto da linha 373, junto do `killAllTerminals()`):

```ts
killAllDockerStreams();
```

- [ ] **Step 4: Verificar tipos**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Checkpoint:** eventos expostos + cleanup ligado. (Sem commit.)

---

## Task 9: Store do renderer (zustand)

**Files:** Create `src/renderer/src/stores/dockerStore.ts`

- [ ] **Step 1: Implementar**

```ts
// src/renderer/src/stores/dockerStore.ts
import { create } from 'zustand';
import type { DockerContainer } from '@renderer/lib/dockerGrouping';

export type EngineStatus = 'unknown' | 'connected' | 'no-engine' | 'error';

export interface ContainerStatsView {
  cpuPercent: number;
  memUsedMb: number;
  memLimitMb: number;
}

interface DockerState {
  engine: EngineStatus;
  engineMessage?: string;
  containers: DockerContainer[];
  selectedId: string | null;
  /** Logs acumulados por container id. */
  logsById: Record<string, string>;
  /** Última stat por container id. */
  statsById: Record<string, ContainerStatsView>;
  setEngine: (status: EngineStatus, message?: string) => void;
  setContainers: (containers: DockerContainer[]) => void;
  select: (id: string | null) => void;
  appendLog: (id: string, chunk: string) => void;
  clearLog: (id: string) => void;
  setStats: (id: string, stats: ContainerStatsView) => void;
}

const MAX_LOG_CHARS = 200_000; // cap por container pra não crescer sem limite

export const useDockerStore = create<DockerState>((set) => ({
  engine: 'unknown',
  containers: [],
  selectedId: null,
  logsById: {},
  statsById: {},
  setEngine: (status, message) => set({ engine: status, engineMessage: message }),
  setContainers: (containers) => set({ containers }),
  select: (id) => set({ selectedId: id }),
  appendLog: (id, chunk) =>
    set((s) => {
      const next = (s.logsById[id] ?? '') + chunk;
      const capped = next.length > MAX_LOG_CHARS ? next.slice(next.length - MAX_LOG_CHARS) : next;
      return { logsById: { ...s.logsById, [id]: capped } };
    }),
  clearLog: (id) => set((s) => ({ logsById: { ...s.logsById, [id]: '' } })),
  setStats: (id, stats) => set((s) => ({ statsById: { ...s.statsById, [id]: stats } })),
}));
```

- [ ] **Step 2: Verificar tipos**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Checkpoint:** store compila. (Sem commit.)

---

## Task 10: UI — lista de containers (agrupada)

**Files:** Create `src/renderer/src/components/docker/ContainerList.tsx`

- [ ] **Step 1: Implementar a lista**

Usa `groupByCompose` (Task 4) e componentes do design system. Ícone de estado por `state`.

```tsx
// src/renderer/src/components/docker/ContainerList.tsx
import { groupByCompose, type DockerContainer } from '@renderer/lib/dockerGrouping';
import { cn } from '@renderer/lib/utils';
import { Circle, Square, Layers } from 'lucide-react';

function stateColor(state: string): string {
  if (state === 'running') return 'text-emerald-500';
  if (state === 'paused') return 'text-amber-500';
  return 'text-text-secondary';
}

export function ContainerList({
  containers,
  selectedId,
  onSelect,
}: {
  containers: DockerContainer[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const groups = groupByCompose(containers);
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-2">
      {groups.map((g) => (
        <div key={g.project ?? '__loose__'}>
          <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-text-secondary">
            <Layers className="h-3.5 w-3.5" />
            {g.project ?? 'Avulsos'}
          </div>
          {g.containers.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                { 'bg-surface-1 text-text-primary': selectedId === c.id },
                { 'text-text-secondary hover:bg-surface-1/60': selectedId !== c.id },
              )}
            >
              {c.state === 'running' ? (
                <Circle className={cn('h-2.5 w-2.5 fill-current', stateColor(c.state))} />
              ) : (
                <Square className={cn('h-2.5 w-2.5', stateColor(c.state))} />
              )}
              <span className="flex-1 truncate">
                {c.labels['com.docker.compose.service'] ?? c.name}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verificar tipos + lint**

Run: `npm run typecheck && npx eslint src/renderer/src/components/docker/ContainerList.tsx`
Expected: PASS / sem erro novo.

- [ ] **Checkpoint:** lista compila. (Sem commit.)

---

## Task 11: UI — detalhe (Logs | Stats | Inspect | Exec) + painel raiz

**Files:**

- Create: `src/renderer/src/components/docker/ContainerDetail.tsx`
- Create: `src/renderer/src/components/docker/DockerPanel.tsx`

- [ ] **Step 1: ContainerDetail (abas + ações + streams)**

```tsx
// src/renderer/src/components/docker/ContainerDetail.tsx
import { useEffect, useState } from 'react';
import { useDockerStore } from '@renderer/stores/dockerStore';
import { useToastStore } from '@renderer/stores/toastStore';
import { Play, Square, RotateCw, Trash2 } from 'lucide-react';

type Tab = 'logs' | 'stats' | 'inspect';

export function ContainerDetail({ id }: { id: string }) {
  const [tab, setTab] = useState<Tab>('logs');
  const [inspectJson, setInspectJson] = useState('');
  const logs = useDockerStore((s) => s.logsById[id] ?? '');
  const stats = useDockerStore((s) => s.statsById[id]);
  const appendLog = useDockerStore((s) => s.appendLog);
  const clearLog = useDockerStore((s) => s.clearLog);
  const setStats = useDockerStore((s) => s.setStats);
  const toast = useToastStore((s) => s.show);

  // Stream de logs + stats enquanto este container está selecionado.
  useEffect(() => {
    clearLog(id);
    const offLogs = window.orkestralEvents.onDockerLogsData((e) => {
      if (e.id === id) appendLog(id, e.chunk);
    });
    const offStats = window.orkestralEvents.onDockerStatsData((e) => {
      if (e.id === id) setStats(id, e);
    });
    window.orkestral['docker:logs-start']({ id }).catch(() => undefined);
    window.orkestral['docker:stats-start']({ id }).catch(() => undefined);
    return () => {
      offLogs();
      offStats();
      window.orkestral['docker:logs-stop']({ id }).catch(() => undefined);
      window.orkestral['docker:stats-stop']({ id }).catch(() => undefined);
    };
  }, [id, appendLog, clearLog, setStats]);

  useEffect(() => {
    if (tab === 'inspect') {
      window.orkestral['docker:inspect']({ id })
        .then((r) => setInspectJson(r.json))
        .catch(() => undefined);
    }
  }, [tab, id]);

  async function action(act: 'start' | 'stop' | 'restart' | 'remove') {
    if (act === 'remove' && !window.confirm('Remover este container? Ação irreversível.')) return;
    try {
      await window.orkestral['docker:container-action']({ id, action: act });
      toast({ kind: 'success', message: `Container: ${act} ok` });
    } catch (e) {
      toast({ kind: 'error', message: e instanceof Error ? e.message : 'Falha na ação' });
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={() => action('start')}
          title="Start"
          className="rounded p-1 hover:bg-surface-1"
        >
          <Play className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => action('stop')}
          title="Stop"
          className="rounded p-1 hover:bg-surface-1"
        >
          <Square className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => action('restart')}
          title="Restart"
          className="rounded p-1 hover:bg-surface-1"
        >
          <RotateCw className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => action('remove')}
          title="Remove"
          className="rounded p-1 text-red-500 hover:bg-surface-1"
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <div className="mx-2 h-4 w-px bg-border" />
        {(['logs', 'stats', 'inspect'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={t === tab ? 'text-text-primary' : 'text-text-secondary'}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs">
        {tab === 'logs' && <pre className="whitespace-pre-wrap">{logs}</pre>}
        {tab === 'stats' && (
          <div>
            CPU: {stats ? stats.cpuPercent.toFixed(1) : '—'}% · RAM:{' '}
            {stats ? `${stats.memUsedMb.toFixed(0)} / ${stats.memLimitMb.toFixed(0)} MB` : '—'}
          </div>
        )}
        {tab === 'inspect' && <pre className="whitespace-pre-wrap">{inspectJson}</pre>}
      </div>
    </div>
  );
}
```

> Exec (aba "Exec" reusando xterm do `TerminalPanel.tsx`) entra como **Task 11.5 / F1.5** — depende de extrair o componente xterm pra um wrapper reutilizável. A infra IPC (`docker:exec-*` + `onDockerExecData/Exit`) já está pronta nas Tasks 5–8. Documentar como pendência, não bloquear o resto da F1.

- [ ] **Step 2: DockerPanel (raiz: ping + lista + detalhe)**

```tsx
// src/renderer/src/components/docker/DockerPanel.tsx
import { useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDockerStore } from '@renderer/stores/dockerStore';
import { ContainerList } from './ContainerList';
import { ContainerDetail } from './ContainerDetail';

export function DockerPanel() {
  const engine = useDockerStore((s) => s.engine);
  const setEngine = useDockerStore((s) => s.setEngine);
  const setContainers = useDockerStore((s) => s.setContainers);
  const containers = useDockerStore((s) => s.containers);
  const selectedId = useDockerStore((s) => s.selectedId);
  const select = useDockerStore((s) => s.select);

  // Ping do engine ao montar.
  useEffect(() => {
    window.orkestral['docker:ping']()
      .then((r) => setEngine(r.status, r.message))
      .catch(() => setEngine('error'));
  }, [setEngine]);

  // Lista de containers (refetch periódico leve + on containers-changed).
  const refetch = useCallback(async () => {
    const r = await window.orkestral['docker:list-containers']();
    setContainers(r.containers);
  }, [setContainers]);

  useQuery({
    queryKey: ['docker-containers'],
    queryFn: async () => {
      await refetch();
      return true;
    },
    enabled: engine === 'connected',
    refetchInterval: 4000,
  });

  useEffect(() => {
    const off = window.orkestralEvents.onDockerContainersChanged(() => {
      void refetch();
    });
    return off;
  }, [refetch]);

  if (engine === 'no-engine' || engine === 'error') {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-text-secondary">
        <div>
          <p className="mb-2 font-medium text-text-primary">Nenhum engine Docker encontrado</p>
          <p>Instale/suba um engine (Docker, OrbStack ou Colima) e reabra este painel.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-[260px_1fr]">
      <div className="border-r border-border">
        <ContainerList containers={containers} selectedId={selectedId} onSelect={select} />
      </div>
      <div className="min-h-0">
        {selectedId ? (
          <ContainerDetail id={selectedId} />
        ) : (
          <div className="grid h-full place-items-center text-sm text-text-secondary">
            Selecione um container
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verificar tipos + lint**

Run: `npm run typecheck && npx eslint src/renderer/src/components/docker`
Expected: PASS / sem erro novo. (Confirmar nomes reais de `useToastStore.show` e tokens de cor do design system; ajustar se divergir.)

- [ ] **Checkpoint:** painel compila. (Sem commit.)

---

## Task 12: Navegação — rota + sidebar + i18n

**Files:**

- Modify: router do renderer (onde `/issues`, `/sources` etc. são declarados — `src/renderer/src/App.tsx` ou equivalente)
- Modify: `src/renderer/src/components/layout/Sidebar.tsx`
- Modify: `messages/*.json` (i18n)

- [ ] **Step 1: Registrar a rota**

Localizar o arquivo de rotas (grep):

```bash
grep -rn "path=\"/sources\"\|path: '/sources'\|createBrowserRouter\|<Routes>" src/renderer/src
```

Adicionar rota `/docker` apontando pra `DockerPanel`, no mesmo padrão das rotas existentes (lazy ou direta, conforme o arquivo).

- [ ] **Step 2: Adicionar o grupo na sidebar**

Em `src/renderer/src/components/layout/Sidebar.tsx`, no array `NAV_GROUPS`, adicionar (o ícone `Boxes` já está importado):

```ts
  { id: 'docker', icon: Boxes, labelKey: 'layout.section.docker', match: /^\/docker/, to: '/docker' },
```

e estender o tipo `NavGroupId`:

```ts
type NavGroupId = 'chat' | 'work' | 'sources' | 'knowledge' | 'agents' | 'resources' | 'docker';
```

- [ ] **Step 3: i18n**

Adicionar a chave `layout.section.docker` (valor "Docker") em **todos** os `messages/*.json` (ex.: `messages/pt-BR.json`, `messages/en.json`). Confirmar quais existem:

```bash
ls messages/ 2>/dev/null || grep -rln "layout.section.sources" src messages
```

- [ ] **Step 4: Verificar tipos + lint**

Run: `npm run typecheck && npx eslint src/renderer/src/components/layout/Sidebar.tsx`
Expected: PASS.

- [ ] **Checkpoint:** navegação ligada. (Sem commit.)

---

## Task 13: Verificação manual ponta a ponta

**Files:** nenhum (validação)

- [ ] **Step 1: Rodar o app**

Run: `npm run dev`

- [ ] **Step 2: Conferir (com um engine rodando, ex.: Docker/OrbStack/Colima):**
  - [ ] Ícone Docker aparece na sidebar; clicar abre `/docker`.
  - [ ] Sem engine: aparece o estado vazio "Nenhum engine Docker encontrado".
  - [ ] Com engine: containers listados, agrupados por projeto compose.
  - [ ] Selecionar container → logs fluindo na aba Logs.
  - [ ] Aba Stats mostra CPU% e RAM atualizando.
  - [ ] Aba Inspect mostra JSON.
  - [ ] start/stop/restart funcionam; remove pede confirmação; cada ação dá toast.
  - [ ] Trocar de container para os streams do anterior (sem vazar log no novo).
  - [ ] Fechar o app não deixa processo/stream pendurado.

- [ ] **Step 3: Gate final**

Run: `npm run typecheck && npx vitest run src/main/services/docker-stats.test.ts src/main/services/docker-log-demux.test.ts src/renderer/src/lib/dockerGrouping.test.ts`
Expected: typecheck PASS, 6 testes PASS.

- [ ] **Checkpoint final:** Fase 1 funcional. (Sem commit — Luccas decide quando commitar.)

---

## Pendências conscientes (F1.5 / depois)

- **Exec (shell no container)**: infra IPC pronta (Tasks 5–8); falta extrair o xterm do `TerminalPanel.tsx` pra wrapper reutilizável e plugar a aba "Exec".
- **Resize real do exec** (reter handle `Exec` no serviço).
- **Buffer de borda no demux de log** (frames cortados entre chunks).
- **Ações no nível do projeto compose** (start/stop de todos do projeto).
- **Volumes/networks/imagens com ações** (F1 só lista imagens).
- Tudo da **Fase 2** (gerência de engine / Colima no mac) = plano separado.

---

## Self-review (cobertura do spec)

- Detecção/estados engine → Task 6 (`ping`) + Task 11 (estado vazio). ✓
- Lista agrupada por compose → Tasks 4 + 10. ✓
- start/stop/restart/remove + confirmação + feedback → Task 11. ✓
- Logs streaming → Tasks 3, 6, 11. ✓
- Stats CPU/RAM → Tasks 2, 6, 11. ✓
- Exec → infra Tasks 5–8; UI = pendência F1.5 (declarada). ✓ (parcial, consciente)
- Cross-platform socket/pipe → Task 6 (`makeDocker`). ✓
- Segurança (canais tipados, whitelist de ação, confirmação destrutiva) → Tasks 5/7/11. ✓
- Gate typecheck + sem commit → todas as tasks. ✓
