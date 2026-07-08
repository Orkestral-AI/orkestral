import { useMemo } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Loader2,
  Settings2,
  Search,
  Signal,
  Sparkles,
} from 'lucide-react';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { toast } from '@renderer/stores/toastStore';
import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';

type Provider = 'new_relic' | 'better_stack';

const META: Record<Provider, { icon: typeof Activity }> = {
  new_relic: { icon: Activity },
  better_stack: { icon: Signal },
};

const KIND_COLOR: Record<string, string> = {
  error: 'border-accent-red/25 bg-accent-red/[0.08] text-accent-red',
  incident: 'border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow',
  log: 'border-accent-blue/25 bg-accent-blue/10 text-accent-blue',
};

export function ObservabilityPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const { provider: rawProvider = 'new_relic' } = useParams();
  const provider: Provider = rawProvider === 'better_stack' ? 'better_stack' : 'new_relic';
  const providerName = t(`observability.providers.${provider}`);
  const Icon = META[provider].icon;
  const workspaceId = useWorkspaceStore((s) => s.active?.id);

  const accountQuery = useQuery({
    queryKey: ['observability', 'account', provider, workspaceId],
    queryFn: () =>
      window.orkestral['observability:get-account']({ workspaceId: workspaceId!, provider }),
    enabled: !!workspaceId,
  });
  const signalsQuery = useQuery({
    queryKey: ['observability', 'signals', provider, workspaceId],
    queryFn: () =>
      window.orkestral['observability:list-signals']({
        workspaceId: workspaceId!,
        provider,
        limit: 60,
      }),
    enabled: !!workspaceId && !!accountQuery.data,
    refetchInterval: 5 * 60_000,
  });
  const analyzeMut = useMutation({
    mutationFn: (signal: NonNullable<typeof signalsQuery.data>[number]) =>
      window.orkestral['observability:analyze-signal']({
        workspaceId: workspaceId!,
        provider,
        signal,
      }),
    onSuccess: (res) => navigate(`/session/${res.sessionId}`),
    onError: (err) =>
      toast.error(
        t('observability.signals.analyzeError'),
        err instanceof Error ? err.message : String(err),
      ),
  });

  const signals = useMemo(() => signalsQuery.data ?? [], [signalsQuery.data]);

  return (
    <PageShell>
      <div className="window-drag flex items-end justify-between border-b border-hairline-soft px-8 pt-5">
        <div className="pb-3">
          <button
            type="button"
            onClick={() => navigate('/integrations')}
            className="window-no-drag mb-2 inline-flex items-center gap-1 text-[11.5px] text-text-muted transition-colors hover:text-text-secondary"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('observability.signals.backToIntegrations')}
          </button>
          <div className="flex items-center gap-2.5">
            <Icon className="h-5 w-5 text-text-secondary" />
            <div>
              <h1 className="text-[18px] font-semibold tracking-tight text-text-primary">
                {providerName}
              </h1>
              <p className="mt-0.5 text-[12.5px] text-text-muted">
                {t('observability.signals.subtitle')}
              </p>
            </div>
          </div>
        </div>
        {accountQuery.data && (
          <button
            type="button"
            onClick={() => navigate(`/observability/${provider}/automations`)}
            className="window-no-drag mb-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-faint px-2.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary disabled:opacity-50"
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t('observability.signals.automations')}
          </button>
        )}
      </div>
      {accountQuery.data && (
        <div className="flex justify-end border-b border-hairline-soft px-8 py-2">
          <button
            type="button"
            onClick={() => signalsQuery.refetch()}
            disabled={signalsQuery.isFetching}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-faint px-2.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary disabled:opacity-50"
          >
            {signalsQuery.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            {t('observability.signals.refresh')}
          </button>
        </div>
      )}

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {!accountQuery.data ? (
          <Empty
            title={t('observability.signals.notConnectedTitle', { name: providerName })}
            hint={t('observability.signals.notConnectedHint')}
          />
        ) : signalsQuery.isPending ? (
          <div className="flex items-center justify-center py-20 text-text-muted">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : signalsQuery.isError ? (
          <Empty
            title={t('observability.signals.loadError')}
            hint={signalsQuery.error instanceof Error ? signalsQuery.error.message : ''}
          />
        ) : signals.length === 0 ? (
          <Empty
            title={t('observability.signals.emptyTitle')}
            hint={t('observability.signals.emptyHint')}
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            {signals.map((signal) => (
              <div
                key={signal.id}
                role="button"
                tabIndex={0}
                onClick={() =>
                  navigate(`/observability/${provider}/${encodeURIComponent(signal.id)}`)
                }
                onKeyDown={(e) =>
                  e.key === 'Enter' &&
                  navigate(`/observability/${provider}/${encodeURIComponent(signal.id)}`)
                }
                className="rounded-xl border border-hairline-med bg-surface-veil p-4 text-left transition-colors hover:border-hairline-bright hover:bg-surface-hover"
              >
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      'mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide',
                      KIND_COLOR[signal.kind] ?? KIND_COLOR.log,
                    )}
                  >
                    {signal.kind}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-text-primary">
                      {signal.title}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-faint">
                      {signal.service && <span>{signal.service}</span>}
                      {signal.severity && <span>{signal.severity}</span>}
                      {signal.count != null && (
                        <span>{t('observability.signals.events', { count: signal.count })}</span>
                      )}
                      {signal.lastSeen && <span>{new Date(signal.lastSeen).toLocaleString()}</span>}
                      {signal.url && (
                        <a
                          href={signal.url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-text-muted hover:text-text-secondary"
                        >
                          <ExternalLink className="h-3 w-3" />
                          {t('observability.signals.open')}
                        </a>
                      )}
                    </div>
                    {signal.summary && (
                      <div className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-text-muted">
                        {signal.summary}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      analyzeMut.mutate(signal);
                    }}
                    disabled={analyzeMut.isPending}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-hairline-heavy bg-surface-hover px-2.5 text-[12px] font-medium text-text-secondary transition-colors hover:border-white/20 hover:bg-surface-4 hover:text-text-primary disabled:opacity-50"
                  >
                    {analyzeMut.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {t('observability.signals.analyze')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}

function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <AlertTriangle className="h-6 w-6 text-text-faint" />
      <div className="mt-3 text-[13.5px] font-medium text-text-secondary">{title}</div>
      {hint && <div className="mt-1 max-w-md text-[12px] text-text-muted">{hint}</div>}
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
