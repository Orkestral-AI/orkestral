import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Settings2 } from 'lucide-react';
import { Input } from '@renderer/components/ui/input';
import { Switch } from '@renderer/components/ui/switch';
import { Button } from '@renderer/components/ui/button';
import { PanelShell, SettingsSection, Field, ToggleRow } from './PanelShell';
import { useT } from '@renderer/i18n';

export function GeneralPanel() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const userQuery = useQuery({
    queryKey: ['user'],
    queryFn: () => window.orkestral['user:get'](),
  });
  const user = userQuery.data ?? null;

  const versionQuery = useQuery({
    queryKey: ['app-version'],
    queryFn: () => window.orkestral['app:get-version'](),
  });

  // Checagem real de atualização (GitHub Releases) — só mostramos "você está na
  // versão mais recente" quando o check confirma; se houver update, mostramos
  // a versão disponível em vez da frase estática que mentia.
  const updateQuery = useQuery({
    queryKey: ['update-check'],
    queryFn: () => window.orkestral['update:check'](),
  });

  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [email, setEmail] = useState('');
  const [useDeviceTz, setUseDeviceTz] = useState(true);

  // Hidrata os campos locais com os dados reais do usuário assim que chegam.
  useEffect(() => {
    if (!user) return;
    const frame = requestAnimationFrame(() => {
      setName(user.name ?? '');
      setAliases((user.aliases ?? []).join(', '));
      setEmail(user.email ?? '');
      setUseDeviceTz(user.useDeviceTimezone ?? true);
    });
    return () => cancelAnimationFrame(frame);
  }, [user]);

  const saveMutation = useMutation({
    mutationFn: () =>
      window.orkestral['user:update']({
        name: name.trim(),
        aliases: aliases
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean),
        email: email.trim() || null,
        useDeviceTimezone: useDeviceTz,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['user'] }),
  });

  return (
    <PanelShell
      title={t('settings.general.title')}
      icon={Settings2}
      description={t('settings.general.description')}
    >
      <SettingsSection title={t('settings.general.groupProfile')}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label={t('settings.general.nameLabel')}
            description={t('settings.general.nameDescription')}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings.general.namePlaceholder')}
            />
          </Field>
          <Field label={t('settings.general.emailLabel')}>
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('settings.general.emailPlaceholder')}
            />
          </Field>
        </div>

        <Field
          label={t('settings.general.aliasesLabel')}
          description={t('settings.general.aliasesDescription')}
        >
          <Input
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder={t('settings.general.aliasesPlaceholder')}
          />
        </Field>

        <div>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !userQuery.isSuccess}
          >
            {saveMutation.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </SettingsSection>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <SettingsSection title={t('settings.general.groupTimezone')}>
          <Field
            label={t('settings.general.timezoneLabel')}
            description={t('settings.general.timezoneDescription')}
          >
            <Button
              variant="secondary"
              size="sm"
              className="w-fit"
              onClick={() => void window.orkestral['system:open-datetime-settings']()}
            >
              {t('settings.general.openDatetimeSettings')}
            </Button>
          </Field>
          <ToggleRow
            label={t('settings.general.useDeviceTz')}
            right={<Switch checked={useDeviceTz} onCheckedChange={setUseDeviceTz} />}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.general.groupAbout')}>
          <div className="text-[11.5px] leading-relaxed text-text-muted">
            {t('settings.general.versionLine', {
              version: versionQuery.data ? ` v${versionQuery.data.version}` : '',
            })}
            {updateQuery.data && (
              <>
                <br />
                {updateQuery.data.hasUpdate && updateQuery.data.latestVersion ? (
                  <button
                    type="button"
                    onClick={() =>
                      updateQuery.data?.url &&
                      void window.orkestral['update:open']({ url: updateQuery.data.url })
                    }
                    className="text-accent transition-colors hover:text-accent/80"
                  >
                    {t('settings.general.updateAvailable', {
                      version: updateQuery.data.latestVersion,
                    })}
                  </button>
                ) : (
                  <span>{t('settings.general.upToDate')}</span>
                )}
              </>
            )}
          </div>
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void window.orkestral['app:quit']()}
            >
              {t('settings.general.quit')}
            </Button>
          </div>
        </SettingsSection>
      </div>
    </PanelShell>
  );
}
