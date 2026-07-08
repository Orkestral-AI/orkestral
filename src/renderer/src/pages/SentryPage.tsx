import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Loader2,
  RefreshCw,
  Sparkles,
  ExternalLink,
  AlertTriangle,
  Search,
  Zap,
  MessageSquare,
} from 'lucide-react';
import { SentryIcon } from '@renderer/components/brand-icons';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useSentryViewStore } from '@renderer/stores/sentryViewStore';
import { useSentryAnalysisStore } from '@renderer/stores/sentryAnalysisStore';
import { toast } from '@renderer/stores/toastStore';
import { cn } from '@renderer/lib/utils';
import { useT, type Language } from '@renderer/i18n';

const LEVEL_COLOR: Record<string, string> = {
  fatal: 'border-accent-red/30 bg-accent-red/10 text-accent-red',
  error: 'border-accent-red/25 bg-accent-red/[0.08] text-accent-red',
  warning: 'border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow',
  info: 'border-accent-blue/25 bg-accent-blue/10 text-accent-blue',
  debug: 'border-hairline-heavy bg-surface-1 text-text-muted',
};

/** Cor da barrinha lateral por severidade (acento à esquerda do card). */
const LEVEL_BAR: Record<string, string> = {
  fatal: 'bg-accent-red',
  error: 'bg-accent-red/70',
  warning: 'bg-accent-yellow',
  info: 'bg-accent-blue',
  debug: 'bg-white/20',
};

function relativeTime(iso: string, lang: Language): string {
  const then = new Date(iso).getTime();
  if (!then) return '';
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (abs < hour) return rtf.format(Math.round(diff / min), 'minute');
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
  return rtf.format(Math.round(diff / day), 'day');
}

