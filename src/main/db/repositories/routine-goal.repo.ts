import { randomUUID } from 'node:crypto';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { routines, goals, issues, issueRuns } from '../schema';
import type { Routine, Goal } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToRoutine(row: typeof routines.$inferSelect): Routine {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToGoal(row: typeof goals.$inferSelect): Goal {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    description: row.description,
    status: row.status,
    progress: row.progress,
    ownerAgentId: row.ownerAgentId,
    parentGoalId: row.parentGoalId,
    planSessionId: row.planSessionId,
    verifySessionId: row.verifySessionId,
    tokenBudget: row.tokenBudget,
    convergenceCount: row.convergenceCount,
    lastConvergenceAt: row.lastConvergenceAt,
    dueDate: row.dueDate,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class RoutineRepository {
  listByWorkspace(workspaceId: string): Routine[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(routines)
      .where(eq(routines.workspaceId, workspaceId))
      .orderBy(desc(routines.updatedAt))
      .all();
    return rows.map(rowToRoutine);
  }
  listEnabled(): Routine[] {
    const db = getDatabase();
    const rows = db.select().from(routines).where(eq(routines.enabled, true)).all();
    return rows.map(rowToRoutine);
  }
  get(id: string): Routine | null {
    const db = getDatabase();
    const row = db.select().from(routines).where(eq(routines.id, id)).get();
    return row ? rowToRoutine(row) : null;
  }
  create(input: {
    workspaceId: string;
    agentId: string;
    name: string;
    description?: string | null;
    prompt: string;
    intervalMinutes?: number;
    enabled?: boolean;
  }): Routine {
    const db = getDatabase();
    const now = nowIso();
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      name: input.name.trim(),
      description: input.description ?? null,
      prompt: input.prompt,
      intervalMinutes: input.intervalMinutes ?? 60,
      enabled: input.enabled ?? false,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(routines).values(row).run();
    return rowToRoutine(row as typeof routines.$inferSelect);
  }
  update(
    id: string,
    patch: Partial<
      Pick<Routine, 'name' | 'description' | 'prompt' | 'intervalMinutes' | 'enabled' | 'agentId'>
    >,
  ): Routine {
    const db = getDatabase();
    const setPayload: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.name !== undefined) setPayload.name = patch.name.trim();
    if (patch.description !== undefined) setPayload.description = patch.description;
    if (patch.prompt !== undefined) setPayload.prompt = patch.prompt;
    if (patch.intervalMinutes !== undefined) setPayload.intervalMinutes = patch.intervalMinutes;
    if (patch.enabled !== undefined) setPayload.enabled = patch.enabled;
    if (patch.agentId !== undefined) setPayload.agentId = patch.agentId;
    db.update(routines).set(setPayload).where(eq(routines.id, id)).run();
    return this.get(id)!;
  }
  touchLastRun(id: string): void {
    const db = getDatabase();
    const now = nowIso();
    db.update(routines).set({ lastRunAt: now, updatedAt: now }).where(eq(routines.id, id)).run();
  }
  delete(id: string): void {
    const db = getDatabase();
    db.delete(routines).where(eq(routines.id, id)).run();
  }
}

export class GoalRepository {
  listByWorkspace(workspaceId: string): Goal[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(goals)
      .where(eq(goals.workspaceId, workspaceId))
      .orderBy(desc(goals.updatedAt))
      .all();
    return rows.map(rowToGoal);
  }
  get(id: string): Goal | null {
    const db = getDatabase();
    const row = db.select().from(goals).where(eq(goals.id, id)).get();
    return row ? rowToGoal(row) : null;
  }
  create(input: {
    workspaceId: string;
    title: string;
    description?: string | null;
    ownerAgentId?: string | null;
    parentGoalId?: string | null;
    dueDate?: string | null;
    tokenBudget?: number | null;
  }): Goal {
    const db = getDatabase();
    const now = nowIso();
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      title: input.title.trim(),
      description: input.description ?? null,
      status: 'active' as const,
      progress: 0,
      ownerAgentId: input.ownerAgentId ?? null,
      parentGoalId: input.parentGoalId ?? null,
      tokenBudget: input.tokenBudget ?? null,
      convergenceCount: 0,
      lastConvergenceAt: null,
      dueDate: input.dueDate ?? null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(goals).values(row).run();
    return rowToGoal(row as typeof goals.$inferSelect);
  }
  update(
    id: string,
    patch: Partial<
      Pick<
        Goal,
        | 'title'
        | 'description'
        | 'status'
        | 'progress'
        | 'ownerAgentId'
        | 'dueDate'
        | 'planSessionId'
        | 'verifySessionId'
        | 'tokenBudget'
      >
    >,
  ): Goal {
    const db = getDatabase();
    const now = nowIso();
    const setPayload: Record<string, unknown> = { updatedAt: now };
    if (patch.title !== undefined) setPayload.title = patch.title.trim();
    if (patch.description !== undefined) setPayload.description = patch.description;
    if (patch.status !== undefined) {
      setPayload.status = patch.status;
      setPayload.completedAt = patch.status === 'achieved' ? now : null;
    }
    if (patch.progress !== undefined) setPayload.progress = patch.progress;
    if (patch.ownerAgentId !== undefined) setPayload.ownerAgentId = patch.ownerAgentId;
    if (patch.dueDate !== undefined) setPayload.dueDate = patch.dueDate;
    if (patch.planSessionId !== undefined) setPayload.planSessionId = patch.planSessionId;
    if (patch.verifySessionId !== undefined) setPayload.verifySessionId = patch.verifySessionId;
    if (patch.tokenBudget !== undefined) setPayload.tokenBudget = patch.tokenBudget;
    db.update(goals).set(setPayload).where(eq(goals.id, id)).run();
    return this.get(id)!;
  }

  /**
   * Tokens JÁ GASTOS no objetivo (HORIZON Fase 2): soma tokens_in+tokens_out de
   * TODOS os issue_runs das issues vinculadas ao goal. É o número honesto que o
   * loop de convergência compara com token_budget antes de acordar o CEO.
   */
  spentTokens(goalId: string): number {
    const db = getDatabase();
    const row = db
      .select({
        total: sql<
          number | null
        >`sum(coalesce(${issueRuns.tokensIn}, 0) + coalesce(${issueRuns.tokensOut}, 0))`,
      })
      .from(issueRuns)
      .innerJoin(issues, eq(issueRuns.issueId, issues.id))
      .where(eq(issues.goalId, goalId))
      .get();
    return row?.total ?? 0;
  }

  /** Registra um turno de convergência (contador + timestamp de rate-limit). */
  bumpConvergence(goalId: string): void {
    const db = getDatabase();
    const now = nowIso();
    db.update(goals)
      .set({
        convergenceCount: sql`${goals.convergenceCount} + 1`,
        lastConvergenceAt: now,
        updatedAt: now,
      })
      .where(eq(goals.id, goalId))
      .run();
  }
  /**
   * Recalcula o progresso DERIVADO de um objetivo: % de issues `done` entre as
   * issues vinculadas (goalId). Sem issues vinculadas → 0. Chamado quando uma
   * issue muda de status ou de objetivo. Não auto-marca como `achieved` — quem
   * decide o fechamento é o CEO/usuário (verificação goal-backward vem depois).
   * Retorna o progresso calculado (0–100).
   */
  recalcProgress(goalId: string): number {
    const db = getDatabase();
    // Progresso conta só folhas — épicas (pais) são guarda-chuva, não contam.
    const row = db
      .select({
        total: sql<number>`count(*)`,
        done: sql<number>`sum(case when ${issues.status} = 'done' then 1 else 0 end)`,
      })
      .from(issues)
      .where(
        sql`${issues.goalId} = ${goalId} AND ${issues.id} NOT IN (
          SELECT parent_issue_id FROM issues
          WHERE parent_issue_id IS NOT NULL AND goal_id = ${goalId}
        )`,
      )
      .get();
    const total = row?.total ?? 0;
    const done = row?.done ?? 0;
    const progress = total > 0 ? Math.round((done / total) * 100) : 0;
    // Só grava se mudou — permite recalc preguiçoso no goal:list sem write à toa.
    db.update(goals)
      .set({ progress, updatedAt: nowIso() })
      .where(and(eq(goals.id, goalId), ne(goals.progress, progress)))
      .run();
    return progress;
  }

  /** Recalc preguiçoso de todos os objetivos do workspace (só grava os que mudam). */
  recalcAllForWorkspace(workspaceId: string): void {
    const db = getDatabase();
    const ids = db
      .select({ id: goals.id })
      .from(goals)
      .where(eq(goals.workspaceId, workspaceId))
      .all();
    for (const { id } of ids) this.recalcProgress(id);
  }

  delete(id: string): void {
    const db = getDatabase();
    // Desvincula as issues primeiro (goalId é soft-FK, sem cascade) pra não
    // deixar issues apontando pra objetivo morto.
    db.update(issues).set({ goalId: null }).where(eq(issues.goalId, id)).run();
    db.delete(goals).where(eq(goals.id, id)).run();
  }
}
