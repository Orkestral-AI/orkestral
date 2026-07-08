import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { kbEmbeddingJobs, type KbEmbeddingJobRow } from '../schema';
import type { KbEmbeddingJobStatus, KbEmbeddingJobSummary } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToSummary(row: KbEmbeddingJobRow): KbEmbeddingJobSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sourceId: row.sourceId,
    sourceLabel: row.sourceLabel,
    reason: row.reason as KbEmbeddingJobSummary['reason'],
    status: row.status as KbEmbeddingJobStatus,
    current: row.current,
    total: row.total,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export class KbEmbeddingJobRepository {
  create(input: {
    id: string;
    workspaceId: string;
    reason: KbEmbeddingJobSummary['reason'];
    pageIds: string[];
    sourceId?: string | null;
    sourceLabel?: string | null;
  }): KbEmbeddingJobSummary {
    const now = nowIso();
    const row = {
      id: input.id,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId ?? null,
      sourceLabel: input.sourceLabel ?? null,
      reason: input.reason,
      status: 'queued' as const,
      pageIdsJson: input.pageIds,
      current: 0,
      total: input.pageIds.length,
      error: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    };
    getDatabase().insert(kbEmbeddingJobs).values(row).run();
    return rowToSummary(row);
  }

  get(id: string): KbEmbeddingJobRow | null {
    return (
      getDatabase().select().from(kbEmbeddingJobs).where(eq(kbEmbeddingJobs.id, id)).get() ?? null
    );
  }

  update(
    id: string,
    patch: Partial<{
      status: KbEmbeddingJobStatus;
      current: number;
      error: string | null;
      startedAt: string | null;
      completedAt: string | null;
    }>,
  ): KbEmbeddingJobSummary | null {
    const db = getDatabase();
    const existing = this.get(id);
    if (!existing) return null;
    db.update(kbEmbeddingJobs)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.current !== undefined ? { current: patch.current } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
        ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(kbEmbeddingJobs.id, id))
      .run();
    const row = this.get(id);
    return row ? rowToSummary(row) : null;
  }

  listByWorkspace(workspaceId: string, limit = 20): KbEmbeddingJobSummary[] {
    return getDatabase()
      .select()
      .from(kbEmbeddingJobs)
      .where(eq(kbEmbeddingJobs.workspaceId, workspaceId))
      .orderBy(desc(kbEmbeddingJobs.createdAt))
      .limit(Math.min(Math.max(limit, 1), 100))
      .all()
      .map(rowToSummary);
  }

  listResumable(): KbEmbeddingJobRow[] {
    return getDatabase()
      .select()
      .from(kbEmbeddingJobs)
      .where(inArray(kbEmbeddingJobs.status, ['queued', 'running']))
      .orderBy(desc(kbEmbeddingJobs.createdAt))
      .all();
  }

  findQueuedDuplicate(input: {
    workspaceId: string;
    reason: KbEmbeddingJobSummary['reason'];
  }): KbEmbeddingJobRow[] {
    return getDatabase()
      .select()
      .from(kbEmbeddingJobs)
      .where(
        and(
          eq(kbEmbeddingJobs.workspaceId, input.workspaceId),
          eq(kbEmbeddingJobs.reason, input.reason),
          eq(kbEmbeddingJobs.status, 'queued'),
        ),
      )
      .orderBy(desc(kbEmbeddingJobs.createdAt))
      .all();
  }
}

export const kbEmbeddingJobRepo = new KbEmbeddingJobRepository();
