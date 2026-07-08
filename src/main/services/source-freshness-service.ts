import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { WorkspaceSourceRepository } from '../db/repositories/workspace-source.repo';
import type { WorkspaceSource } from '../../shared/types';
import { gitFetch, gitHeadSha, gitPullFastForward, gitStatus, gitUpstreamSha } from './git-service';
import { analyzeSource } from './kb-repo-analyzer';
import { kbAnalysisJobRepo } from '../db/repositories/kb-analysis-job.repo';

const sourceRepo = new WorkspaceSourceRepository();

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cache',
  'vendor',
]);

export interface SourceFreshnessResult {
  source: WorkspaceSource;
  changed: boolean;
  fingerprint: string | null;
  status: 'fresh' | 'stale' | 'dirty' | 'error';
  message: string;
  analysisJobId?: string;
  analysisDeferred?: boolean;
}

export interface EnsureSourceFreshOptions {
  waitForAnalysis?: boolean;
  analysisWaitMs?: number;
  onPhase?: (message: string) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashLocalTree(root: string): string {
  const hash = createHash('sha256');
  const stack = [root];
  let files = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') {
        if (entry.name !== '.github') continue;
      }
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = statSync(full);
        if (st.size > 2_000_000) continue;
        files++;
        hash.update(relative(root, full));
        hash.update(':');
        hash.update(String(st.size));
        hash.update(':');
        hash.update(String(Math.floor(st.mtimeMs)));
        hash.update('\n');
      } catch {
        // Ignore arquivos que mudaram/sumiram durante o scan.
      }
    }
  }
  hash.update(`files:${files}`);
  return `tree:${hash.digest('hex').slice(0, 24)}`;
}

function isGitSource(source: WorkspaceSource): boolean {
  return source.kind === 'github_repo' || source.kind === 'azure_repo';
}

const ANALYSIS_POLL_MS = 500;

async function fingerprintSource(source: WorkspaceSource): Promise<{
  fingerprint: string;
  dirty: boolean;
  summary: Record<string, unknown>;
}> {
  if (!source.path || !existsSync(source.path)) {
    throw new Error(`Source sem path local válido: ${source.label}`);
  }

  if (!isGitSource(source) || !existsSync(join(source.path, '.git'))) {
    const fingerprint = hashLocalTree(source.path);
    return { fingerprint, dirty: false, summary: { mode: 'local-tree' } };
  }

  const status = await gitStatus(source.path);
  const dirty = status.files.length > 0;
  if (dirty) {
    const head = await gitHeadSha(source.path).catch(() => 'unknown');
    return {
      fingerprint: `git:${head}:dirty:${hashLocalTree(source.path)}`,
      dirty: true,
      summary: { mode: 'git-dirty', branch: status.branch, changedFiles: status.files.length },
    };
  }

  const head = await gitHeadSha(source.path);
  const upstream = await gitUpstreamSha(source.path);
  return {
    fingerprint: `git:${head}`,
    dirty: false,
    summary: { mode: 'git-clean', branch: status.branch, upstream },
  };
}

/**
 * Espera a reindexação do KB — mas é BEST-EFFORT: a indexação é uma melhoria de
 * RAG, NUNCA um gate de execução. O agente lê os arquivos REAIS de qualquer forma
 * (warp-grep + leitura direta). Por isso esta função:
 *  - espera só um teto CURTO (reindex incremental pequeno termina a tempo);
 *  - se demorar além do teto OU o job falhar, NÃO lança — segue, e o job continua
 *    em background atualizando o índice. (Antes lançava "excedeu o tempo limite"
 *    e isso virava "Erro fatal na execução", matando a issue.)
 * Retorna o estado observado só pra feedback; o caller nunca trava por causa dele.
 */
const ANALYSIS_SOFT_WAIT_MS = 60_000;

