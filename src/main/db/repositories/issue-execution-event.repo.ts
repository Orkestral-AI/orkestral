import { randomUUID } from 'node:crypto';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { getDatabase, getSqlite } from '../connection';
import { issueExecutionEvents } from '../schema';
import type { IssueExecutionEvent } from '../../../shared/types';

const DEFAULT_MAX_EVENTS_PER_ISSUE = 1000;

function rowToEvent(row: typeof issueExecutionEvents.$inferSelect): IssueExecutionEvent | null {
  try {
    const parsed = JSON.parse(row.payloadJson) as IssueExecutionEvent;
    return parsed;
  } catch {
    return null;
  }
}

export class IssueExecutionEventRepository {
  constructor(private readonly maxEventsPerIssue = DEFAULT_MAX_EVENTS_PER_ISSUE) {}

  record(event: IssueExecutionEvent): void {
    if (!event.workspaceId || !event.issueId) return;
    const db = getDatabase();
    db.insert(issueExecutionEvents)
      .values({
        id: randomUUID(),
        workspaceId: event.workspaceId,
        issueId: event.issueId,
        runId: event.runId ?? null,
        type: event.type,
        payloadJson: JSON.stringify(event),
        createdAt: event.createdAt,
      })
      .run();
    this.pruneIssue(event.issueId);
  }

  pruneIssue(issueId: string): void {
    getSqlite()
      .prepare(
        `
          DELETE FROM issue_execution_events
          WHERE issue_id = ?
            AND id NOT IN (
              SELECT id
              FROM issue_execution_events
              WHERE issue_id = ?
              ORDER BY created_at DESC, id DESC
              LIMIT ?
            )
        `,
      )
      .run(issueId, issueId, this.maxEventsPerIssue);
  }

  listByIssue(issueId: string, limit = 200): IssueExecutionEvent[] {
    const db = getDatabase();
    return db
      .select()
      .from(issueExecutionEvents)
      .where(eq(issueExecutionEvents.issueId, issueId))
      .orderBy(desc(issueExecutionEvents.createdAt))
      .limit(limit)
      .all()
      .reverse()
      .map(rowToEvent)
      .filter((event): event is IssueExecutionEvent => !!event);
  }

  listByIssues(issueIds: string[], limitPerIssue = 200): Record<string, IssueExecutionEvent[]> {
    if (issueIds.length === 0) return {};
    const db = getDatabase();
    const rows = db
      .select()
      .from(issueExecutionEvents)
      .where(inArray(issueExecutionEvents.issueId, issueIds))
      .orderBy(asc(issueExecutionEvents.createdAt))
      .all();
    const out: Record<string, IssueExecutionEvent[]> = Object.fromEntries(
      issueIds.map((id) => [id, []]),
    );
    for (const row of rows) {
      const event = rowToEvent(row);
      if (!event) continue;
      const list = out[row.issueId] ?? [];
      if (list.length >= limitPerIssue) list.shift();
      list.push(event);
      out[row.issueId] = list;
    }
    return out;
  }
}
