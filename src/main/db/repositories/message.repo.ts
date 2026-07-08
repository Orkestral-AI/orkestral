import { randomUUID } from 'node:crypto';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { messages } from '../schema';
import type { ChatMessage, ChatRole, MessagePart, MessageStatus } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToMessage(row: typeof messages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as ChatRole,
    parts: (row.parts ?? []) as MessagePart[],
    status: row.status as MessageStatus,
    runId: row.runId,
    createdAt: row.createdAt,
  };
}

export class MessageRepository {
  insert(input: {
    sessionId: string;
    role: ChatRole;
    parts: MessagePart[];
    status?: MessageStatus;
    runId?: string | null;
  }): ChatMessage {
    const db = getDatabase();
    const row = {
      id: randomUUID(),
      sessionId: input.sessionId,
      role: input.role,
      parts: input.parts,
      status: input.status ?? 'done',
      runId: input.runId ?? null,
      createdAt: nowIso(),
    };
    db.insert(messages).values(row).run();
    return rowToMessage(row as typeof messages.$inferSelect);
  }

  listBySession(sessionId: string): ChatMessage[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt))
      .all();
    return rows.map(rowToMessage);
  }

  /** Última mensagem da sessão (ORDER BY createdAt DESC LIMIT 1) — preview do /resume. */
  lastBySession(sessionId: string): ChatMessage | null {
    const db = getDatabase();
    const row = db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt))
      .limit(1)
      .get();
    return row ? rowToMessage(row) : null;
  }

  /** COUNT(*) da sessão direto no banco — nada de carregar a coleção pra contar. */
  countBySession(sessionId: string): number {
    const db = getDatabase();
    const row = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .get();
    return row?.count ?? 0;
  }

  updateParts(id: string, parts: MessagePart[]): void {
    const db = getDatabase();
    db.update(messages).set({ parts }).where(eq(messages.id, id)).run();
  }

  updateStatus(id: string, status: MessageStatus): void {
    const db = getDatabase();
    db.update(messages).set({ status }).where(eq(messages.id, id)).run();
  }

  /** Atualiza parts + status atomicamente (usado no finish do streaming). */
  finalize(id: string, parts: MessagePart[], status: MessageStatus): void {
    const db = getDatabase();
    db.update(messages).set({ parts, status }).where(eq(messages.id, id)).run();
  }

  /** Remove uma mensagem (ex.: turno sintético que finalizou SEM conteúdo visível,
   *  pra não persistir uma bolha vazia no chat). */
  delete(id: string): void {
    const db = getDatabase();
    db.delete(messages).where(eq(messages.id, id)).run();
  }

  /**
   * Apaga TODAS as mensagens de uma sessão numa única query (`DELETE ... WHERE
   * session_id = ?`). Usado pelo `/clear` da CLI pra esvaziar a conversa atual
   * mantendo o mesmo id de sessão. Uma query só — não carrega coleção pra contar
   * nem deleta uma a uma (respeita a regra de custo/perf de query).
   */
  deleteBySession(sessionId: string): void {
    const db = getDatabase();
    db.delete(messages).where(eq(messages.sessionId, sessionId)).run();
  }

  /**
   * Marca como "cancelled" todas as mensagens que ficaram em `status='streaming'`
   * sem nenhum processo ativo (ex: app foi fechado no meio de uma run, ou run
   * crashou sem chamar message-end). Chamado no boot pra desbloquear inputs
   * presos.
   */
  cleanupStreamingOrphans(): number {
    return this.cleanupStreamingOrphansDetailed().length;
  }

  cleanupStreamingOrphansDetailed(): ChatMessage[] {
    const db = getDatabase();
    const rows = db.select().from(messages).where(eq(messages.status, 'streaming')).all();
    for (const row of rows) {
      const currentParts = (row.parts ?? []) as MessagePart[];
      const alreadyMarked = currentParts.some(
        (part) => part.type === 'text' && part.text.includes('interrompida ao fechar o app'),
      );
      // Nota CALMA e CURTA (não bloco de erro vermelho): reabrir o app no meio de um
      // run é normal e o estado fica preservado — um item italicizado discreto, sem
      // parecer crash nem encher o chat.
      const parts = alreadyMarked
        ? currentParts
        : [
            ...currentParts,
            {
              type: 'text' as const,
              text: `\n\n_Resposta interrompida ao fechar o app — o estado foi preservado._`,
            },
          ];
      db.update(messages).set({ parts, status: 'cancelled' }).where(eq(messages.id, row.id)).run();
    }
    return rows.map(rowToMessage);
  }
}
