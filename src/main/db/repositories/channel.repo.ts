import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { channelAccounts, channelSessions, chatSessions } from '../schema';
import type {
  ChannelAccount,
  ChannelSessionMeta,
  ChannelStatus,
  ChannelType,
} from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToAccount(row: typeof channelAccounts.$inferSelect): ChannelAccount {
  return {
    id: row.id,
    channelType: row.channelType,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    status: row.status,
    selfId: row.selfId,
    allowlist: row.allowlist ?? [],
    lastConnectedAt: row.lastConnectedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Vínculo interlocutor↔sessão de chat (uso interno do main). */
export interface ChannelSessionLink {
  id: string;
  accountId: string;
  channelUserId: string;
  displayName: string | null;
  phone: string | null;
  photoUrl: string | null;
  chatSessionId: string;
  lastMessageAt: string | null;
}

function rowToLink(row: typeof channelSessions.$inferSelect): ChannelSessionLink {
  return {
    id: row.id,
    accountId: row.accountId,
    channelUserId: row.channelUserId,
    displayName: row.displayName,
    phone: row.phone,
    photoUrl: row.photoUrl,
    chatSessionId: row.chatSessionId,
    lastMessageAt: row.lastMessageAt,
  };
}

export class ChannelRepository {
  // ---- Contas -------------------------------------------------------------

  createAccount(input: {
    channelType: ChannelType;
    workspaceId: string;
    agentId: string;
  }): ChannelAccount {
    const db = getDatabase();
    const now = nowIso();
    const row = {
      id: randomUUID(),
      channelType: input.channelType,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      status: 'disconnected' as ChannelStatus,
      selfId: null,
      allowlist: [] as string[],
      lastConnectedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(channelAccounts).values(row).run();
    return rowToAccount(row as typeof channelAccounts.$inferSelect);
  }

  getAccount(id: string): ChannelAccount | null {
    const db = getDatabase();
    const row = db.select().from(channelAccounts).where(eq(channelAccounts.id, id)).get();
    return row ? rowToAccount(row) : null;
  }

  listAccounts(channelType?: ChannelType): ChannelAccount[] {
    const db = getDatabase();
    const rows = channelType
      ? db
          .select()
          .from(channelAccounts)
          .where(eq(channelAccounts.channelType, channelType))
          .orderBy(desc(channelAccounts.createdAt))
          .all()
      : db.select().from(channelAccounts).orderBy(desc(channelAccounts.createdAt)).all();
    return rows.map(rowToAccount);
  }

  updateAccount(
    id: string,
    patch: Partial<
      Pick<
        ChannelAccount,
        | 'workspaceId'
        | 'agentId'
        | 'status'
        | 'selfId'
        | 'allowlist'
        | 'lastConnectedAt'
        | 'lastError'
      >
    >,
  ): void {
    const db = getDatabase();
    db.update(channelAccounts)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(channelAccounts.id, id))
      .run();
  }

  deleteAccount(id: string): void {
    const db = getDatabase();
    db.delete(channelAccounts).where(eq(channelAccounts.id, id)).run();
  }

  // ---- Sessões (interlocutor ↔ chat) --------------------------------------

  getLinkByUser(accountId: string, channelUserId: string): ChannelSessionLink | null {
    const db = getDatabase();
    const row = db
      .select()
      .from(channelSessions)
      .where(
        and(
          eq(channelSessions.accountId, accountId),
          eq(channelSessions.channelUserId, channelUserId),
        ),
      )
      .get();
    return row ? rowToLink(row) : null;
  }

  createLink(input: {
    accountId: string;
    channelUserId: string;
    displayName?: string | null;
    phone?: string | null;
    chatSessionId: string;
  }): ChannelSessionLink {
    const db = getDatabase();
    const now = nowIso();
    const row = {
      id: randomUUID(),
      accountId: input.accountId,
      channelUserId: input.channelUserId,
      displayName: input.displayName ?? null,
      phone: input.phone ?? null,
      photoUrl: null,
      chatSessionId: input.chatSessionId,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(channelSessions).values(row).run();
    return rowToLink(row as typeof channelSessions.$inferSelect);
  }

  touchLink(id: string): void {
    const db = getDatabase();
    const now = nowIso();
    db.update(channelSessions)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(channelSessions.id, id))
      .run();
  }

  /** Grava a URL da foto de perfil (buscada async após criar o vínculo). */
  setLinkPhoto(id: string, photoUrl: string): void {
    const db = getDatabase();
    db.update(channelSessions)
      .set({ photoUrl, updatedAt: nowIso() })
      .where(eq(channelSessions.id, id))
      .run();
  }

  /** Aponta o vínculo pra uma nova sessão de chat (comando /new — recomeça a conversa). */
  setLinkSession(id: string, chatSessionId: string): void {
    const db = getDatabase();
    db.update(channelSessions)
      .set({ chatSessionId, updatedAt: nowIso() })
      .where(eq(channelSessions.id, id))
      .run();
  }

  countLinks(accountId: string): number {
    const db = getDatabase();
    return db.select().from(channelSessions).where(eq(channelSessions.accountId, accountId)).all()
      .length;
  }

  /** Acha o vínculo a partir da sessão de chat (usado no caminho de saída: o
   *  agente respondeu numa sessão → descobrir pra qual interlocutor mandar). */
  getLinkByChatSession(chatSessionId: string): ChannelSessionLink | null {
    const db = getDatabase();
    const row = db
      .select()
      .from(channelSessions)
      .where(eq(channelSessions.chatSessionId, chatSessionId))
      .get();
    return row ? rowToLink(row) : null;
  }

  /** Proveniência de canal por sessão de chat de um workspace (pra UI badge/header). */
  listSessionMetaByWorkspace(workspaceId: string): ChannelSessionMeta[] {
    const db = getDatabase();
    const rows = db
      .select({
        chatSessionId: channelSessions.chatSessionId,
        channelType: channelAccounts.channelType,
        phone: channelSessions.phone,
        displayName: channelSessions.displayName,
        photoUrl: channelSessions.photoUrl,
      })
      .from(channelSessions)
      .innerJoin(channelAccounts, eq(channelSessions.accountId, channelAccounts.id))
      // Filtra pelo workspace da SESSÃO (não da conta): com a escolha de workspace por
      // conversa, um mesmo bot cria sessões em workspaces diferentes do "home" da conta.
      .innerJoin(chatSessions, eq(channelSessions.chatSessionId, chatSessions.id))
      .where(eq(chatSessions.workspaceId, workspaceId))
      .all();
    const result: ChannelSessionMeta[] = rows.map((r) => ({
      chatSessionId: r.chatSessionId,
      channelType: r.channelType,
      phone: r.phone,
      displayName: r.displayName,
      photoUrl: r.photoUrl,
    }));

    // Sessões históricas de canal: o link (1 por contato) é re-apontado pra a conversa
    // nova em /new, então as antigas saem do join acima. Pega o channelType direto da
    // sessão pra o ícone do canal não sumir nas conversas anteriores (qualquer canal).
    const seen = new Set(result.map((r) => r.chatSessionId));
    const histRows = db
      .select({ chatSessionId: chatSessions.id, channelType: chatSessions.channelType })
      .from(chatSessions)
      .where(and(eq(chatSessions.workspaceId, workspaceId), isNotNull(chatSessions.channelType)))
      .all();
    for (const h of histRows) {
      if (!h.channelType || seen.has(h.chatSessionId)) continue;
      result.push({
        chatSessionId: h.chatSessionId,
        channelType: h.channelType,
        phone: null,
        displayName: null,
        photoUrl: null,
      });
    }
    return result;
  }
}

export const channelRepo = new ChannelRepository();
