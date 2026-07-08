import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { sessionContextSnapshots } from '../schema';

export interface SessionContextSnapshot {
  id: string;
  sessionId: string;
  workspaceId: string;
  summary: string;
  messageCount: number;
  charCount: number;
  tokenEstimate: number;
  lastMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToSnapshot(row: typeof sessionContextSnapshots.$inferSelect): SessionContextSnapshot {
  return {
    id: row.id,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    summary: row.summary,
    messageCount: row.messageCount,
    charCount: row.charCount,
    tokenEstimate: row.tokenEstimate,
    lastMessageId: row.lastMessageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SessionContextRepository {
  getBySession(sessionId: string): SessionContextSnapshot | null {
    const db = getDatabase();
    const row = db
      .select()
      .from(sessionContextSnapshots)
      .where(eq(sessionContextSnapshots.sessionId, sessionId))
      .get();
    return row ? rowToSnapshot(row) : null;
  }

  upsert(input: {
    sessionId: string;
    workspaceId: string;
    summary: string;
    messageCount: number;
    charCount: number;
    tokenEstimate: number;
    lastMessageId: string | null;
  }): SessionContextSnapshot {
    const db = getDatabase();
    const existing = this.getBySession(input.sessionId);
    const now = nowIso();
    const row = {
      id: existing?.id ?? randomUUID(),
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      summary: input.summary,
      messageCount: input.messageCount,
      charCount: input.charCount,
      tokenEstimate: input.tokenEstimate,
      lastMessageId: input.lastMessageId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    db.insert(sessionContextSnapshots)
      .values(row)
      .onConflictDoUpdate({
        target: sessionContextSnapshots.sessionId,
        set: {
          workspaceId: row.workspaceId,
          summary: row.summary,
          messageCount: row.messageCount,
          charCount: row.charCount,
          tokenEstimate: row.tokenEstimate,
          lastMessageId: row.lastMessageId,
          updatedAt: row.updatedAt,
        },
      })
      .run();
    return rowToSnapshot(row as typeof sessionContextSnapshots.$inferSelect);
  }

  /**
   * Apaga o snapshot de compactação da sessão numa única query (`DELETE ...
   * WHERE session_id = ?` — no máximo 1 linha, a coluna é única). Usado pelo
   * `/clear` da CLI: sem isso, o resumo compactado das mensagens apagadas
   * voltaria pro contexto do próximo run como se a conversa não tivesse sido
   * limpa.
   */
  deleteBySession(sessionId: string): void {
    const db = getDatabase();
    db.delete(sessionContextSnapshots)
      .where(eq(sessionContextSnapshots.sessionId, sessionId))
      .run();
  }
}
