import { useEffect, useState } from 'react';
import { Card } from '../ui/card';
import { useT } from '@renderer/i18n';
import type { ExecEconomics } from '../../../../shared/ipc-contract';

function formatPct(rate: number | null): string {
  if (rate === null) return '—';
  return `${Math.round(rate * 100)}%`;
}

// Custos REAIS vêm em USD (cost_usd do stream-json). Sem hardcode de moeda/valor.
function formatUsd(value: number): string {
  return value.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

export function RunEconomicsCard() {
  const { t } = useT();
  const [stats, setStats] = useState<ExecEconomics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const data = await window.orkestral['execStats:get']();
        if (active) setStats(data);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : t('dashboard.economics.loadError'));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [t]);

  return (
    <Card className="p-5">
      <header className="mb-4">
        <h2 className="text-lg font-semibold text-text-primary">
          {t('dashboard.economics.title')}
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          {t('dashboard.economics.introPart1')}
          <strong>{t('dashboard.economics.introPlan')}</strong>
          {t('dashboard.economics.introPart2')}
          <strong>{t('dashboard.economics.introExecute')}</strong>
          {t('dashboard.economics.introPart3')}
        </p>
      </header>

      {loading && <p className="text-sm text-text-secondary">{t('common.loading')}</p>}

      {error && !loading && <p className="text-sm text-text-secondary">{error}</p>}

      {stats && !loading && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Metric
              label={t('dashboard.economics.localExecutions')}
              value={String(stats.localExecutions)}
              hint={t('dashboard.economics.localExecutionsHint')}
            />
            <Metric
              label={t('dashboard.economics.escalations')}
              value={String(stats.escalations)}
              hint={t('dashboard.economics.escalationsHint')}
            />
            <Metric
              label={t('dashboard.economics.localSuccessRate')}
              value={formatPct(stats.localSuccessRate)}
              hint={t('dashboard.economics.localSuccessRateHint', {
                local: stats.localExecutions,
                total: stats.orchestratedTotal,
              })}
            />
          </div>

          {stats.orchestratedTotal === 0 ? (
            <p className="mt-4 text-sm text-text-secondary">{t('dashboard.economics.noRuns')}</p>
          ) : stats.savedUsd !== null && stats.avgPremiumCostUsd !== null ? (
            <div className="mt-4 rounded-lg border border-border bg-surface-2 p-3">
              <p className="text-xs uppercase tracking-wide text-text-tertiary">
                {t('dashboard.economics.savedLabel')}
              </p>
              <p className="mt-1 text-sm text-text-primary">
                <span className="font-semibold">{formatUsd(stats.savedUsd)}</span>{' '}
                <span className="text-text-secondary">
                  {t('dashboard.economics.savedDetail', {
                    local: stats.localExecutions + stats.localAssisted,
                    cost: formatUsd(stats.avgPremiumCostUsd),
                  })}
                </span>
              </p>
              <p className="mt-2 text-xs text-text-tertiary">
                {t('dashboard.economics.savedNote')}
              </p>
            </div>
          ) : stats.counterfactualSavedUsd > 0 ? (
            // Sem custo premium MEDIDO (Forge não escalou — o caso comum), mas a
            // economia continua VISÍVEL: o que o premium TERIA gastado a preço de
            // referência. É o pilar do produto mostrado por padrão, não escondido.
            <div className="mt-4 rounded-lg border border-accent/30 bg-accent/5 p-3">
              <p className="text-xs uppercase tracking-wide text-text-tertiary">
                {t('dashboard.economics.counterfactualLabel')}
              </p>
              <p className="mt-1 text-sm text-text-primary">
                <span className="font-semibold text-accent">
                  {formatUsd(stats.counterfactualSavedUsd)}
                </span>{' '}
                <span className="text-text-secondary">
                  {t('dashboard.economics.counterfactualDetail', {
                    label: stats.referencePriceLabel,
                  })}
                </span>
              </p>
              <p className="mt-2 text-xs text-text-tertiary">
                {t('dashboard.economics.counterfactualNote')}
              </p>
            </div>
          ) : (
            <p className="mt-4 text-sm text-text-secondary">
              {t('dashboard.economics.noCostData')}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-text-primary">{value}</p>
      <p className="mt-1 text-xs text-text-tertiary">{hint}</p>
    </div>
  );
}
