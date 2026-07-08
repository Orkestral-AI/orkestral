import { resolveActiveWorkspaceId } from './active-workspace';
import { findResumableSession, listAgents, newSession } from './actions';
import { messagePartsToBlocks, type StreamBlock } from './ui/stream-render';
import { ChannelRepository } from '../db/repositories/channel.repo';
import { WorkspaceRepository } from '../db/repositories/workspace.repo';
import type { ChatMessage } from '../../shared/types';

/**
 * Boot COMPARTILHADO do REPL e do modo print (`-p`): resolve workspace ativo →
 * agente orquestrador → sessão (retomada ou nova). Extraído do Repl.tsx pra os
 * dois caminhos usarem EXATAMENTE a mesma resolução — o print mode não pode
 * divergir do REPL sobre qual sessão/agente atende o prompt.
 */

/**
 * Turn do transcript em BLOCOS (texto + tools intercalados na ordem em que
 * aconteceram) — tools não somem do transcript quando o turn fecha. Turns de
 * user/note são um único bloco de texto.
 */
export interface HistoryTurn {
  role: 'user' | 'assistant' | 'note';
  blocks: readonly StreamBlock[];
}

export type BootSession =
  | { ok: false }
  | {
      ok: true;
      workspaceId: string;
      agentId: string;
      sessionId: string;
      /** Turns do histórico da sessão retomada — vazio quando a sessão é nova. */
      turns: HistoryTurn[];
    };

/** Sessão parada há mais que isso não é retomada no boot — abre uma nova. */
export const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Mensagens persistidas → turns do transcript. Só user/assistant entram
 * (system/tool são bastidor — pulados); turns sem conteúdo visível (ex.: run
 * cancelado antes de produzir algo) também caem fora. Exportada: o `/resume`
 * do REPL hidrata o transcript da sessão escolhida pelo MESMO caminho do boot.
 */
export function messagesToTurns(messages: ChatMessage[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const blocks = messagePartsToBlocks(msg.parts);
    const hasContent = blocks.some(
      (b) => b.kind === 'tool' || (b.kind === 'text' && b.text.trim().length > 0),
    );
    if (hasContent) turns.push({ role: msg.role, blocks });
  }
  return turns;
}

/**
 * Resolve a sessão inicial do REPL: workspace ativo → agente orquestrador (o
 * primeiro de `listAgents`, que ordena o orquestrador no topo) → RETOMA a
 * sessão mais recente do par (se a última atividade tem < 24h) em vez de criar
 * uma nova a cada launch — o histórico dela vira os turns iniciais. `--new`
 * (forceNew) e sessão velha/inexistente caem na criação de uma nova.
 * `{ ok: false }` quando falta workspace ou agente (pede `orkestral init`).
 */
export function resolveBootSession(forceNew: boolean): BootSession {
  const workspaceId = resolveActiveWorkspaceId();
  if (!workspaceId) return { ok: false };
  const agent = listAgents(workspaceId)[0];
  if (!agent) return { ok: false };
  if (!forceNew) {
    const resumable = findResumableSession({
      workspaceId,
      agentId: agent.id,
      maxAgeMs: RESUME_MAX_AGE_MS,
    });
    if (resumable) {
      const turns = messagesToTurns(resumable.messages);
      if (turns.length > 0) {
        turns.push({
          role: 'note',
          blocks: [{ kind: 'text', text: 'sessão retomada — /new começa uma conversa nova.' }],
        });
      }
      return {
        ok: true,
        workspaceId,
        agentId: agent.id,
        sessionId: resumable.session.id,
        turns,
      };
    }
  }
  const session = newSession({ workspaceId, agentId: agent.id });
  return { ok: true, workspaceId, agentId: agent.id, sessionId: session.id, turns: [] };
}

/**
 * Checagens BARATAS de setup pro banner do REPL (rodam uma vez no boot, tudo
 * leitura local do SQLite): canal conectado e pasta de projeto do workspace.
 * Cada problema vira uma linha curta com o comando que resolve — o Welcome
 * renderiza em amarelo dim, só quando a lista não é vazia.
 */
export function collectSetupIssues(workspaceId: string): string[] {
  const issues: string[] = [];
  const hasChannel = new ChannelRepository()
    .listAccounts()
    .some((account) => account.status === 'connected');
  if (!hasChannel) issues.push('nenhum canal conectado — /channels');
  const workspace = new WorkspaceRepository().listAll().find((w) => w.id === workspaceId);
  if (workspace && !workspace.path) {
    issues.push('workspace sem pasta de projeto — os agentes não enxergam código');
  }
  return issues;
}
