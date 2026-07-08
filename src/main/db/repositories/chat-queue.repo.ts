import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { chatQueue } from '../schema';
import type { ChatAttachment, ChatQueueItem } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Ordenação por prioridade da fila: itens `steer` furam a fila (vão pra frente),
 * preservando a ordem relativa de criação dentro de cada grupo. Recebe itens já
 * ordenados por `createdAt` (FIFO). Pura — testável sem DB. NÃO há checkpoint
 * mid-turn: steer só significa "despachado primeiro quando o turno atual acaba".
 */
export function orderBySteerPriority<T extends { kind: 'queue' | 'steer' }>(items: T[]): T[] {
  return [...items.filter((i) => i.kind === 'steer'), ...items.filter((i) => i.kind === 'queue')];
}

function rowToItem(row: typeof chatQueue.$inferSelect): ChatQueueItem {
  return {
    id: row.id,
    sessionId: row.sessionId,
    content: row.content,
    attachments: (row.attachments as ChatAttachment[] | null) ?? undefined,
    scope: (row.scope as 'all' | string[] | null) ?? undefined,
    kind: row.kind,
    status: row.status,
    origin: row.origin ?? undefined,
    createdAt: row.createdAt,
  };
}

/**
 * Repositório da fila de mensagens persistida no MAIN (`chat_queue`). Substitui
 * a fila que vivia só na memória do renderer — agora a fila sobrevive a reload e
 * é despachada pelo chat-service ao terminar cada run (sem depender da UI montada).
 */
export class ChatQueueRepository {
  enqueue(input: {
    sessionId: string;
    content: string;
    scope?: 'all' | string[];
    attachments?: ChatAttachment[];
    kind?: 'queue' | 'steer';
    origin?: 'renderer' | 'channel' | 'cli';
  }): ChatQueueItem {
    const db = getDatabase();
    const row = {
      id: randomUUID(),
      sessionId: input.sessionId,
      content: input.content,
      attachments: (input.attachments as Array<Record<string, unknown>> | undefined) ?? null,
      scope: input.scope ?? null,
      kind: input.kind ?? ('queue' as const),
      status: 'pending' as const,
      origin: input.origin ?? null,
      createdAt: nowIso(),
    };
    db.insert(chatQueue).values(row).run();
    return rowToItem(row as typeof chatQueue.$inferSelect);
  }

  /** Itens ainda pendentes da sessão (steer primeiro, depois FIFO por criação). */
  listPending(sessionId: string): ChatQueueItem[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(chatQueue)
      .where(and(eq(chatQueue.sessionId, sessionId), eq(chatQueue.status, 'pending')))
      .orderBy(asc(chatQueue.createdAt))
      .all();
    // Steer tem prioridade: vai pra frente preservando a ordem relativa de criação.
    return orderBySteerPriority(rows.map(rowToItem));
  }

  /** Próximo pendente a despachar (steer antes de queue, FIFO). Não remove. */
  nextPending(sessionId: string): ChatQueueItem | null {
    return this.listPending(sessionId)[0] ?? null;
  }

  get(id: string): ChatQueueItem | null {
    const db = getDatabase();
    const row = db.select().from(chatQueue).where(eq(chatQueue.id, id)).get();
    return row ? rowToItem(row) : null;
  }

  /** Marca como despachado (mantém a linha por histórico). */
  markSent(id: string): void {
    const db = getDatabase();
    db.update(chatQueue).set({ status: 'sent' }).where(eq(chatQueue.id, id)).run();
  }

  setKind(id: string, kind: 'queue' | 'steer'): void {
    const db = getDatabase();
    db.update(chatQueue).set({ kind }).where(eq(chatQueue.id, id)).run();
  }

  remove(id: string): void {
    const db = getDatabase();
    db.delete(chatQueue).where(eq(chatQueue.id, id)).run();
  }
}
