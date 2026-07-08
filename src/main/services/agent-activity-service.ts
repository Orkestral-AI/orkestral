/**
 * Atividade unificada do agente — junta as 3 fontes:
 *   - agent_runs        (mensagens de chat respondidas)
 *   - heartbeat_runs    (heartbeats agendados/manuais)
 *   - code_reviews      (reviews onde o agente foi reviewer)
 *
 * Retorna em ordem cronológica decrescente. Cada item carrega `kind` pra UI
 * decidir como renderizar.
 */

import { AgentRunRepository } from '../db/repositories/run.repo';
import { HeartbeatRunRepository } from '../db/repositories/heartbeat-run.repo';
import { CodeReviewRepository } from '../db/repositories/code-review.repo';
import { IssueRepository } from '../db/repositories/issue.repo';
import { WorkspaceRepository } from '../db/repositories/workspace.repo';
import type {
  AgentActivityItem,
  AgentActivityKind,
  AgentActivityStatus,
  AgentActivityStats,
} from '../../shared/types';

const agentRunRepo = new AgentRunRepository();
const heartbeatRepo = new HeartbeatRunRepository();
const codeReviewRepo = new CodeReviewRepository();
const issueRepo = new IssueRepository();
const workspaceRepo = new WorkspaceRepository();

/** Prefixo da issue key na URL (PREFIX-N) — mesmo formato do renderer. */
function issuePrefix(name: string): string {
  return (
    (name || 'ORK')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 3)
      .toUpperCase() || 'ORK'
  );
}

const KIND_TITLES: Record<AgentActivityKind, string> = {
  chat: 'Mensagem de chat',
  heartbeat: 'Heartbeat',
  'code-review': 'Code review',
  issue: 'Execução de issue',
};

function normalizeStatus(raw: string, kind: AgentActivityKind): AgentActivityStatus {
  // Mapeia status de cada fonte pro espaço comum.
  if (kind === 'code-review') {
    if (raw === 'completed') return 'done';
    if (raw === 'failed') return 'error';
    if (raw === 'analyzing' || raw === 'queued') return 'running';
    if (raw === 'cancelled') return 'cancelled';
  }
  if (kind === 'heartbeat') {
    if (raw === 'succeeded') return 'done';
    if (raw === 'failed') return 'error';
    if (raw === 'running' || raw === 'queued') return raw as AgentActivityStatus;
  }
  if (kind === 'issue') {
    // issue_runs: queued | running | done | failed | cancelled
    if (raw === 'failed') return 'error';
    if (raw === 'done' || raw === 'running' || raw === 'queued' || raw === 'cancelled') {
      return raw as AgentActivityStatus;
    }
  }
  // chat: run.repo já usa o vocabulário comum (running/done/error/cancelled)
  if (
    raw === 'running' ||
    raw === 'done' ||
    raw === 'error' ||
    raw === 'cancelled' ||
    raw === 'queued'
  ) {
    return raw as AgentActivityStatus;
  }
  return 'done';
}

