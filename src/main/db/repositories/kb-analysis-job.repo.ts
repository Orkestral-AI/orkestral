import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { kbAnalysisJobs, type KbAnalysisJobRow } from '../schema';
import type { KbAnalysisJobStatus, KbAnalysisJobSummary } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToSummary(row: KbAnalysisJobRow): KbAnalysisJobSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sourceId: row.sourceId,
    sourceLabel: row.sourceLabel,
    status: row.status as KbAnalysisJobStatus,
    phase: row.phase,
    message: row.message,
    filesScanned: row.filesScanned,
    pagesCreated: row.pagesCreated,
    entitiesCreated: row.entitiesCreated,
    relationsCreated: row.relationsCreated,
    coveragePages: row.coveragePages,
    embeddingJobId: row.embeddingJobId,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export class KbAnalysisJobRepository {
  create(input: {
    id: string;
    workspaceId: string;
    sourceId: string | null;
    sourceLabel: string;
  }): KbAnalysisJobSummary {
    const now = nowIso();
    const row = {
      id: input.id,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      sourceLabel: input.sourceLabel,
      status: 'queued' as const,
      phase: null,
      message: null,
      filesScanned: 0,
      pagesCreated: 0,
      entitiesCreated: 0,
      relationsCreated: 0,
      coveragePages: 0,
      embeddingJobId: null,
      error: null,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    };
    getDatabase().insert(kbAnalysisJobs).values(row).run();
    return rowToSummary(row);
  }

  get(id: string): KbAnalysisJobRow | null {
    return (
      getDatabase().select().from(kbAnalysisJobs).where(eq(kbAnalysisJobs.id, id)).get() ?? null
    );
  }

  update(
    id: string,
    patch: Partial<{
      status: KbAnalysisJobStatus;
      phase: string | null;
      message: string | null;
      filesScanned: number;
      pagesCreated: number;
      entitiesCreated: number;
      relationsCreated: number;
      coveragePages: number;
      embeddingJobId: string | null;
      error: string | null;
      tokensIn: number | null;
      tokensOut: number | null;
      costUsd: number | null;
      startedAt: string | null;
      completedAt: string | null;
    }>,
  ): KbAnalysisJobSummary | null {
    const existing = this.get(id);
    if (!existing) return null;
    getDatabase()
      .update(kbAnalysisJobs)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
        ...(patch.message !== undefined ? { message: patch.message } : {}),
        ...(patch.filesScanned !== undefined ? { filesScanned: patch.filesScanned } : {}),
        ...(patch.pagesCreated !== undefined ? { pagesCreated: patch.pagesCreated } : {}),
        ...(patch.entitiesCreated !== undefined ? { entitiesCreated: patch.entitiesCreated } : {}),
        ...(patch.relationsCreated !== undefined
          ? { relationsCreated: patch.relationsCreated }
          : {}),
        ...(patch.coveragePages !== undefined ? { coveragePages: patch.coveragePages } : {}),
        ...(patch.embeddingJobId !== undefined ? { embeddingJobId: patch.embeddingJobId } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.tokensIn !== undefined ? { tokensIn: patch.tokensIn } : {}),
        ...(patch.tokensOut !== undefined ? { tokensOut: patch.tokensOut } : {}),
        ...(patch.costUsd !== undefined ? { costUsd: patch.costUsd } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
        ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(kbAnalysisJobs.id, id))
      .run();
    const row = this.get(id);
    return row ? rowToSummary(row) : null;
  }

  listByWorkspace(workspaceId: string, limit = 50): KbAnalysisJobSummary[] {
    return getDatabase()
      .select()
      .from(kbAnalysisJobs)
      .where(eq(kbAnalysisJobs.workspaceId, workspaceId))
      .orderBy(desc(kbAnalysisJobs.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200))
      .all()
      .map(rowToSummary);
  }

  /**
   * Cleanup de boot: marca jobs `queued`/`running` órfãos (de um processo
   * anterior que crashou) como `failed`. Sem isso, uma análise `running` após
   * crash trava a ingestão do source pra sempre (findActiveBySource a vê como
   * ativa). Espelha o que a fila de embeddings faz com listResumable.
   */
  markBootOrphansFailed(): number {
    const result = getDatabase()
      .update(kbAnalysisJobs)
      .set({
        status: 'failed',
        phase: 'error',
        message: 'Análise interrompida (boot cleanup).',
        error: 'Processo interrompido antes de concluir (boot cleanup).',
        completedAt: nowIso(),
        updatedAt: nowIso(),
      })
      .where(inArray(kbAnalysisJobs.status, ['queued', 'running']))
      .run();
    return result.changes ?? 0;
  }

  findActiveBySource(sourceId: string): KbAnalysisJobSummary | null {
    const row =
      getDatabase()
        .select()
        .from(kbAnalysisJobs)
        .where(
          and(
            eq(kbAnalysisJobs.sourceId, sourceId),
            inArray(kbAnalysisJobs.status, ['queued', 'running']),
          ),
        )
        .orderBy(desc(kbAnalysisJobs.createdAt))
        .get() ?? null;
    return row ? rowToSummary(row) : null;
  }
}

export const kbAnalysisJobRepo = new KbAnalysisJobRepository();
