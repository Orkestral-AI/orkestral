import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { LayoutGrid, CircleDot, Bot, Activity, Heart, AlertCircle, Loader2 } from 'lucide-react';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { RunEconomicsCard } from '@renderer/components/dashboard/RunEconomicsCard';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useT, type TFunction } from '@renderer/i18n';
import type { IssueStatus } from '@shared/types';

const STATUS_ORDER: IssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
];

function statusLabel(t: TFunction, status: IssueStatus): string {
  return t(`dashboard.status.${status}`);
}

const STATUS_DOT: Record<IssueStatus, string> = {
  backlog: 'bg-text-muted',
  todo: 'bg-text-secondary',
  in_progress: 'bg-accent-blue',
  in_review: 'bg-accent-purple',
  blocked: 'bg-accent-red',
  done: 'bg-accent-green',
  cancelled: 'bg-text-faint',
};

export function DashboardPage() {
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const navigate = useNavigate();
  const { t } = useT();

  const issuesQuery = useQuery({
    queryKey: ['issues', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['issue:list']({ workspaceId: activeWorkspace!.id }),
  });
  const countsQuery = useQuery({
    queryKey: ['issue-counts', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['issue:counts-by-status']({ workspaceId: activeWorkspace!.id }),
  });
  const agentsQuery = useQuery({
    queryKey: ['agents', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: activeWorkspace!.id }),
  });
  const sessionsQuery = useQuery({
    queryKey: ['sessions', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['session:list']({ workspaceId: activeWorkspace!.id }),
  });

  const issues = issuesQuery.data ?? [];
  const counts = countsQuery.data;
  const agents = agentsQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];

  const liveAgents = agents.filter((a) => a.status === 'live').length;
  const pausedAgents = agents.filter((a) => a.status === 'paused').length;
  const openIssues = issues.filter((i) => i.status !== 'done' && i.status !== 'cancelled').length;
  const blockedIssues = issues.filter((i) => i.status === 'blocked').length;

  const recentIssues = issues.slice(0, 6);
  const recentSessions = sessions.slice(0, 5);

  if (!activeWorkspace) {
    return (
      <PageShell title={t('dashboard.title')} description={t('dashboard.overview')}>
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('dashboard.noActiveWorkspace')}
        </div>
      </PageShell>
    );
  }

  const isLoading = issuesQuery.isPending || agentsQuery.isPending || sessionsQuery.isPending;
  const isError = issuesQuery.isError || agentsQuery.isError || sessionsQuery.isError;

  if (isLoading || isError) {
    return (
      <PageShell
        title={t('dashboard.title')}
        description={t('dashboard.overviewNamed', { name: activeWorkspace.name })}
      >
        {isError ? (
          <div className="flex flex-1 items-center justify-center text-[13px] text-accent-red">
            {t('dashboard.loadError')}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-text-muted">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}
      </PageShell>
    );
  }

  return (
    <PageShell
      title={t('dashboard.title')}
      description={t('dashboard.overviewNamed', { name: activeWorkspace.name })}
    >
      <div className="thin-scrollbar flex-1 overflow-y-auto px-8 py-6">
        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            icon={CircleDot}
            label={t('dashboard.stats.openIssues')}
            value={String(openIssues)}
            onClick={() => navigate('/issues')}
          />
          <StatCard
            icon={AlertCircle}
            label={t('dashboard.stats.blocked')}
            value={String(blockedIssues)}
            accent={blockedIssues > 0 ? 'red' : undefined}
            onClick={() => navigate('/issues')}
          />
          <StatCard
            icon={Bot}
            label={t('dashboard.stats.activeAgents')}
            value={`${liveAgents + (agents.length - pausedAgents - liveAgents)}/${agents.length}`}
            hint={
              pausedAgents > 0 ? t('dashboard.stats.pausedHint', { n: pausedAgents }) : undefined
            }
            onClick={() => navigate('/agents')}
          />
          <StatCard
            icon={Heart}
            label={t('dashboard.stats.sessions')}
            value={String(sessions.length)}
            onClick={() => navigate('/')}
          />
        </div>

        {/* Issues by status */}
        {counts && (
          <Section title={t('dashboard.sections.issuesByStatus')}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
              {STATUS_ORDER.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => navigate('/issues')}
                  className="flex flex-col gap-1.5 rounded-lg border border-hairline-faint bg-surface-veil px-3 py-2.5 text-left transition-colors hover:bg-surface-hover"
                >
                  <div className="flex items-center gap-1.5">
                    <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[s])} />
                    <span className="text-[10.5px] uppercase tracking-wider text-text-muted">
                      {statusLabel(t, s)}
                    </span>
                  </div>
                  <span className="text-[18px] font-semibold tracking-tight text-text-primary">
                    {counts[s] ?? 0}
                  </span>
                </button>
              ))}
            </div>
          </Section>
        )}

        {/* Two columns: recent issues + recent sessions */}
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Section
            title={t('dashboard.sections.recentIssues')}
            action={{ label: t('dashboard.actions.viewAll'), onClick: () => navigate('/issues') }}
          >
            {recentIssues.length === 0 ? (
              <EmptyHint>{t('dashboard.empty.noIssues')}</EmptyHint>
            ) : (
              <div className="flex flex-col gap-1">
                {recentIssues.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => navigate('/issues')}
                    className="flex items-center gap-2 rounded-md border border-hairline-faint bg-surface-veil px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-surface-hover"
                  >
                    <span className="w-14 shrink-0 font-mono text-[10.5px] text-text-faint">
                      ORK-{i.issueKey}
                    </span>
                    <span
                      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[i.status])}
                    />
                    <span className="min-w-0 flex-1 truncate text-text-primary">{i.title}</span>
                  </button>
                ))}
              </div>
            )}
          </Section>

          <Section
            title={t('dashboard.sections.recentConversations')}
            action={{ label: t('dashboard.actions.new'), onClick: () => navigate('/') }}
          >
            {recentSessions.length === 0 ? (
              <EmptyHint>{t('dashboard.empty.noConversations')}</EmptyHint>
            ) : (
              <div className="flex flex-col gap-1">
                {recentSessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => navigate(`/session/${s.id}`)}
                    className="flex items-center gap-2 rounded-md border border-hairline-faint bg-surface-veil px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-surface-hover"
                  >
                    <Activity className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                    <span className="min-w-0 flex-1 truncate text-text-primary">{s.title}</span>
                    <span className="text-[10.5px] text-text-faint">
                      {fmtRelative(t, s.updatedAt)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Section>
        </div>

        {/* Agents grid */}
        <Section
          title={t('dashboard.sections.agents')}
          action={{ label: t('dashboard.actions.viewAgents'), onClick: () => navigate('/agents') }}
        >
          {agents.length === 0 ? (
            <EmptyHint>{t('dashboard.empty.noAgents')}</EmptyHint>
          ) : (
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              {agents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => navigate(`/agents/${a.id}`)}
                  className="flex items-center gap-2.5 rounded-md border border-hairline-faint bg-surface-veil px-3 py-2.5 text-left transition-colors hover:bg-surface-hover"
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-hairline-strong bg-surface-subtle">
                    <AgentAvatar seed={a.avatarSeed} name={a.name} size={14} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium text-text-primary">
                      {a.name}
                    </div>
                    {a.title && (
                      <div className="truncate text-[10.5px] text-text-muted">{a.title}</div>
                    )}
                  </div>
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      a.status === 'live' && 'bg-accent-green animate-pulse-dot',
                      a.status === 'paused' && 'bg-accent-yellow',
                      a.status === 'error' && 'bg-accent-red',
                      a.status === 'idle' && 'bg-text-muted',
                    )}
                  />
                </button>
              ))}
            </div>
          )}
        </Section>

        {/* Economia de execução — Forge local vs premium (números reais) */}
        <div className="mt-6">
          <RunEconomicsCard />
        </div>
      </div>
    </PageShell>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  accent,
  onClick,
}: {
  icon: typeof LayoutGrid;
  label: string;
  value: string;
  hint?: string;
  accent?: 'red';
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col gap-1.5 rounded-lg border border-hairline bg-surface-faint px-4 py-3 text-left transition-colors hover:bg-surface-1"
    >
      <div className="flex items-center gap-1.5">
        <Icon
          className={cn('h-3.5 w-3.5 text-text-muted', accent === 'red' && 'text-accent-red')}
        />
        <span className="text-[10.5px] uppercase tracking-wider text-text-faint">{label}</span>
      </div>
      <span
        className={cn(
          'text-[22px] font-semibold tracking-tight text-text-primary',
          accent === 'red' && 'text-accent-red',
        )}
      >
        {value}
      </span>
      {hint && <span className="text-[10.5px] text-text-muted">{hint}</span>}
    </button>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold tracking-tight text-text-primary">{title}</h2>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="text-[11.5px] text-text-muted hover:text-text-primary"
          >
            {action.label} →
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-hairline bg-surface-ghost px-3 py-4 text-center text-[12px] text-text-muted">
      {children}
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

function fmtRelative(t: TFunction, iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return t('dashboard.relative.now');
    if (mins < 60) return t('dashboard.relative.minutes', { n: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return t('dashboard.relative.hours', { n: hrs });
    return t('dashboard.relative.days', { n: Math.floor(hrs / 24) });
  } catch {
    return iso;
  }
}
