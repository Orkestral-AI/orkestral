import { useMemo, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ListChecks,
  CircleAlert,
  CircleSlash,
  GitPullRequest,
  Check,
  CheckCheck,
  X,
  ChevronRight,
  Loader2,
  Activity,
  Signal,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT, type TFunction } from '@renderer/i18n';
import { SentryIcon } from '@renderer/components/brand-icons';
import { Skeleton } from '@renderer/components/ui/skeleton';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { planNeedsApproval } from '@shared/plan';
import { toast } from '@renderer/stores/toastStore';
import { useInboxDismissStore } from '@renderer/stores/inboxDismissStore';
import type { Issue, SourceAgentAssignment } from '@shared/types';

/** Payload de uma proposta de issue do Sentry (automação). */
interface SentryProposalPayload {
  issueId?: string;
  level?: string;
  count?: number;
  agentId?: string | null;
  permalink?: string;
}

interface ObservabilityProposalPayload {
  type?: string;
  provider?: 'new_relic' | 'better_stack';
  agentId?: string | null;
  signal?: {
    id: string;
    provider: 'new_relic' | 'better_stack';
    kind: 'error' | 'incident' | 'log';
    title: string;
    service: string | null;
    severity: string | null;
    count: number | null;
    lastSeen: string | null;
    url: string | null;
    summary: string;
    raw: Record<string, unknown>;
  };
}

/**
 * Inbox = central de DECISÕES, não réplica de chats/issues. Mostra só o que
 * precisa de uma ação sua, em momentos decisivos:
 *   1. Planos aguardando aprovação (épicas com sub-issues, sem decisão)
 *   2. Issues em revisão (in_review) — aprovar ou pedir ajustes
 *   3. Bloqueios e falhas — issues 'blocked' e code reviews que falharam
 *
 * Cada item traz a ação direto na linha. Tudo o resto (chats, issues abertas
 * comuns) vive em suas próprias telas.
 */
