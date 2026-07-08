import { randomUUID } from 'node:crypto';
import { eq, and, inArray } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { issues, issueDependencies, issueReviewers } from '../schema';
import type {
  IssueRef,
  IssueRelations,
  IssueReviewer,
  IssueReviewerRole,
  IssueReviewerDecision,
  IssueStatus,
} from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

type IssueRow = typeof issues.$inferSelect;

function toRef(row: IssueRow, linkId?: string): IssueRef {
  return {
    id: row.id,
    issueKey: row.issueKey,
    title: row.title,
    status: row.status as IssueStatus,
    ...(linkId ? { linkId } : {}),
  };
}

/**
 * Relações de issue estilo Paperclip: blocked-by / blocking / sub-issues /
 * reviewers / approvers / monitor. Parent/children via `parentIssueId` (FK pro
 * id da issue pai). Dependências e reviewers em tabelas próprias.
 */
export class IssueRelationsRepository {
  getRelations(issueId: string): IssueRelations {
    const db = getDatabase();
    const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
    if (!issue) {
      return {
        parent: null,
        children: [],
        blockedBy: [],
        blocking: [],
        reviewers: [],
        approvers: [],
        monitorSchedule: null,
      };
    }

    // Parent / children via parentIssueId.
    let parent: IssueRef | null = null;
    if (issue.parentIssueId) {
      const p = db.select().from(issues).where(eq(issues.id, issue.parentIssueId)).get();
      if (p) parent = toRef(p);
    }
    const children = db
      .select()
      .from(issues)
      .where(eq(issues.parentIssueId, issueId))
      .all()
      .map((r) => toRef(r));

    // Dependências: blocked-by = quem bloqueia ESTA; blocking = quem ESTA bloqueia.
    const blockedByLinks = db
      .select()
      .from(issueDependencies)
      .where(eq(issueDependencies.blockedIssueId, issueId))
      .all();
    const blockingLinks = db
      .select()
      .from(issueDependencies)
      .where(eq(issueDependencies.blockerIssueId, issueId))
      .all();
    const relIds = [
      ...blockedByLinks.map((l) => l.blockerIssueId),
      ...blockingLinks.map((l) => l.blockedIssueId),
    ];
    const relMap = new Map<string, IssueRow>();
    if (relIds.length > 0) {
      for (const r of db.select().from(issues).where(inArray(issues.id, relIds)).all()) {
        relMap.set(r.id, r);
      }
    }
    const blockedBy = blockedByLinks
      .map((l) => {
        const r = relMap.get(l.blockerIssueId);
        return r ? toRef(r, l.id) : null;
      })
      .filter((x): x is IssueRef => x !== null);
    const blocking = blockingLinks
      .map((l) => {
        const r = relMap.get(l.blockedIssueId);
        return r ? toRef(r, l.id) : null;
      })
      .filter((x): x is IssueRef => x !== null);

    // Reviewers / approvers.
    const reviewerRows = db
      .select()
      .from(issueReviewers)
      .where(eq(issueReviewers.issueId, issueId))
      .all();
    const allReviewers: IssueReviewer[] = reviewerRows.map((r) => ({
      id: r.id,
      issueId: r.issueId,
      agentId: r.agentId,
      role: r.role as IssueReviewerRole,
      decision: (r.decision ?? null) as IssueReviewerDecision,
      decidedAt: r.decidedAt ?? null,
      createdAt: r.createdAt,
    }));

    return {
      parent,
      children,
      blockedBy,
      blocking,
      reviewers: allReviewers.filter((r) => r.role === 'reviewer'),
      approvers: allReviewers.filter((r) => r.role === 'approver'),
      monitorSchedule: issue.monitorSchedule ?? null,
    };
  }

  /**
   * Dependências (blocker→blocked) ainda ABERTAS que bloqueiam ESTA issue: as
   * issues que precisam terminar (done/cancelled) antes desta poder executar.
   * Gate real de execução/sequenciamento — vazio = liberada.
   */
  openBlockers(issueId: string): IssueRef[] {
    const db = getDatabase();
    const links = db
      .select()
      .from(issueDependencies)
      .where(eq(issueDependencies.blockedIssueId, issueId))
      .all();
    if (links.length === 0) return [];
    const blockerIds = links.map((l) => l.blockerIssueId);
    const rows = db.select().from(issues).where(inArray(issues.id, blockerIds)).all();
    return rows.filter((r) => r.status !== 'done' && r.status !== 'cancelled').map((r) => toRef(r));
  }

