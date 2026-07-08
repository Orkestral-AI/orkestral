import { eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { sentryAutomations, type SentryAutomationRow } from '../schema';

export type SentryAutomationMode = 'propose' | 'auto';

export interface SentryAutomationRecord {
  workspaceId: string;
  enabled: boolean;
  /** Severidade mínima: fatal | error | warning | info. */
  minLevel: string;
  /** Slug do projeto (null = todos). */
  projectSlug: string | null;
  /** Agente que analisa (null = CEO/orquestrador). */
  agentId: string | null;
  mode: SentryAutomationMode;
  /** Auto-refresh (min) pra observabilidade. 0 = desligado. */
  refreshIntervalMin: number;
  seenIssueIds: string[];
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToRecord(row: SentryAutomationRow): SentryAutomationRecord {
  let seen: string[] = [];
  try {
    const parsed = JSON.parse(row.seenIssueIds) as unknown;
    if (Array.isArray(parsed)) seen = parsed.map(String);
  } catch {
    seen = [];
  }
  return {
    workspaceId: row.workspaceId,
    enabled: row.enabled,
    minLevel: row.minLevel,
    projectSlug: row.projectSlug ?? null,
    agentId: row.agentId ?? null,
    mode: row.mode === 'auto' ? 'auto' : 'propose',
    refreshIntervalMin: row.refreshIntervalMin ?? 5,
    seenIssueIds: seen,
    updatedAt: row.updatedAt,
  };
}

export class SentryAutomationRepository {
  get(workspaceId: string): SentryAutomationRecord | null {
    const db = getDatabase();
    const row = db
      .select()
      .from(sentryAutomations)
      .where(eq(sentryAutomations.workspaceId, workspaceId))
      .get();
    return row ? rowToRecord(row) : null;
  }

  /** Linhas com automação ligada (pra o watcher varrer). */
  listEnabled(): SentryAutomationRecord[] {
    const db = getDatabase();
    return db
      .select()
      .from(sentryAutomations)
      .where(eq(sentryAutomations.enabled, true))
      .all()
      .map(rowToRecord);
  }

  upsert(input: {
    workspaceId: string;
    enabled: boolean;
    minLevel: string;
    projectSlug: string | null;
    agentId: string | null;
    mode: SentryAutomationMode;
    refreshIntervalMin: number;
    seenIssueIds?: string[];
  }): SentryAutomationRecord {
    const db = getDatabase();
    const now = nowIso();
    const existing = db
      .select()
      .from(sentryAutomations)
      .where(eq(sentryAutomations.workspaceId, input.workspaceId))
      .get();
    // Mantém o histórico de vistos se quem chama não mandar um novo (UI não manda).
    const seen = input.seenIssueIds ?? (existing ? rowToRecord(existing).seenIssueIds : []);
    const values = {
      workspaceId: input.workspaceId,
      enabled: input.enabled,
      minLevel: input.minLevel,
      projectSlug: input.projectSlug,
      agentId: input.agentId,
      mode: input.mode,
      refreshIntervalMin: input.refreshIntervalMin,
      seenIssueIds: JSON.stringify(seen.slice(-500)),
      updatedAt: now,
    };
    if (existing) {
      db.update(sentryAutomations)
        .set(values)
        .where(eq(sentryAutomations.workspaceId, input.workspaceId))
        .run();
    } else {
      db.insert(sentryAutomations)
        .values({ ...values, createdAt: now })
        .run();
    }
    return this.get(input.workspaceId)!;
  }

  /** Atualiza só o conjunto de ids já vistos (chamado pelo watcher). */
  setSeen(workspaceId: string, seenIssueIds: string[]): void {
    getDatabase()
      .update(sentryAutomations)
      .set({ seenIssueIds: JSON.stringify(seenIssueIds.slice(-500)), updatedAt: nowIso() })
      .where(eq(sentryAutomations.workspaceId, workspaceId))
      .run();
  }
}

export const sentryAutomationRepo = new SentryAutomationRepository();
