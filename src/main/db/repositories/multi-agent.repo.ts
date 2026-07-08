import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import {
  multiAgentRuns,
  multiAgentSteps,
  type MultiAgentRunRow,
  type MultiAgentStepRow,
} from '../schema';

function nowIso(): string {
  return new Date().toISOString();
}

export class MultiAgentRepository {
  createRun(input: {
    workspaceId: string;
    issueId?: string | null;
    runId?: string | null;
    plan: Record<string, unknown>;
  }): MultiAgentRunRow {
    const db = getDatabase();
    const now = nowIso();
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      issueId: input.issueId ?? null,
      runId: input.runId ?? null,
      status: 'planned' as const,
      planJson: input.plan,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(multiAgentRuns).values(row).run();
    return row;
  }

  createStep(input: {
    multiAgentRunId: string;
    workspaceId: string;
    role: MultiAgentStepRow['role'];
    inputText?: string | null;
  }): MultiAgentStepRow {
    const db = getDatabase();
    const now = nowIso();
    const row = {
      id: randomUUID(),
      multiAgentRunId: input.multiAgentRunId,
      workspaceId: input.workspaceId,
      role: input.role,
      status: 'pending' as const,
      inputText: input.inputText ?? null,
      outputText: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(multiAgentSteps).values(row).run();
    return row;
  }

  updateRunStatus(id: string, status: MultiAgentRunRow['status']): void {
    const db = getDatabase();
    db.update(multiAgentRuns)
      .set({ status, updatedAt: nowIso() })
      .where(eq(multiAgentRuns.id, id))
      .run();
  }

  listRuns(workspaceId: string, limit = 50): MultiAgentRunRow[] {
    const db = getDatabase();
    return db
      .select()
      .from(multiAgentRuns)
      .where(eq(multiAgentRuns.workspaceId, workspaceId))
      .orderBy(desc(multiAgentRuns.createdAt))
      .limit(limit)
      .all();
  }
}

export const multiAgentRepo = new MultiAgentRepository();
