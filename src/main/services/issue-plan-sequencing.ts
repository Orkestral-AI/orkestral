import type { Issue } from '../../shared/types';

type PlanIssueLike = Pick<
  Issue,
  'id' | 'status' | 'childOrdinal' | 'createdAt' | 'issueKey' | 'parentIssueId' | 'title' | 'labels'
>;

/**
 * Regex CONSERVADORA pra reconhecer uma issue de revisão/QA pelo título ou label.
 * Cobre PT/EN ("revisão", "review", "validação", "QA", "quality") + os prefixos
 * `[Review]`/`[QA]` que o orquestrador às vezes usa. Usada tanto na auto-fiação de
 * dependências (create_issue_plan) quanto no gate "revisão por último" do
 * sequenciador, pra que planos antigos (sem aresta blockedBy) também sejam serializados.
 * Casa por PREFIXO (stem) ancorado no início da palavra; sem boundary no fim nos stems
 * acentuados ("revisão", "validação"), seguidos de char não-ASCII onde o \b do JS (só
 * ASCII) não dispara. "qa"/"quality" exigem boundary no fim pra não pegar "quad" etc.
 */
const REVIEW_LIKE_RE = /\b(revis|review|valida(c|ç)|qa\b|quality\b)/i;

export function isReviewLikeIssue(issue: Pick<Issue, 'title' | 'labels'>): boolean {
  if (REVIEW_LIKE_RE.test(issue.title)) return true;
  return issue.labels.some((l) => REVIEW_LIKE_RE.test(l));
}

const EPIC_MARKER_RE = /^\s*\[(épica|epica|epic)\]/i;

/**
 * SUB-ÉPICA (HORIZON Fase 1 — recursão de planos): uma issue FILHA que é container
 * de um sub-plano, não uma folha executável. Filha COM filhos é sempre sub-épica
 * (container de fato). Filha SEM filhos só é sub-épica quando marcada
 * explicitamente ([EPIC]/[ÉPICA] no título ou label `epic`) — é o placeholder que
 * o sub-orquestrador ainda vai DETALHAR num turno de planejamento próprio.
 * Top-level não é "sub"-épica (a detecção de épica raiz vive no executor).
 */
export function isSubEpicIssue(
  issue: Pick<Issue, 'parentIssueId' | 'title' | 'labels'>,
  childCount: number,
): boolean {
  if (!issue.parentIssueId) return false;
  if (childCount > 0) return true;
  return EPIC_MARKER_RE.test(issue.title) || issue.labels.some((l) => l.toLowerCase() === 'epic');
}

export function orderPlanChildren<T extends PlanIssueLike>(children: T[]): T[] {
  return [...children].sort((a, b) => {
    const ao = a.childOrdinal ?? Number.MAX_SAFE_INTEGER;
    const bo = b.childOrdinal ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.issueKey - b.issueKey;
  });
}

/**
 * Predicado opcional: a issue tem dependência blockedBy ainda ABERTA? Quando
 * fornecido, o sequenciador trata a issue como NÃO executável (pula sem travar
 * o plano) até a dependência fechar. Mantém o sequenciador puro/testável.
 */
type BlockedByGate<T extends PlanIssueLike> = (issue: T) => boolean;

/**
 * Predicado opcional: a issue está PARADA num estado não-terminal (in_review/
 * blocked) mas SEM nenhum ator pra avançá-la — ex.: revisão automática esgotou as
 * tentativas (precisa de humano) ou aguarda aprovação manual. Sem isso, um irmão
 * "estacionado" travava a épica inteira pra sempre (inclusive após restart), pois
 * o sequenciador confundia "não-terminal" com "ainda rodando". Quando o predicado
 * retorna true, o irmão é TRANSPARENTE: não dispara, mas também não bloqueia os
 * seguintes. Mantém bloqueado quem está de fato rodando (in_progress / in_review
 * com run ativo).
 */
type ParkedNoActorGate<T extends PlanIssueLike> = (issue: T) => boolean;

/**
 * "Revisão por último" (belt-and-suspenders): uma issue de revisão/QA NÃO roda
 * enquanto QUALQUER irmão de implementação (não-review) ainda estiver pendente.
 * Vale mesmo para planos criados ANTES da auto-fiação de blockedBy (sem aresta de
 * dependência). Uma vez que TODOS os irmãos de implementação assentaram
 * (done/cancelled/blocked ou estacionados sem ator), a revisão volta a ser
 * executável — espelha o caminho de review final da épica, sem estacioná-la pra sempre.
 */
