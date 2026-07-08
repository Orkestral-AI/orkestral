import { create } from 'zustand';
import type {
  KbAnalysisJobSummary,
  KbAnalyzeEvent,
  KbEmbeddingEvent,
  KbEmbeddingJobSummary,
} from '@shared/types';

export type KnowledgeProgressStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface KnowledgeProgressItem {
  id: string;
  workspaceId: string;
  sourceId: string | null;
  sourceLabel: string;
  status: KnowledgeProgressStatus;
  phase: string;
  message: string;
  current: number;
  total: number;
  pagesCreated: number;
  filesScanned: number;
  embeddingCurrent: number;
  embeddingTotal: number;
  /** Log das ferramentas que o agente usou na análise IA (Read, Glob, kb_create_page…),
   *  pra o thinking ao vivo mostrar o "uso de ferramentas". Últimas ~12, sem repetir
   *  consecutivas. */
  toolLog: Array<{ tool: string; at: number }>;
  updatedAt: number;
  completedAt: number | null;
}

interface KnowledgeProgressState {
  items: KnowledgeProgressItem[];
  hydrateWorkspaceStatus: (workspaceId: string) => Promise<void>;
  handleAnalyzeEvent: (event: KbAnalyzeEvent) => void;
  handleEmbeddingEvent: (event: KbEmbeddingEvent) => void;
  dismiss: (id: string) => void;
  clearCompleted: () => void;
}

function now(): number {
  return Date.now();
}

function progressIdForAnalyze(event: KbAnalyzeEvent): string {
  return event.sourceId ? `source:${event.sourceId}` : `analyze:${event.jobId}`;
}

function progressIdForEmbedding(event: KbEmbeddingEvent): string {
  return event.job.sourceId ? `source:${event.job.sourceId}` : `embedding:${event.job.id}`;
}

function sourceLabelFromAnalyze(event: KbAnalyzeEvent): string {
  return event.sourceLabel || event.sourceId || 'Knowledge base';
}

function sourceLabelFromEmbedding(event: KbEmbeddingEvent): string {
  return event.job.sourceLabel || event.job.sourceId || 'Knowledge base';
}

function upsert(
  items: KnowledgeProgressItem[],
  id: string,
  patch: Partial<KnowledgeProgressItem> & Pick<KnowledgeProgressItem, 'workspaceId'>,
): KnowledgeProgressItem[] {
  const at = now();
  const existing = items.find((item) => item.id === id);
  if (!existing) {
    return [
      ...items,
      {
        id,
        workspaceId: patch.workspaceId,
        sourceId: patch.sourceId ?? null,
        sourceLabel: patch.sourceLabel ?? 'Knowledge base',
        status: patch.status ?? 'running',
        phase: patch.phase ?? 'start',
        message: patch.message ?? '',
        current: patch.current ?? 0,
        total: patch.total ?? 100,
        pagesCreated: patch.pagesCreated ?? 0,
        filesScanned: patch.filesScanned ?? 0,
        embeddingCurrent: patch.embeddingCurrent ?? 0,
        embeddingTotal: patch.embeddingTotal ?? 0,
        toolLog: patch.toolLog ?? [],
        updatedAt: at,
        completedAt: patch.completedAt ?? null,
      },
    ];
  }
  return items.map((item) =>
    item.id === id
      ? {
          ...item,
          ...patch,
          sourceLabel: patch.sourceLabel ?? item.sourceLabel,
          sourceId: patch.sourceId ?? item.sourceId,
          updatedAt: at,
        }
      : item,
  );
}

