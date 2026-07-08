import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FlaskConical, RotateCcw } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { PanelShell, SettingsSection, Field } from './PanelShell';
import { useT } from '@renderer/i18n';

export function AdvancedPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { t } = useT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function resetOnboarding() {
    setBusy(true);
    try {
      await window.orkestral['onboarding:reset']();
      await queryClient.invalidateQueries({ queryKey: ['onboarding'] });
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      onClose();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <PanelShell icon={FlaskConical} title={t('settings.advanced.title')}>
      <SettingsSection title={t('settings.advanced.groupOnboarding')}>
        <Field
          label={t('settings.advanced.resetOnboardingLabel')}
          description={t('settings.advanced.resetOnboardingDescription')}
        >
          {!confirming ? (
            <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>
              <RotateCcw className="h-3.5 w-3.5" />
              {t('settings.advanced.redoOnboarding')}
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-accent-red" />
              <span className="text-[12px] text-text-secondary">
                {t('settings.advanced.areYouSure')}
              </span>
              <Button variant="destructive" size="sm" onClick={resetOnboarding} disabled={busy}>
                {busy ? t('settings.advanced.resetting') : t('common.confirm')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                {t('common.cancel')}
              </Button>
            </div>
          )}
        </Field>
      </SettingsSection>

      <div className="rounded-md border border-border bg-surface/40 p-4">
        <div className="text-[12px] text-text-muted">{t('settings.advanced.moreOptions')}</div>
      </div>
    </PanelShell>
  );
}
