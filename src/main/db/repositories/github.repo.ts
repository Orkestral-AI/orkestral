import { desc, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { githubAccounts, type GithubAccountRow } from '../schema';

export interface GithubAccountRecord {
  id: string;
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** Token cifrado (host.secrets). Decifrar antes de usar. */
  tokenEncrypted: Buffer;
  scope: string;
  createdAt: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToRecord(row: GithubAccountRow): GithubAccountRecord {
  return {
    id: row.id,
    login: row.login,
    displayName: row.displayName ?? null,
    avatarUrl: row.avatarUrl ?? null,
    tokenEncrypted: row.tokenEncrypted as Buffer,
    scope: row.scope,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class GithubAccountRepository {
  /** Retorna a conta mais recente quando nenhum login explicito foi pedido. */
  get(login?: string | null): GithubAccountRecord | null {
    const db = getDatabase();
    const row = login
      ? db.select().from(githubAccounts).where(eq(githubAccounts.login, login)).get()
      : db.select().from(githubAccounts).orderBy(desc(githubAccounts.updatedAt)).get();
    return row ? rowToRecord(row) : null;
  }

  list(): GithubAccountRecord[] {
    const db = getDatabase();
    return db
      .select()
      .from(githubAccounts)
      .orderBy(desc(githubAccounts.updatedAt))
      .all()
      .map(rowToRecord);
  }

  upsert(input: {
    login: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    tokenEncrypted: Buffer;
    scope: string;
  }): GithubAccountRecord {
    const db = getDatabase();
    const existing = this.get(input.login);
    const now = nowIso();

    if (!existing) {
      const row = {
        id: input.login,
        login: input.login,
        displayName: input.displayName ?? null,
        avatarUrl: input.avatarUrl ?? null,
        tokenEncrypted: input.tokenEncrypted,
        scope: input.scope,
        createdAt: now,
        updatedAt: now,
      };
      db.insert(githubAccounts).values(row).run();
      return rowToRecord(row as GithubAccountRow);
    }

    const setPayload = {
      login: input.login,
      displayName: input.displayName ?? existing.displayName,
      avatarUrl: input.avatarUrl ?? existing.avatarUrl,
      tokenEncrypted: input.tokenEncrypted,
      scope: input.scope,
      updatedAt: now,
    };
    db.update(githubAccounts).set(setPayload).where(eq(githubAccounts.id, existing.id)).run();
    return { ...existing, ...setPayload };
  }

  delete(login?: string | null): void {
    const db = getDatabase();
    if (login) {
      db.delete(githubAccounts).where(eq(githubAccounts.login, login)).run();
      return;
    }
    db.delete(githubAccounts).run();
  }
}