export const useKnowledgeProgressStore = create<KnowledgeProgressState>((set) => ({
  items: [],
  hydrateWorkspaceStatus: async (workspaceId) => {
    const [analysisJobs, embeddingJobs] = await Promise.all([
      window.orkestral['kb:analysis-status']({ workspaceId }).catch(
        () => [] as KbAnalysisJobSummary[],
      ),
      window.orkestral['kb:embedding-status']({ workspaceId }).catch(
        () => [] as KbEmbeddingJobSummary[],
      ),
    ]);
    set((state) => {
      let items = state.items;
      for (const job of analysisJobs.filter(shouldHydrateAnalysisJob).slice(0, 8)) {
        const id = job.sourceId ? `source:${job.sourceId}` : `analyze:${job.id}`;
        items = upsert(items, id, {
          workspaceId: job.workspaceId,
          sourceId: job.sourceId,
          sourceLabel: job.sourceLabel,
          status: job.status === 'queued' || job.status === 'running' ? 'running' : job.status,
          phase: job.phase ?? job.status,
          message: job.message ?? job.error ?? '',
          current: analysisPercent(job),
          total: 100,
          pagesCreated: job.pagesCreated,
          filesScanned: job.filesScanned,
          completedAt: job.completedAt ? Date.parse(job.completedAt) : null,
        });
      }
      for (const job of embeddingJobs.filter(shouldHydrateEmbeddingJob).slice(0, 8)) {
        const id = job.sourceId ? `source:${job.sourceId}` : `embedding:${job.id}`;
        items = upsert(items, id, {
          workspaceId: job.workspaceId,
          sourceId: job.sourceId ?? null,
          sourceLabel: job.sourceLabel ?? 'Knowledge base',
          status: job.status === 'queued' || job.status === 'running' ? 'running' : job.status,
          phase: 'embedding',
          message:
            job.error ??
            (job.status === 'completed'
              ? 'Base vetorizada com sucesso'
              : 'Gerando embeddings semânticos'),
          current: embeddingPercent(job),
          total: 100,
          embeddingCurrent: job.current,
          embeddingTotal: job.total,
          completedAt: job.completedAt ? Date.parse(job.completedAt) : null,
        });
      }
      return { items };
    });
  },
  handleAnalyzeEvent: (event) => {
    const workspaceId =
      'workspaceId' in event && event.workspaceId ? event.workspaceId : 'unknown-workspace';
    const id = progressIdForAnalyze(event);
    if (event.type === 'analyze-start') {
      set((state) => ({
        items: upsert(state.items, id, {
          workspaceId: event.workspaceId,
          sourceId: event.sourceId,
          sourceLabel: sourceLabelFromAnalyze(event),
          status: 'running',
          phase: 'start',
          message: 'Preparando análise',
          current: 2,
          total: 100,
        }),
      }));
      return;
    }
    if (event.type === 'analyze-phase') {
      const phaseProgress: Record<string, number> = {
        walk: 12,
        'ai-analysis': 45,
        snapshot: 76,
      };
      set((state) => ({
        items: upsert(state.items, id, {
          workspaceId,
          sourceId: event.sourceId ?? null,
          sourceLabel: sourceLabelFromAnalyze(event),
          status: 'running',
          phase: event.phase,
          message: event.message,
          current: phaseProgress[event.phase] ?? 35,
          total: 100,
        }),
      }));
      return;
    }
    if (event.type === 'analyze-progress') {
      const current = event.total > 0 ? Math.round((event.current / event.total) * 65) : 55;
      const tool = event.file?.trim();
      set((state) => {
        const existing = state.items.find((item) => item.id === id);
        const prevLog = existing?.toolLog ?? [];
        // Acumula o uso de ferramentas (sem repetir a mesma consecutivamente).
        const toolLog =
          tool && prevLog[prevLog.length - 1]?.tool !== tool
            ? [...prevLog, { tool, at: now() }].slice(-12)
            : prevLog;
        return {
          items: upsert(state.items, id, {
            workspaceId,
            sourceId: event.sourceId ?? null,
            sourceLabel: sourceLabelFromAnalyze(event),
            status: 'running',
            // Mantém a fase semântica (análise IA em curso), não o nome da tool —
            // o nome da tool vai pro toolLog, que o thinking renderiza.
            phase: 'ai-analysis',
            message: tool ? `Usando ${tool}` : 'Alimentando base',
            current: Math.max(16, Math.min(72, current)),
            total: 100,
            toolLog,
          }),
        };
      });
      return;
    }
    if (event.type === 'analyze-done') {
      set((state) => ({
        items: upsert(state.items, id, {
          workspaceId,
          sourceId: event.sourceId ?? null,
          sourceLabel: sourceLabelFromAnalyze(event),
          status: 'running',
          phase: 'embedding',
          message: 'Gerando embeddings semânticos',
          current: 82,
          total: 100,
          pagesCreated: event.pagesCreated,
          filesScanned: event.filesScanned ?? 0,
        }),
      }));
      return;
    }
    if (event.type === 'analyze-error') {
      set((state) => ({
        items: upsert(state.items, id, {
          workspaceId,
          sourceId: event.sourceId ?? null,
          sourceLabel: sourceLabelFromAnalyze(event),
          status: 'failed',
          phase: 'error',
          message: event.error,
          current: 100,
          total: 100,
          completedAt: now(),
        }),
      }));
    }
  },
  handleEmbeddingEvent: (event) => {
    const id = progressIdForEmbedding(event);
    const total = Math.max(1, event.job.total);
    const percent = Math.round((Math.min(event.job.current, total) / total) * 100);
    const status: KnowledgeProgressStatus =
      event.type === 'embedding-error'
        ? 'failed'
        : event.type === 'embedding-cancelled'
          ? 'cancelled'
          : event.type === 'embedding-done'
            ? 'completed'
            : 'running';
    const pageTitle = event.type === 'embedding-progress' ? event.title : undefined;
    set((state) => ({
      items: upsert(state.items, id, {
        workspaceId: event.job.workspaceId,
        sourceId: event.job.sourceId ?? null,
        sourceLabel: sourceLabelFromEmbedding(event),
        status,
        phase: 'embedding',
        message:
          event.type === 'embedding-error'
            ? event.error
            : event.type === 'embedding-done'
              ? 'Base vetorizada com sucesso'
              : pageTitle
                ? `Vetorizando ${pageTitle}`
                : 'Gerando embeddings semânticos',
        current: status === 'completed' ? 100 : Math.max(82, Math.min(99, 82 + percent * 0.18)),
        total: 100,
        embeddingCurrent: event.job.current,
        embeddingTotal: event.job.total,
        completedAt: status === 'running' ? null : now(),
      }),
    }));
  },
  dismiss: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
  clearCompleted: () =>
    set((state) => ({
      items: state.items.filter((item) => item.status === 'running'),
    })),
}));

