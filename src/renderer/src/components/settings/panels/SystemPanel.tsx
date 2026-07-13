import { Monitor } from 'lucide-react';
import { Switch } from '@renderer/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { PanelShell, SettingsSection, ToggleRow } from './PanelShell';
import { useSettingsStore } from '@renderer/stores/settingsStore';
import { useT } from '@renderer/i18n';
import type { SettingsRecord } from '@shared/types';

type System = SettingsRecord['system'];

export function SystemPanel() {
  const { t } = useT();
  const system = useSettingsStore((s) => s.settings?.system);
  const update = useSettingsStore((s) => s.updateSystem);
  const pet = useSettingsStore((s) => s.settings?.pet);
  const updatePet = useSettingsStore((s) => s.updatePet);
  const hydrate = useSettingsStore((s) => s.hydrate);

  const launch = system?.launchOnStartup ?? false;
  const notifications = system?.notifications ?? true;
  const notificationSound = system?.notificationSound ?? true;
  const inboxNotifications = system?.inboxNotifications ?? true;
  const timeFormat = system?.timeFormat ?? '24h';
  const showAppIn = system?.showAppIn ?? 'dock-and-status';

  async function updatePetEnabled(enabled: boolean): Promise<void> {
    // pet:set-enabled persiste E cria/destrói a janela no main; o hydrate
    // ressincroniza a store com o estado canônico (o main é a fonte da verdade).
    await window.orkestral['pet:set-enabled']({ enabled });
    await hydrate();
  }

  function updateNotifications(enabled: boolean): void {
    if (enabled && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
    void update({ notifications: enabled });
  }

  return (
    <PanelShell
      icon={Monitor}
      title={t('settings.system.title')}
      description={t('settings.system.description')}
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <SettingsSection title={t('settings.system.groupGeneral')}>
          <ToggleRow
            label={t('settings.system.launchLabel')}
            description={t('settings.system.launchDescription')}
            right={
              <Switch
                checked={launch}
                onCheckedChange={(v) => void update({ launchOnStartup: v })}
              />
            }
          />
          <ToggleRow
            label={t('settings.system.timeFormatLabel')}
            description={t('settings.system.timeFormatDescription')}
            right={
              <Select
                value={timeFormat}
                onValueChange={(v) => void update({ timeFormat: v as System['timeFormat'] })}
              >
                <SelectTrigger className="h-8 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="12h">{t('settings.system.timeFormat12h')}</SelectItem>
                  <SelectItem value="24h">{t('settings.system.timeFormat24h')}</SelectItem>
                </SelectContent>
              </Select>
            }
          />
          <ToggleRow
            label={t('settings.system.showAppInLabel')}
            description={t('settings.system.showAppInDescription')}
            right={
              <Select
                value={showAppIn}
                onValueChange={(v) => void update({ showAppIn: v as System['showAppIn'] })}
              >
                <SelectTrigger className="h-8 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dock-and-status">
                    {t('settings.system.showAppInDockAndStatus')}
                  </SelectItem>
                  <SelectItem value="dock">{t('settings.system.showAppInDock')}</SelectItem>
                  <SelectItem value="status">{t('settings.system.showAppInStatus')}</SelectItem>
                </SelectContent>
              </Select>
            }
          />
        </SettingsSection>
        <SettingsSection title={t('settings.system.groupNotifications')}>
          <ToggleRow
            label={t('settings.system.notificationsLabel')}
            description={t('settings.system.notificationsDescription')}
            right={<Switch checked={notifications} onCheckedChange={updateNotifications} />}
          />
          <ToggleRow
            label={t('settings.system.notificationSoundLabel')}
            description={t('settings.system.notificationSoundDescription')}
            right={
              <Switch
                checked={notificationSound}
                onCheckedChange={(v) => void update({ notificationSound: v })}
              />
            }
          />
          <ToggleRow
            label={t('settings.system.inboxNotificationsLabel')}
            description={t('settings.system.inboxNotificationsDescription')}
            right={
              <Switch
                checked={inboxNotifications}
                onCheckedChange={(v) => void update({ inboxNotifications: v })}
              />
            }
          />
        </SettingsSection>
        <SettingsSection title={t('settings.system.groupPet')}>
          <ToggleRow
            label={t('settings.system.petLabel')}
            description={t('settings.system.petDescription')}
            right={
              <Switch
                checked={pet?.enabled ?? false}
                onCheckedChange={(v) => void updatePetEnabled(v)}
              />
            }
          />
          <ToggleRow
            label={t('settings.system.petSizeLabel')}
            description={t('settings.system.petSizeDescription')}
            right={
              <Select
                value={pet?.size ?? 'md'}
                onValueChange={(v) => void updatePet({ size: v as 'sm' | 'md' })}
              >
                <SelectTrigger className="h-8 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sm">{t('settings.system.petSizeSm')}</SelectItem>
                  <SelectItem value="md">{t('settings.system.petSizeMd')}</SelectItem>
                </SelectContent>
              </Select>
            }
          />
          <ToggleRow
            label={t('settings.system.petSoundLabel')}
            description={t('settings.system.petSoundDescription')}
            right={
              <Switch
                checked={pet?.sound ?? true}
                onCheckedChange={(v) => void updatePet({ sound: v })}
              />
            }
          />
          <ToggleRow
            label={t('settings.system.petDndLabel')}
            description={t('settings.system.petDndDescription')}
            right={
              <Switch
                checked={pet?.doNotDisturb ?? false}
                onCheckedChange={(v) => void updatePet({ doNotDisturb: v })}
              />
            }
          />
          <ToggleRow
            label={t('settings.system.petNotifExecutionLabel')}
            description={t('settings.system.petNotifExecutionDescription')}
            right={
              <Switch
                checked={pet?.notifications.execution ?? true}
                onCheckedChange={(v) => void updatePet({ notifications: { execution: v } })}
              />
            }
          />
          <ToggleRow
            label={t('settings.system.petNotifInboxLabel')}
            description={t('settings.system.petNotifInboxDescription')}
            right={
              <Switch
                checked={pet?.notifications.inbox ?? false}
                onCheckedChange={(v) => void updatePet({ notifications: { inbox: v } })}
              />
            }
          />
          <ToggleRow
            label={t('settings.system.petNotifUpdatesLabel')}
            description={t('settings.system.petNotifUpdatesDescription')}
            right={
              <Switch
                checked={pet?.notifications.updates ?? true}
                onCheckedChange={(v) => void updatePet({ notifications: { updates: v } })}
              />
            }
          />
        </SettingsSection>
      </div>
    </PanelShell>
  );
}
