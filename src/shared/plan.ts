import type { Issue } from './types';

/**
 * Estado de aprovação de um "plano". Um plano é a épica (task principal) que
 * agrupa as sub-issues criadas por um agente. O estado vive em
 * `issue.metadata.plan` — sem migração de schema, pois `metadata_json` é livre.
 */
export interface IssuePlanState {
  /** pending = aguardando · approved = liberado · changes_requested = ajustes · rejected = recusado */
  status: 'pending' | 'approved' | 'changes_requested' | 'rejected';
  /** ISO de quando o usuário decidiu. */
  decidedAt?: string;
  /** Observação livre (usada em changes_requested). */
  note?: string;
  /** Sessão de chat que gerou o plano — liga a épica ao chat pro banner de aprovação. */
  sessionId?: string;
}

/** Lê o estado do plano da metadata da issue (null se não houver). */
export function readPlanState(issue: Pick<Issue, 'metadata'>): IssuePlanState | null {
  const meta = issue.metadata as { plan?: IssuePlanState } | null;
  if (meta && meta.plan && typeof meta.plan.status === 'string') return meta.plan;
  return null;
}

/**
 * Heurística de épica: tem sub-issues, label `epic`/`épica`, ou título começando
 * com `[ÉPICA]`/`[EPIC]`. `childCount` vem da contagem de filhos.
 */
export function looksLikeEpic(issue: Pick<Issue, 'labels' | 'title'>, childCount: number): boolean {
  if (childCount > 0) return true;
  if (issue.labels?.some((l) => l.toLowerCase() === 'epic' || l.toLowerCase() === 'épica')) {
    return true;
  }
  const t = issue.title.trim().toUpperCase();
  return t.startsWith('[ÉPICA') || t.startsWith('[EPICA') || t.startsWith('[EPIC');
}

/**
 * Um plano precisa de aprovação quando foi submetido (`plan.status === 'pending'`).
 * Vale tanto pra ÉPICA (com sub-issues) quanto pra issue ÚNICA — a submissão
 * (`submitPlansCreatedSince`) só marca top-level executável (épica OU issue com
 * responsável), feita no FIM do turno do agente (nunca no streaming, senão pedia
 * aprovação com o plano pela metade). `childCount` é mantido por compat de assinatura.
 */
export function planNeedsApproval(
  issue: Pick<Issue, 'metadata' | 'labels' | 'title'>,
  _childCount: number,
): boolean {
  return readPlanState(issue)?.status === 'pending';
}