export function InboxPage() {
  const { t } = useT();
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const issuesQuery = useQuery({
    queryKey: ['issues', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['issue:list']({ workspaceId: activeWorkspace!.id }),
    refetchInterval: 8000,
  });
  const agentsQuery = useQuery({
    queryKey: ['agents', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: activeWorkspace!.id }),
  });
  const activityQuery = useQuery({
    queryKey: ['activity', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () =>
      window.orkestral['activity:list']({ workspaceId: activeWorkspace!.id, limit: 50 }),
    refetchInterval: 5_000,
  });
  const assignmentsQuery = useQuery({
    queryKey: ['agent-source-assignments', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () =>
      window.orkestral['agent:source-assignments']({ workspaceId: activeWorkspace!.id }),
    refetchInterval: 5_000,
  });
  const issues = useMemo(() => issuesQuery.data ?? [], [issuesQuery.data]);
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const activity = useMemo(() => activityQuery.data ?? [], [activityQuery.data]);
  const assignments = useMemo(() => assignmentsQuery.data ?? [], [assignmentsQuery.data]);
  const prefix = issuePrefix(activeWorkspace?.name ?? '');

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['issues'] });
    queryClient.invalidateQueries({ queryKey: ['issue-by-key'] });
    queryClient.invalidateQueries({ queryKey: ['issue-children'] });
    queryClient.invalidateQueries({ queryKey: ['activity'] });
  };

  const decidePlanMut = useMutation({
    mutationFn: (input: {
      epicIssueId: string;
      decision: 'approve' | 'request_changes' | 'reject';
    }) => window.orkestral['issue:decide-plan'](input),
    onSuccess: (res, vars) => {
      invalidate();
      if (vars.decision === 'approve')
        toast.success(
          t('issues.plan.toastApprovedTitle'),
          res.executed > 0
            ? t('issues.plan.toastApprovedExecuted', { n: res.executed })
            : t('issues.plan.toastApprovedReleased'),
        );
      else if (vars.decision === 'reject')
        toast.success(
          t('issues.plan.toastRejectedTitle'),
          t('issues.plan.toastRejectedBody', { n: res.cancelled }),
        );
    },
    onError: (e) =>
      toast.error(t('issues.plan.toastDecideFailed'), e instanceof Error ? e.message : undefined),
  });
  const updateIssueMut = useMutation({
    mutationFn: (input: { issueId: string; status: Issue['status'] }) =>
      window.orkestral['issue:update']({ issueId: input.issueId, patch: { status: input.status } }),
    onSuccess: (_res, vars) => {
      invalidate();
      toast.success(
        vars.status === 'done'
          ? t('issues.inbox.toastIssueApproved')
          : t('issues.inbox.toastIssueToChanges'),
      );
    },
    onError: (e) =>
      toast.error(t('issues.inbox.toastUpdateFailed'), e instanceof Error ? e.message : undefined),
  });
  // Aprovar todos: aplica done em lote nas subtasks de um grupo.
  const approveManyMut = useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(
        ids.map((id) =>
          window.orkestral['issue:update']({ issueId: id, patch: { status: 'done' } }),
        ),
      ),
    onSuccess: (_res, ids) => {
      invalidate();
      toast.success(
        t('issues.inbox.toastSubtasksApprovedTitle'),
        t('issues.inbox.toastSubtasksApprovedBody', { n: ids.length }),
      );
    },
    onError: (e) =>
      toast.error(
        t('issues.inbox.toastApproveAllFailed'),
        e instanceof Error ? e.message : undefined,
      ),
  });
  const createSpecialistMut = useMutation({
    mutationFn: (input: { sourceId: string; activityId: string }) =>
      window.orkestral['agent:create-source-specialist']({
        workspaceId: activeWorkspace!.id,
        sourceId: input.sourceId,
      }),
    onSuccess: (agent, vars) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['agent-source-assignments'] });
      dismiss(`act:${vars.activityId}`, vars.activityId);
      toast.success(
        t('issues.inbox.toastSpecialistCreatedTitle'),
        t('issues.inbox.toastSpecialistCreatedBody', { name: agent.name }),
      );
    },
    onError: (e) =>
      toast.error(
        t('issues.inbox.toastSpecialistCreateFailed'),
        e instanceof Error ? e.message : undefined,
      ),
  });
  const analyzeSentryMut = useMutation({
    mutationFn: (input: { issueId: string; agentId: string | null; activityId: string }) =>
      window.orkestral['sentry:analyze-issue']({
        workspaceId: activeWorkspace!.id,
        issueId: input.issueId,
        agentId: input.agentId,
      }),
    onSuccess: (res, vars) => {
      dismiss(`act:${vars.activityId}`, vars.activityId);
      navigate(`/session/${res.sessionId}`);
    },
    onError: (e) =>
      toast.error(
        t('pages.sentryErrors.analyzeFailed'),
        e instanceof Error ? e.message : undefined,
      ),
  });
  const analyzeObservabilityMut = useMutation({
    mutationFn: (input: {
      provider: 'new_relic' | 'better_stack';
      signal: NonNullable<ObservabilityProposalPayload['signal']>;
      agentId: string | null;
      activityId: string;
    }) =>
      window.orkestral['observability:analyze-signal']({
        workspaceId: activeWorkspace!.id,
        provider: input.provider,
        signal: input.signal,
        agentId: input.agentId,
      }),
    onSuccess: (res, vars) => {
      dismiss(`act:${vars.activityId}`, vars.activityId);
      navigate(`/session/${res.sessionId}`);
    },
    onError: (e) =>
      toast.error(
        t('issues.inbox.analyzeSignalFailed'),
        e instanceof Error ? e.message : undefined,
      ),
  });
  const pendingId =
    (decidePlanMut.isPending && decidePlanMut.variables?.epicIssueId) ||
    (updateIssueMut.isPending && updateIssueMut.variables?.issueId) ||
    null;
  const bulkIds = approveManyMut.isPending ? (approveManyMut.variables ?? null) : null;

  const { plans, reviewGroups, reviewCount, blocked } = useMemo(() => {
    const byId = new Map(issues.map((i) => [i.id, i]));
    // Integridade referencial (P0-15): conta só filhos REAIS e acionáveis (não
    // cancelados). Plano fantasma = épico marcado 'pending' mas sem filho válido.
    const childCount = new Map<string, number>();
    for (const i of issues) {
      if (i.parentIssueId && i.status !== 'cancelled')
        childCount.set(i.parentIssueId, (childCount.get(i.parentIssueId) ?? 0) + 1);
    }
    const plans = issues
      // Épico já concluído/cancelado nunca pede aprovação (evita pendência órfã).
      .filter((i) => i.status !== 'done' && i.status !== 'cancelled')
      .filter((i) => planNeedsApproval(i, childCount.get(i.id) ?? 0))
      .map((i) => ({ issue: i, steps: childCount.get(i.id) ?? 0 }));

    // Em revisão, agrupado por task pai (épica). Subtasks órfãs caem num grupo
    // "Outras revisões" (parent = null).
    //
    // O Inbox mostra SÓ o que precisa de aprovação REAL: issues `in_review`
    // aguardando um aprovador obrigatório (gate de approver). As que estão em
    // revisão AUTOMÁTICA pela cadeia reports_to (um agente revisor foi acionado,
    // marcado por `metadata.review`) NÃO entram — o sistema resolve sozinho, e
    // antes elas apareciam "pra aprovar" e sumiam quando o agente aprovava.
    const reviews = issues.filter(
      (i) =>
        i.status === 'in_review' &&
        !(i.metadata as { review?: unknown } | null | undefined)?.review,
    );
    const groupMap = new Map<string, { parent: Issue | null; items: Issue[] }>();
    for (const i of reviews) {
      const parent = i.parentIssueId ? (byId.get(i.parentIssueId) ?? null) : null;
      const key = parent?.id ?? '__none__';
      const g = groupMap.get(key) ?? { parent, items: [] };
      g.items.push(i);
      groupMap.set(key, g);
    }
    const reviewGroups = Array.from(groupMap.entries()).map(([key, g]) => ({ key, ...g }));

    const blocked = issues.filter((i) => i.status === 'blocked');
    return { plans, reviewGroups, reviewCount: reviews.length, blocked };
  }, [issues]);

  const failedReviews = useMemo(
    () => activity.filter((e) => e.kind === 'code_review.failed').slice(0, 5),
    [activity],
  );

  // Propostas pendentes (ex.: hiring plan) — atividade 'proposal.pending'.
  // Dedup por sessão (mantém a mais recente). Resolve quando o time já foi
  // criado (existe agente não-CEO) ou quando dispensada.
  const teamAlreadyBuilt = agents.some((a) => !a.isOrchestrator);
  const proposals = useMemo(() => {
    const bySession = new Map<string, (typeof activity)[number]>();
    for (const e of activity) {
      if (e.kind !== 'proposal.pending' || !e.subjectId) continue;
      const prev = bySession.get(e.subjectId);
      if (!prev || e.createdAt > prev.createdAt) bySession.set(e.subjectId, e);
    }
    return Array.from(bySession.values());
  }, [activity]);

  // Dispensa local (localStorage) — esconde itens de "Precisam de atenção" sem
  // alterar a issue. sig = updatedAt (issue reaparece se mudar) ou id (evento).
  const dismissedMap = useInboxDismissStore((s) => s.dismissed);
  const dismiss = useInboxDismissStore((s) => s.dismiss);
  const dismissMany = useInboxDismissStore((s) => s.dismissMany);
  const isDismissed = (key: string, sig: string) => dismissedMap[key] === sig;

  const blockedVisible = blocked.filter((i) => !isDismissed(`issue:${i.id}`, i.updatedAt));
  const failedVisible = failedReviews.filter((e) => !isDismissed(`act:${e.id}`, e.id));
  const assignmentBySource = new Map(assignments.map((a) => [a.sourceId, a]));
  const proposalsVisible = proposals.filter((e) => {
    if (isDismissed(`act:${e.id}`, e.id)) return false;
    const payload = e.payload as { type?: string; sourceId?: string } | undefined;
    if (payload?.type === 'hiring' && teamAlreadyBuilt) return false;
    if (payload?.type === 'source-specialist' && payload.sourceId) {
      return assignmentBySource.get(payload.sourceId)?.needsNewAgent ?? true;
    }
    return true;
  });
  const attentionCount = blockedVisible.length + failedVisible.length;

  const agentName = (id: string | null) => agents.find((a) => a.id === id)?.name;
  const goIssue = (i: Issue) => navigate(`/issues/${prefix}-${i.issueKey}`);
  const total = plans.length + reviewCount + attentionCount + proposalsVisible.length;

  const clearAttention = () => {
    dismissMany([
      ...blockedVisible.map((i) => ({ key: `issue:${i.id}`, sig: i.updatedAt })),
      ...failedVisible.map((e) => ({ key: `act:${e.id}`, sig: e.id })),
    ]);
    toast.info(t('issues.inbox.toastInboxClearedTitle'), t('issues.inbox.toastInboxClearedBody'));
  };

  return (
    <PageShell title={t('issues.inbox.title')} description={t('issues.inbox.description')}>
      {!activeWorkspace ? (
        <Centered>{t('issues.inbox.noActiveWorkspace')}</Centered>
      ) : issuesQuery.isPending ? (
        <InboxSkeleton t={t} />
      ) : total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-1">
            <Check className="h-5 w-5 text-accent-green" />
          </span>
          <div className="mt-3 text-[13px] font-medium text-text-primary">
            {t('issues.inbox.allClearTitle')}
          </div>
          <div className="mt-1 max-w-md text-[12px] text-text-muted">
            {t('issues.inbox.allClearBody')}
          </div>
        </div>
      ) : (
        <div className="thin-scrollbar flex-1 space-y-7 overflow-y-auto px-6 py-5">
          {proposalsVisible.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
                {t('issues.inbox.proposalsTitle')}
              </h2>
              <div className="overflow-hidden rounded-lg border border-hairline">
                {proposalsVisible.map((e) => {
                  const payload = e.payload as
                    | ({ type?: string; sourceId?: string } & Partial<SourceAgentAssignment> &
                        SentryProposalPayload &
                        ObservabilityProposalPayload)
                    | undefined;
                  if (payload?.type === 'sentry-issue' && payload.issueId) {
                    const busy =
                      analyzeSentryMut.isPending && analyzeSentryMut.variables?.activityId === e.id;
                    return (
                      <DecisionRow
                        key={e.id}
                        accent="bg-accent-red"
                        icon={<SentryIcon className="h-4 w-4 shrink-0 text-accent-red" />}
                        title={e.title}
                        meta={t('issues.inbox.sentryProposalMeta', {
                          level: payload.level ?? 'error',
                          count: payload.count ?? 0,
                        })}
                        onOpen={() => navigate('/sentry')}
                        primary={{
                          label: t('issues.inbox.analyzeFix'),
                          tone: 'green',
                          onClick: () =>
                            analyzeSentryMut.mutate({
                              issueId: payload.issueId!,
                              agentId: payload.agentId ?? null,
                              activityId: e.id,
                            }),
                        }}
                        secondary={{
                          label: t('pages.sentryErrors.openInSentry'),
                          onClick: () =>
                            payload.permalink && window.open(payload.permalink, '_blank'),
                        }}
                        onDismiss={() => dismiss(`act:${e.id}`, e.id)}
                        busy={busy}
                      />
                    );
                  }
                  if (
                    payload?.type === 'observability-signal' &&
                    payload.provider &&
                    payload.signal
                  ) {
                    const ProviderIcon = payload.provider === 'new_relic' ? Activity : Signal;
                    const providerName =
                      payload.provider === 'new_relic' ? 'New Relic' : 'Better Stack';
                    const busy =
                      analyzeObservabilityMut.isPending &&
                      analyzeObservabilityMut.variables?.activityId === e.id;
                    return (
                      <DecisionRow
                        key={e.id}
                        accent={
                          payload.signal.kind === 'incident' ? 'bg-accent-yellow' : 'bg-accent-blue'
                        }
                        icon={<ProviderIcon className="h-4 w-4 shrink-0 text-accent-blue" />}
                        title={e.title}
                        meta={t('issues.inbox.signalMeta', {
                          provider: providerName,
                          kind: payload.signal.kind,
                          scope:
                            payload.signal.service ??
                            payload.signal.severity ??
                            t('issues.inbox.signalScopeFallback'),
                        })}
                        onOpen={() =>
                          navigate(
                            `/observability/${payload.provider}/${encodeURIComponent(payload.signal!.id)}`,
                          )
                        }
                        primary={{
                          label: t('issues.inbox.analyzeFix'),
                          tone: 'green',
                          onClick: () =>
                            analyzeObservabilityMut.mutate({
                              provider: payload.provider!,
                              signal: payload.signal!,
                              agentId: payload.agentId ?? null,
                              activityId: e.id,
                            }),
                        }}
                        secondary={{
                          label: t('common.open'),
                          onClick: () => {
                            if (payload.signal?.url) window.open(payload.signal.url, '_blank');
                            else
                              navigate(
                                `/observability/${payload.provider}/${encodeURIComponent(
                                  payload.signal!.id,
                                )}`,
                              );
                          },
                        }}
                        onDismiss={() => dismiss(`act:${e.id}`, e.id)}
                        busy={busy}
                      />
                    );
                  }
                  const isSourceSpecialist =
                    payload?.type === 'source-specialist' && payload.sourceId;
                  if (isSourceSpecialist) {
                    const busy =
                      createSpecialistMut.isPending &&
                      createSpecialistMut.variables?.activityId === e.id;
                    return (
                      <DecisionRow
                        key={e.id}
                        accent="bg-accent-blue"
                        icon={<GitPullRequest className="h-4 w-4 shrink-0 text-accent-blue" />}
                        title={e.title}
                        meta={
                          payload.reason ??
                          t('issues.inbox.sourceSpecialistMeta', {
                            source: payload.sourceLabel ?? t('issues.inbox.sourceFallback'),
                          })
                        }
                        onOpen={() => navigate('/knowledge')}
                        primary={{
                          label: t('issues.inbox.approveAndCreate'),
                          tone: 'green',
                          onClick: () =>
                            createSpecialistMut.mutate({
                              sourceId: payload.sourceId!,
                              activityId: e.id,
                            }),
                        }}
                        secondary={{
                          label: t('issues.inbox.viewKnowledge'),
                          onClick: () => navigate('/knowledge'),
                        }}
                        onDismiss={() => dismiss(`act:${e.id}`, e.id)}
                        busy={busy}
                      />
                    );
                  }
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => navigate(`/session/${e.subjectId}`)}
                      className="flex w-full items-center gap-3 border-b border-hairline-soft px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-surface-faint"
                    >
                      <GitPullRequest className="h-4 w-4 shrink-0 text-accent-blue" />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-primary">
                        {e.title}
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-text-faint" />
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* 1. Planos aguardando aprovação */}
          {plans.length > 0 && (
            <Section
              icon={<ListChecks className="h-3.5 w-3.5 text-accent-purple" />}
              title={t('issues.inbox.plansSection')}
              count={plans.length}
            >
              {plans.map(({ issue, steps }) => (
                <DecisionRow
                  key={issue.id}
                  accent="bg-accent-purple"
                  title={issue.title}
                  meta={t('issues.inbox.planMeta', {
                    ref: `${prefix}-${issue.issueKey}`,
                    steps,
                    label:
                      steps !== 1 ? t('issues.inbox.stepPlural') : t('issues.inbox.stepSingular'),
                  })}
                  onOpen={() => goIssue(issue)}
                  busy={pendingId === issue.id}
                  primary={{
                    label: t('issues.inbox.approveAndExecute'),
                    tone: 'green',
                    onClick: () =>
                      decidePlanMut.mutate({ epicIssueId: issue.id, decision: 'approve' }),
                  }}
                  secondary={{ label: t('issues.inbox.viewPlan'), onClick: () => goIssue(issue) }}
                />
              ))}
            </Section>
          )}

          {/* 2. Issues em revisão — agrupadas por task pai, com Aprovar todos */}
          {reviewCount > 0 && (
            <Section
              icon={<CircleAlert className="h-3.5 w-3.5 text-accent-yellow" />}
              title={t('issues.inbox.inReviewSection')}
              count={reviewCount}
              bare
            >
              {reviewGroups.map((g) => (
                <ReviewGroup
                  key={g.key}
                  parent={g.parent}
                  items={g.items}
                  prefix={prefix}
                  agentName={agentName}
                  onOpen={goIssue}
                  onApprove={(id) => updateIssueMut.mutate({ issueId: id, status: 'done' })}
                  onReject={(id) => updateIssueMut.mutate({ issueId: id, status: 'in_progress' })}
                  onApproveAll={(ids) => approveManyMut.mutate(ids)}
                  pendingId={pendingId}
                  bulkBusy={!!bulkIds && g.items.some((i) => bulkIds.includes(i.id))}
                  t={t}
                />
              ))}
            </Section>
          )}

          {/* 3. Bloqueios e falhas — dispensáveis (não têm aprovar/recusar) */}
          {attentionCount > 0 && (
            <Section
              icon={<CircleSlash className="h-3.5 w-3.5 text-accent-red" />}
              title={t('issues.inbox.attentionSection')}
              count={attentionCount}
              action={
                <button
                  type="button"
                  onClick={clearAttention}
                  className="rounded-md px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary"
                >
                  {t('issues.inbox.clear')}
                </button>
              }
            >
              {blockedVisible.map((issue) => {
                const ag = agentName(issue.assigneeAgentId);
                return (
                  <DecisionRow
                    key={issue.id}
                    accent="bg-accent-red"
                    title={issue.title}
                    meta={
                      ag
                        ? t('issues.inbox.blockedMetaAgent', {
                            ref: `${prefix}-${issue.issueKey}`,
                            agent: ag,
                          })
                        : t('issues.inbox.blockedMeta', { ref: `${prefix}-${issue.issueKey}` })
                    }
                    onOpen={() => goIssue(issue)}
                    onDismiss={() => dismiss(`issue:${issue.id}`, issue.updatedAt)}
                  />
                );
              })}
              {failedVisible.map((ev) => (
                <DecisionRow
                  key={ev.id}
                  accent="bg-accent-red"
                  icon={<GitPullRequest className="h-3.5 w-3.5 text-text-muted" />}
                  title={ev.title}
                  meta={t('issues.inbox.codeReviewFailed')}
                  onOpen={() => navigate('/code-reviews')}
                  onDismiss={() => dismiss(`act:${ev.id}`, ev.id)}
                />
              ))}
            </Section>
          )}
        </div>
      )}
    </PageShell>
  );
}

