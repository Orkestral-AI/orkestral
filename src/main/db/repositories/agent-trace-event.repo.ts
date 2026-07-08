import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { agentTraceEvents } from '../schema';
import type {
  AgentTraceEvent,
  AgentTraceEventKind,
  AgentTraceEventStatus,
} from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function parsePayload(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* payload corrompido nao deve quebrar a timeline */
  }
  return null;
}

function stringifyPayload(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null;
  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify({ note: 'Payload omitted because it was not JSON-serializable.' });
  }
}

function rowToEvent(row: typeof agentTraceEvents.$inferSelect): AgentTraceEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    runId: row.runId,
    issueId: row.issueId,
    issueKey: row.issueKey,
    agentId: row.agentId,
    agentName: row.agentName,
    parentId: row.parentId,
    kind: row.kind as AgentTraceEventKind,
    status: row.status as AgentTraceEventStatus,
    title: row.title,
    summary: row.summary,
    payload: parsePayload(row.payloadJson),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationMs: row.durationMs,
  };
}

export interface CreateAgentTraceEventInput {
  workspaceId: string;
  runId?: string | null;
  issueId?: string | null;
  issueKey?: string | number | null;
  agentId?: string | null;
  agentName?: string | null;
  parentId?: string | null;
  kind: AgentTraceEventKind;
  status?: AgentTraceEventStatus;
  title: string;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
}

export class AgentTraceEventRepository {
  create(input: CreateAgentTraceEventInput): AgentTraceEvent {
    const now = nowIso();
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      issueId: input.issueId ?? null,
      issueKey: input.issueKey != null ? String(input.issueKey) : null,
      agentId: input.agentId ?? null,
      agentName: input.agentName ?? null,
      parentId: input.parentId ?? null,
      kind: input.kind,
      status: input.status ?? 'started',
      title: input.title,
      summary: input.summary ?? null,
      payloadJson: stringifyPayload(input.payload),
      startedAt: now,
      completedAt: input.status === 'completed' || input.status === 'failed' ? now : null,
      durationMs: null,
    };
    getDatabase().insert(agentTraceEvents).values(row).run();
    return rowToEvent(row);
  }

  complete(
    id: string,
    patch: {
      status?: AgentTraceEventStatus;
      summary?: string | null;
      payload?: Record<string, unknown> | null;
      durationMs?: number | null;
    } = {},
  ): AgentTraceEvent | null {
    const db = getDatabase();
    const existing = db.select().from(agentTraceEvents).where(eq(agentTraceEvents.id, id)).get();
    if (!existing) return null;
    const completedAt = nowIso();
    // Caller pode fornecer durationMs (ex.: step one-shot que ja sabe quanto durou);
    // senao recomputa a partir do startedAt persistido.
    const durationMs =
      patch.durationMs != null
        ? Math.max(0, patch.durationMs)
        : Math.max(0, new Date(completedAt).getTime() - new Date(existing.startedAt).getTime());
    db.update(agentTraceEvents)
      .set({
        status: patch.status ?? 'completed',
        summary: patch.summary !== undefined ? patch.summary : existing.summary,
        payloadJson:
          patch.payload !== undefined ? stringifyPayload(patch.payload) : existing.payloadJson,
        completedAt,
        durationMs,
      })
      .where(eq(agentTraceEvents.id, id))
      .run();
    return this.get(id);
  }

  get(id: string): AgentTraceEvent | null {
    const row = getDatabase()
      .select()
      .from(agentTraceEvents)
      .where(eq(agentTraceEvents.id, id))
      .get();
    return row ? rowToEvent(row) : null;
  }

  list(input: {
    workspaceId: string;
    issueId?: string;
    runId?: string;
    limit?: number;
  }): AgentTraceEvent[] {
    const predicates = [eq(agentTraceEvents.workspaceId, input.workspaceId)];
    if (input.issueId) predicates.push(eq(agentTraceEvents.issueId, input.issueId));
    if (input.runId) predicates.push(eq(agentTraceEvents.runId, input.runId));
    return getDatabase()
      .select()
      .from(agentTraceEvents)
      .where(and(...predicates))
      .orderBy(asc(agentTraceEvents.startedAt))
      .limit(Math.min(Math.max(input.limit ?? 200, 1), 1000))
      .all()
      .map(rowToEvent);
  }

  deleteOlderThan(workspaceId: string, cutoffIso: string): number {
    const res = getDatabase()
      .delete(agentTraceEvents)
      .where(
        and(
          eq(agentTraceEvents.workspaceId, workspaceId),
          sql`${agentTraceEvents.startedAt} < ${cutoffIso}`,
        ),
      )
      .run();
    return Number(res.changes ?? 0);
  }
}

export const agentTraceEventRepo = new AgentTraceEventRepository();
