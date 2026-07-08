import { randomUUID } from 'node:crypto';
import { desc, eq, gte, sql } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { agentRuns } from '../schema';
import type { AdapterType, RunStatus } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

export interface AgentRun {
  id: string;
  sessionId: string;
  agentId: string;
  adapterType: AdapterType;
  model: string | null;
  status: RunStatus;
  exitCode: number | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

function rowToRun(row: typeof agentRuns.$inferSelect): AgentRun {
  return {
    id: row.id,
    sessionId: row.sessionId,
    agentId: row.agentId,
    adapterType: row.adapterType as AdapterType,
    model: row.model,
    status: row.status as RunStatus,
    exitCode: row.exitCode,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    costUsd: row.costUsd,
  };
}

export class AgentRunRepository {
  get(id: string): AgentRun | null {
    const db = getDatabase();
    const row = db.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
    return row ? rowToRun(row) : null;
  }

  start(input: {
    sessionId: string;
    agentId: string;
    adapterType: AdapterType;
    model?: string | null;
  }): AgentRun {
    const db = getDatabase();
    const row = {
      id: randomUUID(),
      sessionId: input.sessionId,
      agentId: input.agentId,
      adapterType: input.adapterType,
      model: input.model ?? null,
      status: 'running' as RunStatus,
      exitCode: null,
      errorMessage: null,
      startedAt: nowIso(),
      finishedAt: null,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
    };
    db.insert(agentRuns).values(row).run();
    return rowToRun(row as typeof agentRuns.$inferSelect);
  }

  finish(
    id: string,
    patch: {
      status: RunStatus;
      exitCode?: number | null;
      errorMessage?: string | null;
      tokensIn?: number | null;
      tokensOut?: number | null;
      costUsd?: number | null;
    },
  ): void {
    const db = getDatabase();
    db.update(agentRuns)
      .set({
        status: patch.status,
        exitCode: patch.exitCode ?? null,
        errorMessage: patch.errorMessage ?? null,
        tokensIn: patch.tokensIn ?? null,
        tokensOut: patch.tokensOut ?? null,
        costUsd: patch.costUsd ?? null,
        finishedAt: nowIso(),
      })
      .where(eq(agentRuns.id, id))
      .run();
  }

  /**
   * Uso acumulado da SESSÃO numa única query de agregação (`SUM`/`COUNT ...
   * WHERE session_id = ?`) — nada de carregar runs pra somar em JS. Runs sem
   * usage (adapters sem stream-json, cancelados) têm colunas NULL e o SUM
   * simplesmente os ignora; COALESCE garante 0 (não NULL) em sessão vazia.
   */
  sumUsageBySession(sessionId: string): {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    runs: number;
  } {
    const db = getDatabase();
    const row = db
      .select({
        tokensIn: sql<number>`COALESCE(SUM(${agentRuns.tokensIn}), 0)`,
        tokensOut: sql<number>`COALESCE(SUM(${agentRuns.tokensOut}), 0)`,
        costUsd: sql<number>`COALESCE(SUM(${agentRuns.costUsd}), 0)`,
        runs: sql<number>`COUNT(*)`,
      })
      .from(agentRuns)
      .where(eq(agentRuns.sessionId, sessionId))
      .get();
    return {
      tokensIn: row?.tokensIn ?? 0,
      tokensOut: row?.tokensOut ?? 0,
      costUsd: row?.costUsd ?? 0,
      runs: row?.runs ?? 0,
    };
  }

  listByAgent(agentId: string, limit = 50): AgentRun[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.agentId, agentId))
      .orderBy(desc(agentRuns.startedAt))
      .limit(limit)
      .all();
    return rows.map(rowToRun);
  }

  listByAgentSince(agentId: string, sinceIso: string): AgentRun[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.agentId, agentId))
      .all()
      .filter((r) => r.startedAt >= sinceIso);
    // (filter em JS porque o `and` da drizzle exigiria import extra — small dataset)
    void gte; // mantém import disponível pra uso futuro
    return rows.map(rowToRun);
  }

  /** Cleanup boot: runs com status='running' órfãs viram cancelled. */
  cleanupRunningOrphans(): number {
    const db = getDatabase();
    const result = db
      .update(agentRuns)
      .set({ status: 'cancelled', finishedAt: nowIso() })
      .where(eq(agentRuns.status, 'running'))
      .run();
    return result.changes ?? 0;
  }
}
