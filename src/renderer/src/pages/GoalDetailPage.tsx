import { useState, useEffect, type ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Target, Sparkles, Check, Loader2, ArrowLeft, ChevronRight, Plus } from 'lucide-react';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { CreateGoalModal } from '@renderer/pages/GoalsPage';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useT, type TFunction } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';
import type { Issue, IssueStatus } from '@shared/types';

// Cor (token) por status — usada nos pontos da timeline, na barra de atingimento e
// na legenda. Reaproveita os labels de `dashboard.status.*` (já existentes).
const STATUS_META: Record<IssueStatus, { dot: string; bar: string; key: string }> = {
  done: { dot: 'bg-accent-green', bar: 'bg-accent-green', key: 'done' },
  in_review: { dot: 'bg-accent-purple', bar: 'bg-accent-purple', key: 'in_review' },
  in_progress: { dot: 'bg-accent-blue', bar: 'bg-accent-blue', key: 'in_progress' },
  blocked: { dot: 'bg-accent-red', bar: 'bg-accent-red', key: 'blocked' },
  todo: { dot: 'bg-text-secondary', bar: 'bg-surface-5', key: 'todo' },
  backlog: { dot: 'bg-text-faint', bar: 'bg-surface-4', key: 'backlog' },
  cancelled: { dot: 'bg-text-faint', bar: 'bg-surface-3', key: 'cancelled' },
};
// Ordem de exibição na barra/legenda (concluído → bloqueado → andamento → pendente).
const STATUS_ORDER: IssueStatus[] = [
  'done',
  'in_review',
  'in_progress',
  'blocked',
  'todo',
  'backlog',
  'cancelled',
];

