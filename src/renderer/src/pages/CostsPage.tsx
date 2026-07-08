import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleDollarSign, Bot, Heart, MessageSquare, CircleDot } from 'lucide-react';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useT, type TFunction } from '@renderer/i18n';

export function CostsPage() {
  const { t } = useT();
  const activeWorkspace = useWorkspaceStore((s) => s.active);

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
  const issuesQuery = useQuery({
    queryKey: ['issues', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['issue:list']({ workspaceId: activeWorkspace!.id }),
  });
  const economicsQuery = useQuery({
    queryKey: ['execStats', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['execStats:get'](),
  });

  const agents = agentsQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];
  const issues = issuesQuery.data ?? [];
  const economics = economicsQuery.data ?? null;

  return (
    <PageShell title={t('pages.costs.title')} description={t('pages.costs.description')}>
      {!activeWorkspace ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('pages.costs.noActiveWorkspace')}
        </div>
      ) : (
        <div className="thin-scrollbar flex-1 overflow-y-auto px-8 py-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat icon={Bot} label={t('pages.costs.statAgents')} value={String(agents.length)} />
            <Stat
              icon={MessageSquare}
              label={t('pages.costs.statConversations')}
              value={String(sessions.length)}
            />
            <Stat
              icon={CircleDot}
              label={t('pages.costs.statOpenIssues')}
              value={String(
                issues.filter((i) => i.status !== 'done' && i.status !== 'cancelled').length,
              )}
            />
            <Stat
              icon={Heart}
              label={t('pages.costs.statHeartbeats')}
              value={String(agents.filter((a) => a.heartbeatEnabled).length)}
            />
          </div>

          <Section title={t('pages.costs.perAgent')}>
            <div className="overflow-hidden rounded-lg border border-hairline-faint">
              {agents.map((a, i) => (
                <div
                  key={a.id}
                  className={
                    i > 0
                      ? 'flex items-center gap-3 border-t border-hairline-soft px-4 py-2.5'
                      : 'flex items-center gap-3 px-4 py-2.5'
                  }
                >
                  <AgentAvatar seed={a.avatarSeed} name={a.name} size={14} />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-primary">
                    {a.name}
                  </span>
                  <span className="font-mono text-[10.5px] text-text-muted">
                    {a.adapterType ?? '—'}
                  </span>
                  <span className="text-[10.5px] text-text-muted">
                    {a.heartbeatEnabled
                      ? `${a.heartbeatIntervalMinutes}min`
                      : t('pages.costs.noHeartbeat')}
                  </span>
                  <span className="text-[10.5px] text-text-faint">
                    {a.lastHeartbeatAt
                      ? t('pages.costs.last', { time: fmtRelative(a.lastHeartbeatAt, t) })
                      : '—'}
                  </span>
                </div>
              ))}
              {agents.length === 0 && (
                <div className="px-4 py-4 text-center text-[12px] text-text-muted">
                  {t('pages.costs.noAgents')}
                </div>
              )}
            </div>
          </Section>

          {economics && economics.orchestratedTotal > 0 && (
            <Section title={t('pages.costs.savingsTitle')}>
              <div className="rounded-lg border border-hairline bg-surface-faint p-4">
                {economics.savedUsd !== null && economics.avgPremiumCostUsd !== null ? (
                  <>
                    <span className="block text-[10.5px] uppercase tracking-wider text-text-faint">
                      {t('pages.costs.savingsAmount')}
                    </span>
                    <span className="mt-1 block text-[22px] font-semibold tracking-tight text-text-primary">
                      {fmtUsd(economics.savedUsd)}
                    </span>
                    <p className="mt-2 text-[12px] text-text-muted">
                      {t('pages.costs.savingsDetail', {
                        local: economics.localExecutions + economics.localAssisted,
                        cost: fmtUsd(economics.avgPremiumCostUsd),
                        spent: fmtUsd(economics.premiumSpentUsd),
                      })}
                    </p>
                  </>
                ) : (
                  <p className="text-[12.5px] text-text-muted">
                    {t('pages.costs.savingsNoData', {
                      local: economics.localExecutions + economics.localAssisted,
                    })}
                  </p>
                )}
              </div>
            </Section>
          )}

          {economics && economics.localPhaseRuns > 0 && (
            <Section title={t('pages.costs.localPhasesTitle')}>
              <div className="rounded-lg border border-hairline bg-surface-faint p-4">
                <span className="block text-[10.5px] uppercase tracking-wider text-text-faint">
                  {t('pages.costs.localPhasesLabel')}
                </span>
                <span className="mt-1 block text-[22px] font-semibold tracking-tight text-accent-green">
                  ~{Math.round(economics.localPhaseTokensAvoided / 1000)}k tokens
                </span>
                <p className="mt-2 text-[12px] text-text-muted">
                  {t('pages.costs.localPhasesDetail', { runs: economics.localPhaseRuns })}
                </p>
              </div>
            </Section>
          )}

          <Section title={t('pages.costs.comingSoon')}>
            <div className="rounded-lg border border-dashed border-hairline bg-surface-whisper p-5 text-[12.5px] text-text-muted">
              {t('pages.costs.comingSoonDesc')}
            </div>
          </Section>
        </div>
      )}
    </PageShell>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CircleDollarSign;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-hairline bg-surface-faint px-4 py-3">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-text-muted" />
        <span className="text-[10.5px] uppercase tracking-wider text-text-faint">{label}</span>
      </div>
      <span className="mt-1.5 block text-[22px] font-semibold tracking-tight text-text-primary">
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-[13px] font-semibold tracking-tight text-text-primary">{title}</h2>
      {children}
    </section>
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

// Custos REAIS vêm em USD (cost_usd do stream-json). Sem hardcode de valor.
function fmtUsd(value: number): string {
  return value.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

function fmtRelative(iso: string, t: TFunction): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return t('pages.costs.relNow');
    if (mins < 60) return `${mins}min`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  } catch {
    return iso;
  }
}