async function waitForAnalysis(jobId: string): Promise<'completed' | 'pending' | 'failed'> {
  const deadline = Date.now() + ANALYSIS_SOFT_WAIT_MS;
  while (Date.now() < deadline) {
    const job = kbAnalysisJobRepo.get(jobId);
    if (!job) return 'completed';
    if (job.status === 'completed') return 'completed';
    if (job.status === 'failed' || job.status === 'cancelled') {
      console.warn(
        `[freshness] análise do source ${jobId} ${job.status} — seguindo com o índice atual`,
      );
      return 'failed';
    }
    await new Promise((resolve) => setTimeout(resolve, ANALYSIS_POLL_MS));
  }
  console.warn(
    `[freshness] análise do source ${jobId} ainda rodando após ${ANALYSIS_SOFT_WAIT_MS / 1000}s — seguindo (continua em background)`,
  );
  return 'pending';
}

export async function ensureSourceFresh(
  source: WorkspaceSource | null | undefined,
  options: EnsureSourceFreshOptions = {},
): Promise<SourceFreshnessResult | null> {
  if (!source?.path) return null;
  const onPhase = options.onPhase ?? (() => {});
  const before = sourceRepo.get(source.id) ?? source;
  sourceRepo.update(source.id, {
    freshnessStatus: 'syncing',
    lastSyncAt: nowIso(),
    syncDetails: { reason: 'pre-issue-execution' },
  });

  try {
    onPhase(`Sincronizando source ${source.label}`);
    if (isGitSource(source) && existsSync(join(source.path, '.git'))) {
      const status = await gitStatus(source.path);
      if (status.files.length === 0) {
        try {
          await gitFetch(source.path);
          await gitPullFastForward(source.path, { branch: status.branch ?? undefined });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          onPhase(
            `Não consegui sincronizar ${source.label} agora; seguindo com o checkout local (${message})`,
          );
        }
      } else {
        onPhase(
          `${source.label} tem mudanças locais; pull automático foi pulado para preservar o trabalho atual`,
        );
      }
    }

    const current = await fingerprintSource(source);
    const previous = before.lastIndexedFingerprint ?? before.lastSyncedFingerprint;
    const changed = !previous || previous !== current.fingerprint;
    const status = current.dirty ? 'dirty' : changed ? 'stale' : 'fresh';
    sourceRepo.update(source.id, {
      freshnessStatus: status,
      lastSyncedFingerprint: current.fingerprint,
      lastSyncAt: nowIso(),
      syncDetails: current.summary,
    });

    if (!changed) {
      return {
        source: sourceRepo.get(source.id) ?? source,
        changed: false,
        fingerprint: current.fingerprint,
        status,
        message: `${source.label} já está atualizado`,
      };
    }

    onPhase(`Base de conhecimento obsoleta em ${source.label}; reanalisando source`);
    const { jobId } = analyzeSource(source.workspaceId, source.id);
    const analysisState =
      options.waitForAnalysis !== false ? await waitForAnalysis(jobId) : 'pending';
    const stillIndexing = analysisState === 'pending';
    if (stillIndexing) {
      onPhase(`Reindexação de ${source.label} segue em background; execução prossegue`);
    }
    const fresh = sourceRepo.update(source.id, {
      // 'fresh' só quando a indexação completou; se segue em background, mantém
      // 'stale' (o job termina e o próximo run não reanalisa) sem travar este.
      freshnessStatus: current.dirty ? 'dirty' : stillIndexing ? 'stale' : 'fresh',
      lastIndexedFingerprint: current.fingerprint,
      lastSyncedFingerprint: current.fingerprint,
      lastSyncAt: nowIso(),
      syncDetails: { ...current.summary, analysisJobId: jobId, analysisState },
    });
    return {
      source: fresh,
      changed: true,
      fingerprint: current.fingerprint,
      status: current.dirty ? 'dirty' : 'stale',
      message: stillIndexing
        ? `${source.label} sincronizado; reindexação do KB segue em background`
        : `${source.label} reanalisado antes da execução`,
      analysisJobId: jobId,
      analysisDeferred: stillIndexing,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sourceRepo.update(source.id, {
      freshnessStatus: 'error',
      lastSyncAt: nowIso(),
      syncDetails: { error: message },
    });
    throw err;
  }
}
