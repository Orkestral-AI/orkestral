import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SettingsRepository } from '../db/repositories/settings.repo';
import { WorkspaceSourceRepository } from '../db/repositories/workspace-source.repo';
import { kbAnalysisJobRepo } from '../db/repositories/kb-analysis-job.repo';
import { execStatsRepo } from '../db/repositories/exec-stats.repo';
import { AgentRepository } from '../db/repositories/agent.repo';
import { syncWorkspaceTeamForSources } from './source-team-sync';
import {
  inferSourceRoleFromSignals,
  inferAgentCoverageRole,
  normalizeSourceRole,
} from './agent-assignment-policy';
import { analyzeSource } from './kb-repo-analyzer';
import { decideModelRoute, decisionLedgerLine } from './model-routing-policy';
import { trace } from './log-bus';
import { isForgeBundled, getSmartExecConfig } from './smart-exec/config';
import { runLocalPhase, parseFirstJsonObject } from './smart-exec/llama-runtime';
import type { ModelRoutingPhase, WorkspaceSource, WorkspaceSourceRole } from '../../shared/types';

const sourceRepo = new WorkspaceSourceRepository();
const settingsRepo = new SettingsRepository();
const agentRepo = new AgentRepository();
const HIRING_ANALYSIS_POLL_MS = 1_000;
const HIRING_ANALYSIS_WAIT_MS = 15 * 60 * 1_000;

const SOURCE_ROLES: WorkspaceSourceRole[] = [
  'frontend',
  'backend',
  'mobile',
  'infra',
  'docs',
  'other',
];

/**
 * Decide o roteamento de uma fase e LOGA o ledger. Retorna se o executor é o
 * modelo local — o caller só roda a inferência local quando `executor==='local'`
 * (aiRouting habilitado + fase elegível + Forge pronto). Em qualquer outro caso,
 * o caller usa a heurística/premium existente. O fluxo feliz nunca regride.
 */
function routePhase(input: {
  phase: ModelRoutingPhase;
  risk?: Parameters<typeof decideModelRoute>[0]['risk'];
  localModelReady?: boolean;
}): { ledger: string; executor: 'cli' | 'local' | 'none' } {
  const decision = decideModelRoute({
    settings: settingsRepo.get().aiRouting,
    phase: input.phase,
    risk: input.risk ?? 'low',
    localModelReady: input.localModelReady ?? isForgeBundled(),
    activeCliProvider: null,
  });
  const ledger = decisionLedgerLine(decision);
  const executorLabel =
    decision.executor === 'local'
      ? 'modelo local'
      : decision.executor === 'cli'
        ? 'CLI premium'
        : 'nenhum executor';
  // A economia agora é REAL (gravada em exec-stats quando a fase local roda de
  // verdade) — o `projected_tokens_est` do ledger fica só como projeção do roteador.
  trace({
    level: 'info',
    source: 'model-routing',
    scope: input.phase,
    message: `[hybrid] ${input.phase}: roteado para ${executorLabel} · ${decision.reason} · ${ledger}`,
  });
  return { ledger, executor: decision.executor };
}

/** Lê os manifestos (package.json/composer.json/app.json) já presentes no source. */
function readManifest(path: string | null): string {
  if (!path) return '';
  const parts: string[] = [];
  for (const file of ['package.json', 'composer.json', 'app.json']) {
    try {
      const full = join(path, file);
      if (existsSync(full)) parts.push(`### ${file}\n${readFileSync(full, 'utf8').slice(0, 4000)}`);
    } catch {
      // best-effort: manifesto ausente/ilegível só reduz o sinal, não quebra
    }
  }
  return parts.join('\n\n');
}

/**
 * source_classification LOCAL: classifica o role do source a partir do manifesto
 * já lido (sem tool-calling). Roda no Forge só quando o roteamento permite; em
 * qualquer falha (modelo ausente, output inválido) cai na heurística determinística
 * `inferSourceRoleFromSignals` (grátis, sem premium). Persiste o role no source e
 * grava a economia REAL quando o local resolveu. Retorna o role efetivo.
 */
async function classifySourceRole(source: WorkspaceSource): Promise<WorkspaceSourceRole | null> {
  const heuristic = inferSourceRoleFromSignals({ source });
  const { executor } = routePhase({ phase: 'source_classification', risk: 'low' });
  if (executor !== 'local') return heuristic;

  const manifest = readManifest(source.path);
  if (!manifest) return heuristic;

  const result = await runLocalPhase<WorkspaceSourceRole>(getSmartExecConfig(), {
    scope: 'source_classification',
    system:
      'You classify a software repository into exactly one role. Respond ONLY with a JSON object ' +
      `{"role": "<role>"} where <role> is one of: ${SOURCE_ROLES.join(', ')}. No prose.`,
    user: `Repository "${source.label}". Manifests:\n\n${manifest}\n\nClassify its role.`,
    parse: (raw) => {
      const obj = parseFirstJsonObject(raw);
      const role = normalizeSourceRole(typeof obj?.role === 'string' ? obj.role : null);
      return role && SOURCE_ROLES.includes(role) ? role : null;
    },
  });

  if (!result) return heuristic;
  execStatsRepo.recordLocalPhase({
    phase: 'source_classification',
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  });
  trace({
    level: 'success',
    source: 'forge',
    scope: 'source_classification',
    message: `source "${source.label}" classificado local como ${result.value} (premium evitado ≈ ${result.tokensIn + result.tokensOut} tokens)`,
  });
  return result.value;
}

