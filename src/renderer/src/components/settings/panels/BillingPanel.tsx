import { Check, Cloud, CreditCard, HardDrive, Sparkles } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { PanelShell } from './PanelShell';
import { usePlan } from '@renderer/hooks/usePlan';
import { useT } from '@renderer/i18n';

/**
 * Assinatura — HONESTO. Não existe backend de billing ainda.
 *
 * Mostra o plano REAL (via usePlan, fonte única) e apresenta o Orkestral Cloud
 * como tier "Em breve", com botão desabilitado. Sem preços apresentados como
 * compráveis, sem faturas. Quando o backend existir, este card vira o ponto de
 * entrada do upgrade (basta trocar o disabled/onClick).
 */
export function BillingPanel() {
  const { isLocal } = usePlan();
  const { t } = useT();

  const cloudFeatures = [
    t('settings.billing.features.team'),
    t('settings.billing.features.sync'),
    t('settings.billing.features.billing'),
    t('settings.billing.features.backups'),
  ];

  return (
    <PanelShell
      icon={CreditCard}
      title={t('settings.billing.title')}
      description={t('settings.billing.description')}
    >
      {/* Plano atual — real */}
      <div className="rounded-lg border border-border bg-surface/40 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-purple/12 text-accent-purple">
            <HardDrive className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold text-text-primary">
                {isLocal ? t('settings.billing.planLocal') : t('settings.billing.planTeam')}
              </span>
              <span className="inline-flex items-center rounded-full bg-accent-green/12 px-2 py-0.5 text-[10px] font-medium text-accent-green">
                {t('settings.billing.currentPlan')}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
              {isLocal ? t('settings.billing.localBlurb') : t('settings.billing.teamBlurb')}
            </p>
          </div>
        </div>
      </div>

      {/* Orkestral Cloud — em breve */}
      <div className="rounded-lg border border-dashed border-border bg-surface/30 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-text-secondary">
            <Cloud className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold text-text-primary">
                {t('settings.billing.cloudTitle')}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-text-muted">
                <Sparkles className="h-2.5 w-2.5" />
                {t('common.comingSoon')}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
              {t('settings.billing.cloudDescription')}
            </p>
            <ul className="mt-3 flex flex-col gap-1.5">
              {cloudFeatures.map((f) => (
                <li key={f} className="flex items-start gap-2 text-[12px] text-text-secondary">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-purple/70" />
                  {f}
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <Button
                variant="secondary"
                size="sm"
                disabled
                title={t('settings.billing.cloudCtaTitle')}
              >
                {t('settings.billing.cloudCta')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </PanelShell>
  );
}
