import { useSettingsStore } from '@renderer/stores/settingsStore';
import { resolveLanguage } from '@renderer/i18n';

/** Locale ativo (idioma das settings), pra formatar datas sem hardcodar 'pt-BR'. */
function activeLocale(): string {
  return resolveLanguage(useSettingsStore.getState().settings?.appearance.language);
}

/**
 * Formata um horário (HH:MM) respeitando o formato escolhido nas configurações
 * (12h/24h). Lê a settings store diretamente — componentes re-renderizam quando
 * novos dados chegam, então o formato passa a valer dali em diante.
 */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  const timeFormat = useSettingsStore.getState().settings?.system.timeFormat ?? '24h';
  return d.toLocaleTimeString(activeLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: timeFormat === '12h',
  });
}

/**
 * Formata data + hora completas respeitando o formato 12h/24h. Usado em
 * timestamps de issues/comentários/runs.
 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const timeFormat = useSettingsStore.getState().settings?.system.timeFormat ?? '24h';
  return d.toLocaleString(activeLocale(), { hour12: timeFormat === '12h' });
}

/** Hora com segundos (timeline ao vivo), respeitando 12h/24h. */
export function formatTimeWithSeconds(iso: string | number): string {
  const d = new Date(iso);
  const timeFormat = useSettingsStore.getState().settings?.system.timeFormat ?? '24h';
  return d.toLocaleTimeString(activeLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: timeFormat === '12h',
  });
}
