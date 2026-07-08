import { eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { users } from '../schema';
import type { UserProfile } from '../../../shared/types';

const SINGLE_USER_ID = 'local';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToProfile(row: typeof users.$inferSelect): UserProfile {
  return {
    id: row.id,
    name: row.name,
    aliases: row.aliases ?? [],
    email: row.email,
    timezone: row.timezone,
    useDeviceTimezone: row.useDeviceTimezone,
    language: row.language,
    aiStyle: row.aiStyle,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class UserRepository {
  get(): UserProfile | null {
    const db = getDatabase();
    const row = db.select().from(users).get();
    return row ? rowToProfile(row) : null;
  }

  upsert(patch: Partial<UserProfile>): UserProfile {
    const db = getDatabase();
    const existing = db.select().from(users).get();
    const now = nowIso();

    if (!existing) {
      const created = {
        id: patch.id ?? SINGLE_USER_ID,
        name: patch.name ?? 'Usuário',
        aliases: patch.aliases ?? [],
        email: patch.email ?? null,
        timezone: patch.timezone ?? 'America/Sao_Paulo',
        useDeviceTimezone: patch.useDeviceTimezone ?? true,
        language: patch.language ?? ('pt-BR' as const),
        aiStyle: patch.aiStyle ?? ('concise' as const),
        createdAt: now,
        updatedAt: now,
      };
      db.insert(users).values(created).run();
      return rowToProfile(created);
    }

    const setPayload = {
      name: patch.name ?? existing.name,
      aliases: patch.aliases ?? existing.aliases ?? [],
      email: patch.email ?? existing.email,
      timezone: patch.timezone ?? existing.timezone,
      useDeviceTimezone: patch.useDeviceTimezone ?? existing.useDeviceTimezone,
      language: patch.language ?? existing.language,
      aiStyle: patch.aiStyle ?? existing.aiStyle,
      updatedAt: now,
    };
    db.update(users).set(setPayload).where(eq(users.id, existing.id)).run();

    return rowToProfile({ ...existing, ...setPayload });
  }
}

export { SINGLE_USER_ID };