/**
 * agent_assignment LOCAL: confirma qual role de agente cobre este source. O
 * mapeamento determinístico (`inferAgentCoverageRole` + match de role) já existe e
 * é a fonte de verdade — aqui só rodamos uma checagem local quando o roteamento
 * permite, pra contabilizar a economia REAL do trabalho analítico que o premium
 * faria. Nunca altera a decisão de cobertura nem quebra o fluxo.
 */
async function assignAgentsLocally(
  workspaceId: string,
  source: WorkspaceSource,
  role: WorkspaceSourceRole | null,
): Promise<void> {
  const { executor } = routePhase({ phase: 'agent_assignment', risk: 'low' });
  if (executor !== 'local') return;

  const agents = agentRepo.listByWorkspace(workspaceId);
  if (agents.length === 0) return;
  const roster = agents
    .map((a) => `- ${a.name} (role=${inferAgentCoverageRole(a) ?? 'unclassified'})`)
    .join('\n');

  const result = await runLocalPhase<string>(getSmartExecConfig(), {
    scope: 'agent_assignment',
    system:
      'You pick which agent role should own a source. Respond ONLY with a JSON object ' +
      `{"role": "<role>"} where <role> is one of: ${SOURCE_ROLES.join(', ')}, lead, review. No prose.`,
    user: `Source "${source.label}" (role=${role ?? 'unclassified'}). Agents:\n${roster}\n\nWhich agent role should own it?`,
    parse: (raw) => {
      const obj = parseFirstJsonObject(raw);
      const picked = typeof obj?.role === 'string' ? obj.role.toLowerCase().trim() : '';
      return picked === 'lead' || picked === 'review' || normalizeSourceRole(picked)
        ? picked
        : null;
    },
  });

  if (!result) return;
  execStatsRepo.recordLocalPhase({
    phase: 'agent_assignment',
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  });
}

export function scheduleSourceIngestion(input: {
  workspaceId: string;
  sourceId: string;
  reason: string;
  runKnowledgeAnalysis?: boolean;
  delayMs?: number;
  onReadyForHiring?: () => void;
}): void {
  setTimeout(() => {
    void ingestSource(input).catch((err) => {
      console.warn('[source-ingestion] falhou:', err);
    });
  }, input.delayMs ?? 500);
}

function scheduleHiringAfterAnalysis(
  workspaceId: string,
  jobId: string,
  onReadyForHiring?: () => void,
): void {
  if (!onReadyForHiring) return;
  const startedAt = Date.now();

  const poll = () => {
    const job = kbAnalysisJobRepo.get(jobId);
    const status = job?.status;
    const settled =
      status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled' ||
      !job ||
      Date.now() - startedAt >= HIRING_ANALYSIS_WAIT_MS;

    if (!settled) {
      setTimeout(poll, HIRING_ANALYSIS_POLL_MS);
      return;
    }

    try {
      syncWorkspaceTeamForSources(workspaceId, 'analysis-ready-for-hiring');
    } catch (err) {
      console.warn('[source-ingestion] sync pre-hiring falhou:', err);
    }
    onReadyForHiring();
  };

  setTimeout(poll, HIRING_ANALYSIS_POLL_MS);
}

export async function ingestSource(input: {
  workspaceId: string;
  sourceId: string;
  reason: string;
  runKnowledgeAnalysis?: boolean;
  onReadyForHiring?: () => void;
}): Promise<{ analysisJobId: string | null; skippedReason?: string }> {
  const source = sourceRepo.get(input.sourceId);
  if (!source) throw new Error(`Source ${input.sourceId} nao encontrado`);

  const refreshed = sourceRepo.get(input.sourceId) ?? source;
  if (!refreshed.path || !existsSync(refreshed.path)) {
    return { analysisJobId: null, skippedReason: 'source-path-not-ready' };
  }

  // source_classification — local quando o roteamento permite; senão heurística.
  // Persiste o role inferido pra alimentar o sync de time e o assignment abaixo.
  const role = await classifySourceRole(refreshed);
  if (role && role !== refreshed.role) {
    sourceRepo.update(refreshed.id, { role });
  }

  syncWorkspaceTeamForSources(input.workspaceId, input.reason);
  await assignAgentsLocally(input.workspaceId, refreshed, role ?? refreshed.role);

  if (input.runKnowledgeAnalysis === false) {
    input.onReadyForHiring?.();
    return { analysisJobId: null, skippedReason: 'knowledge-disabled' };
  }

  const active = kbAnalysisJobRepo.findActiveBySource(refreshed.id);
  if (active) {
    scheduleHiringAfterAnalysis(input.workspaceId, active.id, input.onReadyForHiring);
    return { analysisJobId: active.id, skippedReason: 'analysis-already-running' };
  }

  routePhase({ phase: 'kb_coverage', risk: 'low' });
  const { jobId } = analyzeSource(input.workspaceId, refreshed.id);
  scheduleHiringAfterAnalysis(input.workspaceId, jobId, input.onReadyForHiring);
  return { analysisJobId: jobId };
}
