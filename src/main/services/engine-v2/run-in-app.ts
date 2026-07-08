/**
 * Motor v2: entry IN-APP, premium planeja/conduz + FORGE LOCAL executa.
 *
 * Acha o agente premium configurado (qualquer adapter != Forge) e usa o CLI dele pra
 * planejar/conduzir; o Forge local (default do createEngineV2) executa de graca. Esta e a
 * versao economica de verdade (vs o script de terminal, onde o premium executa tudo).
 *
 * SO roda no processo main do app (Forge precisa do node-llama-cpp via Electron). Chamado
 * pelo handler IPC `engine-v2:run-slice`.
 */
import type { EngineV2RunSummary } from '../../../shared/types';
import { AgentRepository } from '../../db/repositories/agent.repo';
import { createEngineV2 } from './entry';
import { createAdapterPremiumChat, isPremiumAdapter } from './premium-runner';
import type { RunPlanResult } from './plan-runner';
import type { CheckpointSnapshot } from './issue-runner';
import type { PreviewPlan } from './preview-policy';
import type { Plan } from './planner';

const agentRepo = new AgentRepository();

export interface RunInAppInput {
  workspaceId: string;
  intent: string;
  projectRoot: string;
  port?: number;
  signal?: AbortSignal;
  onPlanReady?: (plan: Plan) => void;
  onCheckpoint?: (s: CheckpointSnapshot) => void;
  onPreviewReady?: (p: PreviewPlan) => void;
}

/** Acha o agente premium (nao-Forge): prioriza o orquestrador, senao qualquer nao-Forge. */
function findPremiumAgent(
  workspaceId: string,
): { adapterType: string; model: string | null } | null {
  const agents = agentRepo.listByWorkspace(workspaceId);
  const pick =
    agents.find((a) => a.isOrchestrator && a.adapterType && isPremiumAdapter(a.adapterType)) ??
    agents.find((a) => a.adapterType && isPremiumAdapter(a.adapterType));
  if (!pick || !pick.adapterType) return null;
  return { adapterType: pick.adapterType, model: pick.model ?? null };
}

function toSummary(res: RunPlanResult): EngineV2RunSummary {
  return {
    planned: res.planned,
    reply: res.reply,
    planViolations: res.planViolations,
    issues: res.issues.map((i) => ({
      issueId: i.issueId,
      title: i.title,
      isWalkingSkeleton: i.isWalkingSkeleton,
      doneCount: i.doneCount,
      blockedCount: i.blockedCount,
    })),
    totalDone: res.totalDone,
    totalBlocked: res.totalBlocked,
    economyLine: res.economyLine,
    premiumTokens: res.economy.premiumTokens,
    localTokens: res.economy.localTokens,
    preview: res.preview
      ? {
          kind: res.preview.kind,
          mode: res.preview.mode,
          url: res.preview.url,
          needsBackendUp: res.preview.needsBackendUp,
          reason: res.preview.reason,
        }
      : null,
    previewLaunched: res.previewLaunched,
    cancelled: res.cancelled,
  };
}

/**
 * Roda uma fatia in-app: premium configurado planeja/conduz, Forge local executa.
 * Lanca claro se nao houver agente premium configurado (em vez de falhar silencioso).
 */
export async function runEngineV2InApp(input: RunInAppInput): Promise<EngineV2RunSummary> {
  const premium = findPremiumAgent(input.workspaceId);
  if (!premium) {
    throw new Error(
      'engine-v2: nenhum agente premium (nao-Forge) configurado neste workspace. Configure um provider (claude/codex/...).',
    );
  }
  const premiumChat = createAdapterPremiumChat({
    adapterType: premium.adapterType,
    model: premium.model,
    cwd: input.projectRoot,
  });
  // Forge local executa (default do createEngineV2, sem forgeChat override).
  const motor = createEngineV2({ premiumChat });
  const res = await motor.run({
    intent: input.intent,
    projectRoot: input.projectRoot,
    port: input.port,
    commitPerSlice: true,
    launchPreviewServer: true,
    signal: input.signal,
    onPlanReady: input.onPlanReady,
    onCheckpoint: input.onCheckpoint,
    onPreviewReady: input.onPreviewReady,
  });
  return toSummary(res);
}
