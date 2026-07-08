import { dialog, BrowserWindow, shell } from '../../platform/electron';
import type { OpenDialogOptions } from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  cpSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { registerHandler } from '../register';
import { broadcast } from '../../platform/host';
import { atomicWriteFileSync } from '../../utils/atomic-write';
import { WorkspaceSourceRepository } from '../../db/repositories/workspace-source.repo';
import { resolveWorkspaceDir } from '../../db/connection';
import { listPullRequests, listPullRequestsPage, cloneRepo } from '../../services/github';
import { gitRemoteUrl } from '../../services/git-service';
import { getAzureDevopsAccessToken } from '../../services/azure-devops';
import { syncWorkspaceTeamForSources } from '../../services/source-team-sync';
import { scheduleSourceIngestion } from '../../services/source-ingestion-service';
import { KbPageRepository } from '../../db/repositories/kb-page.repo';
import { kbCodeChunkRepo } from '../../db/repositories/kb-code-chunk.repo';
import { kbAnalysisJobRepo } from '../../db/repositories/kb-analysis-job.repo';
import { kbEmbeddingJobRepo } from '../../db/repositories/kb-embedding-job.repo';
import { cancelAnalyze } from '../../services/kb-repo-analyzer';
import { cancelEmbeddingJob } from '../../services/kb-embedding-queue';

const sourceRepo = new WorkspaceSourceRepository();
const pageRepo = new KbPageRepository();

/** Emite evento de clonagem — janelas quando existem + pushBus (gateway/CLI). */
function emitCloneEvent(payload: {
  sourceId?: string;
  workspaceId: string;
  repoFullName: string;
  phase: 'start' | 'progress' | 'done' | 'failed';
  message: string;
}) {
  broadcast('source:clone-event', payload);
}

/**
 * Gera um path único pra clonar o source baseado em owner/repo.
 * Ex: ~/.orkestral/workspaces/<wsId>/sources/<owner>__<repo>
 */
function sourceClonePath(workspaceId: string, repoFullName: string): string {
  const wsDir = resolveWorkspaceDir(workspaceId);
  const safe = repoFullName.replace(/[^a-zA-Z0-9_-]/g, '__');
  return join(wsDir, 'sources', safe);
}

