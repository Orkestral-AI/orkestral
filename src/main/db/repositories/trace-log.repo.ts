import { desc, sql } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { traceLogs } from '../schema';
import type { TraceEntry, TraceLevel, TraceSource } from '../../../shared/types';

/** Máximo de linhas mantidas — o resto é expurgado (pedido do usuário: 500). */
export const TRACE_LOG_CAP = 500;

function rowToEntry(row: typeof traceLogs.$inferSelect): TraceEntry {
  return {
    id: row.id,
    ts: row.ts,
    level: row.level as TraceLevel,
    source: row.source as TraceSource,
    message: row.message,
    scope: row.scope,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    agentName: row.agentName,
    issueKey: row.issueKey,
    durationMs: row.durationMs,
  };
}

export class TraceLogRepository {
  /** Insere uma linha de trace. Expurga periodicamente pra respeitar o CAP. */
  private sinceLastPrune = 0;

  insert(e: TraceEntry): void {
    const db = getDatabase();
    db.insert(traceLogs)
      .values({
        id: e.id,
        ts: e.ts,
        level: e.level,
        source: e.source,
        message: e.message,
        scope: e.scope ?? null,
        workspaceId: e.workspaceId ?? null,
        agentId: e.agentId ?? null,
        agentName: e.agentName ?? null,
        issueKey: e.issueKey != null ? String(e.issueKey) : null,
        durationMs: e.durationMs ?? null,
      })
      .run();
    // Expurga a cada ~25 inserts (barato; evita rodar DELETE a cada linha).
    if (++this.sinceLastPrune >= 25) {
      this.prune();
      this.sinceLastPrune = 0;
    }
  }

  /** Linhas mais recentes em ordem cronológica (até `limit`, teto no CAP). */
  list(limit = TRACE_LOG_CAP): TraceEntry[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(traceLogs)
      .orderBy(desc(traceLogs.ts))
      .limit(Math.min(limit, TRACE_LOG_CAP))
      .all();
    return rows.reverse().map(rowToEntry);
  }

  clear(): void {
    getDatabase().delete(traceLogs).run();
  }

  /** Mantém só as TRACE_LOG_CAP linhas mais recentes; apaga o excedente. */
  prune(): void {
    const db = getDatabase();
    db.run(
      sql`DELETE FROM trace_logs WHERE id NOT IN (SELECT id FROM trace_logs ORDER BY ts DESC LIMIT ${TRACE_LOG_CAP})`,
    );
  }
}

export const traceLogRepo = new TraceLogRepository();