  /**
   * `fromId` alcança `targetId` seguindo as arestas blocker→blocked? Usado pra
   * detectar ciclo antes de inserir uma dependência nova.
   */
  private reaches(fromId: string, targetId: string): boolean {
    const db = getDatabase();
    const seen = new Set<string>();
    const stack = [fromId];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === targetId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const succ = db
        .select()
        .from(issueDependencies)
        .where(eq(issueDependencies.blockerIssueId, cur))
        .all();
      for (const e of succ) stack.push(e.blockedIssueId);
    }
    return false;
  }

  addDependency(workspaceId: string, blockerIssueId: string, blockedIssueId: string): void {
    if (blockerIssueId === blockedIssueId) return;
    const db = getDatabase();
    const exists = db
      .select()
      .from(issueDependencies)
      .where(
        and(
          eq(issueDependencies.blockerIssueId, blockerIssueId),
          eq(issueDependencies.blockedIssueId, blockedIssueId),
        ),
      )
      .get();
    if (exists) return;
    // Detecção de CICLO: se `blocked` já alcança `blocker`, adicionar blocker→blocked
    // fecharia um ciclo (A→B→…→A) e travaria o scheduler (ninguém nunca fica done).
    // Rejeita com erro claro (o MCP/UI surfacam pro agente/usuário).
    if (this.reaches(blockedIssueId, blockerIssueId)) {
      throw new Error(
        'Essa dependência criaria um ciclo entre as issues (A dependeria de B que depende de A).',
      );
    }
    db.insert(issueDependencies)
      .values({
        id: randomUUID(),
        workspaceId,
        blockerIssueId,
        blockedIssueId,
        createdAt: nowIso(),
      })
      .run();
  }

  removeDependency(linkId: string): void {
    getDatabase().delete(issueDependencies).where(eq(issueDependencies.id, linkId)).run();
  }

  addReviewer(issueId: string, agentId: string, role: IssueReviewerRole): IssueReviewer {
    const db = getDatabase();
    const existing = db
      .select()
      .from(issueReviewers)
      .where(
        and(
          eq(issueReviewers.issueId, issueId),
          eq(issueReviewers.agentId, agentId),
          eq(issueReviewers.role, role),
        ),
      )
      .get();
    if (existing) {
      return {
        id: existing.id,
        issueId: existing.issueId,
        agentId: existing.agentId,
        role: existing.role as IssueReviewerRole,
        decision: (existing.decision ?? null) as IssueReviewerDecision,
        decidedAt: existing.decidedAt ?? null,
        createdAt: existing.createdAt,
      };
    }
    const id = randomUUID();
    const createdAt = nowIso();
    db.insert(issueReviewers).values({ id, issueId, agentId, role, createdAt }).run();
    return { id, issueId, agentId, role, decision: null, decidedAt: null, createdAt };
  }

  removeReviewer(id: string): void {
    getDatabase().delete(issueReviewers).where(eq(issueReviewers.id, id)).run();
  }

  setReviewerDecision(id: string, decision: IssueReviewerDecision): void {
    getDatabase()
      .update(issueReviewers)
      .set({ decision: decision ?? null, decidedAt: decision ? nowIso() : null })
      .where(eq(issueReviewers.id, id))
      .run();
  }

  /**
   * Approvers de uma issue — gate REAL de `done`. Diferente dos reviewers
   * (cadeia hierárquica via reportsTo), approvers são pessoas/agentes que
   * precisam aprovar EXPLICITAMENTE (decision='approved') antes da issue poder
   * concluir. Qualquer 'rejected' impede; qualquer pendente (decision=null) deixa
   * a issue "aguardando aprovação". Vazio = sem gate.
   */
  getApprovers(issueId: string): IssueReviewer[] {
    const db = getDatabase();
    return db
      .select()
      .from(issueReviewers)
      .where(and(eq(issueReviewers.issueId, issueId), eq(issueReviewers.role, 'approver')))
      .all()
      .map((r) => ({
        id: r.id,
        issueId: r.issueId,
        agentId: r.agentId,
        role: r.role as IssueReviewerRole,
        decision: (r.decision ?? null) as IssueReviewerDecision,
        decidedAt: r.decidedAt ?? null,
        createdAt: r.createdAt,
      }));
  }

  setMonitor(issueId: string, schedule: string | null): void {
    getDatabase()
      .update(issues)
      .set({ monitorSchedule: schedule, updatedAt: nowIso() })
      .where(eq(issues.id, issueId))
      .run();
  }
}
