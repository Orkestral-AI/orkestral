import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDatabase } from '../connection';
import {
  aiTrainingExamples,
  ragEvaluationRuns,
  type AiTrainingExampleRow,
  type RagEvaluationRunRow,
} from '../schema';

function nowIso(): string {
  return new Date().toISOString();
}

export class AiLearningRepository {
  createTrainingExample(input: {
    workspaceId: string;
    sourceKind: AiTrainingExampleRow['sourceKind'];
    sourceId?: string | null;
    taskType?: AiTrainingExampleRow['taskType'];
    inputText: string;
    expectedOutput?: string | null;
    actualOutput?: string | null;
    label?: AiTrainingExampleRow['label'];
    metadata?: Record<string, unknown> | null;
    status?: AiTrainingExampleRow['status'];
  }): AiTrainingExampleRow {
    const db = getDatabase();
    const now = nowIso();
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId ?? null,
      taskType: input.taskType ?? 'reasoning',
      inputText: input.inputText,
      expectedOutput: input.expectedOutput ?? null,
      actualOutput: input.actualOutput ?? null,
      label: input.label ?? 'neutral',
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      status: input.status ?? 'candidate',
      createdAt: now,
      updatedAt: now,
    };
    db.insert(aiTrainingExamples).values(row).run();
    return row;
  }

  listTrainingExamples(workspaceId: string, limit = 100): AiTrainingExampleRow[] {
    const db = getDatabase();
    return db
      .select()
      .from(aiTrainingExamples)
      .where(eq(aiTrainingExamples.workspaceId, workspaceId))
      .orderBy(desc(aiTrainingExamples.createdAt))
      .limit(limit)
      .all();
  }

  updateTrainingExample(input: {
    id: string;
    status?: AiTrainingExampleRow['status'];
    label?: AiTrainingExampleRow['label'];
    expectedOutput?: string | null;
    actualOutput?: string | null;
    metadata?: Record<string, unknown> | null;
  }): AiTrainingExampleRow | null {
    const db = getDatabase();
    const patch: Partial<AiTrainingExampleRow> = {
      updatedAt: nowIso(),
    };
    if (input.status) patch.status = input.status;
    if (input.label) patch.label = input.label;
    if ('expectedOutput' in input) patch.expectedOutput = input.expectedOutput ?? null;
    if ('actualOutput' in input) patch.actualOutput = input.actualOutput ?? null;
    if ('metadata' in input)
      patch.metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
    db.update(aiTrainingExamples).set(patch).where(eq(aiTrainingExamples.id, input.id)).run();
    return (
      db.select().from(aiTrainingExamples).where(eq(aiTrainingExamples.id, input.id)).get() ?? null
    );
  }

  updateTrainingExamplesStatus(input: {
    ids: string[];
    status: AiTrainingExampleRow['status'];
  }): number {
    if (input.ids.length === 0) return 0;
    const db = getDatabase();
    const info = db
      .update(aiTrainingExamples)
      .set({ status: input.status, updatedAt: nowIso() })
      .where(inArray(aiTrainingExamples.id, input.ids))
      .run();
    return info.changes ?? 0;
  }

  rejectIssueRunCandidates(input: {
    workspaceId: string;
    issueId: string;
    reason: string;
  }): number {
    const db = getDatabase();
    const rows = db
      .select()
      .from(aiTrainingExamples)
      .where(
        and(
          eq(aiTrainingExamples.workspaceId, input.workspaceId),
          eq(aiTrainingExamples.sourceKind, 'issue_run'),
          eq(aiTrainingExamples.sourceId, input.issueId),
        ),
      )
      .all();
    let changed = 0;
    for (const row of rows) {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = row.metadataJson
          ? (JSON.parse(row.metadataJson) as Record<string, unknown>)
          : {};
      } catch {
        metadata = {};
      }
      db.update(aiTrainingExamples)
        .set({
          status: 'ignored',
          metadataJson: JSON.stringify({
            ...metadata,
            invalidatedBy: 'undo',
            invalidationReason: input.reason,
            invalidatedAt: nowIso(),
          }),
          updatedAt: nowIso(),
        })
        .where(eq(aiTrainingExamples.id, row.id))
        .run();
      changed++;
    }
    return changed;
  }

  createRagEvaluationRun(input: {
    workspaceId: string;
    query: string;
    expectedPageIds: string[];
    resultPageIds: string[];
    metrics: Record<string, unknown>;
    status: RagEvaluationRunRow['status'];
  }): RagEvaluationRunRow {
    const db = getDatabase();
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      query: input.query,
      expectedPageIdsJson: input.expectedPageIds,
      resultPageIdsJson: input.resultPageIds,
      metricsJson: input.metrics,
      status: input.status,
      createdAt: nowIso(),
    };
    db.insert(ragEvaluationRuns).values(row).run();
    return row;
  }

  listRagEvaluationRuns(workspaceId: string, limit = 100): RagEvaluationRunRow[] {
    const db = getDatabase();
    return db
      .select()
      .from(ragEvaluationRuns)
      .where(eq(ragEvaluationRuns.workspaceId, workspaceId))
      .orderBy(desc(ragEvaluationRuns.createdAt))
      .limit(limit)
      .all();
  }

  findRagFeedbackExample(input: {
    workspaceId: string;
    query: string;
    pageId: string;
  }): AiTrainingExampleRow | null {
    const db = getDatabase();
    return (
      db
        .select()
        .from(aiTrainingExamples)
        .where(
          and(
            eq(aiTrainingExamples.workspaceId, input.workspaceId),
            eq(aiTrainingExamples.sourceKind, 'rag_feedback'),
            eq(aiTrainingExamples.sourceId, input.pageId),
            eq(aiTrainingExamples.inputText, input.query),
          ),
        )
        .get() ?? null
    );
  }

  /**
   * Versão em lote de findRagFeedbackExample: 1 query (IN) pra todos os pageIds
   * candidatos da busca, em vez de uma por candidato (N+1). Mapa pageId→exemplo.
   */
  findRagFeedbackExamplesByPageId(input: {
    workspaceId: string;
    query: string;
    pageIds: string[];
  }): Map<string, AiTrainingExampleRow> {
    const out = new Map<string, AiTrainingExampleRow>();
    if (input.pageIds.length === 0) return out;
    const db = getDatabase();
    const rows = db
      .select()
      .from(aiTrainingExamples)
      .where(
        and(
          eq(aiTrainingExamples.workspaceId, input.workspaceId),
          eq(aiTrainingExamples.sourceKind, 'rag_feedback'),
          eq(aiTrainingExamples.inputText, input.query),
          inArray(aiTrainingExamples.sourceId, input.pageIds),
        ),
      )
      .all();
    for (const row of rows) {
      if (row.sourceId && !out.has(row.sourceId)) out.set(row.sourceId, row);
    }
    return out;
  }
}

export const aiLearningRepo = new AiLearningRepository();
