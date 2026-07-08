import { Bot } from 'lucide-react';
import { PanelShell, SettingsSection, ToggleRow } from './PanelShell';
import { Switch } from '@renderer/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { useT } from '@renderer/i18n';
import { useSettingsStore } from '@renderer/stores/settingsStore';
import type { HybridModelRoutingMode, SettingsRecord, TaskRisk } from '@shared/types';

const ROUTING_MODES: HybridModelRoutingMode[] = ['observe', 'ask', 'local_assist', 'local_first'];
const RISK_LEVELS: TaskRisk[] = ['low', 'medium', 'high'];
const ATTEMPT_OPTIONS = [1, 2, 3, 4, 5];

/**
 * Comportamento do agente — SEPARADO de "Modelos" (que lista os adapters). Controla
 * COMO o agente decide/insiste/escala: roteamento híbrido, fallback premium e quantas
 * vezes o Forge local tenta antes de cair pro premium.
 */
export function AgentBehaviorPanel() {
  const { t } = useT();
  const aiRouting = useSettingsStore((s) => s.settings?.aiRouting);
  const updateAiRouting = useSettingsStore((s) => s.updateAiRouting);

  const update = (patch: Partial<SettingsRecord['aiRouting']>): void => {
    void updateAiRouting(patch);
  };

  return (
    <PanelShell
      icon={Bot}
      title={t('settings.agent.title')}
      description={t('settings.agent.description')}
    >
      {aiRouting && (
        <SettingsSection
          title={t('settings.agent.fallbackTitle')}
          description={t('settings.agent.fallbackDescription')}
        >
          <ToggleRow
            label={t('settings.models.routingPremiumLabel')}
            description={t('settings.models.routingPremiumDescription')}
            right={
              <Switch
                checked={aiRouting.allowPremiumFallback ?? true}
                onCheckedChange={(allowPremiumFallback) => update({ allowPremiumFallback })}
              />
            }
          />
          <ToggleRow
            label={t('settings.agent.attemptsLabel')}
            description={t('settings.agent.attemptsDescription')}
            right={
              <Select
                value={String(aiRouting.localAttemptsBeforeFallback ?? 2)}
                onValueChange={(v) => update({ localAttemptsBeforeFallback: Number(v) })}
              >
                <SelectTrigger className="h-8 w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ATTEMPT_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {t('settings.agent.attemptsOption', { count: n })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </SettingsSection>
      )}

      {aiRouting && (
        <SettingsSection
          title={t('settings.models.routingTitle')}
          description={t('settings.models.routingDescription')}
        >
          <ToggleRow
            label={t('settings.models.routingEnabledLabel')}
            description={t('settings.models.routingEnabledDescription')}
            right={
              <Switch
                checked={aiRouting.enabled}
                onCheckedChange={(enabled) => update({ enabled })}
              />
            }
          />
          <ToggleRow
            label={t('settings.models.routingModeLabel')}
            description={t('settings.models.routingModeDescription')}
            right={
              <Select
                value={aiRouting.mode}
                onValueChange={(mode) => update({ mode: mode as HybridModelRoutingMode })}
              >
                <SelectTrigger className="h-8 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROUTING_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(`settings.models.routingMode.${mode}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <ToggleRow
            label={t('settings.models.routingRiskLabel')}
            description={t('settings.models.routingRiskDescription')}
            right={
              <Select
                value={aiRouting.maxLocalRisk}
                onValueChange={(maxLocalRisk) => update({ maxLocalRisk: maxLocalRisk as TaskRisk })}
              >
                <SelectTrigger className="h-8 w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RISK_LEVELS.map((risk) => (
                    <SelectItem key={risk} value={risk}>
                      {t(`settings.models.routingRisk.${risk}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <ToggleRow
            label={t('settings.models.routingPreserveLabel')}
            description={t('settings.models.routingPreserveDescription')}
            right={
              <Switch
                checked={aiRouting.preserveCliContext}
                onCheckedChange={(preserveCliContext) => update({ preserveCliContext })}
              />
            }
          />
          <ToggleRow
            label={t('settings.models.routingApprovalLabel')}
            description={t('settings.models.routingApprovalDescription')}
            right={
              <Switch
                checked={aiRouting.requireApprovalForLocal}
                onCheckedChange={(requireApprovalForLocal) => update({ requireApprovalForLocal })}
              />
            }
          />
          <div className="rounded-md border border-hairline bg-surface/35 p-3 text-[11.5px] leading-relaxed text-text-muted">
            {t('settings.models.routingLocalPhases')}
          </div>
        </SettingsSection>
      )}
    </PanelShell>
  );
}
