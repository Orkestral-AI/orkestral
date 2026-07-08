import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { agentApiKeys } from '../schema';
import type { AgentApiKey } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToKey(row: typeof agentApiKeys.$inferSelect): AgentApiKey {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    tokenPreview: row.tokenPreview,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AgentApiKeyRepository {
  /**
   * Cria uma nova key. Retorna o token EM CLARO uma vez só — caller
   * é responsável por mostrar ao usuário. No DB ficamos só com hash + preview.
   */
  create(input: { agentId: string; workspaceId: string; name: string }): {
    key: AgentApiKey;
    /** Token completo — só disponível uma vez. */
    token: string;
  } {
    const db = getDatabase();
    const id = randomUUID();
    const token = `ork_${randomBytes(24).toString('hex')}`;
    const preview = token.slice(0, 12);
    const tokenHash = hashToken(token);
    const now = nowIso();
    const row = {
      id,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      name: input.name.trim() || 'token',
      tokenHash,
      tokenPreview: preview,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: now,
    };
    db.insert(agentApiKeys).values(row).run();
    return { key: rowToKey(row as typeof agentApiKeys.$inferSelect), token };
  }

  /** Lista keys ativas (não revogadas) de um agente. */
  listByAgent(agentId: string): AgentApiKey[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.agentId, agentId), isNull(agentApiKeys.revokedAt)))
      .all();
    return rows.map(rowToKey);
  }

  /** Revoga uma key (soft delete). */
  revoke(id: string): void {
    const db = getDatabase();
    db.update(agentApiKeys).set({ revokedAt: nowIso() }).where(eq(agentApiKeys.id, id)).run();
  }
}
