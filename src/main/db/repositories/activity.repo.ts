import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { activityLog } from '../schema';
import type { ActivityEntry } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToEntry(row: typeof activityLog.$inferSelect): ActivityEntry {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    actorKind: row.actorKind,
    actorId: row.actorId,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    title: row.title,
    payload: row.payload ?? {},
    createdAt: row.createdAt,
  };
}

export class ActivityRepository {
  log(input: {
    workspaceId: string;
    kind: string;
    actorKind?: 'user' | 'agent' | 'system';
    actorId?: string | null;
    subjectKind?: string | null;
    subjectId?: string | null;
    title: string;
    payload?: Record<string, unknown>;
  }): ActivityEntry {
    const db = getDatabase();
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      kind: input.kind,
      actorKind: input.actorKind ?? 'user',
      actorId: input.actorId ?? null,
      subjectKind: input.subjectKind ?? null,
      subjectId: input.subjectId ?? null,
      title: input.title,
      payload: input.payload ?? {},
      createdAt: nowIso(),
    };
    db.insert(activityLog).values(row).run();
    return rowToEntry(row as typeof activityLog.$inferSelect);
  }

  /**
   * Apaga as pendências de proposta (`proposal.pending`) de uma sessão. Usado
   * antes de gravar uma nova proposta na mesma sessão pra que aprovar
   * materialize sempre o time da proposta MAIS RECENTE — não a antiga (stale).
   */
  deletePendingProposalsForSession(workspaceId: string, sessionId: string): void {
    const db = getDatabase();
    db.delete(activityLog)
      .where(
        and(
          eq(activityLog.workspaceId, workspaceId),
          eq(activityLog.kind, 'proposal.pending'),
          eq(activityLog.subjectId, sessionId),
        ),
      )
      .run();
  }

  /**
   * Marca a proposta de hiring de uma sessão como APLICADA (idempotência): consome
   * a pendência e grava um `proposal.applied` com os nomes criados. Um segundo
   * clique de "Aprovar e criar" (botão perdeu o estado / mensagem remontou) cai no
   * `getAppliedProposal` e vira no-op, em vez de re-materializar / re-pedir blocos
   * ao CEO (a duplicata de "criar plano").
   */
  markProposalApplied(
    workspaceId: string,
    sessionId: string,
    names: string[],
    title: string,
  ): void {
    this.deletePendingProposalsForSession(workspaceId, sessionId);
    this.log({
      workspaceId,
      kind: 'proposal.applied',
      actorKind: 'system',
      subjectKind: 'session',
      subjectId: sessionId,
      title,
      payload: { names, appliedAt: nowIso() },
    });
  }

  /** Proposta de hiring mais recente já aplicada nesta sessão (ou null). */
  getAppliedProposal(workspaceId: string, sessionId: string): ActivityEntry | null {
    const db = getDatabase();
    const row = db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.workspaceId, workspaceId),
          eq(activityLog.kind, 'proposal.applied'),
          eq(activityLog.subjectId, sessionId),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1)
      .get();
    return row ? rowToEntry(row) : null;
  }

  listByWorkspace(workspaceId: string, limit = 100): ActivityEntry[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(activityLog)
      .where(eq(activityLog.workspaceId, workspaceId))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit)
      .all();
    return rows.map(rowToEntry);
  }
}
