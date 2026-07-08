import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Loader2,
  MessageSquare,
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

export function ObservabilitySignalDetailPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const { provider: rawProvider = 'new_relic', signalId: rawSignalId = '' } = useParams();
  const provider: Provider = rawProvider === 'better_stack' ? 'better_stack' : 'new_relic';
  const signalId = decodeURIComponent(rawSignalId);
  const workspaceId = useWorkspaceStore((s) => s.active?.id);
  const providerName = t(`observability.providers.${provider}`);
  const Icon = META[provider].icon;

  const signalQuery = useQuery({
    queryKey: ['observability', 'signal', provider, workspaceId, signalId],
    queryFn: () =>
      window.orkestral['observability:get-signal']({
        workspaceId: workspaceId!,
        provider,
        signalId,
      }),
    enabled: !!workspaceId && !!signalId,
  });

  const analyzeMut = useMutation({
    mutationFn: () => {
      if (!workspaceId || !signalQuery.data)
        throw new Error(t('observability.detail.signalUnavailable'));
      return window.orkestral['observability:analyze-signal']({
        workspaceId,
        provider,
        signal: signalQuery.data,
      });
    },
    onSuccess: (res) => navigate(`/session/${res.sessionId}`),
    onError: (err) =>
      toast.error(
        t('observability.detail.analyzeError'),
        err instanceof Error ? err.message : String(err),
      ),
  });

  const signal = signalQuery.data;

  return (
    <PageShell>
      <div className="window-drag border-b border-hairline-soft px-8 pt-5">
        <button
          type="button"
          onClick={() => navigate(`/observability/${provider}`)}
          className="window-no-drag mb-2 inline-flex items-center gap-1 text-[11.5px] text-text-muted transition-colors hover:text-text-secondary"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {providerName}
        </button>
        {!signal ? (
          <div className="pb-3" />
        ) : (
          <div className="flex items-start justify-between gap-4 pb-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Icon className="h-4 w-4 text-text-secondary" />
                <span
                  className={cn(
                    'shrink-0 rounded border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide',
                    KIND_COLOR[signal.kind] ?? KIND_COLOR.log,
                  )}
                >
                  {signal.kind}
                </span>
                {signal.service && (
                  <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                    {signal.service}
                  </span>
                )}
                {signal.severity && (
                  <span className="font-mono text-[10.5px] text-text-faint">{signal.severity}</span>
                )}
              </div>
              <h1 className="mt-1.5 text-[17px] font-semibold leading-snug tracking-tight text-text-primary">
                {signal.title}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-faint">
                {signal.count != null && (
                  <span>
                    {t('observability.signals.events', { count: signal.count.toLocaleString() })}
                  </span>
                )}
                {signal.lastSeen && <span>{new Date(signal.lastSeen).toLocaleString()}</span>}
                <span className="font-mono">{signal.id}</span>
              </div>
            </div>
            <div className="window-no-drag flex shrink-0 items-center gap-2">
              {signal.url && (
                <a
                  href={signal.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-faint px-2.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t('observability.detail.open')}
                </a>
              )}
              <button
                type="button"
                onClick={() => analyzeMut.mutate()}
                disabled={analyzeMut.isPending}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-heavy bg-surface-hover px-2.5 text-[12px] font-medium text-text-secondary transition-colors hover:border-white/20 hover:bg-surface-4 hover:text-text-primary disabled:opacity-50"
              >
                {analyzeMut.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {t('observability.detail.analyze')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-8 py-5">
        {signalQuery.isPending ? (
          <div className="flex items-center justify-center py-20 text-text-muted">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : signalQuery.isError || !signal ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <AlertTriangle className="h-6 w-6 text-text-faint" />
            <div className="mt-3 text-[13.5px] font-medium text-text-secondary">
              {t('observability.detail.loadErrorTitle')}
            </div>
            {signalQuery.error instanceof Error && (
              <div className="mt-1 max-w-md text-[12px] text-text-muted">
                {signalQuery.error.message}
              </div>
            )}
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-5">
              <section className="rounded-xl border border-hairline bg-surface-veil p-4">
                <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                  <MessageSquare className="h-3.5 w-3.5" />
                  {t('observability.detail.productionContext')}
                </div>
                <p className="text-[13px] leading-relaxed text-text-secondary">
                  {signal.summary || t('observability.detail.noSummary')}
                </p>
              </section>
              <section className="rounded-xl border border-hairline bg-surface-veil p-4">
                <div className="mb-3 text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                  {t('observability.detail.rawPayload')}
                </div>
                <pre className="thin-scrollbar max-h-[520px] overflow-auto rounded-lg bg-black/30 p-3 text-[11px] leading-relaxed text-text-secondary">
                  {JSON.stringify(signal.raw, null, 2)}
                </pre>
              </section>
            </div>
            <aside className="space-y-2.5">
              <Info label={t('observability.detail.provider')} value={providerName} />
              <Info label={t('observability.detail.kind')} value={signal.kind} />
              <Info
                label={t('observability.detail.service')}
                value={signal.service ?? t('observability.detail.unknown')}
              />
              <Info
                label={t('observability.detail.severity')}
                value={signal.severity ?? t('observability.detail.unknown')}
              />
              <Info
                label={t('observability.detail.occurrences')}
                value={signal.count != null ? String(signal.count) : 'n/a'}
              />
              <Info label={t('observability.detail.lastSeen')} value={signal.lastSeen ?? 'n/a'} />
            </aside>
          </div>
        )}
      </div>
    </PageShell>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-hairline bg-surface-veil px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-text-faint">{label}</div>
      <div className="mt-1 break-words text-[12px] text-text-secondary">{value}</div>
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
