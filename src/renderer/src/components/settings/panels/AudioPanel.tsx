import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Mic } from 'lucide-react';
import { PanelShell, SettingsSection, Field } from './PanelShell';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { useSettingsStore } from '@renderer/stores/settingsStore';
import { useT } from '@renderer/i18n';

/**
 * Valor-sentinela do <Select> pro "padrão do sistema" (mapeia pra null no
 * store). NÃO pode ser um deviceId real — o Chromium usa 'default' como id de
 * device de verdade, então usamos um token que nenhum device tem.
 */
const SYSTEM_DEFAULT = '__default__';

type Perm = 'unknown' | 'granted' | 'denied';

/**
 * Dispositivos de áudio: microfone de entrada (usado no ditado por voz) e saída.
 * Lê/grava em settings.audio. Os labels só aparecem após a permissão de
 * microfone (regra do enumerateDevices) — daí o CTA que a solicita.
 */
export function AudioPanel(): JSX.Element {
  const audio = useSettingsStore((s) => s.settings?.audio);
  const update = useSettingsStore((s) => s.updateAudio);
  const { t } = useT();

  const [perm, setPerm] = useState<Perm>('unknown');
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);

  const load = useCallback(async (requestPerms: boolean): Promise<void> => {
    try {
      if (requestPerms) {
        // Dispara o prompt de permissão pra desbloquear os labels dos devices.
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((tr) => tr.stop());
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const ins = devices.filter((d) => d.kind === 'audioinput' && d.deviceId);
      const outs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId);
      setInputs(ins);
      setOutputs(outs);
      // Rótulo presente ⇒ permissão concedida; senão ainda precisamos pedir.
      setPerm(ins.some((d) => d.label) ? 'granted' : 'unknown');
    } catch {
      setPerm('denied');
    }
  }, []);

  // Carrega no mount (sem forçar permissão) e re-carrega em hotplug de device.
  useEffect(() => {
    void load(false);
    const onChange = (): void => void load(false);
    navigator.mediaDevices?.addEventListener('devicechange', onChange);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', onChange);
  }, [load]);

  const inputValue = audio?.inputDeviceId ?? SYSTEM_DEFAULT;
  const outputValue = audio?.outputDeviceId ?? SYSTEM_DEFAULT;

  return (
    <PanelShell
      icon={Mic}
      title={t('settings.audio.title')}
      description={t('settings.audio.description')}
    >
      {perm !== 'granted' ? (
        <div className="rounded-xl border border-hairline bg-surface-veil p-5">
          <div className="text-[13px] font-medium text-text-primary">
            {t('settings.audio.permissionTitle')}
          </div>
          <div className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
            {perm === 'denied'
              ? t('settings.audio.permissionDenied')
              : t('settings.audio.permissionDescription')}
          </div>
          <button
            type="button"
            onClick={() => void load(true)}
            className="mt-3 h-8 rounded-md border border-accent-purple/40 bg-accent-purple/10 px-3 text-[12.5px] text-text-primary transition-colors hover:bg-accent-purple/15"
          >
            {t('settings.audio.permissionButton')}
          </button>
        </div>
      ) : (
        <SettingsSection title={t('settings.audio.groupDevices')}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label={t('settings.audio.inputLabel')}
              description={t('settings.audio.inputDescription')}
            >
              <Select
                value={inputValue}
                onValueChange={(v) =>
                  void update({ inputDeviceId: v === SYSTEM_DEFAULT ? null : v })
                }
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SYSTEM_DEFAULT}>
                    {t('settings.audio.systemDefault')}
                  </SelectItem>
                  {inputs.map((d) => (
                    <SelectItem key={d.deviceId} value={d.deviceId}>
                      {d.label || t('settings.audio.unknownDevice')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field
              label={t('settings.audio.outputLabel')}
              description={t('settings.audio.outputDescription')}
            >
              {outputs.length === 0 ? (
                <div className="text-[11.5px] text-text-muted">
                  {t('settings.audio.outputUnsupported')}
                </div>
              ) : (
                <Select
                  value={outputValue}
                  onValueChange={(v) =>
                    void update({ outputDeviceId: v === SYSTEM_DEFAULT ? null : v })
                  }
                >
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SYSTEM_DEFAULT}>
                      {t('settings.audio.systemDefault')}
                    </SelectItem>
                    {outputs.map((d) => (
                      <SelectItem key={d.deviceId} value={d.deviceId}>
                        {d.label || t('settings.audio.unknownDevice')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>
        </SettingsSection>
      )}
    </PanelShell>
  );
}
