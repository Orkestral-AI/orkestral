import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { heartbeatRuns } from '../schema';
import type { HeartbeatRun } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

type Row = typeof heartbeatRuns.$inferSelect;

function rowToRun(row: Row): HeartbeatRun {
  return {
    id: row.id,
    agentId: row.agentId,
    workspaceId: row.workspaceId,
    source: row.source,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    output: row.output,
    errorMessage: row.errorMessage,
    exitCode: row.exitCode,
    durationMs: row.durationMs,
    createdAt: row.createdAt,
  };
}

export class HeartbeatRunRepository {
  /**
   * Cria uma run em status 'queued'. O service muda pra 'running' assim
   * que o processo é spawnado.
   */
  start(input: {
    agentId: string;
    workspaceId: string;
    source: 'manual' | 'scheduler';
  }): HeartbeatRun {
    const db = getDatabase();
    const now = nowIso();
    const row = {
      id: randomUUID(),
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      source: input.source,
      status: 'running' as const,
      startedAt: now,
      finishedAt: null,
      output: null,
      errorMessage: null,
      exitCode: null,
      durationMs: null,
      createdAt: now,
    };
    db.insert(heartbeatRuns).values(row).run();
    return rowToRun(row as Row);
  }

  /** Finaliza com sucesso ou falha, registrando output + exitCode + duração. */
  finish(
    id: string,
    patch: {
      status: 'succeeded' | 'failed' | 'cancelled';
      output?: string | null;
      errorMessage?: string | null;
      exitCode?: number | null;
    },
  ): void {
    const db = getDatabase();
    const existing = db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).get();
    if (!existing) return;
    // Early-return se a run já não está mais 'running': um cancel (status
    // 'cancelled') não pode ser sobrescrito por um finish('succeeded'/'failed')
    // que chega depois (close do processo morto pelo SIGTERM).
    if (existing.status !== 'running') return;
    const now = new Date();
    const startedAt = new Date(existing.startedAt).getTime();
    const durationMs = now.getTime() - startedAt;
    db.update(heartbeatRuns)
      .set({
        status: patch.status,
        finishedAt: now.toISOString(),
        output: patch.output ?? null,
        errorMessage: patch.errorMessage ?? null,
        exitCode: patch.exitCode ?? null,
        durationMs,
      })
      .where(eq(heartbeatRuns.id, id))
      .run();
  }

  /** Lista runs de um agente, ordenadas pela mais recente primeiro. */
  listByAgent(agentId: string, limit = 50): HeartbeatRun[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .orderBy(desc(heartbeatRuns.startedAt))
      .limit(limit)
      .all();
    return rows.map(rowToRun);
  }

  get(id: string): HeartbeatRun | null {
    const db = getDatabase();
    const row = db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).get();
    return row ? rowToRun(row) : null;
  }

  /** Stats agregadas pro Dashboard tab. */
  stats(
    agentId: string,
    days = 14,
  ): {
    total: number;
    succeeded: number;
    failed: number;
    avgDurationMs: number | null;
    lastStatus: HeartbeatRun['status'] | null;
  } {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const db = getDatabase();
    const rows = db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .orderBy(desc(heartbeatRuns.startedAt))
      .all();
    const recent = rows.filter((r) => r.startedAt >= cutoff);
    const succeeded = recent.filter((r) => r.status === 'succeeded').length;
    const failed = recent.filter((r) => r.status === 'failed').length;
    const durations = recent
      .filter((r) => typeof r.durationMs === 'number')
      .map((r) => r.durationMs as number);
    const avgDurationMs =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null;
    return {
      total: recent.length,
      succeeded,
      failed,
      avgDurationMs,
      lastStatus: rows[0]?.status ?? null,
    };
  }

  /** Cleanup boot: marca runs 'running' órfãs como cancelled. */
  cleanupRunningOrphans(): number {
    const db = getDatabase();
    const result = db
      .update(heartbeatRuns)
      .set({
        status: 'cancelled',
        finishedAt: nowIso(),
        errorMessage: 'Processo interrompido (boot cleanup).',
      })
      .where(eq(heartbeatRuns.status, 'running'))
      .run();
    return result.changes ?? 0;
  }
}