function sanitizeRemote(remote: string): string {
  return remote
    .replace(/(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, '$1$2:***@')
    .replace(/(https?:\/\/)([^@/\s]+)@/gi, '$1***@');
}

function cloneGitRemote(input: {
  remote: string;
  targetDir: string;
  depth?: number;
  authHeader?: string;
  onProgress?: (line: string) => void;
}): Promise<{ path: string }> {
  return new Promise((resolve, reject) => {
    const targetParent = dirname(input.targetDir);
    if (!existsSync(targetParent)) {
      mkdirSync(targetParent, { recursive: true });
    }
    const args: string[] = [];
    if (input.authHeader) {
      args.push('-c', `http.extraheader=${input.authHeader}`);
    }
    args.push('clone', '--progress');
    if (input.depth && input.depth > 0) args.push('--depth', String(input.depth));
    args.push(input.remote, input.targetDir);
    const child = spawn('git', args, {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) input.onProgress?.(sanitizeRemote(line.trim()));
      }
    });
    child.on('error', (err) => {
      reject(new Error(`git clone falhou: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ path: input.targetDir });
      } else {
        reject(new Error(`git clone falhou (exit ${code}): ${sanitizeRemote(stderr).slice(-500)}`));
      }
    });
  });
}

function scheduleTeamSourceSync(workspaceId: string, reason: string): void {
  setTimeout(() => {
    try {
      syncWorkspaceTeamForSources(workspaceId, reason);
    } catch (err) {
      console.warn('[source:create] sincronização do time falhou:', err);
    }
  }, 400);
}

async function cloneRemoteSource(input: {
  sourceId: string;
  workspaceId: string;
  kind: 'github_repo' | 'azure_repo';
  repoFullName: string;
  githubAccountLogin?: string | null;
}): Promise<string> {
  const targetDir = sourceClonePath(input.workspaceId, input.repoFullName);

  emitCloneEvent({
    sourceId: input.sourceId,
    workspaceId: input.workspaceId,
    repoFullName: input.repoFullName,
    phase: 'start',
    message: `Clonando ${input.repoFullName}…`,
  });

  try {
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    const onProgress = (line: string) => {
      emitCloneEvent({
        sourceId: input.sourceId,
        workspaceId: input.workspaceId,
        repoFullName: input.repoFullName,
        phase: 'progress',
        message: line,
      });
    };

    if (input.kind === 'github_repo') {
      await cloneRepo({
        ownerRepo: input.repoFullName,
        targetDir,
        depth: 1,
        accountLogin: input.githubAccountLogin,
        onProgress,
      });
    } else {
      const token = await getAzureDevopsAccessToken().catch(() => null);
      await cloneGitRemote({
        remote: input.repoFullName,
        targetDir,
        depth: 1,
        authHeader: token ? `AUTHORIZATION: bearer ${token}` : undefined,
        onProgress,
      });
    }

    sourceRepo.update(input.sourceId, { path: targetDir });
    emitCloneEvent({
      sourceId: input.sourceId,
      workspaceId: input.workspaceId,
      repoFullName: input.repoFullName,
      phase: 'done',
      message: `Clonado em ${targetDir}`,
    });
    return targetDir;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitCloneEvent({
      sourceId: input.sourceId,
      workspaceId: input.workspaceId,
      repoFullName: input.repoFullName,
      phase: 'failed',
      message: msg,
    });
    throw err;
  }
}

/** Dirs ignorados ao varrer subpastas pro @ mention (ruído/pesado). */
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'tmp']);
const MAX_DIRS = 500;
const MAX_DEPTH = 6;
// Cap de arquivos por source pro menu de `@` (o renderer filtra por query).
const MAX_FILES_MENTION = 4000;

/** Varre `root` procurando repos git (pasta com `.git`) até `maxDepth` níveis.
 *  Não desce em pasta que já é repo (submódulos/aninhados ficam de fora).
 *  Pula dot-dirs e IGNORE_DIRS. */
/** Provider + identificador a partir da URL de um remote git. GitHub vira
 *  `owner/repo`; Azure mantém a URL (é assim que o repoFullName azure é guardado);
 *  qualquer outro host fica como 'other'. */
export type ParsedGitRemote = {
  url: string;
  provider: 'github' | 'azure' | 'other';
  fullName: string;
};
function parseGitRemote(rawUrl: string): ParsedGitRemote {
  const url = rawUrl.trim();
  const noGit = url.replace(/\.git$/i, '');
  // github.com/owner/repo  |  git@github.com:owner/repo
  const gh = noGit.match(/github\.com[:/]([^/]+)\/(.+?)\/?$/i);
  if (gh) return { url, provider: 'github', fullName: `${gh[1]}/${gh[2]}` };
  if (/dev\.azure\.com|visualstudio\.com/i.test(noGit)) {
    return { url, provider: 'azure', fullName: url };
  }
  return { url, provider: 'other', fullName: noGit };
}

function findGitRepos(
  root: string,
  maxDepth: number,
): Array<{ path: string; name: string; relPath: string }> {
  const out: Array<{ path: string; name: string; relPath: string }> = [];
  const queue: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: root, rel: '', depth: 0 },
  ];
  // Cap no número de DIRETÓRIOS VISITADOS (não nos repos achados) — é o que de
  // fato limita a varredura, independente de maxDepth.
  let scanned = 0;
  while (queue.length > 0 && scanned < MAX_DIRS) {
    const { abs, rel, depth } = queue.shift()!;
    scanned++;
    if (depth >= maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const childAbs = join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (existsSync(join(childAbs, '.git'))) {
        out.push({ path: childAbs, name: e.name, relPath: childRel });
        continue; // repo encontrado: não desce mais nele
      }
      queue.push({ abs: childAbs, rel: childRel, depth: depth + 1 });
    }
  }
  return out;
}

/** BFS dos ARQUIVOS de `root`, relativo a ele (pro `@` mencionar arquivos, estilo
 *  opencode). Pula dot-dirs/IGNORE_DIRS; cap de total + profundidade. */
// Walker DEDICADO da busca (separado do de @-mention): vai bem mais fundo e INCLUI
// dotfiles (.coderabbit.yaml, .env, etc.) — só pula dirs de lixo/VCS. É o que faz a
// contagem bater com a do VS Code em vez de truncar cedo.
const SEARCH_IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'tmp',
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vercel',
]);
const SEARCH_MAX_DEPTH = 24;
const SEARCH_MAX_WALK_FILES = 60000;

function listSearchFiles(root: string, scope?: string): string[] {
  const s = (scope ?? '').replace(/^\/+|\/+$/g, '');
  const start = s ? join(root, s) : root;
  const result: string[] = [];
  const queue: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: start, rel: s, depth: 0 },
  ];
  while (queue.length > 0 && result.length < SEARCH_MAX_WALK_FILES) {
    const { abs, rel, depth } = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SEARCH_IGNORE_DIRS.has(e.name)) continue;
        if (depth >= SEARCH_MAX_DEPTH) continue;
        queue.push({ abs: join(abs, e.name), rel: childRel, depth: depth + 1 });
      } else if (e.isFile()) {
        result.push(childRel);
        if (result.length >= SEARCH_MAX_WALK_FILES) break;
      }
    }
  }
  return result;
}

// Glob simples (** = qualquer incl. '/', * = qualquer menos '/', ? = 1 char). Sem
// âncoras: casa como substring no relPath (igual "files to include/exclude" do VS Code).
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(re, 'i');
}

function parsePatterns(spec?: string): RegExp[] {
  if (!spec) return [];
  return spec
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map(globToRegExp);
}

/** BFS dos ARQUIVOS sob `root`, relativos a ele. Pula dot-dirs e IGNORE_DIRS;
 *  caps de profundidade (MAX_DEPTH) e total (MAX_FILES_MENTION) pra não travar
 *  em repo gigante. Exportado: a CLI usa o MESMO walker no autocomplete de
 *  `@arquivo` (paridade com o mention da GUI). */
export function listFilesUnder(root: string): string[] {
  const result: string[] = [];
  const queue: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: root, rel: '', depth: 0 },
  ];
  while (queue.length > 0 && result.length < MAX_FILES_MENTION) {
    const { abs, rel, depth } = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth >= MAX_DEPTH) continue;
        queue.push({ abs: join(abs, e.name), rel: childRel, depth: depth + 1 });
      } else if (e.isFile()) {
        result.push(childRel);
        if (result.length >= MAX_FILES_MENTION) break;
      }
    }
  }
  return result;
}

/** BFS dos subdiretórios de `root`, relativo a ele. Pula dot-dirs e IGNORE_DIRS;
 *  caps de profundidade e total pra não travar em repo gigante. */
function listSubdirs(root: string): string[] {
  const result: string[] = [];
  const queue: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: root, rel: '', depth: 0 },
  ];
  while (queue.length > 0 && result.length < MAX_DIRS) {
    const { abs, rel, depth } = queue.shift()!;
    if (depth >= MAX_DEPTH) continue;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      result.push(childRel);
      if (result.length >= MAX_DIRS) break;
      queue.push({ abs: join(abs, e.name), rel: childRel, depth: depth + 1 });
    }
  }
  return result;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB: acima disso não abre no editor

/** Resolve `relPath` contra a raiz da source e GARANTE que o resultado fica dentro
 *  dela (anti path-traversal). Lança se a source não existe, não tem path, ou o
 *  path escapa. Retorna o caminho absoluto validado + a raiz. */
function resolveInsideSource(sourceId: string, relPath: string): { abs: string; root: string } {
  const source = sourceRepo.get(sourceId);
  if (!source) throw new Error('source-not-found');
  if (!source.path || !existsSync(source.path)) throw new Error('source-path-missing');
  const root = resolve(source.path);
  const abs = resolve(root, relPath);
  // 1. Lexical guard: rejeita ../absoluto sem tocar o disco. Também cobre o caso
  //    de path inexistente (write-file rejeita criação depois).
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error('path-escapes-source');
  // 2. Symlink guard: se o alvo existe, resolve symlinks dos DOIS lados e revalida.
  //    path.resolve é lexical e não pega symlink que aponta pra fora da source.
  if (existsSync(abs)) {
    const realRoot = realpathSync(root);
    const realAbs = realpathSync(abs);
    if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) {
      throw new Error('path-escapes-source');
    }
  }
  return { abs, root };
}

/** Heurística de binário: byte nulo nos primeiros 8KB. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchMatcher(
  query: string,
  opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean },
): RegExp {
  let pat = opts.regex ? query : escapeRegex(query);
  if (opts.wholeWord) pat = `\\b(?:${pat})\\b`;
  return new RegExp(pat, 'g' + (opts.caseSensitive ? '' : 'i'));
}

const SEARCH_MATCH_CAP = 2000;
const SEARCH_PER_FILE_CAP = 20;
// Teto de tempo de parede (main thread) pra busca/replace: um regex do usuário com
// backtracking pesado OU uma varredura de ~60k arquivos sem match poderia travar a UI.
// Ao estourar, a busca para com truncated=true em vez de pendurar o app. (Mitigação
// proporcional — um regex catastrófico num ÚNICO arquivo grande ainda é atômico; o fix
// completo seria mover pra worker_threads/RE2, deferido por ser auto-infligido e P2.)
const SEARCH_TIME_BUDGET_MS = 5000;

export function registerSourcesHandlers(): void {
  registerHandler('source:list', ({ workspaceId }) => sourceRepo.listByWorkspace(workspaceId));

  registerHandler('source:read-dir', ({ sourceId, relPath }) => {
    const { abs } = resolveInsideSource(sourceId, relPath);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: Array<{ name: string; relPath: string; kind: 'dir' | 'file' }> = [];
    for (const e of entries) {
      // esconde dot-DIRS de ruído, mas mantém arquivos dot (ex: .env) visíveis
      if (e.isDirectory() && (e.name.startsWith('.') || IGNORE_DIRS.has(e.name))) continue;
      const childRel = relPath ? `${relPath}/${e.name}` : e.name;
      if (e.isDirectory()) out.push({ name: e.name, relPath: childRel, kind: 'dir' });
      else if (e.isFile()) out.push({ name: e.name, relPath: childRel, kind: 'file' });
    }
    out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return out;
  });

  registerHandler('source:read-file', ({ sourceId, relPath }) => {
    const { abs } = resolveInsideSource(sourceId, relPath);
    const stat = statSync(abs);
    if (!stat.isFile()) throw new Error('not-a-file');
    if (stat.size > MAX_FILE_BYTES) return { tooLarge: true as const, size: stat.size };
    const buf = readFileSync(abs);
    if (looksBinary(buf)) return { binary: true as const };
    return { content: buf.toString('utf-8'), size: stat.size };
  });

  registerHandler('source:write-file', ({ sourceId, relPath, content }) => {
    const { abs } = resolveInsideSource(sourceId, relPath);
    if (!existsSync(abs)) throw new Error('file-not-found');
    atomicWriteFileSync(abs, content, 'utf-8');
    return { ok: true as const };
  });

  registerHandler('source:create-file', ({ sourceId, relPath }) => {
    const { abs } = resolveInsideSource(sourceId, relPath);
    if (existsSync(abs)) throw new Error('file-exists');
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, '', 'utf-8');
    return { ok: true as const };
  });

  registerHandler('source:create-dir', ({ sourceId, relPath }) => {
    const { abs } = resolveInsideSource(sourceId, relPath);
    if (existsSync(abs)) throw new Error('dir-exists');
    mkdirSync(abs, { recursive: true });
    return { ok: true as const };
  });

  registerHandler('source:rename', ({ sourceId, relPath, newRelPath }) => {
    const { abs: absFrom } = resolveInsideSource(sourceId, relPath);
    const { abs: absTo } = resolveInsideSource(sourceId, newRelPath);
    if (existsSync(absTo)) throw new Error('target-exists');
    mkdirSync(dirname(absTo), { recursive: true });
    renameSync(absFrom, absTo);
    return { ok: true as const };
  });

  registerHandler('source:copy', ({ sourceId, relPath, newRelPath }) => {
    const { abs: absFrom } = resolveInsideSource(sourceId, relPath);
    const { abs: absTo } = resolveInsideSource(sourceId, newRelPath);
    if (!existsSync(absFrom)) throw new Error('source-missing');
    if (existsSync(absTo)) throw new Error('target-exists');
    mkdirSync(dirname(absTo), { recursive: true });
    cpSync(absFrom, absTo, { recursive: true });
    return { ok: true as const };
  });

  registerHandler('source:delete-file', async ({ sourceId, relPath }) => {
    // trashItem (lixeira do SO) só existe no Electron — sem fallback destrutivo
    // (rm definitivo) escondido atrás do mesmo botão.
    if (!shell) throw new Error('Mover pra lixeira disponível apenas no app desktop.');
    const { abs } = resolveInsideSource(sourceId, relPath);
    await shell.trashItem(abs);
    return { ok: true as const };
  });

  // Permalink GitHub (igual "Copy Web URL" do VS Code): só faz sentido em repo GitHub.
  // Usa o SHA do HEAD pra link estável; cai pra branch atual se rev-parse falhar.
  registerHandler('source:github-permalink', ({ sourceId, relPath, line }) => {
    const source = sourceRepo.get(sourceId);
    if (source?.kind !== 'github_repo' || !source.repoFullName || !source.path) {
      throw new Error('not-github');
    }
    const root = resolve(source.path);
    let ref: string;
    try {
      ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    } catch {
      try {
        ref = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })
          .toString()
          .trim();
      } catch {
        throw new Error('no-git');
      }
    }
    const path = relPath
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const hash = line && line > 0 ? `#L${line}` : '';
    return { url: `https://github.com/${source.repoFullName}/blob/${ref}/${path}${hash}` };
  });

  registerHandler('source:reveal', ({ sourceId, relPath }) => {
    if (!shell)
      throw new Error('Revelar no gerenciador de arquivos disponível apenas no app desktop.');
    const { abs } = resolveInsideSource(sourceId, relPath);
    shell.showItemInFolder(abs);
    return { ok: true as const };
  });

  registerHandler('source:search', ({ sourceId, query, opts, scope, include, exclude }) => {
    if (!query) return { results: [], truncated: false, fileCount: 0, matchCount: 0 };
    const source = sourceRepo.get(sourceId);
    if (!source?.path || !existsSync(source.path)) throw new Error('source-path-missing');
    let re: RegExp;
    try {
      re = buildSearchMatcher(query, opts);
    } catch {
      throw new Error('bad-regex');
    }
    const root = resolve(source.path);
    const inc = parsePatterns(include);
    const exc = parsePatterns(exclude);
    const passFilter = (rel: string) =>
      (inc.length === 0 || inc.some((r) => r.test(rel))) && !exc.some((r) => r.test(rel));
    const results: Array<{
      relPath: string;
      matches: Array<{ line: number; column: number; preview: string }>;
    }> = [];
    let matchCount = 0;
    let truncated = false;
    const t0 = Date.now();
    for (const rel of listSearchFiles(root, scope)) {
      if (matchCount >= SEARCH_MATCH_CAP || Date.now() - t0 > SEARCH_TIME_BUDGET_MS) {
        truncated = true;
        break;
      }
      if (!passFilter(rel)) continue;
      const abs = join(root, rel);
      let buf: Buffer;
      try {
        const st = statSync(abs);
        if (st.size > MAX_FILE_BYTES) continue;
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      if (looksBinary(buf)) continue;
      const lines = buf.toString('utf-8').split('\n');
      const matches: Array<{ line: number; column: number; preview: string }> = [];
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (m) {
          matches.push({ line: i + 1, column: m.index + 1, preview: lines[i].slice(0, 200) });
          matchCount++;
          if (matches.length >= SEARCH_PER_FILE_CAP || matchCount >= SEARCH_MATCH_CAP) break;
        }
      }
      if (matches.length) results.push({ relPath: rel, matches });
    }
    return { results, truncated, fileCount: results.length, matchCount };
  });

  registerHandler(
    'source:replace-all',
    ({ sourceId, query, replacement, opts, scope, include, exclude }) => {
      if (!query) return { files: 0, occurrences: 0 };
      const source = sourceRepo.get(sourceId);
      if (!source?.path || !existsSync(source.path)) throw new Error('source-path-missing');
      let re: RegExp;
      try {
        re = buildSearchMatcher(query, opts);
      } catch {
        throw new Error('bad-regex');
      }
      const root = resolve(source.path);
      const inc = parsePatterns(include);
      const exc = parsePatterns(exclude);
      const passFilter = (rel: string) =>
        (inc.length === 0 || inc.some((r) => r.test(rel))) && !exc.some((r) => r.test(rel));
      let files = 0;
      let occurrences = 0;
      const t0 = Date.now();
      for (const rel of listSearchFiles(root, scope)) {
        // Teto de tempo: não pendura o app numa varredura/regex pesada. Para com o que já
        // foi feito (replace é re-executável pras ocorrências restantes) em vez de travar.
        if (Date.now() - t0 > SEARCH_TIME_BUDGET_MS) {
          console.warn(
            '[source:replace-all] budget de tempo estourado — replace parcial, re-rode pra continuar',
          );
          break;
        }
        if (!passFilter(rel)) continue;
        const abs = join(root, rel);
        let buf: Buffer;
        try {
          const st = statSync(abs);
          if (st.size > MAX_FILE_BYTES) continue;
          buf = readFileSync(abs);
        } catch {
          continue;
        }
        if (looksBinary(buf)) continue;
        const content = buf.toString('utf-8');
        const n = (content.match(re) || []).length;
        if (n > 0) {
          atomicWriteFileSync(abs, content.replace(re, replacement), 'utf-8');
          files++;
          occurrences += n;
        }
      }
      return { files, occurrences };
    },
  );

  registerHandler('source:list-dirs', ({ workspaceId }) => {
    const sources = sourceRepo.listByWorkspace(workspaceId);
    const out: Array<{ sourceId: string; sourceLabel: string; relPath: string }> = [];
    for (const s of sources) {
      if (!s.path || !existsSync(s.path)) continue;
      for (const rel of listSubdirs(s.path)) {
        out.push({ sourceId: s.id, sourceLabel: s.label, relPath: rel });
        if (out.length >= MAX_DIRS) return out;
      }
    }
    return out;
  });

  registerHandler('source:list-files', ({ workspaceId }) => {
    const sources = sourceRepo.listByWorkspace(workspaceId);
    const out: Array<{ sourceId: string; sourceLabel: string; relPath: string }> = [];
    for (const s of sources) {
      if (!s.path || !existsSync(s.path)) continue;
      for (const rel of listFilesUnder(s.path)) {
        out.push({ sourceId: s.id, sourceLabel: s.label, relPath: rel });
        if (out.length >= MAX_FILES_MENTION) return out;
      }
    }
    return out;
  });

  /**
   * Cria source. Pra repos remotos, faz clone automático em background:
   *   1. Cria a row no banco (sem path ainda)
   *   2. Retorna o source imediatamente
   *   3. Clona via git em background, emitindo eventos de progresso
   *   4. Quando termina, atualiza source.path com o clone
   */
  registerHandler('source:create', async (input) => {
    const existing = sourceRepo.listByWorkspace(input.workspaceId).find((source) => {
      if (source.kind !== input.kind) return false;
      if (input.kind === 'local_folder') return !!input.path && source.path === input.path;
      return !!input.repoFullName && source.repoFullName === input.repoFullName;
    });
    if (existing) {
      // Remoto já existe mas o clone anterior FALHOU (path null/inexistente):
      // re-dispara o clone em vez de devolver um source quebrado.
      const cloneFailed =
        (existing.kind === 'github_repo' || existing.kind === 'azure_repo') &&
        !!existing.repoFullName &&
        (!existing.path || !existsSync(existing.path));
      if (!cloneFailed) return existing;

      const reclonePromise = cloneRemoteSource({
        sourceId: existing.id,
        workspaceId: input.workspaceId,
        kind: existing.kind as 'github_repo' | 'azure_repo',
        repoFullName: existing.repoFullName!,
        githubAccountLogin: input.githubAccountLogin,
      });
      const runKnowledge = input.runKnowledgeAnalysisAfterCreate === true;

      if (input.waitForClone) {
        const clonedPath = await reclonePromise;
        const updated = sourceRepo.update(existing.id, { path: clonedPath });
        scheduleSourceIngestion({
          workspaceId: input.workspaceId,
          sourceId: existing.id,
          reason: 'source-cloned',
          runKnowledgeAnalysis: runKnowledge,
          delayMs: 400,
        });
        return updated;
      }

      void reclonePromise
        .then(() => {
          scheduleSourceIngestion({
            workspaceId: input.workspaceId,
            sourceId: existing.id,
            reason: 'source-cloned',
            runKnowledgeAnalysis: runKnowledge,
            delayMs: 400,
          });
        })
        .catch(() => undefined);
      return existing;
    }

    const source = sourceRepo.create(input);
    // Source-add NÃO abre mais chat de hiring (gerava sessão "Plano de contratação
    // inicial" duplicada + re-prompt confuso). O especialista do novo source vem
    // pela proposta do Inbox (toast com Aprovar), criada pelo syncWorkspaceTeamForSources.
    const runKnowledgeAfterCreate = input.runKnowledgeAnalysisAfterCreate === true;
    scheduleSourceIngestion({
      workspaceId: input.workspaceId,
      sourceId: source.id,
      reason: 'source-created',
      runKnowledgeAnalysis: false,
      delayMs: 300,
    });

    // "Apontar pro repo existente": se já existe um checkout local (path com .git),
    // NÃO clona — só ingere/analisa a pasta existente (cai no else como uma source-ready).
    const hasLocalCheckout =
      !!input.path && existsSync(input.path) && existsSync(join(input.path, '.git'));
    // Pra repos GitHub/Azure SEM checkout local, clona em background.
    if (
      (input.kind === 'github_repo' || input.kind === 'azure_repo') &&
      input.repoFullName &&
      !hasLocalCheckout &&
      !input.skipClone
    ) {
      const clonePromise = cloneRemoteSource({
        sourceId: source.id,
        workspaceId: input.workspaceId,
        kind: input.kind,
        repoFullName: input.repoFullName,
        githubAccountLogin: input.githubAccountLogin,
      });

      if (input.waitForClone) {
        const clonedPath = await clonePromise;
        const updated = sourceRepo.update(source.id, { path: clonedPath });
        scheduleSourceIngestion({
          workspaceId: input.workspaceId,
          sourceId: source.id,
          reason: 'source-cloned',
          runKnowledgeAnalysis: runKnowledgeAfterCreate,
          delayMs: 400,
        });
        return updated;
      }

      // Fire-and-forget — não bloqueia o retorno do IPC no fluxo normal.
      void clonePromise
        .then(() => {
          scheduleSourceIngestion({
            workspaceId: input.workspaceId,
            sourceId: source.id,
            reason: 'source-cloned',
            runKnowledgeAnalysis: runKnowledgeAfterCreate,
            delayMs: 400,
          });
        })
        .catch(() => undefined);
    } else {
      scheduleSourceIngestion({
        workspaceId: input.workspaceId,
        sourceId: source.id,
        reason: 'source-ready',
        runKnowledgeAnalysis: runKnowledgeAfterCreate,
        delayMs: 400,
      });
    }

    return source;
  });

  // Dedupe inteligente: dado um repo GitHub (owner/repo), acha se já existe um source
  // que o mapeia — direto (github_repo com mesmo repoFullName) ou uma pasta local cujo
  // `.git` remote `origin` aponta pro mesmo repo. Evita o usuário duplicar o source.
  registerHandler('source:match-repo', async ({ workspaceId, repoFullName }) => {
    const target = repoFullName.toLowerCase();
    const sources = sourceRepo.listByWorkspace(workspaceId);
    const direct = sources.find(
      (s) => s.kind === 'github_repo' && (s.repoFullName ?? '').toLowerCase() === target,
    );
    if (direct) return { source: direct };
    for (const s of sources) {
      if (s.kind !== 'local_folder' || !s.path) continue;
      if (!existsSync(join(s.path, '.git'))) continue;
      const remote = await gitRemoteUrl(s.path);
      if (!remote) continue;
      const parsed = parseGitRemote(remote);
      if (parsed.provider === 'github' && parsed.fullName.toLowerCase() === target) {
        return { source: s };
      }
    }
    return { source: null };
  });

  // Linka um source EXISTENTE (pasta local que já é o repo) ao GitHub: promove pra
  // github_repo + grava o repoFullName. Mantém o path/checkout — não re-clona, não
  // duplica. Habilita os PRs daquele repo sem criar um segundo source.
  registerHandler('source:link-repo', ({ sourceId, repoFullName }) => {
    return sourceRepo.update(sourceId, { kind: 'github_repo', repoFullName });
  });

  registerHandler('source:update', ({ sourceId, patch }) => {
    const updated = sourceRepo.update(sourceId, patch);
    scheduleTeamSourceSync(updated.workspaceId, 'source-updated');
    return updated;
  });

  registerHandler('source:set-primary', ({ sourceId }) => {
    const updated = sourceRepo.setPrimary(sourceId);
    scheduleTeamSourceSync(updated.workspaceId, 'source-primary-changed');
    return updated;
  });

  registerHandler('source:delete', ({ sourceId }) => {
    // Remove o clone local também (se for um repo remoto clonado pelo Orkestral)
    const source = sourceRepo.get(sourceId);
    if (source) {
      // Cancela jobs de análise/embedding ativos do source (evita o job tocar
      // páginas já apagadas) e apaga as páginas da KB ligadas a ele — sem isso o
      // grafo fica com nós órfãos apontando pra um source inexistente.
      const activeAnalysis = kbAnalysisJobRepo.findActiveBySource(sourceId);
      if (activeAnalysis) cancelAnalyze(activeAnalysis.id);
      for (const job of kbEmbeddingJobRepo.listByWorkspace(source.workspaceId, 100)) {
        if (job.sourceId === sourceId && (job.status === 'queued' || job.status === 'running')) {
          cancelEmbeddingJob(job.id);
        }
      }
      pageRepo.deleteBySourceId(source.workspaceId, sourceId);
      // Limpa também o código-fonte indexado deste source (corpus 'code' do
      // kb_search) — senão trechos de um repo removido continuariam recuperáveis.
      kbCodeChunkRepo.deleteBySourceId(source.workspaceId, sourceId);
    }
    if (
      (source?.kind === 'github_repo' || source?.kind === 'azure_repo') &&
      source.path &&
      source.repoFullName
    ) {
      const expectedPath = sourceClonePath(source.workspaceId, source.repoFullName);
      if (source.path === expectedPath && existsSync(source.path)) {
        try {
          rmSync(source.path, { recursive: true, force: true });
        } catch {
          // ignore — usuário pode limpar manualmente depois
        }
      }
    }
    sourceRepo.delete(sourceId);
    if (source) {
      scheduleTeamSourceSync(source.workspaceId, 'source-deleted');
    }
    return { ok: true as const };
  });

  /** Lista PRs de todos os repos GitHub do workspace, em paralelo. */
  registerHandler('source:list-all-prs', async ({ workspaceId }) => {
    const sources = sourceRepo.listGithubRepos(workspaceId);
    const results = await Promise.all(
      sources.map(async (source) => {
        try {
          const prs = await listPullRequests(source.repoFullName!);
          return {
            sourceId: source.id,
            sourceLabel: source.label,
            sourceRole: source.role,
            repoFullName: source.repoFullName!,
            prs,
          };
        } catch {
          return {
            sourceId: source.id,
            sourceLabel: source.label,
            sourceRole: source.role,
            repoFullName: source.repoFullName!,
            prs: [],
          };
        }
      }),
    );
    return results;
  });

  // Versão PAGINADA (infinite scroll): busca SÓ a página `page` do estado pedido
  // em CADA repo, em paralelo, e funde. hasMore = algum repo encheu a página
  // (provavelmente há mais). Evita o fetch de até 1000 PRs/repo upfront.
  registerHandler('source:list-prs-page', async ({ workspaceId, state, page, perPage }) => {
    const sources = sourceRepo.listGithubRepos(workspaceId);
    const results = await Promise.all(
      sources.map(async (source) => {
        try {
          const { prs, hasMore } = await listPullRequestsPage(source.repoFullName!, {
            state,
            page,
            perPage,
          });
          return {
            group: {
              sourceId: source.id,
              sourceLabel: source.label,
              sourceRole: source.role,
              repoFullName: source.repoFullName!,
              prs,
            },
            hasMore,
          };
        } catch {
          return {
            group: {
              sourceId: source.id,
              sourceLabel: source.label,
              sourceRole: source.role,
              repoFullName: source.repoFullName!,
              prs: [],
            },
            hasMore: false,
          };
        }
      }),
    );
    return {
      groups: results.map((r) => r.group),
      hasMore: results.some((r) => r.hasMore),
    };
  });

  /** Varre a pasta procurando repos git. Se a própria pasta for repo, não
   *  varre (`rootIsGit`). Senão devolve os repos achados dentro (até 2 níveis). */
  registerHandler('source:scan-folder', async ({ path: folderPath }) => {
    if (!folderPath || !existsSync(folderPath)) {
      return { rootIsGit: false, repos: [] };
    }
    if (existsSync(join(folderPath, '.git'))) {
      // A pasta já é um repo git: lê o remote `origin` pra permitir "apontar pro
      // repo existente" (linkar sem re-clonar).
      const remoteUrl = await gitRemoteUrl(folderPath);
      return {
        rootIsGit: true,
        repos: [],
        rootRemote: remoteUrl ? parseGitRemote(remoteUrl) : null,
      };
    }
    return { rootIsGit: false, repos: findGitRepos(folderPath, 2) };
  });

  /** Abre diálogo nativo de pasta. Retorna path absoluto ou null. */
  registerHandler('source:pick-folder', async ({ defaultPath }) => {
    if (!dialog) throw new Error('Seletor de pastas disponível apenas no app desktop.');
    const focused = BrowserWindow?.getFocusedWindow() ?? BrowserWindow?.getAllWindows()[0];
    const opts: OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath ?? undefined,
    };
    const result = focused
      ? await dialog.showOpenDialog(focused, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) {
      return { path: null };
    }
    return { path: result.filePaths[0] };
  });
}
