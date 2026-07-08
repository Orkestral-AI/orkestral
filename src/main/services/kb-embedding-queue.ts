import { randomUUID } from 'node:crypto';
import { broadcast } from '../platform/host';
import { and, eq } from 'drizzle-orm';
import { getDatabase } from '../db/connection';
import { kbEmbeddingJobRepo } from '../db/repositories/kb-embedding-job.repo';
import { kbPages } from '../db/schema';
import { indexPageEmbedding, isPageEmbeddingUpToDate } from './kb-semantic-search';
import { syncWorkspaceTeamForSources } from './source-team-sync';
import { trace } from './log-bus';
import type {
  KbEmbeddingEvent,
  KbEmbeddingJobSummary,
  KbEmbeddingJobStatus,
} from '../../shared/types';

type EmbeddingJobReason = KbEmbeddingJobSummary['reason'];

interface EmbeddingJob {
  id: string;
  workspaceId: string;
  sourceId: string | null;
  sourceLabel: string | null;
  reason: EmbeddingJobReason;
  status: KbEmbeddingJobStatus;
  pageIds: string[];
  current: number;
  total: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelled: boolean;
}

const jobs = new Map<string, EmbeddingJob>();
const queue: EmbeddingJob[] = [];
let processing = false;
let hydrated = false;
const MAX_PAGE_ATTEMPTS = 2;
// Páginas processadas em paralelo DENTRO de um job. O embedding em si já é
// serializado pelo runtime local (contexto único do modelo), então o ganho aqui
// é sobrepor o trabalho NÃO-embedding (leitura da página, split de chunks,
// checagem de hash, reuse/cópia de vetor) enquanto outra página aguarda o
// contexto — mantém o pipeline cheio sem disputar o modelo. Pool pequeno e fixo.
const MAX_PAGE_CONCURRENCY = 3;
const CONTEXT_SYNC_INTERVAL_MS = 3_000;
const lastContextSyncByWorkspace = new Map<string, number>();
// Janela de coalescência de escritas de página: createPage/updatePage disparam
// um enqueue por pageId. Em vez de virar um job de 1 página cada (log spam +
// benchmark a cada página), bufferizamos os pageIds por workspace e fazemos UM
// job só após a janela quietar — ou antes, se o buffer estourar o máximo.
const COALESCE_WINDOW_MS = 750;
const COALESCE_MAX_PAGES = 32;
// Mínimo de páginas pra rodar o benchmark RAG ao fim de um job: jobs
// incrementais pequenos (page-write) não justificam o custo/ruído de um
// benchmark completo — só rebuilds ou lotes grandes rodam.
const RAG_BENCHMARK_MIN_PAGES = 8;

interface CoalesceBuffer {
  pageIds: Set<string>;
  sourceId: string | null;
  sourceLabel: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}
// Buffer de coalescência por workspaceId (só para reason='page-write').
const coalesceBuffers = new Map<string, CoalesceBuffer>();

function nowIso(): string {
  return new Date().toISOString();
}

