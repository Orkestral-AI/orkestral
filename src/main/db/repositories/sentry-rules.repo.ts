import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { sentryRules, sentryRuleRuns, type SentryRuleRow, type SentryRuleRunRow } from '../schema';

export type SentryRuleMode = 'propose' | 'auto';
export type SentryRunAction = 'proposed' | 'analyzed';
export type SentryRunStatus = 'ok' | 'error';

export interface SentryRuleRecord {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  minLevel: string;
  projectSlug: string | null;
  agentId: string | null;
  mode: SentryRuleMode;
  seenIssueIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SentryRuleRunRecord {
  id: string;
  ruleId: string;
  workspaceId: string;
  issueId: string;
  shortId: string | null;
  title: string | null;
  level: string | null;
  project: string | null;
  action: SentryRunAction;
  status: SentryRunStatus;
  detail: string | null;
  createdAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function ruleToRecord(row: SentryRuleRow): SentryRuleRecord {
  let seen: string[] = [];
  try {
    const parsed = JSON.parse(row.seenIssueIds) as unknown;
    if (Array.isArray(parsed)) seen = parsed.map(String);
  } catch {
    seen = [];
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    enabled: row.enabled,
    minLevel: row.minLevel,
    projectSlug: row.projectSlug ?? null,
    agentId: row.agentId ?? null,
    mode: row.mode === 'auto' ? 'auto' : 'propose',
    seenIssueIds: seen,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function runToRecord(row: SentryRuleRunRow): SentryRuleRunRecord {
  return {
    id: row.id,
    ruleId: row.ruleId,
    workspaceId: row.workspaceId,
    issueId: row.issueId,
    shortId: row.shortId ?? null,
    title: row.title ?? null,
    level: row.level ?? null,
    project: row.project ?? null,
    action: row.action === 'analyzed' ? 'analyzed' : 'proposed',
    status: row.status === 'error' ? 'error' : 'ok',
    detail: row.detail ?? null,
    createdAt: row.createdAt,
  };
}

export class SentryRuleRepository {
  listByWorkspace(workspaceId: string): SentryRuleRecord[] {
    return getDatabase()
      .select()
      .from(sentryRules)
      .where(eq(sentryRules.workspaceId, workspaceId))
      .orderBy(desc(sentryRules.createdAt))
      .all()
      .map(ruleToRecord);
  }

  get(id: string): SentryRuleRecord | null {
    const row = getDatabase().select().from(sentryRules).where(eq(sentryRules.id, id)).get();
    return row ? ruleToRecord(row) : null;
  }

  /** Regras ligadas (de todos os workspaces) — pra o watcher varrer. */
  listEnabled(): SentryRuleRecord[] {
    return getDatabase()
      .select()
      .from(sentryRules)
      .where(eq(sentryRules.enabled, true))
      .all()
      .map(ruleToRecord);
  }

  create(input: {
    workspaceId: string;
    name: string;
    enabled: boolean;
    minLevel: string;
    projectSlug: string | null;
    agentId: string | null;
    mode: SentryRuleMode;
    seenIssueIds?: string[];
  }): SentryRuleRecord {
    const id = randomUUID();
    const now = nowIso();
    getDatabase()
      .insert(sentryRules)
      .values({
        id,
        workspaceId: input.workspaceId,
        name: input.name,
        enabled: input.enabled,
        minLevel: input.minLevel,
        projectSlug: input.projectSlug,
        agentId: input.agentId,
        mode: input.mode,
        seenIssueIds: JSON.stringify((input.seenIssueIds ?? []).slice(-500)),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.get(id)!;
  }

  update(
    id: string,
    patch: Partial<{
      name: string;
      enabled: boolean;
      minLevel: string;
      projectSlug: string | null;
      agentId: string | null;
      mode: SentryRuleMode;
      seenIssueIds: string[];
    }>,
  ): SentryRuleRecord | null {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.minLevel !== undefined) set.minLevel = patch.minLevel;
    if (patch.projectSlug !== undefined) set.projectSlug = patch.projectSlug;
    if (patch.agentId !== undefined) set.agentId = patch.agentId;
    if (patch.mode !== undefined) set.mode = patch.mode;
    if (patch.seenIssueIds !== undefined)
      set.seenIssueIds = JSON.stringify(patch.seenIssueIds.slice(-500));
    getDatabase().update(sentryRules).set(set).where(eq(sentryRules.id, id)).run();
    return this.get(id);
  }

  delete(id: string): void {
    getDatabase().delete(sentryRules).where(eq(sentryRules.id, id)).run();
  }

  setSeen(id: string, seenIssueIds: string[]): void {
    getDatabase()
      .update(sentryRules)
      .set({ seenIssueIds: JSON.stringify(seenIssueIds.slice(-500)), updatedAt: nowIso() })
      .where(eq(sentryRules.id, id))
      .run();
  }
}

export class SentryRuleRunRepository {
  log(input: {
    ruleId: string;
    workspaceId: string;
    issueId: string;
    shortId?: string | null;
    title?: string | null;
    level?: string | null;
    project?: string | null;
    action: SentryRunAction;
    status: SentryRunStatus;
    detail?: string | null;
  }): void {
    getDatabase()
      .insert(sentryRuleRuns)
      .values({
        id: randomUUID(),
        ruleId: input.ruleId,
        workspaceId: input.workspaceId,
        issueId: input.issueId,
        shortId: input.shortId ?? null,
        title: input.title ?? null,
        level: input.level ?? null,
        project: input.project ?? null,
        action: input.action,
        status: input.status,
        detail: input.detail ?? null,
        createdAt: nowIso(),
      })
      .run();
  }

  listByWorkspace(workspaceId: string, limit = 50): SentryRuleRunRecord[] {
    return getDatabase()
      .select()
      .from(sentryRuleRuns)
      .where(eq(sentryRuleRuns.workspaceId, workspaceId))
      .orderBy(desc(sentryRuleRuns.createdAt))
      .limit(limit)
      .all()
      .map(runToRecord);
  }
}

export const sentryRuleRepo = new SentryRuleRepository();
export const sentryRuleRunRepo = new SentryRuleRunRepository();
