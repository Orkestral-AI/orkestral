import { eq } from 'drizzle-orm';
import { secrets } from '../../platform/host';
import { getDatabase } from '../connection';
import { settings } from '../schema';

const CLOUD_ACCOUNT_KEY = 'cloudAccount';

/** Conta do Orkestral Cloud conectada via login no web (deep link). */
export interface CloudAccountRecord {
  userId: string;
  email: string;
  name: string | null;
  /** Tokens Supabase cifrados via host.secrets (base64). Nunca vão pro renderer. */
  accessTokenEnc: string;
  refreshTokenEnc: string;
  savedAt: string;
}

function encrypt(plain: string): string {
  // host.secrets sempre cifra: safeStorage quando disponível, senão fallback
  // aes-256-gcm (VPS sem keychain). Nada mais é guardado em claro.
  return secrets.encrypt(plain).toString('base64');
}

function decrypt(stored: string): string {
  // Compat: versões antigas guardavam em claro com prefixo `plain:` quando o
  // keychain faltava — segue legível. decryptCompat cobre blobs safeStorage
  // legados (sem byte de esquema) e os tagueados novos.
  if (stored.startsWith('plain:')) {
    return Buffer.from(stored.slice('plain:'.length), 'base64').toString('utf8');
  }
  return secrets.decryptCompat(Buffer.from(stored, 'base64'));
}

export class CloudAccountRepository {
  get(): CloudAccountRecord | null {
    const db = getDatabase();
    const row = db.select().from(settings).where(eq(settings.key, CLOUD_ACCOUNT_KEY)).get();
    if (!row) return null;
    return row.value as CloudAccountRecord;
  }

  save(account: {
    userId: string;
    email: string;
    name: string | null;
    accessToken: string;
    refreshToken: string;
  }): CloudAccountRecord {
    const record: CloudAccountRecord = {
      userId: account.userId,
      email: account.email,
      name: account.name,
      accessTokenEnc: encrypt(account.accessToken),
      refreshTokenEnc: encrypt(account.refreshToken),
      savedAt: new Date().toISOString(),
    };
    const db = getDatabase();
    db.insert(settings)
      .values({ key: CLOUD_ACCOUNT_KEY, value: record, updatedAt: record.savedAt })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: record, updatedAt: record.savedAt },
      })
      .run();
    return record;
  }

  /** Tokens decifrados — uso exclusivo do main (sync futuro do plano Team). */
  getTokens(): { accessToken: string; refreshToken: string } | null {
    const record = this.get();
    if (!record) return null;
    try {
      return {
        accessToken: decrypt(record.accessTokenEnc),
        refreshToken: decrypt(record.refreshTokenEnc),
      };
    } catch {
      return null;
    }
  }

  clear(): void {
    const db = getDatabase();
    db.delete(settings).where(eq(settings.key, CLOUD_ACCOUNT_KEY)).run();
  }
}
