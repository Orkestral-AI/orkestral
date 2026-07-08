import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { taskExecutions } from '../schema';
import type {
  ExecutionMetrics,
  TaskExecutionRecord,
  SmartExecMetricsSummary,
} from '../../../shared/types';

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

const DEFAULT_METRICS: ExecutionMetrics = {
  premiumAvoided: false,
  estimatedPremiumInputTokensAvoided: 0,
  estimatedPremiumOutputTokensAvoided: 0,
  localExecutionUsed: false,
  localRuntime: null,
};

function asMetrics(v: unknown): ExecutionMetrics {
  const obj = typeof v === 'string' ? safeParse(v) : v;
  if (!obj || typeof obj !== 'object') return DEFAULT_METRICS;
  return { ...DEFAULT_METRICS, ...(obj as Partial<ExecutionMetrics>) };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function rowToRecord(row: typeof taskExecutions.$inferSelect): TaskExecutionRecord {
  return {
    id: row.id,
    issueId: row.issueId,
    runId: row.runId,
    workspaceId: row.workspaceId,
    executionMode: row.executionMode as TaskExecutionRecord['executionMode'],
    modelUsed: row.modelUsed as TaskExecutionRecord['modelUsed'],
    risk: row.risk as TaskExecutionRecord['risk'],
    filesChanged: asArray(row.filesChanged),
    diffSummary: row.diffSummary,
    validationResult: row.validationResult as TaskExecutionRecord['validationResult'],
    fallbackUsed: row.fallbackUsed === 1,
    failureReason: row.failureReason,
    attempts: row.attempts,
    durationMs: row.durationMs,
    metrics: asMetrics(row.metrics),
    createdAt: row.createdAt,
  };
}

export interface NewTaskExecution {
  issueId?: string | null;
  runId?: string | null;
  workspaceId?: string | null;
  executionMode: TaskExecutionRecord['executionMode'];
  modelUsed: TaskExecutionRecord['modelUsed'];
  risk: TaskExecutionRecord['risk'];
  filesChanged: string[];
  diffSummary: string;
  validationResult: TaskExecutionRecord['validationResult'];
  fallbackUsed: boolean;
  failureReason?: string | null;
  attempts: number;
  durationMs?: number | null;
  metrics: ExecutionMetrics;
  plan?: unknown;
}

export class TaskExecutionRepository {
  insert(input: NewTaskExecution): TaskExecutionRecord {
    const db = getDatabase();
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    db.insert(taskExecutions)
      .values({
        id,
        issueId: input.issueId ?? null,
        runId: input.runId ?? null,
        workspaceId: input.workspaceId ?? null,
        executionMode: input.executionMode,
        modelUsed: input.modelUsed,
        risk: input.risk,
        filesChanged: input.filesChanged,
        diffSummary: input.diffSummary,
        validationResult: input.validationResult,
        fallbackUsed: input.fallbackUsed ? 1 : 0,
        failureReason: input.failureReason ?? null,
        attempts: input.attempts,
        durationMs: input.durationMs ?? null,
        metrics: input.metrics,
        plan: input.plan ?? null,
        createdAt,
      })
      .run();
    return rowToRecord(db.select().from(taskExecutions).where(eq(taskExecutions.id, id)).get()!);
  }

  listByWorkspace(workspaceId: string, limit = 100): TaskExecutionRecord[] {
    const db = getDatabase();
    return db
      .select()
      .from(taskExecutions)
      .where(eq(taskExecutions.workspaceId, workspaceId))
      .orderBy(desc(taskExecutions.createdAt))
      .limit(limit)
      .all()
      .map(rowToRecord);
  }

  listByIssue(issueId: string): TaskExecutionRecord[] {
    const db = getDatabase();
    return db
      .select()
      .from(taskExecutions)
      .where(eq(taskExecutions.issueId, issueId))
      .orderBy(desc(taskExecutions.createdAt))
      .all()
      .map(rowToRecord);
  }

  metricsSummary(workspaceId: string): SmartExecMetricsSummary {
    const records = this.listByWorkspace(workspaceId, 1000);
    const summary: SmartExecMetricsSummary = {
      totalExecutions: records.length,
      localExecutions: 0,
      premiumEscalations: 0,
      premiumAvoidedCount: 0,
      estimatedInputTokensAvoided: 0,
      estimatedOutputTokensAvoided: 0,
    };
    for (const r of records) {
      if (r.modelUsed === 'local') summary.localExecutions++;
      if (r.fallbackUsed || r.executionMode === 'premium_model') summary.premiumEscalations++;
      if (r.metrics.premiumAvoided) summary.premiumAvoidedCount++;
      summary.estimatedInputTokensAvoided += r.metrics.estimatedPremiumInputTokensAvoided;
      summary.estimatedOutputTokensAvoided += r.metrics.estimatedPremiumOutputTokensAvoided;
    }
    return summary;
  }

  /** Tabela existe? (defensivo, caso a migration ainda não tenha rodado). */
  static available(): boolean {
    try {
      getDatabase().select().from(taskExecutions).limit(1).all();
      return true;
    } catch {
      return false;
    }
  }
}
