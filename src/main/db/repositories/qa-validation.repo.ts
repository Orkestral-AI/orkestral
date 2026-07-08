import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import {
  qaValidationChecks,
  qaValidations,
  type QaValidationCheckRow,
  type QaValidationRow,
} from '../schema';
import type {
  QaValidation,
  QaValidationCheck,
  QaValidationCheckStatus,
  QaValidationStatus,
} from '../../../shared/types';

export interface QaCheckPlanInput {
  kind: string;
  title: string;
  description: string;
  commandHint?: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToCheck(row: QaValidationCheckRow): QaValidationCheck {
  return {
    id: row.id,
    validationId: row.validationId,
    ordinal: row.ordinal,
    kind: row.kind,
    title: row.title,
    description: row.description,
    commandHint: row.commandHint ?? null,
    status: row.status as QaValidationCheckStatus,
    evidence: row.evidence ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToValidation(row: QaValidationRow, checks: QaValidationCheck[]): QaValidation {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    issueId: row.issueId,
    executorAgentId: row.executorAgentId ?? null,
    qaAgentId: row.qaAgentId ?? null,
    status: row.status as QaValidationStatus,
    summary: row.summary ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    checks,
  };
}

export class QaValidationRepository {
  create(input: {
    workspaceId: string;
    issueId: string;
    executorAgentId: string | null;
    qaAgentId: string | null;
    checks: QaCheckPlanInput[];
  }): QaValidation {
    const db = getDatabase();
    const id = randomUUID();
    const now = nowIso();
    db.transaction(() => {
      db.insert(qaValidations)
        .values({
          id,
          workspaceId: input.workspaceId,
          issueId: input.issueId,
          executorAgentId: input.executorAgentId,
          qaAgentId: input.qaAgentId,
          status: 'planned',
          summary: null,
          startedAt: null,
          finishedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      input.checks.forEach((check, idx) => {
        db.insert(qaValidationChecks)
          .values({
            id: randomUUID(),
            validationId: id,
            ordinal: idx + 1,
            kind: check.kind,
            title: check.title,
            description: check.description,
            commandHint: check.commandHint ?? null,
            status: 'pending',
            evidence: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      });
    });
    return this.get(id)!;
  }

  get(id: string): QaValidation | null {
    const db = getDatabase();
    const row = db.select().from(qaValidations).where(eq(qaValidations.id, id)).get();
    if (!row) return null;
    return rowToValidation(row, this.listChecks(id));
  }

  latestForIssue(issueId: string): QaValidation | null {
    const db = getDatabase();
    const row = db
      .select()
      .from(qaValidations)
      .where(eq(qaValidations.issueId, issueId))
      .orderBy(desc(qaValidations.createdAt))
      .get();
    return row ? rowToValidation(row, this.listChecks(row.id)) : null;
  }

  listByIssue(issueId: string): QaValidation[] {
    const db = getDatabase();
    return db
      .select()
      .from(qaValidations)
      .where(eq(qaValidations.issueId, issueId))
      .orderBy(desc(qaValidations.createdAt))
      .all()
      .map((row) => rowToValidation(row, this.listChecks(row.id)));
  }

  listChecks(validationId: string): QaValidationCheck[] {
    return getDatabase()
      .select()
      .from(qaValidationChecks)
      .where(eq(qaValidationChecks.validationId, validationId))
      .orderBy(asc(qaValidationChecks.ordinal))
      .all()
      .map(rowToCheck);
  }

  updateCheck(input: {
    validationId: string;
    ordinal: number;
    status: QaValidationCheckStatus;
    evidence?: string | null;
  }): QaValidationCheck {
    const db = getDatabase();
    const check = db
      .select()
      .from(qaValidationChecks)
      .where(
        and(
          eq(qaValidationChecks.validationId, input.validationId),
          eq(qaValidationChecks.ordinal, input.ordinal),
        ),
      )
      .get();
    if (!check) throw new Error(`QA check ${input.ordinal} não encontrado.`);
    db.update(qaValidationChecks)
      .set({
        status: input.status,
        evidence: input.evidence ?? check.evidence ?? null,
        updatedAt: nowIso(),
      })
      .where(eq(qaValidationChecks.id, check.id))
      .run();
    return this.listChecks(input.validationId).find((c) => c.id === check.id)!;
  }

  updateStatus(input: {
    validationId: string;
    status: QaValidationStatus;
    summary?: string | null;
  }): QaValidation {
    const now = nowIso();
    const set: Record<string, unknown> = {
      status: input.status,
      summary: input.summary ?? null,
      updatedAt: now,
    };
    if (input.status === 'running') set.startedAt = now;
    if (input.status === 'passed' || input.status === 'failed' || input.status === 'needs_human') {
      set.finishedAt = now;
    }
    getDatabase()
      .update(qaValidations)
      .set(set)
      .where(eq(qaValidations.id, input.validationId))
      .run();
    return this.get(input.validationId)!;
  }
}

export const qaValidationRepo = new QaValidationRepository();
