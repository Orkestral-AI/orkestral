import type { IssueStatus } from '../../shared/types';

export type ReviewRunDecision = 'approve' | 'reexecute' | 'terminal' | 'needs_verdict';

export function decideReviewRun(input: {
  issueStatus: IssueStatus;
  attempts: number;
  maxAttempts: number;
}): ReviewRunDecision {
  if (input.issueStatus === 'blocked' || input.issueStatus === 'cancelled') return 'terminal';
  // O revisor pediu mudanças EXPLICITAMENTE movendo a issue de volta pra todo/
  // in_progress (o prompt de REVIEW MODE instrui isso — SEM trocar o responsável).
  // 'reexecute' mesmo com tentativas esgotadas: o caller dá ao executor a última
  // tentativa e o teto global (attempts > maxAttempts em routeReviewOrFinish) ainda
  // estaciona depois — não vira 'needs_verdict' (que descartaria a intenção do revisor).
  if (input.issueStatus === 'todo' || input.issueStatus === 'in_progress') {
    return 'reexecute';
  }
  // Aprovação exige sinal AFIRMATIVO: o revisor moveu pra 'done' (o token de
  // aprovação que o prompt de REVIEW MODE instrui). Encerrar o run em in_review
  // (sem mover) NÃO é aprovação — pede veredito explícito, não conclui por silêncio.
  if (input.issueStatus === 'done') return 'approve';
  return 'needs_verdict';
}