export function SentryPage() {
  const { t, lang } = useT();
  const navigate = useNavigate();
  const workspaceId = useWorkspaceStore((s) => s.active?.id);
  const markViewed = useSentryViewStore((s) => s.markViewed);
  const analyzed = useSentryAnalysisStore((s) => s.analyzed);
  const markAnalyzed = useSentryAnalysisStore((s) => s.markAnalyzed);

  const accountQuery = useQuery({
    queryKey: ['sentry', 'account', workspaceId],
    queryFn: () => window.orkestral['sentry:get-account']({ workspaceId: workspaceId! }),
    enabled: !!workspaceId,
  });
  const automationQuery = useQuery({
    queryKey: ['sentry', 'automation', workspaceId],
    queryFn: () => window.orkestral['sentry:get-automation']({ workspaceId: workspaceId! }),
    enabled: !!workspaceId && !!accountQuery.data,
  });
  const refreshMin = automationQuery.data?.refreshIntervalMin ?? 5;
  const issuesQuery = useQuery({
    queryKey: ['sentry', 'issues', workspaceId],
    queryFn: () => window.orkestral['sentry:list-issues']({ workspaceId: workspaceId!, limit: 50 }),
    enabled: !!workspaceId && !!accountQuery.data,
    refetchOnWindowFocus: false,
    refetchInterval: refreshMin > 0 ? refreshMin * 60_000 : false,
  });

  // Abriu a tela → zera o badge de notificação da sidebar.
  useEffect(() => {
    if (issuesQuery.data) markViewed();
  }, [issuesQuery.data, markViewed]);

  const analyzeMutation = useMutation({
    mutationFn: (issueId: string) => {
      if (!workspaceId) throw new Error('no workspace');
      return window.orkestral['sentry:analyze-issue']({ workspaceId, issueId });
    },
    onSuccess: (res, issueId) => {
      markAnalyzed(issueId, res.sessionId);
      navigate(`/session/${res.sessionId}`);
    },
    onError: (err) =>
      toast.error(
        t('pages.sentryErrors.analyzeFailed'),
        err instanceof Error ? err.message : String(err),
      ),
  });

  const account = accountQuery.data ?? null;
  const issues = useMemo(() => issuesQuery.data ?? [], [issuesQuery.data]);
  const [project, setProject] = useState('');
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');

  const projects = useMemo(
    () => Array.from(new Set(issues.map((i) => i.project).filter(Boolean))).sort(),
    [issues],
  );
  const levels = useMemo(
    () => Array.from(new Set(issues.map((i) => i.level).filter(Boolean))),
    [issues],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return issues.filter((i) => {
      if (project && i.project !== project) return false;
      if (level && i.level !== level) return false;
      if (q && !`${i.title} ${i.culprit} ${i.shortId}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [issues, project, level, search]);

  return (
    <PageShell>
      <div className="window-drag flex items-end justify-between border-b border-hairline-soft px-8 pt-5">
        <div className="flex items-center gap-2.5 pb-3">
          <SentryIcon className="h-5 w-5 text-text-secondary" />
          <div>
            <h1 className="text-[18px] font-semibold tracking-tight text-text-primary">
              {t('pages.sentryErrors.title')}
            </h1>
            <p className="mt-0.5 text-[12.5px] text-text-muted">
              {account
                ? t('pages.sentryErrors.subtitleConnected', {
                    org: account.orgSlug,
                    project: account.projectSlug ?? t('pages.sentryErrors.allProjects'),
                  })
                : t('pages.sentryErrors.subtitle')}
            </p>
          </div>
        </div>
        {account && (
          <div className="window-no-drag mb-3 flex items-center gap-2">
            {refreshMin > 0 && (
              <span className="hidden items-center gap-1 text-[11px] text-text-faint sm:inline-flex">
                <span className="h-1.5 w-1.5 rounded-full bg-accent-green/70" />
                {t('pages.sentryErrors.autoOn', { n: refreshMin })}
              </span>
            )}
            <button
              type="button"
              onClick={() => navigate('/sentry/automations')}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-faint px-2.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary"
            >
              <Zap className="h-3.5 w-3.5" />
              {t('pages.sentryErrors.automation')}
            </button>
            <button
              type="button"
              onClick={() => issuesQuery.refetch()}
              disabled={issuesQuery.isFetching}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-faint px-2.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary disabled:opacity-50"
            >
              {issuesQuery.isFetching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {t('pages.sentryErrors.refresh')}
            </button>
          </div>
        )}
      </div>

      {/* Barra de filtros */}
      {account && issues.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline-soft px-8 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-faint" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('pages.sentryErrors.searchPlaceholder')}
              className="h-8 w-64 rounded-md border border-hairline-strong bg-surface-faint pl-8 pr-3 text-[12px] text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>
          <DSSelect
            value={project}
            onChange={setProject}
            options={[
              { value: '', label: t('pages.sentryErrors.allProjectsFilter'), muted: true },
              ...projects.map((p) => ({ value: p, label: p })),
            ]}
            className="h-8 w-44"
          />
          <DSSelect
            value={level}
            onChange={setLevel}
            options={[
              { value: '', label: t('pages.sentryErrors.allLevelsFilter'), muted: true },
              ...levels.map((l) => ({
                value: l,
                label: t(`pages.sentryErrors.level.${l}`),
              })),
            ]}
            className="h-8 w-36"
          />
          <span className="ml-auto text-[11px] text-text-faint">
            {t('pages.sentryErrors.resultCount', { shown: filtered.length, total: issues.length })}
          </span>
        </div>
      )}

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {!account ? (
          <EmptyState
            title={t('pages.sentryErrors.notConnectedTitle')}
            hint={t('pages.sentryErrors.notConnectedHint')}
            action={
              <button
                type="button"
                onClick={() => navigate('/integrations')}
                className="rounded-md bg-white px-3.5 py-1.5 text-[12.5px] font-medium text-black hover:bg-white/90"
              >
                {t('pages.sentryErrors.goConnect')}
              </button>
            }
          />
        ) : issuesQuery.isPending ? (
          <div className="flex items-center justify-center py-20 text-text-muted">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : issuesQuery.isError ? (
          <EmptyState
            title={t('pages.sentryErrors.errorTitle')}
            hint={issuesQuery.error instanceof Error ? issuesQuery.error.message : ''}
          />
        ) : issues.length === 0 ? (
          <EmptyState
            title={t('pages.sentryErrors.emptyTitle')}
            hint={t('pages.sentryErrors.emptyHint')}
          />
        ) : filtered.length === 0 ? (
          <EmptyState title={t('pages.sentryErrors.noMatch')} />
        ) : (
          <div className="flex flex-col gap-2.5">
            {filtered.map((issue) => (
              <div
                key={issue.id}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/sentry/${issue.id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') navigate(`/sentry/${issue.id}`);
                }}
                className="group relative flex cursor-pointer items-stretch gap-3 overflow-hidden rounded-xl border border-hairline-med bg-surface-veil pl-0 outline-none transition-colors hover:border-hairline-bright hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-accent/40"
              >
                <span
                  className={cn('w-1 shrink-0', LEVEL_BAR[issue.level] ?? LEVEL_BAR.debug)}
                  aria-hidden
                />
                <div className="min-w-0 flex-1 py-3.5 pr-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        'shrink-0 rounded border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide',
                        LEVEL_COLOR[issue.level] ?? LEVEL_COLOR.debug,
                      )}
                    >
                      {issue.level}
                    </span>
                    {issue.project && (
                      <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                        {issue.project}
                      </span>
                    )}
                    {issue.shortId && (
                      <span className="shrink-0 font-mono text-[10.5px] text-text-faint">
                        {issue.shortId}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text-primary">
                      {issue.title}
                    </span>
                  </div>
                  {issue.culprit && (
                    <div className="mt-1 truncate font-mono text-[11px] text-text-muted">
                      {issue.culprit}
                    </div>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-faint">
                    <span>{t('pages.sentryErrors.occurrences', { n: issue.count })}</span>
                    <span>{t('pages.sentryErrors.users', { n: issue.userCount })}</span>
                    {issue.lastSeen && (
                      <span>
                        {t('pages.sentryErrors.lastSeenAgo', {
                          ago: relativeTime(issue.lastSeen, lang),
                        })}
                      </span>
                    )}
                    {issue.permalink && (
                      <a
                        href={issue.permalink}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-text-muted hover:text-text-secondary"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {t('pages.sentryErrors.openInSentry')}
                      </a>
                    )}
                  </div>
                </div>
                {analyzed[issue.id] ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/session/${analyzed[issue.id]}`);
                    }}
                    className="my-2 ml-2 mr-4 inline-flex shrink-0 items-center gap-1.5 self-center rounded-md border border-accent-green/25 bg-accent-green/[0.08] px-2.5 py-1.5 text-[11.5px] font-medium text-accent-green/90 transition-colors hover:bg-accent-green/15"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    {t('pages.sentryErrors.viewAnalysis')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      analyzeMutation.mutate(issue.id);
                    }}
                    disabled={analyzeMutation.isPending}
                    className="my-2 ml-2 mr-4 inline-flex shrink-0 items-center gap-1.5 self-center rounded-md border border-hairline-heavy bg-surface-hover px-2.5 py-1.5 text-[11.5px] font-medium text-text-secondary transition-colors hover:border-white/20 hover:bg-surface-4 hover:text-text-primary disabled:opacity-50"
                  >
                    {analyzeMutation.isPending && analyzeMutation.variables === issue.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {t('pages.sentryErrors.analyze')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        {children}
      </div>
    </div>
  );
}

function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <AlertTriangle className="h-6 w-6 text-text-faint" />
      <div className="mt-3 text-[13.5px] font-medium text-text-secondary">{title}</div>
      {hint && <div className="mt-1 max-w-md text-[12px] text-text-muted">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
