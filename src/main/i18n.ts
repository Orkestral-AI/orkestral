import { app } from './platform/electron';
import { SettingsRepository } from './db/repositories/settings.repo';

/**
 * i18n mínimo do MAIN process — pras poucas strings geradas no servidor
 * (títulos de sessão, prompts de sistema, fallbacks). O renderer tem o seu
 * próprio i18n; aqui só precisamos escolher pt-BR vs en.
 *
 * O idioma vem da MESMA preferência do usuário (settings.appearance.language).
 * 'system' resolve pelo locale do SO (app.getLocale).
 */
export type MainLang = 'pt-BR' | 'en';

const settingsRepo = new SettingsRepository();

export function activeLanguage(): MainLang {
  try {
    const pref = settingsRepo.get().appearance.language;
    if (pref === 'pt-BR' || pref === 'en') return pref;
  } catch {
    // settings ainda não inicializado — cai no locale do SO
  }
  // Node puro (sem Electron): não há locale do app — cai no default 'en'.
  const loc = (app?.getLocale?.() || 'en').toLowerCase();
  return loc.startsWith('pt') ? 'pt-BR' : 'en';
}

/** Escolhe entre o texto pt-BR e o en conforme o idioma ativo. */
export function mt(pt: string, en: string): string {
  return activeLanguage() === 'pt-BR' ? pt : en;
}

/** Nome do idioma ativo por extenso (pra instruir o modelo). */
export function activeLanguageName(): string {
  return activeLanguage() === 'pt-BR' ? 'português do Brasil (pt-BR)' : 'English';
}
