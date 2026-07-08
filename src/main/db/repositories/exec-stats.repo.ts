/**
 * Forge removido: métricas de economia (local vs premium) inertes.
 *
 * As estatísticas de execução mediam quanto o modelo local Forge resolvia sem custo de
 * API. Sem Forge, tudo roda premium e não há economia local a contabilizar. Shim no-op
 * pra preservar os call-sites (issue-execution, kb-repo-analyzer, source-ingestion,
 * mcp-server) sem tocar o banco. A tabela `local_phase_runs` deixou de ser usada.
 */

export interface EconomicsSummary {
  totalRuns: number;
  localResolved: number;
  escalatedToPremium: number;
  blockedLocal: number;
  estimatedSavedUsd: number;
}

export class ExecStatsRepository {
  recordOutcome(_runId: string, _outcome: string): void {
    /* no-op */
  }
  recordCounterfactual(_runId: string, _tokensIn: number, _tokensOut: number): void {
    /* no-op */
  }
  recordVerifiedOutcome(_runId: string, _verified: boolean): void {
    /* no-op */
  }
  recordLocalPhase(_phase: { phase: string; tokensIn: number; tokensOut: number }): void {
    /* no-op */
  }
  getEconomics(): EconomicsSummary {
    return {
      totalRuns: 0,
      localResolved: 0,
      escalatedToPremium: 0,
      blockedLocal: 0,
      estimatedSavedUsd: 0,
    };
  }
}

export const execStatsRepo = new ExecStatsRepository();

/** Forge removido: sem execução local, não há economia contrafactual. */
export function computeCounterfactualSavedUsd(
  _tokensIn: number,
  _tokensOut: number,
  _inputUsdPerMTok: number,
  _outputUsdPerMTok: number,
): number {
  return 0;
}