function shouldHydrateAnalysisJob(job: KbAnalysisJobSummary): boolean {
  if (job.status === 'queued' || job.status === 'running') return true;
  if (!job.completedAt) return true;
  return Date.now() - Date.parse(job.completedAt) < 2 * 60_000;
}

function shouldHydrateEmbeddingJob(job: KbEmbeddingJobSummary): boolean {
  if (job.status === 'queued' || job.status === 'running') return true;
  if (!job.completedAt) return true;
  return Date.now() - Date.parse(job.completedAt) < 2 * 60_000;
}

function analysisPercent(job: KbAnalysisJobSummary): number {
  if (job.status === 'completed') return job.embeddingJobId ? 82 : 100;
  if (job.status === 'failed' || job.status === 'cancelled') return 100;
  if (job.phase === 'snapshot') return 76;
  if (job.phase === 'ai-analysis') return 45;
  if (job.phase === 'coverage-pages') return 35;
  if (job.phase === 'walk') return 12;
  return job.status === 'queued' ? 4 : 20;
}

function embeddingPercent(job: KbEmbeddingJobSummary): number {
  if (job.status === 'completed') return 100;
  if (job.status === 'failed' || job.status === 'cancelled') return 100;
  const total = Math.max(1, job.total);
  const pct = Math.round((Math.min(job.current, total) / total) * 100);
  return Math.max(82, Math.min(99, 82 + pct * 0.18));
}