function toSummary(job: EmbeddingJob): KbEmbeddingJobSummary {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    sourceId: job.sourceId,
    sourceLabel: job.sourceLabel,
    reason: job.reason,
    status: job.status,
    current: job.current,
    total: job.total,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

function emit(event: KbEmbeddingEvent): void {
  broadcast('kb:embedding-event', event);
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function latestPage(pageId: string) {
  const db = getDatabase();
  return db.select().from(kbPages).where(eq(kbPages.id, pageId)).get() ?? null;
}

function syncRepoContextForEmbedding(job: EmbeddingJob, reason: string, force = false): void {
  const last = lastContextSyncByWorkspace.get(job.workspaceId) ?? 0;
  const now = Date.now();
  if (!force && now - last < CONTEXT_SYNC_INTERVAL_MS) return;
  lastContextSyncByWorkspace.set(job.workspaceId, now);
  try {
    syncWorkspaceTeamForSources(job.workspaceId, reason);
  } catch (err) {
    console.warn('[embedding] sync do repo context falhou:', err);
  }
}

async function benchmarkSourceRetrieval(job: EmbeddingJob): Promise<void> {
  if (!job.sourceId) return;
  try {
    const { runAutomaticSourceRagBenchmark } = await import('./kb-quality');
    const summary = await runAutomaticSourceRagBenchmark({
      workspaceId: job.workspaceId,
      sourceId: job.sourceId,
      sourceLabel: job.sourceLabel,
    });
    trace({
      level: summary.failed > 0 ? 'warn' : 'success',
      source: 'embedding',
      scope: 'rag-benchmark',
      workspaceId: job.workspaceId,
      message: `benchmark RAG automático · ${job.sourceLabel ?? job.sourceId} · ${summary.passed}/${summary.total} passou · recall=${summary.avgRecallAtK.toFixed(2)} · mrr=${summary.avgMrr.toFixed(2)}`,
    });
  } catch (err) {
    trace({
      level: 'warn',
      source: 'embedding',
      scope: 'rag-benchmark',
      workspaceId: job.workspaceId,
      message: `benchmark RAG automático falhou: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function normalizePageIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && !!id);
}

function jobFromRow(row: NonNullable<ReturnType<typeof kbEmbeddingJobRepo.get>>): EmbeddingJob {
  const pageIds = normalizePageIds(row.pageIdsJson);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sourceId: row.sourceId,
    sourceLabel: row.sourceLabel,
    reason: row.reason as EmbeddingJobReason,
    status: 'queued',
    pageIds,
    current: Math.min(row.current, pageIds.length),
    total: row.total || pageIds.length,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: null,
    completedAt: null,
    cancelled: false,
  };
}

function hydratePersistedJobs(): void {
  if (hydrated) return;
  hydrated = true;
  for (const row of kbEmbeddingJobRepo.listResumable()) {
    const job = jobFromRow(row);
    jobs.set(job.id, job);
    queue.push(job);
    kbEmbeddingJobRepo.update(job.id, {
      status: 'queued',
      startedAt: null,
      completedAt: null,
      error: row.status === 'running' ? 'Retomado após reinício do app.' : row.error,
    });
  }
  if (queue.length > 0) void processQueue();
}

function enqueueJob(input: {
  workspaceId: string;
  pageIds: string[];
  reason: EmbeddingJobReason;
  sourceId?: string | null;
  sourceLabel?: string | null;
}): KbEmbeddingJobSummary {
  hydratePersistedJobs();
  const uniquePageIds = [...new Set(input.pageIds)].filter(Boolean);
  const duplicate = findDuplicateQueuedJob(input.workspaceId, input.reason, uniquePageIds);
  if (duplicate) return toSummary(duplicate);
  const job: EmbeddingJob = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    sourceId: input.sourceId ?? null,
    sourceLabel: input.sourceLabel ?? null,
    reason: input.reason,
    status: 'queued',
    pageIds: uniquePageIds,
    current: 0,
    total: uniquePageIds.length,
    error: null,
    createdAt: nowIso(),
    startedAt: null,
    completedAt: null,
    cancelled: false,
  };
  jobs.set(job.id, job);
  queue.push(job);
  kbEmbeddingJobRepo.create({
    id: job.id,
    workspaceId: job.workspaceId,
    reason: job.reason,
    pageIds: job.pageIds,
    sourceId: job.sourceId,
    sourceLabel: job.sourceLabel,
  });
  const summary = toSummary(job);
  emit({ type: 'embedding-queued', job: summary });
  void processQueue();
  return summary;
}

// Compara duas listas de pageIds como CONJUNTOS (ordem-independente): dois
// rebuilds idênticos podem derivar a mesma lista em ordens diferentes (o SELECT
// de enqueueWorkspaceEmbeddings não tem ORDER BY), e a comparação posicional
// deixava ambos enfileirarem → trabalho duplicado na fila serial.
function samePageIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const id of b) {
    if (!set.has(id)) return false;
  }
  return true;
}

function findDuplicateQueuedJob(
  workspaceId: string,
  reason: EmbeddingJobReason,
  pageIds: string[],
): EmbeddingJob | null {
  if (pageIds.length === 0) return null;
  for (const job of queue) {
    if (job.workspaceId !== workspaceId || job.reason !== reason || job.status !== 'queued') {
      continue;
    }
    if (reason === 'page-write' && pageIds.length === 1 && job.pageIds[0] === pageIds[0]) {
      return job;
    }
    if (reason === 'workspace-rebuild' && samePageIdSet(job.pageIds, pageIds)) {
      return job;
    }
  }
  for (const row of kbEmbeddingJobRepo.findQueuedDuplicate({ workspaceId, reason })) {
    const pageIdsForRow = normalizePageIds(row.pageIdsJson);
    if (reason === 'page-write' && pageIds.length === 1 && pageIdsForRow[0] === pageIds[0]) {
      const existing = jobs.get(row.id) ?? jobFromRow(row);
      jobs.set(existing.id, existing);
      return existing;
    }
    if (reason === 'workspace-rebuild' && samePageIdSet(pageIdsForRow, pageIds)) {
      const existing = jobs.get(row.id) ?? jobFromRow(row);
      jobs.set(existing.id, existing);
      return existing;
    }
  }
  return null;
}

async function indexPageWithRetry(
  workspaceId: string,
  pageId: string,
  title: string,
  body: string,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt++) {
    try {
      await indexPageEmbedding(workspaceId, pageId, title, body);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_PAGE_ATTEMPTS) await delay(250 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Processa UMA página do job: pula arquivadas/ausentes e páginas já indexadas
 * para o conteúdo atual (changed-pages-only — evita re-walk/re-split/re-embed),
 * senão (re)indexa com retry. A contabilidade de progresso (`job.current`, DB,
 * emit) roda SÍNCRONA após o await — segura sob o pool cooperativo, pois não há
 * preempção no meio do incremento.
 */
async function processJobPage(job: EmbeddingJob, pageId: string): Promise<void> {
  const page = latestPage(pageId);
  if (!page || page.isArchived === 1) {
    job.current++;
    kbEmbeddingJobRepo.update(job.id, { current: job.current });
    return;
  }
  if (isPageEmbeddingUpToDate(page)) {
    job.current++;
    kbEmbeddingJobRepo.update(job.id, { current: job.current });
    return;
  }
  await indexPageWithRetry(page.workspaceId, page.id, page.title, page.contentMd ?? '');
  job.current++;
  kbEmbeddingJobRepo.update(job.id, { current: job.current });
  syncRepoContextForEmbedding(job, 'embedding-progress');
  emit({
    type: 'embedding-progress',
    job: toSummary(job),
    pageId: page.id,
    title: page.title,
  });
}

/**
 * Pool de concorrência limitada genérico: roda `task(item)` sobre `items` com no
 * máximo `concurrency` em voo. Cada worker puxa o próximo índice de um cursor
 * compartilhado; `shouldStop()` para de pegar novos itens (cancelamento) sem
 * abortar os já em voo. Falha de uma task propaga (rejeita o `Promise.all`).
 * Exportado só para teste unitário — não tem dependência de DB/Electron.
 */
export async function runPooled<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (!shouldStop()) {
      const index = cursor++;
      if (index >= items.length) return;
      await task(items[index]!, index);
    }
  };
  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
}

/**
 * Pool de concorrência limitada para as páginas de um job: até
 * `MAX_PAGE_CONCURRENCY` páginas em voo, parando de pegar novas quando o job é
 * cancelado. Mantém o tratamento de erro/cancelamento existente em processQueue.
 */
async function runJobPagesPooled(job: EmbeddingJob): Promise<void> {
  await runPooled(
    job.pageIds,
    MAX_PAGE_CONCURRENCY,
    async (pageId) => {
      await processJobPage(job, pageId);
      await yieldToLoop();
    },
    () => job.cancelled,
  );
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      job.status = 'running';
      job.startedAt = nowIso();
      kbEmbeddingJobRepo.update(job.id, {
        status: 'running',
        startedAt: job.startedAt,
        completedAt: null,
        error: null,
      });
      syncRepoContextForEmbedding(job, 'embedding-started', true);
      emit({ type: 'embedding-progress', job: toSummary(job) });
      trace({
        level: 'info',
        source: 'embedding',
        scope: 'queue',
        message: `indexação semântica iniciada · ${job.total} página(s)`,
      });

      try {
        await runJobPagesPooled(job);
        if (job.cancelled) {
          job.status = 'cancelled';
          job.completedAt = nowIso();
          kbEmbeddingJobRepo.update(job.id, {
            status: 'cancelled',
            completedAt: job.completedAt,
          });
          syncRepoContextForEmbedding(job, 'embedding-cancelled', true);
          emit({ type: 'embedding-cancelled', job: toSummary(job) });
          trace({
            level: 'warn',
            source: 'embedding',
            scope: 'queue',
            message: `indexação semântica cancelada · ${job.current}/${job.total}`,
          });
          continue;
        }
        job.status = 'completed';
        job.completedAt = nowIso();
        kbEmbeddingJobRepo.update(job.id, {
          status: 'completed',
          current: job.current,
          completedAt: job.completedAt,
        });
        // Só roda o benchmark RAG em rebuilds OU em lotes grandes — jobs
        // incrementais de poucas páginas não justificam o custo/ruído.
        if (job.reason === 'workspace-rebuild' || job.total >= RAG_BENCHMARK_MIN_PAGES) {
          await benchmarkSourceRetrieval(job);
        }
        syncRepoContextForEmbedding(job, 'embedding-completed', true);
        emit({ type: 'embedding-done', job: toSummary(job) });
        trace({
          level: 'success',
          source: 'embedding',
          scope: 'queue',
          message: `indexação semântica concluída · ${job.current}/${job.total}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        job.status = 'failed';
        job.error = message;
        job.completedAt = nowIso();
        kbEmbeddingJobRepo.update(job.id, {
          status: 'failed',
          error: message,
          completedAt: job.completedAt,
        });
        syncRepoContextForEmbedding(job, 'embedding-failed', true);
        emit({ type: 'embedding-error', job: toSummary(job), error: message });
        trace({
          level: 'warn',
          source: 'embedding',
          scope: 'queue',
          message: `indexação semântica falhou: ${message}`,
        });
      }
    }
  } finally {
    processing = false;
  }
}

/**
 * Esvazia o buffer de coalescência de um workspace num ÚNICO job com todos os
 * pageIds bufferizados (dedup garantido pelo Set). Limpa o timer e a entrada.
 */
function flushCoalesceBuffer(workspaceId: string): void {
  const buffer = coalesceBuffers.get(workspaceId);
  if (!buffer) return;
  if (buffer.timer) clearTimeout(buffer.timer);
  coalesceBuffers.delete(workspaceId);
  const pageIds = [...buffer.pageIds];
  if (pageIds.length === 0) return;
  enqueueJob({
    workspaceId,
    pageIds,
    reason: 'page-write',
    sourceId: buffer.sourceId,
    sourceLabel: buffer.sourceLabel,
  });
}

export function enqueuePageEmbedding(input: {
  workspaceId: string;
  pageId: string;
  reason?: EmbeddingJobReason;
  sourceId?: string | null;
  sourceLabel?: string | null;
}): KbEmbeddingJobSummary {
  const reason = input.reason ?? 'page-write';
  // Caminho direto p/ rebuild e qualquer reason não-page-write — sem coalescer.
  if (reason !== 'page-write') {
    return enqueueJob({
      workspaceId: input.workspaceId,
      pageIds: [input.pageId],
      reason,
      sourceId: input.sourceId ?? null,
      sourceLabel: input.sourceLabel ?? null,
    });
  }
  // page-write: acumula no buffer do workspace e (re)arma a janela de flush.
  const buffer = coalesceBuffers.get(input.workspaceId) ?? {
    pageIds: new Set<string>(),
    sourceId: input.sourceId ?? null,
    sourceLabel: input.sourceLabel ?? null,
    timer: null,
  };
  buffer.pageIds.add(input.pageId);
  // Mantém o último source conhecido (páginas do mesmo lote tendem ao mesmo source).
  buffer.sourceId = input.sourceId ?? buffer.sourceId;
  buffer.sourceLabel = input.sourceLabel ?? buffer.sourceLabel;
  coalesceBuffers.set(input.workspaceId, buffer);
  if (buffer.pageIds.size >= COALESCE_MAX_PAGES) {
    // Estourou o teto: descarrega já, sem esperar a janela.
    flushCoalesceBuffer(input.workspaceId);
  } else {
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => flushCoalesceBuffer(input.workspaceId), COALESCE_WINDOW_MS);
    // .unref() pra a janela de coalescência nunca segurar o quit do app.
    buffer.timer.unref();
  }
  return {
    workspaceId: input.workspaceId,
    id: '',
    sourceId: buffer.sourceId,
    sourceLabel: buffer.sourceLabel,
    reason: 'page-write',
    status: 'queued',
    current: 0,
    total: buffer.pageIds.size,
    error: null,
    createdAt: nowIso(),
    startedAt: null,
    completedAt: null,
  };
}

/**
 * Resume, no BOOT do app, os jobs de embedding que ficaram pendentes
 * (queued/running) de sessões anteriores — em BACKGROUND, sem depender de abrir
 * a Base de conhecimento. Antes, `hydratePersistedJobs()` só era chamado ao
 * criar página nova OU quando a KB pedia o status (ao montar a view), então a
 * indexação pendente parecia "só rodar quando clica na base de conhecimento".
 */
export function resumeEmbeddingQueueOnBoot(): void {
  hydratePersistedJobs();
}

export function enqueueWorkspaceEmbeddings(input: {
  workspaceId: string;
  reason?: EmbeddingJobReason;
  sourceId?: string | null;
  sourceLabel?: string | null;
}): KbEmbeddingJobSummary {
  const db = getDatabase();
  const pages = db
    .select({ id: kbPages.id })
    .from(kbPages)
    .where(
      input.sourceId
        ? and(eq(kbPages.workspaceId, input.workspaceId), eq(kbPages.sourceId, input.sourceId))
        : eq(kbPages.workspaceId, input.workspaceId),
    )
    .all();
  return enqueueJob({
    workspaceId: input.workspaceId,
    pageIds: pages.map((p) => p.id),
    reason: input.reason ?? 'workspace-rebuild',
    sourceId: input.sourceId ?? null,
    sourceLabel: input.sourceLabel ?? null,
  });
}

export function listEmbeddingJobs(workspaceId: string): KbEmbeddingJobSummary[] {
  hydratePersistedJobs();
  return kbEmbeddingJobRepo.listByWorkspace(workspaceId, 20);
}

export function cancelEmbeddingJob(jobId: string): boolean {
  hydratePersistedJobs();
  const job = jobs.get(jobId);
  const persisted = kbEmbeddingJobRepo.get(jobId);
  if (!job && !persisted) return false;
  if (!job && persisted) {
    if (
      persisted.status === 'completed' ||
      persisted.status === 'failed' ||
      persisted.status === 'cancelled'
    ) {
      return false;
    }
    kbEmbeddingJobRepo.update(jobId, {
      status: 'cancelled',
      completedAt: nowIso(),
    });
    return true;
  }
  if (!job) return false;
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return false;
  }
  job.cancelled = true;
  if (job.status === 'queued') {
    const index = queue.findIndex((item) => item.id === jobId);
    if (index >= 0) queue.splice(index, 1);
    job.status = 'cancelled';
    job.completedAt = nowIso();
    kbEmbeddingJobRepo.update(job.id, {
      status: 'cancelled',
      completedAt: job.completedAt,
    });
    emit({ type: 'embedding-cancelled', job: toSummary(job) });
  }
  return true;
}