export function GoalDetailPage() {
  const { t } = useT();
  const { goalId } = useParams<{ goalId: string }>();
  const navigate = useNavigate();
  const ws = useWorkspaceStore((s) => s.active);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [creatingSub, setCreatingSub] = useState(false);

  const goalsQuery = useQuery({
    queryKey: ['goals', ws?.id],
    enabled: !!ws,
    queryFn: () => window.orkestral['goal:list']({ workspaceId: ws!.id }),
  });
  const issuesQuery = useQuery({
    queryKey: ['issues', ws?.id],
    enabled: !!ws,
    queryFn: () => window.orkestral['issue:list']({ workspaceId: ws!.id }),
  });
  const agentsQuery = useQuery({
    queryKey: ['agents', ws?.id],
    enabled: !!ws,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: ws!.id }),
  });

  // Real-time: agente fecha issue via MCP → invalida pra barra/lista subirem.
  useEffect(() => {
    if (!ws) return;
    return window.orkestralEvents.onIssuesChanged((event) => {
      if (event.workspaceId !== ws.id) return;
      qc.invalidateQueries({ queryKey: ['goals', ws.id] });
      qc.invalidateQueries({ queryKey: ['issues', ws.id] });
    });
  }, [ws, qc]);

  const goals = goalsQuery.data ?? [];
  const goal = goals.find((g) => g.id === goalId);
  const subGoals = goals.filter((g) => g.parentGoalId === goalId);
  const issues = (issuesQuery.data ?? []).filter((i) => i.goalId === goalId);
  const agents = agentsQuery.data ?? [];
  const owner = agents.find((a) => a.id === goal?.ownerAgentId);
  // Conta só folhas (exclui épicas) — espelha recalcProgress no back.
  const epicIds = new Set(issues.map((i) => i.parentIssueId).filter(Boolean));
  const leafIssues = issues.filter((i) => !epicIds.has(i.id));
  const doneCount = leafIssues.filter((i) => i.status === 'done').length;
  const isDone = (goal?.progress ?? 0) >= 100 && leafIssues.length > 0;
  // Distribuição por status (folhas) — alimenta a barra de atingimento + legenda.
  const counts = STATUS_ORDER.map((s) => ({
    status: s,
    n: leafIssues.filter((i) => i.status === s).length,
  })).filter((c) => c.n > 0);

  async function act(kind: 'plan' | 'verify') {
    if (!goal) return;
    setBusy(true);
    try {
      const res = await window.orkestral[kind === 'plan' ? 'goal:plan' : 'goal:verify']({
        goalId: goal.id,
      });
      if (res?.sessionId) navigate(`/session/${res.sessionId}`);
    } catch (err) {
      console.error(`[goal:${kind}] erro:`, err);
    } finally {
      setBusy(false);
    }
  }

  if (!goal) {
    return (
      <Shell title={t('pages.goalDetail.fallbackTitle')} description="">
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {goalsQuery.isPending ? t('pages.goalDetail.loading') : t('pages.goalDetail.notFound')}
        </div>
      </Shell>
    );
  }

  const hasIssues = leafIssues.length > 0;
  const progress = Math.max(0, Math.min(100, goal.progress));

  // Ação primária no header: planejar quando AINDA não há issues; verificar quando
  // 100%. Com issues em andamento, nenhuma ação (a barra + timeline contam a história).
  const actionButton =
    goal.status === 'active' ? (
      isDone ? (
        <HeaderAction
          onClick={() => act('verify')}
          busy={busy}
          icon={<Check className="h-3.5 w-3.5" />}
          label={t('pages.goalDetail.verifyCompletion')}
          tone="green"
        />
      ) : !hasIssues ? (
        <HeaderAction
          onClick={() => act('plan')}
          busy={busy}
          icon={<Sparkles className="h-3.5 w-3.5" />}
          label={t('pages.goalDetail.planWithCeo')}
          tone="purple"
        />
      ) : null
    ) : null;

  return (
    <Shell
      title={goal.title}
      description={goal.description ?? t('pages.goalDetail.fallbackDescription')}
      headerRight={actionButton}
    >
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="flex flex-col gap-6">
          <button
            type="button"
            onClick={() => navigate('/goals')}
            className="inline-flex w-fit items-center gap-1.5 text-[12px] text-text-muted transition-colors hover:text-text-primary"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> {t('pages.goalDetail.backToGoals')}
          </button>

          {/* ── Painel de visão geral: anel de progresso + atingimento por status ── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* Anel de progresso */}
            <div className="flex items-center gap-4 rounded-xl border border-hairline bg-surface-faint p-5">
              <ProgressRing progress={progress} />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <StatusPill status={goal.status} t={t} />
                </div>
                <div className="mt-1.5 text-[13px] font-medium text-text-primary">
                  {t('pages.goalDetail.doneOfTotal', { done: doneCount, total: leafIssues.length })}
                </div>
                {owner && (
                  <span className="mt-1.5 inline-flex items-center gap-1.5 text-[11.5px] text-text-secondary">
                    <AgentAvatar
                      seed={owner.avatarSeed}
                      name={owner.name}
                      size={16}
                      rounded="full"
                    />
                    {owner.name}
                  </span>
                )}
                {goal.dueDate && (
                  <div className="mt-1 text-[11px] text-text-muted">
                    {t('pages.goalDetail.due', {
                      date: new Date(goal.dueDate).toLocaleDateString(),
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Atingimento por status (barra empilhada + legenda) */}
            <div className="rounded-xl border border-hairline bg-surface-faint p-5 lg:col-span-2">
              <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-text-faint">
                {t('pages.goalDetail.byStatus')}
              </div>
              {hasIssues ? (
                <>
                  <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-background">
                    {counts.map((c) => (
                      <motion.div
                        key={c.status}
                        className={cn('h-full', STATUS_META[c.status].bar)}
                        initial={{ width: 0 }}
                        animate={{ width: `${(c.n / leafIssues.length) * 100}%` }}
                        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                        title={`${c.n} ${t(`dashboard.status.${STATUS_META[c.status].key}`)}`}
                      />
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
                    {counts.map((c) => (
                      <span
                        key={c.status}
                        className="inline-flex items-center gap-1.5 text-[11.5px] text-text-secondary"
                      >
                        <span className={cn('h-2 w-2 rounded-full', STATUS_META[c.status].dot)} />
                        {t(`dashboard.status.${STATUS_META[c.status].key}`)}
                        <span className="tabular-nums text-text-muted">{c.n}</span>
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <div className="py-3 text-[12.5px] text-text-muted">
                  {t('pages.goalDetail.noIssuesYet')}
                </div>
              )}
            </div>
          </div>

          {/* ── Timeline das issues do objetivo ── */}
          <section>
            <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-text-faint">
              {t('pages.goalDetail.linkedIssues', { count: issues.length })}
            </div>
            {issues.length === 0 ? (
              <div className="rounded-xl border border-dashed border-hairline bg-surface-faint px-4 py-10 text-center text-[12.5px] text-text-muted">
                {t('pages.goalDetail.noIssues')}
              </div>
            ) : (
              <div className="rounded-xl border border-hairline bg-surface-faint px-5 py-4">
                <ol className="relative ml-1">
                  {/* Linha vertical da timeline */}
                  <span className="absolute bottom-2 left-[5px] top-2 w-px bg-hairline-strong" />
                  {issues.map((i) => (
                    <TimelineNode
                      key={i.id}
                      issue={i}
                      agents={agents}
                      prefix={issuePrefix(ws?.name)}
                      t={t}
                      onClick={() => navigate(`/issues/${i.issueKey}`)}
                    />
                  ))}
                </ol>
              </div>
            )}
          </section>

          {/* ── Sub-objetivos ── */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-text-faint">
                {t('pages.goalDetail.subGoals', { count: subGoals.length })}
              </span>
              <button
                type="button"
                onClick={() => setCreatingSub(true)}
                className="inline-flex items-center gap-1 text-[11.5px] text-text-muted transition-colors hover:text-text-primary"
              >
                <Plus className="h-3.5 w-3.5" /> {t('pages.goalDetail.new')}
              </button>
            </div>
            {subGoals.length === 0 ? (
              <div className="rounded-xl border border-dashed border-hairline bg-surface-faint px-4 py-6 text-center text-[12.5px] text-text-muted">
                {t('pages.goalDetail.noSubGoals')}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {subGoals.map((sg) => (
                  <button
                    key={sg.id}
                    type="button"
                    onClick={() => navigate(`/goals/${sg.id}`)}
                    className="flex items-center gap-2.5 rounded-lg border border-hairline bg-surface-elevated px-3 py-2 text-left transition-colors hover:border-border-strong hover:bg-surface-2"
                  >
                    <Target className="h-3.5 w-3.5 shrink-0 text-accent-purple" />
                    <span className="flex-1 truncate text-[13px] text-text-primary">
                      {sg.title}
                    </span>
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-background">
                      <div
                        className="h-full bg-accent-green"
                        style={{ width: `${Math.max(0, Math.min(100, sg.progress))}%` }}
                      />
                    </div>
                    <span className="w-9 text-right text-[11px] tabular-nums text-text-muted">
                      {sg.progress}%
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {creatingSub && ws && (
        <CreateGoalModal
          workspaceId={ws.id}
          agents={agents}
          parentGoalId={goal.id}
          onClose={() => setCreatingSub(false)}
          onCreated={() => {
            setCreatingSub(false);
            qc.invalidateQueries({ queryKey: ['goals'] });
          }}
        />
      )}
    </Shell>
  );
}

/** Anel de progresso (SVG): círculo de fundo + arco verde proporcional + % no centro. */
function ProgressRing({ progress }: { progress: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const offset = c - (progress / 100) * c;
  return (
    <div className="relative h-[68px] w-[68px] shrink-0">
      <svg viewBox="0 0 64 64" className="h-full w-full -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" className="stroke-surface-2" />
        <motion.circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          className="stroke-accent-green"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-[14px] font-semibold tabular-nums text-text-primary">
        {progress}%
      </span>
    </div>
  );
}

function HeaderAction({
  onClick,
  busy,
  icon,
  label,
  tone,
}: {
  onClick: () => void;
  busy: boolean;
  icon: ReactNode;
  label: string;
  tone: 'green' | 'purple';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[12px] font-medium transition-colors disabled:opacity-50',
        tone === 'green'
          ? 'border-accent-green/30 bg-accent-green/10 text-accent-green hover:bg-accent-green/20'
          : 'border-accent-purple/30 bg-accent-purple/10 text-accent-purple hover:bg-accent-purple/20',
      )}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {label}
    </button>
  );
}

function StatusPill({ status, t }: { status: 'active' | 'achieved' | 'archived'; t: TFunction }) {
  const map = {
    active: {
      label: t('pages.goalDetail.statusActive'),
      cls: 'border-accent-blue/30 bg-accent-blue/10 text-accent-blue',
    },
    achieved: {
      label: t('pages.goalDetail.statusAchieved'),
      cls: 'border-accent-green/30 bg-accent-green/10 text-accent-green',
    },
    archived: {
      label: t('pages.goalDetail.statusArchived'),
      cls: 'border-hairline-strong bg-surface-elevated text-text-muted',
    },
  }[status];
  return (
    <span
      className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium', map.cls)}
    >
      {map.label}
    </span>
  );
}

function issuePrefix(name?: string): string {
  return (
    (name || 'ORK')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 3)
      .toUpperCase() || 'ORK'
  );
}

/** Nó da timeline: marca de status na linha vertical + chave + título + responsável. */
function TimelineNode({
  issue,
  agents,
  prefix,
  t,
  onClick,
}: {
  issue: Issue;
  agents: Array<{ id: string; name: string; avatarSeed?: string | null }>;
  prefix: string;
  t: TFunction;
  onClick: () => void;
}) {
  const assignee = agents.find((a) => a.id === issue.assigneeAgentId);
  const meta = STATUS_META[issue.status];
  return (
    <li className="relative">
      <button
        type="button"
        onClick={onClick}
        className="group flex w-full flex-col gap-0.5 rounded-lg py-2 pl-6 pr-2 text-left transition-colors hover:bg-surface-2"
      >
        {/* Marca de status na linha vertical — alinhada à 1ª linha (título). */}
        <span
          className={cn(
            'absolute left-0 top-4 h-2.5 w-2.5 -translate-y-1/2 rounded-full ring-4 ring-surface-elevated',
            meta.dot,
          )}
          title={t(`dashboard.status.${meta.key}`)}
        />
        <div className="flex items-center gap-2.5">
          <span className="shrink-0 font-mono text-[10.5px] text-text-faint">
            {prefix}-{issue.displayKey ?? issue.issueKey}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-primary">
            {issue.title}
          </span>
          <span className="shrink-0 text-[10.5px] text-text-muted">
            {t(`dashboard.status.${meta.key}`)}
          </span>
          {assignee && (
            <AgentAvatar seed={assignee.avatarSeed} name={assignee.name} size={16} rounded="full" />
          )}
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-faint opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
        {/* Descrição: o que essa issue faz / o que aconteceu. */}
        {issue.description && (
          <div className="line-clamp-2 pr-6 text-[11px] leading-snug text-text-muted">
            {issue.description}
          </div>
        )}
      </button>
    </li>
  );
}

/** Shell local no MESMO padrão das outras páginas (header px-8 py-5, text-[18px]). */
function Shell({
  title,
  description,
  headerRight,
  children,
}: {
  title: string;
  description: string;
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col pb-4 pl-2 pr-4 pt-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <div className="window-drag flex items-start justify-between gap-3 border-b border-hairline-soft px-8 py-5">
          <div className="min-w-0">
            <h1 className="truncate text-[18px] font-semibold tracking-tight text-text-primary">
              {title}
            </h1>
            {description && (
              <p className="mt-0.5 truncate text-[12.5px] text-text-muted">{description}</p>
            )}
          </div>
          {headerRight && <div className="window-no-drag shrink-0">{headerRight}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}