function Section({
  icon,
  title,
  count,
  bare,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  /** Quando true, não envolve os filhos num card único — eles trazem o próprio. */
  bare?: boolean;
  /** Ação à direita do cabeçalho (ex.: "Limpar"). */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 px-1">
        {icon}
        <h2 className="text-[12px] font-semibold text-text-primary">{title}</h2>
        <span className="rounded-full bg-surface-active px-1.5 text-[10px] font-medium text-text-muted">
          {count}
        </span>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {bare ? (
        <div className="space-y-3">{children}</div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-hairline bg-surface-whisper">
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * Grupo de subtasks em revisão sob uma task pai (épica). Cabeçalho com o nome
 * da task + "Aprovar todos"; cada subtask traz ícones ✓ (aprovar) e ✗ (cancelar
 * / pedir ajustes). Subtasks órfãs (sem pai) caem no grupo "Outras revisões".
 */
function ReviewGroup({
  parent,
  items,
  prefix,
  agentName,
  onOpen,
  onApprove,
  onReject,
  onApproveAll,
  pendingId,
  bulkBusy,
  t,
}: {
  parent: Issue | null;
  items: Issue[];
  prefix: string;
  agentName: (id: string | null) => string | undefined;
  onOpen: (i: Issue) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onApproveAll: (ids: string[]) => void;
  pendingId: string | false | null;
  bulkBusy: boolean;
  t: TFunction;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface-whisper">
      {/* Cabeçalho do grupo (task pai) */}
      <div className="flex items-center gap-2.5 border-b border-hairline-faint bg-surface-faint px-4 py-2.5">
        <ListChecks className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        <button
          type="button"
          onClick={() => parent && onOpen(parent)}
          disabled={!parent}
          className="min-w-0 flex-1 truncate text-left text-[12px] font-semibold text-text-primary enabled:hover:text-accent-blue"
          title={parent?.title}
        >
          {parent ? parent.title : t('issues.inbox.otherReviews')}
        </button>
        <span className="shrink-0 font-mono text-[10px] text-text-faint">
          {parent ? `${prefix}-${parent.issueKey} · ` : ''}
          {t('issues.inbox.inReviewCount', { n: items.length })}
        </span>
        <button
          type="button"
          onClick={() => onApproveAll(items.map((i) => i.id))}
          disabled={bulkBusy || items.length === 0}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent-green/15 px-2.5 py-1 text-[11px] font-semibold text-accent-green transition-colors hover:bg-accent-green/25 disabled:opacity-50"
        >
          {bulkBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCheck className="h-3.5 w-3.5" />
          )}
          {t('issues.inbox.approveAll')}
        </button>
      </div>

      {/* Subtasks */}
      {items.map((issue) => {
        const busy = pendingId === issue.id || bulkBusy;
        const ag = agentName(issue.assigneeAgentId);
        return (
          <div
            key={issue.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(issue)}
            onKeyDown={(e) => e.key === 'Enter' && onOpen(issue)}
            className="flex cursor-pointer items-center gap-3 border-b border-hairline-soft px-4 py-2.5 transition-colors last:border-b-0 hover:bg-surface-subtle"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-yellow" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] text-text-primary">{issue.title}</div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-text-faint">
                {prefix}-{issue.issueKey}
                {ag ? ` · ${ag}` : ''}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <IconBtn
                tone="green"
                title={t('issues.inbox.approve')}
                busy={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onApprove(issue.id);
                }}
                icon={<Check className="h-3.5 w-3.5" />}
              />
              <IconBtn
                tone="red"
                title={t('issues.inbox.rejectTooltip')}
                busy={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onReject(issue.id);
                }}
                icon={<X className="h-3.5 w-3.5" />}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function IconBtn({
  tone,
  title,
  icon,
  onClick,
  busy,
}: {
  tone: 'green' | 'red';
  title: string;
  icon: ReactNode;
  onClick: (e: React.MouseEvent) => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={busy}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-md border transition-colors disabled:opacity-40',
        tone === 'green'
          ? 'border-accent-green/25 text-accent-green hover:bg-accent-green/15'
          : 'border-accent-red/25 text-accent-red hover:bg-accent-red/15',
      )}
    >
      {icon}
    </button>
  );
}

type RowAction = { label: string; onClick: () => void; tone?: 'green' };

function DecisionRow({
  accent,
  icon,
  title,
  meta,
  onOpen,
  primary,
  secondary,
  onDismiss,
  busy,
}: {
  accent: string;
  icon?: ReactNode;
  title: string;
  meta: string;
  onOpen: () => void;
  primary?: RowAction;
  secondary?: RowAction;
  /** Dispensar item do Inbox (X). */
  onDismiss?: () => void;
  busy?: boolean;
}) {
  const { t } = useT();
  const dismissLabel = t('issues.inbox.dismiss');
  const act = (e: React.MouseEvent, fn: () => void) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className="group flex cursor-pointer items-center gap-3 border-b border-hairline-soft px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-subtle"
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', accent)} />
      {icon}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-text-primary">{title}</div>
        <div className="mt-0.5 truncate font-mono text-[10.5px] text-text-faint">{meta}</div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {secondary && (
          <button
            type="button"
            onClick={(e) => act(e, secondary.onClick)}
            disabled={busy}
            className="rounded-md border border-hairline-heavy px-2.5 py-1.5 text-[11.5px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
          >
            {secondary.label}
          </button>
        )}
        {primary && (
          <button
            type="button"
            onClick={(e) => act(e, primary.onClick)}
            disabled={busy}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11.5px] font-semibold transition-colors disabled:opacity-50',
              primary.tone === 'green'
                ? 'bg-accent-green text-black hover:bg-accent-green/90'
                : 'bg-white text-black hover:bg-white/90',
            )}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {primary.label}
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            title={dismissLabel}
            aria-label={dismissLabel}
            onClick={(e) => act(e, onDismiss)}
            className="grid h-7 w-7 place-items-center rounded-md text-text-faint opacity-0 transition-opacity hover:bg-surface-active hover:text-text-primary group-hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        {!primary && !secondary && !onDismiss && (
          <ChevronRight className="h-4 w-4 text-text-faint opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </div>
    </div>
  );
}

function PageShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <div className="window-drag border-b border-hairline-soft px-8 py-5">
          <h1 className="text-[18px] font-semibold tracking-tight text-text-primary">{title}</h1>
          <p className="mt-0.5 text-[12.5px] text-text-muted">{description}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Skeleton de carregamento do Inbox — um cabeçalho de seção + algumas linhas
 *  de decisão em pulse, no mesmo gabarito dos cards reais. */
function InboxSkeleton({ t }: { t: TFunction }) {
  return (
    <div
      className="thin-scrollbar flex-1 space-y-7 overflow-y-auto px-6 py-5"
      aria-busy="true"
      aria-label={t('issues.inbox.loadingAria')}
    >
      {Array.from({ length: 2 }).map((_, s) => (
        <section key={s}>
          <div className="mb-2 flex items-center gap-2 px-1">
            <Skeleton className="h-3.5 w-3.5 rounded-full" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-4 w-5 rounded-full" />
          </div>
          <div className="overflow-hidden rounded-xl border border-hairline bg-surface-whisper">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 border-b border-hairline-soft px-4 py-3 last:border-b-0"
              >
                <Skeleton className="h-1.5 w-1.5 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3" style={{ width: `${45 + ((i * 17) % 35)}%` }} />
                  <Skeleton className="h-2.5 w-24" />
                </div>
                <Skeleton className="h-7 w-28 rounded-md" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
      {children}
    </div>
  );
}

function issuePrefix(workspaceName: string): string {
  const letters = workspaceName.match(/[A-Z]/g);
  if (letters && letters.length >= 2) return letters.slice(0, 3).join('');
  return workspaceName.slice(0, 3).toUpperCase();
}
