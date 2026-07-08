import { appInfo, broadcast as hostBroadcast } from '../platform/host';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { computeContainerStats, ioTotals, ioRates, type RawDockerStats } from './docker-stats';
import { demuxDockerStream } from './docker-log-demux';

/**
 * Controlador de containers (Fase 1). dockerode fala com o socket/named pipe do
 * engine local (Docker/OrbStack/Colima). Streaming (logs/stats/exec) vai pro
 * renderer por `webContents.send` (broadcast), mesmo padrão do terminal-service.
 */

/** Runtimes Docker conhecidos no host. Cada um é uma ENGINE separada, com seu
 *  próprio socket e seus próprios containers — Docker Desktop e OrbStack NÃO se
 *  enxergam. O usuário escolhe qual conectar (default = o que estiver no
 *  /var/run/docker.sock). A escolha é persistida em userData. */
export interface DockerEngine {
  id: string;
  label: string;
  socketPath: string;
  available: boolean;
  active: boolean;
}

function candidateEngines(): Array<{ id: string; label: string; socketPath: string }> {
  const home = homedir();
  return [
    { id: 'default', label: 'Padrão', socketPath: '/var/run/docker.sock' },
    {
      id: 'docker-desktop',
      label: 'Docker Desktop',
      socketPath: join(home, '.docker', 'run', 'docker.sock'),
    },
    {
      id: 'orbstack',
      label: 'OrbStack',
      socketPath: join(home, '.orbstack', 'run', 'docker.sock'),
    },
    { id: 'colima', label: 'Colima', socketPath: join(home, '.colima', 'default', 'docker.sock') },
  ];
}

/** Socket escolhido pelo usuário (persistido). undefined = ainda não carregado. */
let activeSocketPath: string | null | undefined;
function enginePrefFile(): string {
  // appInfo.path: userData do Electron no app; fallback ~/.orkestral em Node puro.
  return join(appInfo.path('userData'), 'docker-engine.json');
}
function getActiveSocket(): string | null {
  if (activeSocketPath === undefined) {
    try {
      const parsed = JSON.parse(readFileSync(enginePrefFile(), 'utf8')) as { socketPath?: string };
      activeSocketPath =
        typeof parsed.socketPath === 'string' && parsed.socketPath ? parsed.socketPath : null;
    } catch {
      activeSocketPath = null;
    }
  }
  return activeSocketPath;
}

/** Valor sentinela = "Todas as engines" (modo merge). */
const ALL_ENGINES = 'all';

/** Resolve o endpoint do engine. Prioridade: escolha do usuário > DOCKER_HOST > SO.
 *  No modo 'Todas' o client() único cai pro default (usado só como fallback). */
function makeDocker(): Docker {
  const selected = getActiveSocket();
  if (selected && selected !== ALL_ENGINES) return new Docker({ socketPath: selected });
  if (process.env.DOCKER_HOST) return new Docker(); // dockerode lê DOCKER_HOST
  if (process.platform === 'win32') {
    return new Docker({ socketPath: '\\\\.\\pipe\\docker_engine' });
  }
  return new Docker({ socketPath: '/var/run/docker.sock' });
}

/** O socket que o client() está efetivamente usando agora (pra marcar o ativo). */
function effectiveSocketPath(): string {
  const selected = getActiveSocket();
  if (selected) return selected;
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  if (process.platform === 'win32') return '\\\\.\\pipe\\docker_engine';
  return '/var/run/docker.sock';
}

let docker: Docker | null = null;
function client(): Docker {
  if (!docker) docker = makeDocker();
  return docker;
}