function reviewGatedByUnsettledImpl<T extends PlanIssueLike>(
  child: T,
  siblings: T[],
  isParkedNoActor?: ParkedNoActorGate<T>,
): boolean {
  if (!isReviewLikeIssue(child)) return false;
  const isSettled = (s: T): boolean =>
    s.status === 'done' ||
    s.status === 'cancelled' ||
    s.status === 'blocked' ||
    (isParkedNoActor?.(s) ?? false);
  return siblings.some((s) => s.id !== child.id && !isReviewLikeIssue(s) && !isSettled(s));
}

export function firstRunnablePlanIssue<T extends PlanIssueLike>(
  children: T[],
  isBlockedByOpenDep?: BlockedByGate<T>,
  isParkedNoActor?: ParkedNoActorGate<T>,
): T | null {
  return (
    orderPlanChildren(children).find(
      (child) =>
        child.status === 'todo' &&
        !(isBlockedByOpenDep?.(child) ?? false) &&
        !reviewGatedByUnsettledImpl(child, children, isParkedNoActor),
    ) ?? null
  );
}

/**
 * Onda de execução paralelizável: retorna todas as issues folha que podem iniciar
 * agora segundo dependências explícitas. A ordem ordinal continua preservada na
 * lista, mas não é tratada como dependência implícita. Quem precisa ser serial
 * deve estar ligado por blockedBy; o executor ainda aplica lock por source.
 */
export function runnablePlanIssueWave<T extends PlanIssueLike>(
  children: T[],
  isBlockedByOpenDep?: BlockedByGate<T>,
  isParkedNoActor?: ParkedNoActorGate<T>,
): T[] {
  return orderPlanChildren(children).filter((child) => {
    if (isParkedNoActor?.(child) ?? false) return false;
    if (child.status !== 'todo' && child.status !== 'backlog') return false;
    if (isBlockedByOpenDep?.(child) ?? false) return false;
    return !reviewGatedByUnsettledImpl(child, children, isParkedNoActor);
  });
}

export function nextRunnablePlanIssue<T extends PlanIssueLike>(
  completedIssue: T,
  siblings: T[],
  isBlockedByOpenDep?: BlockedByGate<T>,
  isParkedNoActor?: ParkedNoActorGate<T>,
): T | null {
  if (!completedIssue.parentIssueId) return null;
  const ordered = orderPlanChildren(siblings);
  const completedIndex = ordered.findIndex((child) => child.id === completedIssue.id);
  if (completedIndex === -1) return null;

  for (let idx = 0; idx < ordered.length; idx += 1) {
    const sibling = ordered[idx];
    const parkedNoActor = isParkedNoActor?.(sibling) ?? false;
    if (idx <= completedIndex) {
      // Irmão anterior estacionado sem ator (revisão humana / aprovação pendente)
      // é transparente: não conclui mas também não trava os seguintes.
      if (parkedNoActor) continue;
      // `blocked` é TERMINAL (não retoma sozinho, igual done/cancelled): um passo
      // que falhou não pode congelar o resto do plano. Dependências reais entre
      // issues são impostas por `blockedBy` (isBlockedByOpenDep), não pela ordem.
      if (
        sibling.status !== 'done' &&
        sibling.status !== 'cancelled' &&
        sibling.status !== 'blocked'
      )
        return null;
      continue;
    }
    // Irmão posterior estacionado sem ator → pula e segue procurando o próximo
    // elegível (não é "ainda rodando", então não pode bloquear o resto do plano).
    if (parkedNoActor) continue;
    if (sibling.status === 'todo' || sibling.status === 'backlog') {
      // Dependência blockedBy ainda aberta → não dispara ESTA, mas segue
      // procurando a próxima elegível na ordem do plano (não trava o resto).
      if (isBlockedByOpenDep?.(sibling) ?? false) continue;
      // Revisão/QA não roda enquanto houver irmão de implementação não-assentado
      // (vale pra planos sem aresta blockedBy). Pula sem travar o resto do plano.
      if (reviewGatedByUnsettledImpl(sibling, ordered, isParkedNoActor)) continue;
      return sibling;
    }
    if (
      sibling.status === 'in_progress' ||
      sibling.status === 'in_review' ||
      sibling.status === 'blocked'
    ) {
      return null;
    }
  }
  return null;
}
