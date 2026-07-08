import { ChatSessionRepository } from '../db/repositories/session.repo';
import { AgentRepository } from '../db/repositories/agent.repo';
import { MessageRepository } from '../db/repositories/message.repo';
import { SessionContextRepository } from '../db/repositories/session-context.repo';
import {
  maybeCompactSessionContext,
  type SessionCompactionResult,
} from '../services/session-context-compaction';
import type { Agent, ChatMessage, ChatSession } from '../../shared/types';

/**
 * Cria uma conversa nova no workspace/agente informados. Espelha o padrão de
 * `ipc/handlers/chat.ts` (instância direta do repositório; tudo síncrono via
 * better-sqlite3). O id é gerado pelo próprio repositório quando omitido.
 */
export function newSession(input: {
  workspaceId: string;
  agentId: string;
  title?: string;
  directory?: string;
  model?: string;
}): ChatSession {
  return new ChatSessionRepository().create(input);
}

/**
 * "Limpa" a conversa atual IN PLACE: apaga todas as mensagens da sessão numa
 * única query e MANTÉM o mesmo id de sessão (diferente de `/new`, que abre uma
 * conversa nova). Assim o `sessionId` do REPL continua válido após o clear.
 * Apaga TAMBÉM o snapshot de compactação da sessão (uma query, no máx. 1
 * linha) — ele é contexto derivado das mensagens apagadas; sem isso o resumo
 * antigo vazaria de volta pro próximo run.
 */
export function clearSession(sessionId: string): void {
  new MessageRepository().deleteBySession(sessionId);
  new SessionContextRepository().deleteBySession(sessionId);
}

/**
 * Dispara a compactação de contexto da sessão. A decisão é automática (budget de
 * tokens) — não há flag `force`. Retorna `null` quando nada precisa ser compactado.
 */
export function compactSession(input: {
  sessionId: string;
  workspaceId: string;
}): SessionCompactionResult | null {
  return maybeCompactSessionContext(input);
}

/** Lista os agentes do workspace (orquestrador primeiro, depois por createdAt). */
export function listAgents(workspaceId: string): Agent[] {
  return new AgentRepository().listByWorkspace(workspaceId);
}

/**
 * Sessão RETOMÁVEL no boot do REPL: a mais recente não-arquivada do
 * workspace+agente (`listByWorkspace` já ordena por updatedAt DESC) que NÃO
 * seja de canal (channelType null — conversa de WhatsApp/etc. pertence ao
 * canal, o REPL não deve sequestrar) e cuja última atividade seja recente
 * (última mensagem, ou updatedAt quando a sessão está vazia — reusar a vazia é
 * exatamente o anti-lixo). Retorna as mensagens junto: quem retoma precisa
 * delas pro transcript, então a leitura não é desperdiçada. `null` = criar nova.
 */
export function findResumableSession(input: {
  workspaceId: string;
  agentId: string;
  maxAgeMs: number;
}): { session: ChatSession; messages: ChatMessage[] } | null {
  const sessions = new ChatSessionRepository().listByWorkspace(input.workspaceId);
  const candidate = sessions.find((s) => s.agentId === input.agentId && !s.channelType);
  if (!candidate) return null;
  const messages = new MessageRepository().listBySession(candidate.id);
  const lastActivity =
    messages.length > 0 ? messages[messages.length - 1].createdAt : candidate.updatedAt;
  if (Date.now() - new Date(lastActivity).getTime() > input.maxAgeMs) return null;
  return { session: candidate, messages };
}