/** Ping com timeout curto pra não travar caso um socket exista mas não responda. */
async function pingSocket(socketPath: string): Promise<boolean> {
  try {
    await Promise.race([
      new Docker({ socketPath }).ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Lista os engines Docker disponíveis no host (Docker Desktop, OrbStack, …),
 *  marcando qual está ativo. O 'default' é sempre testado (pode ser symlink). */
export async function listEngines(): Promise<{ engines: DockerEngine[] }> {
  const active = effectiveSocketPath();
  const engines: DockerEngine[] = [];
  for (const candidate of candidateEngines()) {
    if (!existsSync(candidate.socketPath) && candidate.id !== 'default') continue;
    const available = await pingSocket(candidate.socketPath);
    if (!available && candidate.id !== 'default') continue;
    engines.push({ ...candidate, available, active: candidate.socketPath === active });
  }
  // "Todas" no topo quando há 2+ engines disponíveis — junta tudo numa visão só.
  if (engines.filter((e) => e.available).length > 1) {
    engines.unshift({
      id: 'all',
      label: 'Todas',
      socketPath: ALL_ENGINES,
      available: true,
      active: active === ALL_ENGINES,
    });
  }
  return { engines };
}

/** Troca a engine ativa: persiste, derruba streams da engine antiga e força
 *  reconexão no próximo client(). O renderer re-busca via containers-changed. */
export async function setEngine(socketPath: string): Promise<{ ok: true }> {
  activeSocketPath = socketPath || null;
  try {
    writeFileSync(enginePrefFile(), JSON.stringify({ socketPath: activeSocketPath }), 'utf8');
  } catch {
    /* persistência best-effort — não falha a troca se não der pra gravar */
  }
  killAllDockerStreams();
  docker = null;
  broadcast('docker:containers-changed', null);
  return { ok: true };
}

// ---- Modo "Todas" (merge multi-engine) -------------------------------------
// Quando a engine ativa é 'all', as listas (containers/imagens/volumes/redes/
// stats) são unidas de TODAS as engines disponíveis, e as ações por-container/
// imagem são roteadas pro socket de origem (mapas abaixo, com scan de fallback).

function isAllMode(): boolean {
  return getActiveSocket() === ALL_ENGINES;
}

/** Sockets das engines que respondem agora (pro modo 'Todas'). */
async function availableSockets(): Promise<Array<{ socketPath: string; label: string }>> {
  const out: Array<{ socketPath: string; label: string }> = [];
  for (const candidate of candidateEngines()) {
    if (!existsSync(candidate.socketPath) && candidate.id !== 'default') continue;
    if (await pingSocket(candidate.socketPath)) {
      out.push({ socketPath: candidate.socketPath, label: candidate.label });
    }
  }
  return out;
}

/** Roda `fn` em cada engine (modo 'Todas') ou só no client atual (engine única),
 *  devolvendo cada resultado com o rótulo/socket da engine de origem. Uma engine
 *  que falha não derruba as outras. */
async function forEachEngine<T>(
  fn: (docker: Docker) => Promise<T>,
): Promise<Array<{ label: string; socketPath: string; result: Awaited<T> }>> {
  if (!isAllMode()) {
    return [{ label: '', socketPath: effectiveSocketPath(), result: await fn(client()) }];
  }
  const sockets = await availableSockets();
  const settled = await Promise.all(
    sockets.map(async (s) => {
      try {
        const result = await fn(new Docker({ socketPath: s.socketPath }));
        return { label: s.label, socketPath: s.socketPath, result };
      } catch {
        return null;
      }
    }),
  );
  return settled.filter(
    (r): r is { label: string; socketPath: string; result: Awaited<T> } => r !== null,
  );
}

// Mapas id → socket pra rotear ops no modo 'Todas' (preenchidos ao listar).
const containerEngine = new Map<string, string>();
const imageEngine = new Map<string, string>();

/** Client da engine que tem este container (modo 'Todas'); senão o client único. */
async function clientForContainer(id: string): Promise<Docker> {
  if (!isAllMode()) return client();
  let socketPath = containerEngine.get(id);
  if (!socketPath) {
    for (const s of await availableSockets()) {
      try {
        const list = await new Docker({ socketPath: s.socketPath }).listContainers({ all: true });
        if (list.some((c) => c.Id === id || c.Id.startsWith(id))) {
          socketPath = s.socketPath;
          break;
        }
      } catch {
        /* ignora engine que falhou no scan */
      }
    }
  }
  return socketPath ? new Docker({ socketPath }) : client();
}

/** Client da engine que tem esta imagem (modo 'Todas'); senão o client único. */
async function clientForImage(id: string): Promise<Docker> {
  if (!isAllMode()) return client();
  const socketPath = imageEngine.get(id);
  return socketPath ? new Docker({ socketPath }) : client();
}

type DockerEventChannel =
  | 'docker:logs-data'
  | 'docker:stats-data'
  | 'docker:exec-data'
  | 'docker:exec-exit'
  | 'docker:containers-changed';

function broadcast(channel: DockerEventChannel, payload: unknown): void {
  hostBroadcast(channel, payload);
}

type Destroyable = { destroy?: () => void };
const logStreams = new Map<string, NodeJS.ReadableStream>();
const statStreams = new Map<string, NodeJS.ReadableStream>();
const execStreams = new Map<string, NodeJS.ReadWriteStream>();

export async function ping(): Promise<{
  status: 'connected' | 'no-engine' | 'error';
  message?: string;
}> {
  try {
    if (isAllMode()) {
      const sockets = await availableSockets();
      return sockets.length > 0 ? { status: 'connected' } : { status: 'no-engine' };
    }
    await client().ping();
    return { status: 'connected' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ENOENT / ECONNREFUSED = sem engine; resto = erro real.
    if (/ENOENT|ECONNREFUSED|connect/i.test(msg)) return { status: 'no-engine', message: msg };
    return { status: 'error', message: msg };
  }
}

export async function listContainers(): Promise<{
  containers: Array<{
    id: string;
    name: string;
    image: string;
    state: string;
    status: string;
    labels: Record<string, string>;
    engine?: string;
  }>;
}> {
  const groups = await forEachEngine((d) => d.listContainers({ all: true }));
  containerEngine.clear();
  const containers = groups.flatMap((g) =>
    g.result.map((c) => {
      containerEngine.set(c.Id, g.socketPath);
      return {
        id: c.Id,
        name: (c.Names?.[0] ?? c.Id).replace(/^\//, ''),
        image: c.Image,
        state: c.State,
        status: c.Status,
        labels: c.Labels ?? {},
        engine: g.label || undefined,
      };
    }),
  );
  return { containers };
}

export async function listImages(): Promise<{
  images: Array<{ id: string; tags: string[]; sizeMb: number; created: number; engine?: string }>;
}> {
  const groups = await forEachEngine((d) => d.listImages());
  imageEngine.clear();
  const images = groups.flatMap((g) =>
    g.result.map((i) => {
      imageEngine.set(i.Id, g.socketPath);
      return {
        id: i.Id,
        tags: (i.RepoTags ?? []).filter((t) => t && t !== '<none>:<none>'),
        sizeMb: (i.Size ?? 0) / (1024 * 1024),
        created: i.Created ?? 0,
        engine: g.label || undefined,
      };
    }),
  );
  return { images };
}

export async function imageInspect(id: string): Promise<{ json: string }> {
  const data = await (await clientForImage(id)).getImage(id).inspect();
  return { json: JSON.stringify(data, null, 2) };
}

export async function listVolumes(): Promise<{
  volumes: Array<{
    name: string;
    driver: string;
    sizeBytes: number;
    created: string;
    mountpoint: string;
    labels: Record<string, string>;
    engine?: string;
  }>;
}> {
  const groups = await forEachEngine(async (c) => {
    const res = await c.listVolumes();
    const vols = res?.Volumes ?? [];
    // Tamanhos vêm do `docker system df` (listVolumes não traz). Pode falhar — best-effort.
    const sizeByName = new Map<string, number>();
    try {
      const df = (await c.df()) as {
        Volumes?: Array<{ Name: string; UsageData?: { Size?: number } }>;
      };
      for (const v of df?.Volumes ?? []) sizeByName.set(v.Name, v.UsageData?.Size ?? -1);
    } catch {
      // df indisponível em alguns engines — segue sem tamanho
    }
    return vols.map((v) => ({
      name: v.Name,
      driver: v.Driver,
      sizeBytes: sizeByName.get(v.Name) ?? -1,
      created: (v as { CreatedAt?: string }).CreatedAt ?? '',
      mountpoint: v.Mountpoint ?? '',
      labels: v.Labels ?? {},
    }));
  });
  const volumes = groups.flatMap((g) =>
    g.result.map((v) => ({ ...v, engine: g.label || undefined })),
  );
  return { volumes };
}

export async function listNetworks(): Promise<{
  networks: Array<{
    id: string;
    name: string;
    driver: string;
    scope: string;
    subnet: string;
    gateway: string;
    created: string;
    labels: Record<string, string>;
    engine?: string;
  }>;
}> {
  const groups = await forEachEngine((d) => d.listNetworks());
  const networks = groups.flatMap((g) =>
    g.result.map((n) => {
      const cfg = n.IPAM?.Config?.[0] ?? {};
      return {
        id: (n.Id ?? '').slice(0, 12),
        name: n.Name ?? '',
        driver: n.Driver ?? '',
        scope: n.Scope ?? '',
        subnet: cfg.Subnet ?? '',
        gateway: cfg.Gateway ?? '',
        created: (n as { Created?: string }).Created ?? '',
        labels: n.Labels ?? {},
        engine: g.label || undefined,
      };
    }),
  );
  return { networks };
}

// Cache de I/O por container entre polls do Activity Monitor → taxa rede/disco.
const statsAllIo = new Map<string, { netBytes: number; diskBytes: number; ts: number }>();

/** Snapshot de stats de TODOS os containers rodando — pro Activity Monitor. Inclui
 *  projeto/serviço/imagem (pra agrupar + ícone real) e taxa de rede/disco (diff
 *  entre polls via `statsAllIo`). */
export async function statsAll(): Promise<{
  stats: Array<{
    id: string;
    name: string;
    project: string | null;
    image: string;
    cpuPercent: number;
    memUsedMb: number;
    netKbps: number;
    diskMbps: number;
    engine?: string;
  }>;
}> {
  const engineList = isAllMode()
    ? await availableSockets()
    : [{ socketPath: effectiveSocketPath(), label: '' }];
  const alive = new Set<string>();
  // 1) Containers rodando de cada engine (carregando o client de origem junto).
  const entries = (
    await Promise.all(
      engineList.map(async (e) => {
        const d = isAllMode() ? new Docker({ socketPath: e.socketPath }) : client();
        try {
          const list = await d.listContainers(); // só rodando (all:false)
          return list.map((ct) => ({ d, label: e.label, socketPath: e.socketPath, ct }));
        } catch {
          return [];
        }
      }),
    )
  ).flat();
  // 2) Stats de cada container, sempre na engine certa.
  const stats = await Promise.all(
    entries.map(async ({ d, label, socketPath, ct }) => {
      alive.add(ct.Id);
      containerEngine.set(ct.Id, socketPath);
      const labels = ct.Labels ?? {};
      const project = labels['com.docker.compose.project'] ?? null;
      const name =
        labels['com.docker.compose.service'] ?? (ct.Names?.[0] ?? ct.Id).replace(/^\//, '');
      const base = { id: ct.Id, name, project, image: ct.Image, engine: label || undefined };
      try {
        const raw = (await d
          .getContainer(ct.Id)
          .stats({ stream: false })) as unknown as RawDockerStats;
        const s = computeContainerStats(raw);
        const cur = ioTotals(raw);
        const rates = ioRates(cur, statsAllIo.get(ct.Id));
        statsAllIo.set(ct.Id, cur);
        return {
          ...base,
          cpuPercent: s.cpuPercent,
          memUsedMb: s.memUsedMb,
          netKbps: rates.netKbps,
          diskMbps: rates.diskMbps,
        };
      } catch {
        return { ...base, cpuPercent: 0, memUsedMb: 0, netKbps: 0, diskMbps: 0 };
      }
    }),
  );
  // Limpa cache de containers que sumiram.
  for (const k of [...statsAllIo.keys()]) if (!alive.has(k)) statsAllIo.delete(k);
  return { stats };
}

export async function containerAction(
  id: string,
  action: 'start' | 'stop' | 'restart' | 'remove',
): Promise<{ ok: true }> {
  const c = (await clientForContainer(id)).getContainer(id);
  if (action === 'start') await c.start();
  else if (action === 'stop') await c.stop();
  else if (action === 'restart') await c.restart();
  else if (action === 'remove') await c.remove({ force: true });
  broadcast('docker:containers-changed', { reason: action });
  return { ok: true };
}

export async function inspect(id: string): Promise<{ json: string }> {
  const data = await (await clientForContainer(id)).getContainer(id).inspect();
  return { json: JSON.stringify(data, null, 2) };
}

export interface ContainerFileEntry {
  name: string;
  isDir: boolean;
  size: number;
  /** "YYYY-MM-DD HH:MM" (do `--time-style=long-iso`). */
  modified: string;
  kind: 'Folder' | 'File' | 'Symlink';
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Roda um comando único no container e coleta toda a saída (Tty=raw, sem demux). */
async function runOneShot(id: string, cmd: string[]): Promise<string> {
  const exec = await (await clientForContainer(id)).getContainer(id).exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
  });
  const stream = (await exec.start({
    hijack: true,
    stdin: false,
  })) as unknown as NodeJS.ReadableStream;
  return await new Promise<string>((resolve) => {
    let buf = '';
    stream.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
    });
    stream.on('end', () => resolve(buf));
    stream.on('error', () => resolve(buf));
  });
}

function parseLs(out: string): ContainerFileEntry[] {
  const entries: ContainerFileEntry[] = [];
  for (const lineRaw of out.split('\n')) {
    const line = lineRaw.replace(/\r$/, '');
    if (!line || line.startsWith('total ')) continue;
    // perms links owner group size  YYYY-MM-DD HH:MM  name[ -> target]
    const m = line.match(
      /^([dlbcsp-])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.*)$/,
    );
    if (!m) continue;
    const type = m[1];
    const size = Number(m[2]) || 0;
    const modified = m[3];
    let name = m[4];
    if (type === 'l') {
      const arrow = name.indexOf(' -> ');
      if (arrow >= 0) name = name.slice(0, arrow);
    }
    const isDir = type === 'd' || name.endsWith('/');
    if (name.endsWith('/')) name = name.slice(0, -1);
    if (name === '.' || name === '..' || name === '') continue;
    const kind: ContainerFileEntry['kind'] =
      type === 'd' ? 'Folder' : type === 'l' ? 'Symlink' : 'File';
    entries.push({ name, isDir, size, modified, kind });
  }
  // Pastas primeiro, depois alfabético (estilo Finder/OrbStack).
  return entries.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );
}

export async function listFiles(
  id: string,
  path: string,
): Promise<{ path: string; entries: ContainerFileEntry[] }> {
  const safe = path && path.startsWith('/') ? path : '/';
  const out = await runOneShot(id, [
    '/bin/sh',
    '-c',
    `ls -lApL --time-style=long-iso ${shellQuote(safe)} 2>/dev/null`,
  ]);
  return { path: safe, entries: parseLs(out) };
}

export async function startLogs(id: string): Promise<{ ok: true }> {
  stopLogs(id);
  const c = (await clientForContainer(id)).getContainer(id);
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
  return { ok: true };
}

export function stopLogs(id: string): { ok: true } {
  const s = logStreams.get(id) as (NodeJS.ReadableStream & Destroyable) | undefined;
  s?.destroy?.();
  logStreams.delete(id);
  return { ok: true };
}

export async function startStats(id: string): Promise<{ ok: true }> {
  stopStats(id);
  const stream = (await (await clientForContainer(id))
    .getContainer(id)
    .stats({ stream: true })) as unknown as NodeJS.ReadableStream;
  let acc = '';
  let prevIo: { netBytes: number; diskBytes: number; ts: number } | undefined;
  stream.on('data', (chunk: Buffer) => {
    acc += chunk.toString('utf8');
    let nl: number;
    while ((nl = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, nl).trim();
      acc = acc.slice(nl + 1);
      if (!line) continue;
      try {
        const raw = JSON.parse(line) as RawDockerStats;
        const stats = computeContainerStats(raw);
        // Taxas de rede/disco = diff entre esta amostra e a anterior (stream ~1/s).
        const cur = ioTotals(raw);
        const rates = ioRates(cur, prevIo);
        prevIo = cur;
        broadcast('docker:stats-data', {
          id,
          ...stats,
          netKbps: rates.netKbps,
          diskMbps: rates.diskMbps,
        });
      } catch {
        // linha parcial/inválida — ignora
      }
    }
  });
  stream.on('error', () => stopStats(id));
  statStreams.set(id, stream);
  return { ok: true };
}

export function stopStats(id: string): { ok: true } {
  const s = statStreams.get(id) as (NodeJS.ReadableStream & Destroyable) | undefined;
  s?.destroy?.();
  statStreams.delete(id);
  return { ok: true };
}

export async function startExec(
  id: string,
  cols: number,
  rows: number,
): Promise<{ execId: string }> {
  const container = (await clientForContainer(id)).getContainer(id);

  // Working dir do container (Config.WorkingDir) → shell já abre na pasta certa
  // (ex: /var/www/html), igual OrbStack. Fallback '/' se não der pra inspecionar.
  let workingDir = '/';
  try {
    const info = await container.inspect();
    workingDir = info?.Config?.WorkingDir || '/';
  } catch {
    // sem inspect → usa raiz
  }

  // Prompt bonito (usuário verde, host vermelho, [cwd]) — bash quando existir, senão sh.
  // PS1 vai por env; \[ \] e \e funcionam no bash; no sh puro degrada pra texto simples.
  const PS1 = 'PS1=\\[\\e[32m\\]\\u\\[\\e[0m\\]@\\[\\e[31m\\]\\h\\[\\e[0m\\]:[\\w]: ';
  const exec = await container.exec({
    Cmd: ['/bin/sh', '-c', 'exec "$(command -v bash || command -v sh)" -i'],
    Env: [PS1, 'TERM=xterm-256color'],
    WorkingDir: workingDir,
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
  // Bash interativo liga "bracketed paste" (ESC[?2004h/l). Alguns terminais deixam
  // o último char vazar (o "h" solto antes do prompt). Não usamos paste bracketing,
  // então removo as sequências (sem regex de control-char p/ não brigar com o eslint).
  const ESC = String.fromCharCode(27);
  const stripBracketPaste = (s: string): string =>
    s.split(`${ESC}[?2004h`).join('').split(`${ESC}[?2004l`).join('');
  stream.on('data', (chunk: Buffer) =>
    broadcast('docker:exec-data', { execId, data: stripBracketPaste(chunk.toString('utf8')) }),
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

export function execInput(execId: string, data: string): { ok: true } {
  execStreams.get(execId)?.write(data);
  return { ok: true };
}

export async function execResize(
  _execId: string,
  _cols: number,
  _rows: number,
): Promise<{ ok: true }> {
  // resize do exec exige reter o objeto Exec; na F1 o xterm cliente lida com fit visual.
  // No-op seguro (mantém assinatura do contrato).
  return { ok: true };
}

export function execKill(execId: string): { ok: true } {
  const s = execStreams.get(execId) as (NodeJS.ReadWriteStream & Destroyable) | undefined;
  s?.destroy?.();
  execStreams.delete(execId);
  return { ok: true };
}

/** Cleanup global — chamado no before-quit do app. */
export function killAllDockerStreams(): void {
  for (const id of [...logStreams.keys()]) stopLogs(id);
  for (const id of [...statStreams.keys()]) stopStats(id);
  for (const id of [...execStreams.keys()]) execKill(id);
}
