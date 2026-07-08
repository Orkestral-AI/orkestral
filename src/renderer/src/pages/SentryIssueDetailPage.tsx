import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Loader2,
  Sparkles,
  ExternalLink,
  AlertTriangle,
  ArrowLeft,
  MessageSquare,
} from 'lucide-react';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useSentryAnalysisStore } from '@renderer/stores/sentryAnalysisStore';
import { toast } from '@renderer/stores/toastStore';
import { formatDateTime } from '@renderer/lib/time';
import { cn } from '@renderer/lib/utils';
import { useT, type Language } from '@renderer/i18n';

const LEVEL_COLOR: Record<string, string> = {
  fatal: 'border-accent-red/30 bg-accent-red/10 text-accent-red',
  error: 'border-accent-red/25 bg-accent-red/[0.08] text-accent-red',
  warning: 'border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow',
  info: 'border-accent-blue/25 bg-accent-blue/10 text-accent-blue',
  debug: 'border-hairline-heavy bg-surface-1 text-text-muted',
};

const CRUMB_COLOR: Record<string, string> = {
  fatal: 'text-accent-red',
  error: 'text-accent-red',
  warning: 'text-accent-yellow',
  info: 'text-accent-blue',
  debug: 'text-text-faint',
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

function fmtNum(n: number, lang: Language): string {
  return n.toLocaleString(lang);
}

/** Hora curta (HH:MM:SS) de um timestamp de breadcrumb (ISO ou epoch). */
function shortTime(ts: string, lang: Language): string {
  const ms = /^\d+(\.\d+)?$/.test(ts) ? Number(ts) * 1000 : Date.parse(ts);
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString(lang, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function SentryIssueDetailPage() {
  const { t, lang } = useT();
  const navigate = useNavigate();
  const { issueId = '' } = useParams();
  const workspaceId = useWorkspaceStore((s) => s.active?.id);
  const analyzedSession = useSentryAnalysisStore((s) => s.analyzed[issueId]);
  const markAnalyzed = useSentryAnalysisStore((s) => s.markAnalyzed);

  const issueQuery = useQuery({
    queryKey: ['sentry', 'issue', workspaceId, issueId],
    queryFn: () => window.orkestral['sentry:get-issue']({ workspaceId: workspaceId!, issueId }),
    enabled: !!workspaceId && !!issueId,
  });

  const analyzeMutation = useMutation({
    mutationFn: () => {
      if (!workspaceId) throw new Error('no workspace');
      return window.orkestral['sentry:analyze-issue']({ workspaceId, issueId });
    },
    onSuccess: (res) => {
      markAnalyzed(issueId, res.sessionId);
      navigate(`/session/${res.sessionId}`);
    },
    onError: (err) =>
      toast.error(
        t('pages.sentryErrors.analyzeFailed'),
        err instanceof Error ? err.message : String(err),
      ),
  });

  const issue = issueQuery.data;

  return (
    <PageShell>
      {/* Header */}
      <div className="window-drag border-b border-hairline-soft px-8 pt-5">
        <button
          type="button"
          onClick={() => navigate('/sentry')}
          className="window-no-drag mb-2 inline-flex items-center gap-1 text-[11.5px] text-text-muted transition-colors hover:text-text-secondary"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('pages.sentryErrors.detail.back')}
        </button>
        {!issue ? (
          <div className="pb-3" />
        ) : (
          <div className="flex items-start justify-between gap-4 pb-3">
            <div className="min-w-0">
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
              </div>
              <h1 className="mt-1.5 text-[17px] font-semibold leading-snug tracking-tight text-text-primary">
                {issue.title}
              </h1>
              {issue.culprit && (
                <div className="mt-0.5 truncate font-mono text-[11.5px] text-text-muted">
                  {issue.culprit}
                </div>
              )}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-faint">
                <span>{t('pages.sentryErrors.occurrences', { n: issue.count })}</span>
                <span>{t('pages.sentryErrors.users', { n: issue.userCount })}</span>
                {issue.firstSeen && (
                  <span>
                    {t('pages.sentryErrors.detail.firstSeen', {
                      ago: relativeTime(issue.firstSeen, lang),
                    })}
                  </span>
                )}
                {issue.lastSeen && (
                  <span>
                    {t('pages.sentryErrors.detail.lastSeen', {
                      ago: relativeTime(issue.lastSeen, lang),
                    })}
                  </span>
                )}
              </div>
            </div>
            <div className="window-no-drag flex shrink-0 items-center gap-2">
              {issue.permalink && (
                <a
                  href={issue.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-faint px-2.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t('pages.sentryErrors.openInSentry')}
                </a>
              )}
              {analyzedSession ? (
                <button
                  type="button"
                  onClick={() => navigate(`/session/${analyzedSession}`)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent-green/25 bg-accent-green/[0.08] px-2.5 text-[12px] font-medium text-accent-green/90 transition-colors hover:bg-accent-green/15"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  {t('pages.sentryErrors.viewAnalysis')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => analyzeMutation.mutate()}
                  disabled={analyzeMutation.isPending}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-heavy bg-surface-hover px-2.5 text-[12px] font-medium text-text-secondary transition-colors hover:border-white/20 hover:bg-surface-4 hover:text-text-primary disabled:opacity-50"
                >
                  {analyzeMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {t('pages.sentryErrors.analyze')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-8 py-5">
        {issueQuery.isPending ? (
          <div className="flex items-center justify-center py-20 text-text-muted">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : issueQuery.isError || !issue ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <AlertTriangle className="h-6 w-6 text-text-faint" />
            <div className="mt-3 text-[13.5px] font-medium text-text-secondary">
              {t('pages.sentryErrors.detail.loadFailed')}
            </div>
            {issueQuery.error instanceof Error && (
              <div className="mt-1 max-w-md text-[12px] text-text-muted">
                {issueQuery.error.message}
              </div>
            )}
          </div>
        ) : (
          <div className="flex gap-6">
            {/* Coluna principal */}
            <div className="flex min-w-0 flex-1 flex-col gap-5">
              {issue.message && (
                <Section title={t('pages.sentryErrors.detail.message')}>
                  <pre className="thin-scrollbar overflow-x-auto whitespace-pre-wrap rounded-lg border border-hairline bg-surface-veil p-3.5 font-mono text-[12px] leading-relaxed text-text-secondary">
                    {issue.message}
                  </pre>
                </Section>
              )}

              {issue.exception && (
                <Section title={t('pages.sentryErrors.detail.exception')}>
                  <div className="rounded-lg border border-accent-red/20 bg-accent-red/[0.04] p-3.5">
                    <div className="font-mono text-[13px] font-semibold text-accent-red">
                      {issue.exception.type}
                    </div>
                    {issue.exception.value && (
                      <div className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-secondary">
                        {issue.exception.value}
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {issue.exception && issue.exception.frames.length > 0 && (
                <Section
                  title={t('pages.sentryErrors.detail.stacktrace')}
                  hint={t('pages.sentryErrors.detail.stackHint')}
                >
                  <div className="overflow-hidden rounded-lg border border-hairline bg-surface-ghost">
                    {issue.exception.frames.map((f, idx) => (
                      <div
                        key={`${f.filename}:${f.lineNo}:${idx}`}
                        className={cn(
                          'flex items-baseline gap-3 border-b border-hairline-ghost px-3.5 py-2 font-mono text-[12px] last:border-b-0',
                          f.inApp
                            ? 'border-l-2 border-l-accent/50 bg-surface-faint'
                            : 'border-l-2 border-l-transparent opacity-55',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-text-secondary">
                          {f.filename}
                          {f.lineNo != null && <span className="text-accent/80">:{f.lineNo}</span>}
                        </span>
                        {f.function && (
                          <span className="shrink-0 truncate text-text-muted">{f.function}</span>
                        )}
                        {!f.inApp && (
                          <span className="shrink-0 rounded bg-surface-2 px-1 text-[9px] uppercase tracking-wide text-text-faint">
                            {t('pages.sentryErrors.detail.lib')}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {issue.request && (
                <Section title={t('pages.sentryErrors.detail.request')}>
                  <div className="flex items-center gap-2 rounded-lg border border-hairline bg-surface-veil px-3.5 py-2.5 font-mono text-[12px]">
                    <span className="shrink-0 rounded bg-surface-active px-1.5 py-0.5 text-[10.5px] font-semibold text-text-secondary">
                      {issue.request.method}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-text-muted">
                      {issue.request.url}
                    </span>
                  </div>
                </Section>
              )}

              {issue.breadcrumbs.length > 0 && (
                <Section title={t('pages.sentryErrors.detail.breadcrumbs')}>
                  <div className="overflow-hidden rounded-lg border border-hairline bg-surface-ghost">
                    {issue.breadcrumbs.map((b, idx) => (
                      <div
                        key={idx}
                        className="flex items-baseline gap-2.5 border-b border-hairline-ghost px-3.5 py-2 text-[12px] last:border-b-0"
                      >
                        <span
                          className={cn(
                            'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                            (CRUMB_COLOR[b.level] ?? CRUMB_COLOR.debug).replace('text-', 'bg-'),
                          )}
                        />
                        {b.category && (
                          <span className="shrink-0 font-mono text-[11px] text-text-faint">
                            {b.category}
                          </span>
                        )}
                        <span className="min-w-0 flex-1 break-words font-mono text-text-muted">
                          {b.message}
                        </span>
                        {b.timestamp && (
                          <span className="shrink-0 font-mono text-[10px] text-text-faint">
                            {shortTime(b.timestamp, lang)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {!issue.exception && !issue.message && issue.breadcrumbs.length === 0 && (
                <div className="rounded-lg border border-hairline py-10 text-center text-[12px] text-text-muted">
                  {t('pages.sentryErrors.detail.noEvent')}
                </div>
              )}
            </div>

            {/* Painel lateral de detalhes */}
            <aside className="hidden w-72 shrink-0 flex-col gap-4 xl:flex">
              <div className="grid grid-cols-2 gap-2">
                <StatCard
                  label={t('pages.sentryErrors.occurrences', { n: '' }).trim()}
                  value={fmtNum(issue.count, lang)}
                />
                <StatCard
                  label={t('pages.sentryErrors.users', { n: '' }).trim()}
                  value={fmtNum(issue.userCount, lang)}
                />
              </div>

              <div className="rounded-xl border border-hairline bg-surface-ghost p-1">
                <MetaRow label={t('pages.sentryErrors.filterLevel')}>
                  <span
                    className={cn(
                      'rounded border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide',
                      LEVEL_COLOR[issue.level] ?? LEVEL_COLOR.debug,
                    )}
                  >
                    {issue.level}
                  </span>
                </MetaRow>
                <MetaRow label={t('pages.sentryErrors.filterProject')}>
                  <span className="truncate text-text-secondary">{issue.project || '—'}</span>
                </MetaRow>
                {issue.platform && (
                  <MetaRow label="Platform">
                    <span className="truncate text-text-secondary">{issue.platform}</span>
                  </MetaRow>
                )}
                {issue.firstSeen && (
                  <MetaRow label={t('pages.sentryErrors.detail.firstSeen', { ago: '' }).trim()}>
                    <span
                      className="truncate text-text-secondary"
                      title={formatDateTime(issue.firstSeen)}
                    >
                      {relativeTime(issue.firstSeen, lang)}
                    </span>
                  </MetaRow>
                )}
                {issue.lastSeen && (
                  <MetaRow label={t('pages.sentryErrors.detail.lastSeen', { ago: '' }).trim()}>
                    <span
                      className="truncate text-text-secondary"
                      title={formatDateTime(issue.lastSeen)}
                    >
                      {relativeTime(issue.lastSeen, lang)}
                    </span>
                  </MetaRow>
                )}
              </div>

              {issue.tags.length > 0 && (
                <div>
                  <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
                    {t('pages.sentryErrors.detail.tags')}
                  </div>
                  <div className="overflow-hidden rounded-xl border border-hairline bg-surface-ghost">
                    {issue.tags.map((tag) => (
                      <div
                        key={`${tag.key}:${tag.value}`}
                        className="flex items-baseline justify-between gap-3 border-b border-hairline-ghost px-3 py-1.5 text-[11.5px] last:border-b-0"
                      >
                        <span className="shrink-0 text-text-faint">{tag.key}</span>
                        <span className="min-w-0 truncate text-right font-mono text-text-secondary">
                          {tag.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </aside>
          </div>
        )}
      </div>
    </PageShell>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-baseline gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
          {title}
        </h2>
        {hint && <span className="text-[10.5px] text-text-faint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-ghost px-3 py-2.5">
      <div className="truncate text-[18px] font-semibold tracking-tight text-text-primary">
        {value}
      </div>
      <div className="mt-0.5 truncate text-[10.5px] uppercase tracking-wide text-text-faint">
        {label}
      </div>
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-2.5 py-1.5 text-[11.5px]">
      <span className="shrink-0 capitalize text-text-faint">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
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
