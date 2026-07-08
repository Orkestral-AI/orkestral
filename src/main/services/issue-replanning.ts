/**
 * Lógica PURA do replanejamento de ciclo fechado (sem DB/IO) — testável isolada.
 *
 * Quando uma sub-issue de plano DIVERGE (esgotou a revisão automática ou o revisor
 * reprovou repetidamente), o CEO RE-ENTRA pra emitir um PATCH. Estas funções
 * decidem SE o replanejamento pode disparar (há sessão de origem + budget por plano
 * não esgotado) e SE deve ir pro premium (alto risco sob autonomia alta). O efeito
 * (disparar o turno do CEO, marcar budget) vive em issue-execution-service.
 */

export type ReplanReason = 'attempts_exhausted' | 'review_rejected';

export interface ReplanEligibilityInput {
  /** Há uma sessão de chat de origem (onde o CEO vive)? Sem ela, não há quem replaneje. */
  hasOriginSession: boolean;
  /** Quantas vezes o CEO já replanejou ESTE plano (na metadata da raiz). */
  replanCount: number;
  /** Teto de replanejamentos por plano. */
  maxReplanAttempts: number;
}

/**
 * O replanejamento pode disparar? Só quando há sessão de origem E o budget por
 * plano ainda não estourou — junto com o cap de revisão, garante que não vira loop.
 */
export function canReplan(input: ReplanEligibilityInput): boolean {
  if (!input.hasOriginSession) return false;
  return input.replanCount < input.maxReplanAttempts;
}

export interface ReplanForcePremiumInput {
  /** Divergência de alto risco (issue crítica / labels sensíveis). */
  highStakes: boolean;
  /** Nível de autonomia do workspace. */
  autonomyLevel: 'low' | 'medium' | 'high';
}

/**
 * O turno de replanejamento deve usar o modelo PREMIUM (em vez do Forge-first/
 * barato)? Só em divergência de alto risco SOB autonomia alta — onde o time
 * "manda e dorme" sem revisão humana no caminho, então a correção precisa bastar.
 */
export function shouldForcePremiumReplan(input: ReplanForcePremiumInput): boolean {
  return input.highStakes && input.autonomyLevel === 'high';
}
