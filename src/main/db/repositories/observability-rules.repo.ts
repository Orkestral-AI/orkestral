import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import {
  observabilityRuleRuns,
  observabilityRules,
  type ObservabilityRuleRow,
  type ObservabilityRuleRunRow,
} from '../schema';
import type { ObservabilityProvider } from './observability.repo';

export type ObservabilityRuleMode = 'propose' | 'auto';
export type ObservabilityRuleKind = 'all' | 'error' | 'incident' | 'log';
export type ObservabilityRunAction = 'proposed' | 'analyzed';
export type ObservabilityRunStatus = 'ok' | 'error';

export interface ObservabilityRuleRecord {
  id: string;
  workspaceId: string;
  provider: ObservabilityProvider;
  name: string;
  enabled: boolean;
  kind: ObservabilityRuleKind;
  severity: string | null;
  serviceQuery: string | null;
  agentId: string | null;
  mode: ObservabilityRuleMode;
  refreshIntervalMin: number;
  seenSignalIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ObservabilityRuleRunRecord {
  id: string;
  ruleId: string;
  workspaceId: string;
  provider: ObservabilityProvider;
  signalId: string;
  title: string | null;
  kind: string | null;
  service: string | null;
  severity: string | null;
  action: ObservabilityRunAction;
  status: ObservabilityRunStatus;
  detail: string | null;
  createdAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function providerFromDb(value: string): ObservabilityProvider {
  return value === 'better_stack' ? 'better_stack' : 'new_relic';
}

function kindFromDb(value: string): ObservabilityRuleKind {
  return value === 'error' || value === 'incident' || value === 'log' ? value : 'all';
}

function parseSeen(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function ruleToRecord(row: ObservabilityRuleRow): ObservabilityRuleRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    provider: providerFromDb(row.provider),
    name: row.name,
    enabled: row.enabled,
    kind: kindFromDb(row.kind),
    severity: row.severity ?? null,
    serviceQuery: row.serviceQuery ?? null,
    agentId: row.agentId ?? null,
    mode: row.mode === 'auto' ? 'auto' : 'propose',
    refreshIntervalMin: row.refreshIntervalMin,
    seenSignalIds: parseSeen(row.seenSignalIds),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function runToRecord(row: ObservabilityRuleRunRow): ObservabilityRuleRunRecord {
  return {
    id: row.id,
    ruleId: row.ruleId,
    workspaceId: row.workspaceId,
    provider: providerFromDb(row.provider),
    signalId: row.signalId,
    title: row.title ?? null,
    kind: row.kind ?? null,
    service: row.service ?? null,
    severity: row.severity ?? null,
    action: row.action === 'analyzed' ? 'analyzed' : 'proposed',
    status: row.status === 'error' ? 'error' : 'ok',
    detail: row.detail ?? null,
    createdAt: row.createdAt,
  };
}

export class ObservabilityRuleRepository {
  listByWorkspace(workspaceId: string, provider: ObservabilityProvider): ObservabilityRuleRecord[] {
    return getDatabase()
      .select()
      .from(observabilityRules)
      .where(
        and(
          eq(observabilityRules.workspaceId, workspaceId),
          eq(observabilityRules.provider, provider),
        ),
      )
      .orderBy(desc(observabilityRules.createdAt))
      .all()
      .map(ruleToRecord);
  }

  get(id: string): ObservabilityRuleRecord | null {
    const row = getDatabase()
      .select()
      .from(observabilityRules)
      .where(eq(observabilityRules.id, id))
      .get();
    return row ? ruleToRecord(row) : null;
  }

  listEnabled(): ObservabilityRuleRecord[] {
    return getDatabase()
      .select()
      .from(observabilityRules)
      .where(eq(observabilityRules.enabled, true))
      .all()
      .map(ruleToRecord);
  }

  create(input: {
    workspaceId: string;
    provider: ObservabilityProvider;
    name: string;
    enabled: boolean;
    kind: ObservabilityRuleKind;
    severity: string | null;
    serviceQuery: string | null;
    agentId: string | null;
    mode: ObservabilityRuleMode;
    refreshIntervalMin: number;
    seenSignalIds?: string[];
  }): ObservabilityRuleRecord {
    const id = randomUUID();
    const now = nowIso();
    getDatabase()
      .insert(observabilityRules)
      .values({
        id,
        workspaceId: input.workspaceId,
        provider: input.provider,
        name: input.name,
        enabled: input.enabled,
        kind: input.kind,
        severity: input.severity,
        serviceQuery: input.serviceQuery,
        agentId: input.agentId,
        mode: input.mode,
        refreshIntervalMin: input.refreshIntervalMin,
        seenSignalIds: JSON.stringify((input.seenSignalIds ?? []).slice(-500)),
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
      kind: ObservabilityRuleKind;
      severity: string | null;
      serviceQuery: string | null;
      agentId: string | null;
      mode: ObservabilityRuleMode;
      refreshIntervalMin: number;
      seenSignalIds: string[];
    }>,
  ): ObservabilityRuleRecord | null {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.kind !== undefined) set.kind = patch.kind;
    if (patch.severity !== undefined) set.severity = patch.severity;
    if (patch.serviceQuery !== undefined) set.serviceQuery = patch.serviceQuery;
    if (patch.agentId !== undefined) set.agentId = patch.agentId;
    if (patch.mode !== undefined) set.mode = patch.mode;
    if (patch.refreshIntervalMin !== undefined) set.refreshIntervalMin = patch.refreshIntervalMin;
    if (patch.seenSignalIds !== undefined) {
      set.seenSignalIds = JSON.stringify(patch.seenSignalIds.slice(-500));
    }
    getDatabase().update(observabilityRules).set(set).where(eq(observabilityRules.id, id)).run();
    return this.get(id);
  }

  delete(id: string): void {
    getDatabase().delete(observabilityRules).where(eq(observabilityRules.id, id)).run();
  }

  setSeen(id: string, seenSignalIds: string[]): void {
    getDatabase()
      .update(observabilityRules)
      .set({ seenSignalIds: JSON.stringify(seenSignalIds.slice(-500)), updatedAt: nowIso() })
      .where(eq(observabilityRules.id, id))
      .run();
  }
}

export class ObservabilityRuleRunRepository {
  log(input: {
    ruleId: string;
    workspaceId: string;
    provider: ObservabilityProvider;
    signalId: string;
    title?: string | null;
    kind?: string | null;
    service?: string | null;
    severity?: string | null;
    action: ObservabilityRunAction;
    status: ObservabilityRunStatus;
    detail?: string | null;
  }): void {
    getDatabase()
      .insert(observabilityRuleRuns)
      .values({
        id: randomUUID(),
        ruleId: input.ruleId,
        workspaceId: input.workspaceId,
        provider: input.provider,
        signalId: input.signalId,
        title: input.title ?? null,
        kind: input.kind ?? null,
        service: input.service ?? null,
        severity: input.severity ?? null,
        action: input.action,
        status: input.status,
        detail: input.detail ?? null,
        createdAt: nowIso(),
      })
      .run();
  }

  listByWorkspace(
    workspaceId: string,
    provider: ObservabilityProvider,
    limit = 50,
  ): ObservabilityRuleRunRecord[] {
    return getDatabase()
      .select()
      .from(observabilityRuleRuns)
      .where(
        and(
          eq(observabilityRuleRuns.workspaceId, workspaceId),
          eq(observabilityRuleRuns.provider, provider),
        ),
      )
      .orderBy(desc(observabilityRuleRuns.createdAt))
      .limit(limit)
      .all()
      .map(runToRecord);
  }
}

export const observabilityRuleRepo = new ObservabilityRuleRepository();
export const observabilityRuleRunRepo = new ObservabilityRuleRunRepository();
