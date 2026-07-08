import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { chatSessions } from '../schema';
import type { ChannelType, ChatSession } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToSession(row: typeof chatSessions.$inferSelect): ChatSession {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    title: row.title,
    lastModel: row.lastModel,
    lastDirectory: row.lastDirectory,
    isArchived: !!row.isArchived,
    channelType: row.channelType ?? null,
    cliSessionId: row.cliSessionId ?? null,
    cliSessionFingerprint: row.cliSessionFingerprint ?? null,
    cliLastMessageId: row.cliLastMessageId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ChatSessionRepository {
  create(input: {
    /** Id opcional vindo do cliente (navegação otimista). Omisso = gerado aqui. */
    id?: string;
    workspaceId: string;
    agentId: string;
    title?: string;
    directory?: string;
    model?: string;
    channelType?: ChannelType | null;
  }): ChatSession {
    const db = getDatabase();
    const id = input.id ?? randomUUID();
    const now = nowIso();
    const row = {
      id,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      title: input.title?.trim() || 'Nova conversa',
      lastDirectory: input.directory ?? null,
      lastModel: input.model ?? null,
      channelType: input.channelType ?? null,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(chatSessions).values(row).run();
    return rowToSession(row as typeof chatSessions.$inferSelect);
  }

  get(id: string): ChatSession | null {
    const db = getDatabase();
    const row = db.select().from(chatSessions).where(eq(chatSessions.id, id)).get();
    return row ? rowToSession(row) : null;
  }

  /** Conversas NÃO-arquivadas do workspace (Recentes). */
  listByWorkspace(workspaceId: string): ChatSession[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.workspaceId, workspaceId), eq(chatSessions.isArchived, 0)))
      .orderBy(desc(chatSessions.updatedAt))
      .all();
    return rows.map(rowToSession);
  }

  setArchived(id: string, archived: boolean): void {
    const db = getDatabase();
    db.update(chatSessions)
      .set({ isArchived: archived ? 1 : 0, updatedAt: nowIso() })
      .where(eq(chatSessions.id, id))
      .run();
  }

  /**
   * Persiste (ou limpa, com null) o vínculo com a sessão do CLI (claude --resume).
   * Não toca updatedAt — é metadado de runtime, não atividade da conversa.
   */
  setCliSession(
    id: string,
    link: { cliSessionId: string; cliSessionFingerprint: string; cliLastMessageId: string } | null,
  ): void {
    const db = getDatabase();
    db.update(chatSessions)
      .set(link ?? { cliSessionId: null, cliSessionFingerprint: null, cliLastMessageId: null })
      .where(eq(chatSessions.id, id))
      .run();
  }

  listByAgent(agentId: string): ChatSession[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.agentId, agentId))
      .orderBy(desc(chatSessions.updatedAt))
      .all();
    return rows.map(rowToSession);
  }

  updateTitle(id: string, title: string): void {
    const db = getDatabase();
    db.update(chatSessions)
      .set({ title, updatedAt: nowIso() })
      .where(eq(chatSessions.id, id))
      .run();
  }

  touch(id: string, patch: { model?: string; directory?: string } = {}): void {
    const db = getDatabase();
    db.update(chatSessions)
      .set({
        updatedAt: nowIso(),
        ...(patch.model !== undefined ? { lastModel: patch.model } : {}),
        ...(patch.directory !== undefined ? { lastDirectory: patch.directory } : {}),
      })
      .where(eq(chatSessions.id, id))
      .run();
  }

  delete(id: string): void {
    const db = getDatabase();
    db.delete(chatSessions).where(eq(chatSessions.id, id)).run();
  }
}
