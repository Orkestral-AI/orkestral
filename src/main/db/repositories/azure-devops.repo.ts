import { eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { azureDevopsAccounts, type AzureDevopsAccountRow } from '../schema';

function nowIso(): string {
  return new Date().toISOString();
}

export class AzureDevopsAccountRepository {
  get(): AzureDevopsAccountRow | null {
    const db = getDatabase();
    return (
      db.select().from(azureDevopsAccounts).where(eq(azureDevopsAccounts.id, 'singleton')).get() ??
      null
    );
  }

  upsert(input: {
    displayName?: string | null;
    email?: string | null;
    tenantId?: string | null;
    accessTokenEncrypted: Buffer;
    refreshTokenEncrypted?: Buffer | null;
    scope: string;
    expiresAt: string;
    organizations?: string[];
  }): AzureDevopsAccountRow {
    const db = getDatabase();
    const existing = this.get();
    const now = nowIso();
    const row = {
      id: 'singleton',
      displayName: input.displayName ?? existing?.displayName ?? null,
      email: input.email ?? existing?.email ?? null,
      tenantId: input.tenantId ?? existing?.tenantId ?? null,
      accessTokenEncrypted: input.accessTokenEncrypted,
      refreshTokenEncrypted: input.refreshTokenEncrypted ?? existing?.refreshTokenEncrypted ?? null,
      scope: input.scope,
      expiresAt: input.expiresAt,
      organizations: input.organizations ?? existing?.organizations ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    db.insert(azureDevopsAccounts)
      .values(row)
      .onConflictDoUpdate({
        target: azureDevopsAccounts.id,
        set: {
          displayName: row.displayName,
          email: row.email,
          tenantId: row.tenantId,
          accessTokenEncrypted: row.accessTokenEncrypted,
          refreshTokenEncrypted: row.refreshTokenEncrypted,
          scope: row.scope,
          expiresAt: row.expiresAt,
          organizations: row.organizations,
          updatedAt: row.updatedAt,
        },
      })
      .run();
    return this.get()!;
  }

  updateOrganizations(organizations: string[]): void {
    const db = getDatabase();
    db.update(azureDevopsAccounts)
      .set({ organizations, updatedAt: nowIso() })
      .where(eq(azureDevopsAccounts.id, 'singleton'))
      .run();
  }

  delete(): void {
    const db = getDatabase();
    db.delete(azureDevopsAccounts).where(eq(azureDevopsAccounts.id, 'singleton')).run();
  }
}

export const azureDevopsAccountRepo = new AzureDevopsAccountRepository();
