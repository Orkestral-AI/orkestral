/**
 * Forge removido: roteamento de modelo agora é SEMPRE premium.
 *
 * Antes esta política decidia entre o modelo local Forge e o CLI premium (local-first com
 * escalação). Sem Forge, não há executor local: tudo roda no modelo premium do usuário.
 * Mantido como ponto único de decisão (call-sites: kb-repo-analyzer, source-ingestion,
 * issue-execution) com a resposta fixa em "cli" (premium).
 */
import type {
  AiRoutingSettings,
  ModelRoutingDecision,
  ModelRoutingPhase,
  TaskRisk,
} from '../../shared/types';

export interface ModelRouteInput {
  settings: AiRoutingSettings;
  phase: ModelRoutingPhase;
  risk: TaskRisk;
  localModelReady: boolean;
  activeCliProvider: string | null;
}

/** Sem Forge: sempre roteia pro premium (executor "cli"), nunca pro local. */
export function decideModelRoute(input: ModelRouteInput): ModelRoutingDecision {
  return {
    id: '',
    executor: 'cli',
    phase: input.phase,
    mode: 'off',
    risk: input.risk,
    requiresApproval: false,
    preservesCliContext: true,
    contextPolicy: 'cli-native',
    reason: 'Forge removido: execução premium.',
    estimatedInputTokensAvoided: 0,
    estimatedOutputTokensAvoided: 0,
  };
}

export interface LocalEscalationInput {
  allowPremiumFallback: boolean;
  escalations: number;
  forcePremiumNextRun: boolean;
}

/**
 * Sem Forge não há "execução local" pra escalar; o trabalho vai direto pro premium quando
 * o fallback está ligado, e bloqueia só quando o usuário desligou o fallback premium.
 */
export function decideLocalEscalation(input: LocalEscalationInput): 'escalate' | 'block' {
  if (!input.allowPremiumFallback && !input.forcePremiumNextRun) return 'block';
  return 'escalate';
}

/** Linha de ledger (telemetria) — inerte sem roteamento local. */
export function decisionLedgerLine(_decision: ModelRoutingDecision): string {
  return '';
}
