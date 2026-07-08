import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { observabilityAccounts, type ObservabilityAccountRow } from '../schema';

export type ObservabilityProvider = 'new_relic' | 'better_stack';

export interface ObservabilityAccountRecord {
  id: string;
  workspaceId: string;
  provider: ObservabilityProvider;
  displayName: string | null;
  config: Record<string, unknown>;
  tokenEncrypted: Buffer;
  createdAt: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToRecord(row: ObservabilityAccountRow): ObservabilityAccountRecord {
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.configJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    config = {};
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    provider: row.provider === 'better_stack' ? 'better_stack' : 'new_relic',
    displayName: row.displayName ?? null,
    config,
    tokenEncrypted: row.tokenEncrypted as Buffer,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ObservabilityAccountRepository {
  get(workspaceId: string, provider: ObservabilityProvider): ObservabilityAccountRecord | null {
    const row = getDatabase()
      .select()
      .from(observabilityAccounts)
      .where(
        and(
          eq(observabilityAccounts.workspaceId, workspaceId),
          eq(observabilityAccounts.provider, provider),
        ),
      )
      .get();
    return row ? rowToRecord(row) : null;
  }

  upsert(input: {
    workspaceId: string;
    provider: ObservabilityProvider;
    displayName?: string | null;
    config: Record<string, unknown>;
    tokenEncrypted: Buffer;
  }): ObservabilityAccountRecord {
    const db = getDatabase();
    const existing = this.get(input.workspaceId, input.provider);
    const now = nowIso();
    if (existing) {
      db.update(observabilityAccounts)
        .set({
          displayName: input.displayName ?? null,
          configJson: JSON.stringify(input.config),
          tokenEncrypted: input.tokenEncrypted,
          updatedAt: now,
        })
        .where(eq(observabilityAccounts.id, existing.id))
        .run();
      return this.get(input.workspaceId, input.provider)!;
    }
    const id = randomUUID();
    db.insert(observabilityAccounts)
      .values({
        id,
        workspaceId: input.workspaceId,
        provider: input.provider,
        displayName: input.displayName ?? null,
        configJson: JSON.stringify(input.config),
        tokenEncrypted: input.tokenEncrypted,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.get(input.workspaceId, input.provider)!;
  }

  delete(workspaceId: string, provider: ObservabilityProvider): void {
    getDatabase()
      .delete(observabilityAccounts)
      .where(
        and(
          eq(observabilityAccounts.workspaceId, workspaceId),
          eq(observabilityAccounts.provider, provider),
        ),
      )
      .run();
  }
}

export const observabilityAccountRepo = new ObservabilityAccountRepository();
