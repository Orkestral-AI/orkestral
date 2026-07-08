import { randomUUID } from 'node:crypto';
import { desc, eq, isNull } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { sentryAccounts, type SentryAccountRow } from '../schema';

export interface SentryAccountRecord {
  id: string;
  workspaceId: string | null;
  orgSlug: string;
  projectSlug: string | null;
  displayName: string | null;
  /** Token cifrado (host.secrets). Decifrar antes de usar. */
  tokenEncrypted: Buffer;
  createdAt: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToRecord(row: SentryAccountRow): SentryAccountRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? null,
    orgSlug: row.orgSlug,
    projectSlug: row.projectSlug ?? null,
    displayName: row.displayName ?? null,
    tokenEncrypted: row.tokenEncrypted as Buffer,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SentryAccountRepository {
  /**
   * Conta do workspace. Quando um workspaceId é passado, retorna SÓ a linha
   * daquele workspace (ou null) — nunca o token de outro workspace, pra não
   * vazar token entre workspaces. O fallback legado (linha sem workspace ou
   * qualquer conta) só vale no caso explícito sem workspaceId.
   */
  get(workspaceId?: string | null): SentryAccountRecord | null {
    const db = getDatabase();
    if (workspaceId) {
      const scoped = db
        .select()
        .from(sentryAccounts)
        .where(eq(sentryAccounts.workspaceId, workspaceId))
        .orderBy(desc(sentryAccounts.updatedAt))
        .get();
      return scoped ? rowToRecord(scoped) : null;
    }
    const legacy = db
      .select()
      .from(sentryAccounts)
      .where(isNull(sentryAccounts.workspaceId))
      .orderBy(desc(sentryAccounts.updatedAt))
      .get();
    if (legacy) return rowToRecord(legacy);
    const row = db.select().from(sentryAccounts).orderBy(desc(sentryAccounts.updatedAt)).get();
    return row ? rowToRecord(row) : null;
  }

  /** Insere/atualiza por workspace (idempotente). */
  upsert(input: {
    workspaceId: string;
    orgSlug: string;
    projectSlug?: string | null;
    displayName?: string | null;
    tokenEncrypted: Buffer;
  }): SentryAccountRecord {
    const db = getDatabase();
    const existing = db
      .select()
      .from(sentryAccounts)
      .where(eq(sentryAccounts.workspaceId, input.workspaceId))
      .get();
    const now = nowIso();
    if (existing) {
      db.update(sentryAccounts)
        .set({
          projectSlug: input.projectSlug ?? null,
          orgSlug: input.orgSlug,
          displayName: input.displayName ?? null,
          tokenEncrypted: input.tokenEncrypted,
          updatedAt: now,
        })
        .where(eq(sentryAccounts.id, existing.id))
        .run();
      return this.get(input.workspaceId)!;
    }
    const id = randomUUID();
    db.insert(sentryAccounts)
      .values({
        id,
        workspaceId: input.workspaceId,
        orgSlug: input.orgSlug,
        projectSlug: input.projectSlug ?? null,
        displayName: input.displayName ?? null,
        tokenEncrypted: input.tokenEncrypted,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.get(input.workspaceId)!;
  }

  delete(workspaceId?: string | null): void {
    const db = getDatabase();
    if (workspaceId) {
      db.delete(sentryAccounts).where(eq(sentryAccounts.workspaceId, workspaceId)).run();
      return;
    }
    db.delete(sentryAccounts).run();
  }
}

export const sentryAccountRepo = new SentryAccountRepository();