function computeDuration(startedAt: string, finishedAt: string | null): number | null {
  if (!finishedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/**
 * Lista atividade unificada do agente, mais recente primeiro.
 * `limit` aplica-se em CADA fonte separadamente antes do merge — então o
 * retorno pode ter até `limit * 3` itens, mas tipicamente o caller passa
 * algo como 20 e usa `slice(0, limit)` no resultado.
 */
export function listAgentActivity(agentId: string, limit = 20): AgentActivityItem[] {
  const items: AgentActivityItem[] = [];
  // Nome do workspace por id — pro prefixo da issue key na URL (PREFIX-N).
  const wsNameById = new Map(workspaceRepo.listAll().map((w) => [w.id, w.name]));

  // 1. Chat runs (agent_runs)
  const chatRuns = agentRunRepo.listByAgent(agentId, limit);
  for (const r of chatRuns) {
    items.push({
      kind: 'chat',
      id: r.id,
      status: normalizeStatus(r.status, 'chat'),
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: computeDuration(r.startedAt, r.finishedAt),
      title: KIND_TITLES.chat,
      subtitle: r.model && r.model !== 'default' ? r.model : r.adapterType,
      errorMessage: r.errorMessage,
      link: `#/session/${r.sessionId}`,
      meta: { sessionId: r.sessionId, adapterType: r.adapterType, model: r.model },
    });
  }

  // 2. Heartbeat runs
  const heartbeatRuns = heartbeatRepo.listByAgent(agentId, limit);
  for (const h of heartbeatRuns) {
    items.push({
      kind: 'heartbeat',
      id: h.id,
      status: normalizeStatus(h.status, 'heartbeat'),
      startedAt: h.startedAt,
      finishedAt: h.finishedAt,
      durationMs: h.durationMs ?? computeDuration(h.startedAt, h.finishedAt),
      title: KIND_TITLES.heartbeat,
      subtitle: h.source === 'manual' ? 'Manual' : 'Agendado',
      errorMessage: h.errorMessage,
      link: null,
      meta: { source: h.source, exitCode: h.exitCode },
    });
  }

  // 3. Code reviews onde o agente foi reviewer
  const reviews = codeReviewRepo.listByReviewer(agentId, limit);
  for (const cr of reviews) {
    const repoShort = cr.repoFullName.split('/').slice(-1)[0] ?? cr.repoFullName;
    items.push({
      kind: 'code-review',
      id: cr.id,
      status: normalizeStatus(cr.status, 'code-review'),
      startedAt: cr.startedAt,
      finishedAt: cr.finishedAt,
      durationMs: computeDuration(cr.startedAt, cr.finishedAt),
      title: `${repoShort} · PR #${cr.prNumber}`,
      subtitle: cr.prTitle,
      errorMessage: cr.errorMessage,
      link: `#/code-reviews/${encodeURIComponent(cr.repoFullName)}/${cr.prNumber}`,
      meta: {
        repoFullName: cr.repoFullName,
        prNumber: cr.prNumber,
        rating: cr.rating,
        recommendation: cr.recommendation,
        totalComments: cr.totalComments,
      },
    });
  }

  // 4. Issue runs (execuções de issue) — onde os executores (Forge/premium)
  // trabalham. Sem isto, agentes que só executam issues apareciam ZERADOS.
  const issueRuns = issueRepo.listRunsByAgent(agentId, limit);
  for (const run of issueRuns) {
    const issue = issueRepo.get(run.issueId);
    items.push({
      kind: 'issue',
      id: run.id,
      status: normalizeStatus(run.status, 'issue'),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: computeDuration(run.startedAt, run.finishedAt),
      title: issue ? issue.title : KIND_TITLES.issue,
      subtitle: run.outputSummary?.slice(0, 80) ?? null,
      errorMessage: run.errorMessage,
      link: issue
        ? `#/issues/${issuePrefix(wsNameById.get(issue.workspaceId) ?? '')}-${issue.issueKey}`
        : null,
      meta: { issueId: run.issueId, exitCode: run.exitCode },
    });
  }

  // Merge cronológico decrescente + corta limit
  items.sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1));
  return items.slice(0, limit);
}

/**
 * Estatísticas agregadas das últimas N dias. Conta todas as fontes.
 */
export function getAgentActivityStats(agentId: string, days = 14): AgentActivityStats {
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const chat = agentRunRepo.listByAgentSince(agentId, sinceIso);
  const heartbeats = heartbeatRepo
    .listByAgent(agentId, 1000)
    .filter((h) => h.startedAt >= sinceIso);
  const reviews = codeReviewRepo
    .listByReviewer(agentId, 1000)
    .filter((cr) => cr.startedAt >= sinceIso);
  const issues = issueRepo.listRunsByAgent(agentId, 1000).filter((r) => r.startedAt >= sinceIso);

  const all: AgentActivityItem[] = [
    ...issues.map((r) => ({
      kind: 'issue' as AgentActivityKind,
      id: r.id,
      status: normalizeStatus(r.status, 'issue'),
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: computeDuration(r.startedAt, r.finishedAt),
      title: '',
    })),
    ...chat.map((r) => ({
      kind: 'chat' as AgentActivityKind,
      id: r.id,
      status: normalizeStatus(r.status, 'chat'),
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: computeDuration(r.startedAt, r.finishedAt),
      title: '',
    })),
    ...heartbeats.map((h) => ({
      kind: 'heartbeat' as AgentActivityKind,
      id: h.id,
      status: normalizeStatus(h.status, 'heartbeat'),
      startedAt: h.startedAt,
      finishedAt: h.finishedAt,
      durationMs: h.durationMs ?? computeDuration(h.startedAt, h.finishedAt),
      title: '',
    })),
    ...reviews.map((cr) => ({
      kind: 'code-review' as AgentActivityKind,
      id: cr.id,
      status: normalizeStatus(cr.status, 'code-review'),
      startedAt: cr.startedAt,
      finishedAt: cr.finishedAt,
      durationMs: computeDuration(cr.startedAt, cr.finishedAt),
      title: '',
    })),
  ];

  const succeeded = all.filter((i) => i.status === 'done').length;
  const failed = all.filter((i) => i.status === 'error').length;
  const cancelled = all.filter((i) => i.status === 'cancelled').length;
  const finishedDurations = all
    .map((i) => i.durationMs)
    .filter((d): d is number => typeof d === 'number');
  const avgDurationMs =
    finishedDurations.length === 0
      ? null
      : Math.round(finishedDurations.reduce((a, b) => a + b, 0) / finishedDurations.length);
  const successDenominator = succeeded + failed;
  const successRate = successDenominator === 0 ? null : succeeded / successDenominator;

  return {
    total: all.length,
    succeeded,
    failed,
    cancelled,
    byKind: {
      chat: chat.length,
      heartbeat: heartbeats.length,
      'code-review': reviews.length,
      issue: issues.length,
    },
    avgDurationMs,
    successRate,
  };
}
