import { eq } from 'drizzle-orm';
import { secrets } from '../../platform/host';
import { getDatabase } from '../connection';
import { toolSecrets } from '../schema';

/** Chaves conhecidas do secret store das Ferramentas. */
export const TOOL_SECRET_KEYS = {
  morphApiKey: 'morph.apiKey',
} as const;

/** Chave do secret store pra API key de um PROVEDOR (adapter). Ex.: claude_local →
 *  'provider.claude_local.apiKey'. Cifrada igual qualquer secret; só o main decifra. */
export function providerApiKeySecretKey(adapterType: string): string {
  return `provider.${adapterType}.apiKey`;
}

/** Chave do secret store pra uma credencial de MCP (skill). Ex.: bundle abc123 +
 *  env FIGMA_API_KEY → 'mcp.abc123.FIGMA_API_KEY'. Cifrada como qualquer secret; o
 *  config da skill guarda só a referência e o main decifra no spawn. */
export function mcpSkillSecretKey(bundleId: string, envKey: string): string {
  return `mcp.${bundleId}.${envKey}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// Loga só a primeira falha de decrypt (ex.: blob legado sem keychain no ambiente)
// pra não spammar — get() roda em hot paths (spawn de MCP, resolve de API key).
let warnedDecryptFailure = false;
function warnDecryptFailureOnce(key: string, err: unknown): void {
  if (warnedDecryptFailure) return;
  warnedDecryptFailure = true;
  console.warn(`[tool-secret] falha ao decifrar o secret "${key}":`, err);
}

/**
 * Secret store das Ferramentas: API keys etc., cifradas via `host.secrets`
 * (safeStorage quando disponível, senão fallback aes-256-gcm — funciona em VPS
 * sem keychain). Os valores em claro NUNCA saem daqui pro renderer — handlers
 * só expõem "configurado: sim/não". Decifra-se só no main, na hora de usar.
 */
export class ToolSecretRepository {
  /** Valor em claro (null se ausente ou indecifrável neste ambiente). Uso só no main. */
  get(key: string): string | null {
    const db = getDatabase();
    const row = db.select().from(toolSecrets).where(eq(toolSecrets.key, key)).get();
    if (!row) return null;
    try {
      return secrets.decryptCompat(row.valueEncrypted as Buffer);
    } catch (err) {
      warnDecryptFailureOnce(key, err);
      return null;
    }
  }

  /** Existe um secret guardado pra essa chave? (sem decifrar). */
  has(key: string): boolean {
    const db = getDatabase();
    return !!db.select().from(toolSecrets).where(eq(toolSecrets.key, key)).get();
  }

  set(key: string, plain: string): void {
    const db = getDatabase();
    const valueEncrypted = secrets.encrypt(plain);
    db.insert(toolSecrets)
      .values({ key, valueEncrypted, updatedAt: nowIso() })
      .onConflictDoUpdate({
        target: toolSecrets.key,
        set: { valueEncrypted, updatedAt: nowIso() },
      })
      .run();
  }

  clear(key: string): void {
    const db = getDatabase();
    db.delete(toolSecrets).where(eq(toolSecrets.key, key)).run();
  }
}

export const toolSecretRepo = new ToolSecretRepository();
