import { useQueries, useQuery } from '@tanstack/react-query';
import { Cpu } from 'lucide-react';
import { PanelShell } from './PanelShell';
import { AdapterBrandIcon } from '@renderer/components/brand-icons';
import { useT } from '@renderer/i18n';
import type { AdapterDescriptor, AdapterModel } from '@shared/types';

/**
 * Modelos — lista os adapters REAIS (adapter:list) e, pra cada um, seus modelos
 * REAIS via adapter:list-models. Nada hardcoded: os chips de modelo vêm do
 * discovery do próprio adapter.
 */
export function ModelsPanel() {
  const { t } = useT();
  const adaptersQuery = useQuery({
    queryKey: ['adapters'],
    queryFn: () => window.orkestral['adapter:list'](),
  });
  const adapters = adaptersQuery.data ?? [];

  // Uma query de modelos por adapter (cacheada por tipo).
  const modelQueries = useQueries({
    queries: adapters.map((a) => ({
      queryKey: ['adapter-models', a.type],
      queryFn: () => window.orkestral['adapter:list-models']({ type: a.type }),
      enabled: !a.comingSoon,
      staleTime: 5 * 60_000,
    })),
  });

  return (
    <PanelShell
      icon={Cpu}
      title={t('settings.models.title')}
      description={t('settings.models.description')}
    >
      {adaptersQuery.isLoading ? (
        <div className="rounded-lg border border-border bg-surface/40 p-6 text-center text-[12.5px] text-text-muted">
          {t('settings.models.loadingAdapters')}
        </div>
      ) : adapters.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-surface/40 p-6 text-center text-[12.5px] text-text-muted">
          {t('settings.models.noAdapters')}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {adapters.map((adapter, i) => (
            <AdapterCard
              key={adapter.type}
              adapter={adapter}
              models={modelQueries[i]?.data ?? []}
              loading={modelQueries[i]?.isLoading ?? false}
            />
          ))}
        </div>
      )}
    </PanelShell>
  );
}

function AdapterCard({
  adapter,
  models,
  loading,
}: {
  adapter: AdapterDescriptor;
  models: AdapterModel[];
  loading: boolean;
}) {
  const { t } = useT();

  return (
    <div className="rounded-lg border border-border bg-surface/40 p-3.5">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-text-secondary">
          <AdapterBrandIcon type={adapter.type} className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-text-primary">{adapter.name}</span>
            {adapter.recommended && (
              <Badge tone="accent">{t('settings.models.badgeRecommended')}</Badge>
            )}
            {adapter.executorOnly && (
              <Badge tone="muted">{t('settings.models.badgeExecutor')}</Badge>
            )}
            {adapter.comingSoon && <Badge tone="muted">{t('settings.models.badgeSoon')}</Badge>}
          </div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-text-muted">
            {adapter.description}
          </div>

          {/* Chips de modelo — vindos do discovery real do adapter. */}
          {!adapter.comingSoon && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {loading ? (
                <span className="text-[11px] text-text-faint">
                  {t('settings.models.discoveringModels')}
                </span>
              ) : models.length === 0 ? (
                <span className="text-[11px] text-text-faint">{t('settings.models.noModels')}</span>
              ) : (
                models.map((m) => (
                  <span
                    key={m.id}
                    title={m.description}
                    className="inline-flex items-center rounded-md border border-hairline bg-surface-hover px-2 py-0.5 text-[11px] text-text-secondary"
                  >
                    {m.label}
                  </span>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: 'accent' | 'muted' }) {
  return (
    <span
      className={
        tone === 'accent'
          ? 'inline-flex items-center rounded-full bg-accent-purple/12 px-2 py-0.5 text-[10px] font-medium text-accent-purple'
          : 'inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-text-muted'
      }
    >
      {children}
    </span>
  );
}
