/// <reference types="vite/client" />
import { useCallback } from 'react';
import { useSettingsStore } from '@renderer/stores/settingsStore';

/**
 * i18n leve, sem dependências.
 *
 * - Dicionários: um arquivo JSON por ÁREA em `locales/<lang>/<area>.json`
 *   (ex: locales/pt-BR/chat.json). Carregados via import.meta.glob (eager),
 *   então basta CRIAR o arquivo — nada precisa ser registrado aqui. Isso
 *   permite migrar a UI em lotes paralelos sem conflito (cada área = 1 arquivo).
 * - Chave de tradução = `<area>.<caminho.aninhado>` (ex: `chat.sources`).
 * - Interpolação: `{nome}` no texto, passado em `t(key, { nome: valor })`.
 * - Idioma ativo vem do settingsStore (appearance.language). 'system' resolve
 *   pelo locale do SO (navigator.language): pt* → pt-BR, senão en.
 */

export type Language = 'pt-BR' | 'en';
export type LanguagePref = 'system' | Language;

type Dict = Record<string, unknown>;

const ptModules = import.meta.glob('./locales/pt-BR/*.json', { eager: true });
const enModules = import.meta.glob('./locales/en/*.json', { eager: true });

function buildDict(modules: Record<string, unknown>): Dict {
  const dict: Dict = {};
  for (const path in modules) {
    const file = path.split('/').pop() ?? '';
    const area = file.replace(/\.json$/, '');
    const mod = modules[path] as { default?: unknown };
    dict[area] = (mod && 'default' in mod ? mod.default : mod) ?? {};
  }
  return dict;
}

const DICTS: Record<Language, Dict> = {
  'pt-BR': buildDict(ptModules),
  en: buildDict(enModules),
};

/** Resolve a preferência ('system' | lang) no idioma efetivo. */
export function resolveLanguage(pref: LanguagePref | undefined): Language {
  if (pref === 'pt-BR' || pref === 'en') return pref;
  const nav = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en';
  return nav.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}

function lookup(dict: Dict, key: string): string | undefined {
  let cur: unknown = dict;
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function interpolate(str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str;
  let out = str;
  for (const k of Object.keys(vars)) {
    out = out.split(`{${k}}`).join(String(vars[k]));
  }
  return out;
}

/**
 * Traduz uma chave. Fallback em cascata: idioma ativo → inglês → a própria
 * chave (pra ficar óbvio em dev que falta tradução, sem quebrar a UI).
 */
export function translate(
  lang: Language,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const hit = lookup(DICTS[lang], key) ?? lookup(DICTS.en, key);
  return interpolate(hit ?? key, vars);
}

export type TFunction = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Hook principal. Reage à troca de idioma (re-render automático via store).
 * Uso: `const { t } = useT(); t('chat.sources', { n: 4 })`.
 */
export function useT(): { t: TFunction; lang: Language } {
  const pref = useSettingsStore((s) => s.settings?.appearance.language) as LanguagePref | undefined;
  const lang = resolveLanguage(pref);
  const t = useCallback<TFunction>((key, vars) => translate(lang, key, vars), [lang]);
  return { t, lang };
}
