import { create } from 'zustand';
import type { SettingsRecord } from '@shared/types';
import { getCodeTheme } from '@renderer/lib/codeThemes';
import { paletteToOrkestralVars } from '@renderer/lib/paletteToVars';

/**
 * Store de configurações do renderer.
 *
 *  - `hydrate()` carrega o registro do main (settings:get) no boot e aplica os
 *    efeitos visuais imediatamente.
 *  - `updateAppearance` / `updateSystem` fazem update OTIMISTA (UI responde na
 *    hora) + persistem via settings:update, depois reaplicam os efeitos com o
 *    valor canônico devolvido pelo main.
 *
 * IMPORTANTE: o request de `settings:update` é `Partial<SettingsRecord>`, que só
 * torna as CHAVES DE TOPO opcionais — `appearance`/`system` continuam objetos
 * completos. Por isso sempre enviamos o sub-objeto inteiro já mesclado.
 *
 * Os efeitos visuais são data-attributes no <html>; o CSS em global.css reage a
 * eles. Isso NUNCA mexe na chrome do app — só remapeia o token de accent e
 * liga/desliga regras pontuais (fonte, densidade, wrap, largura do chat).
 */
interface SettingsStoreState {
  settings: SettingsRecord | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  updateAppearance: (patch: Partial<SettingsRecord['appearance']>) => Promise<void>;
  updateSystem: (patch: Partial<SettingsRecord['system']>) => Promise<void>;
  updatePrivacy: (patch: Partial<SettingsRecord['privacy']>) => Promise<void>;
  updateAudio: (patch: Partial<SettingsRecord['audio']>) => Promise<void>;
  updateAiRouting: (patch: Partial<SettingsRecord['aiRouting']>) => Promise<void>;
  updateKnowledge: (patch: Partial<SettingsRecord['knowledge']>) => Promise<void>;
  updatePerformance: (patch: Partial<SettingsRecord['performance']>) => Promise<void>;
}

/**
 * Listener do matchMedia do SO, ativo só quando o tema escolhido é "system".
 * Guardamos a referência pra remover/registrar quando o usuário troca de tema,
 * evitando vazamento e dupla-aplicação.
 */
let systemThemeMql: MediaQueryList | null = null;
let systemThemeListener: ((e: MediaQueryListEvent) => void) | null = null;

function teardownSystemThemeWatch(): void {
  if (systemThemeMql && systemThemeListener) {
    systemThemeMql.removeEventListener('change', systemThemeListener);
  }
  systemThemeMql = null;
  systemThemeListener = null;
}

let injectedVarNames: string[] = [];

/**
 * Injects the active code theme's UI palette as CSS vars on :root (chrome only).
 * 'default' clears injected vars → falls back to base @theme tokens.
 * Never touches --color-accent (workspace-driven).
 */
export function applyCodeTheme(s: SettingsRecord): void {
  const root = document.documentElement;
  const id = s.appearance.codeTheme ?? 'default';
  const resolved = resolveTheme(s.appearance.theme ?? 'dark');
  // Clear previously injected vars first so switching themes leaves no residue.
  for (const name of injectedVarNames) root.style.removeProperty(name);
  injectedVarNames = [];
  root.setAttribute('data-code-theme', id);
  if (id === 'default') return;
  const preset = getCodeTheme(id);
  const variant = resolved === 'light' ? preset.light : preset.dark;
  const vars = paletteToOrkestralVars(variant.app);
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
    injectedVarNames.push(name);
  }
}

/**
 * Calcula o zoom factor combinado a partir de fontSize + density.
 *
 * O app usa ~596 `text-[Xpx]` hardcoded, então mexer no `font-size` do root não
 * faz nada. O lever REAL e global é o zoom factor do webContents (main). Aqui
 * derivamos um único fator de ambos os controles — assim os dois passam a
 * escalar a UI inteira (texto + espaçamento) de verdade.
 *
 * Default (md + comfortable) → 1.0, garantindo visual idêntico ao de hoje.
 */
function computeZoomFactor(a: SettingsRecord['appearance']): number {
  const base = a.fontSize === 'sm' ? 0.9 : a.fontSize === 'lg' ? 1.12 : 1.0;
  const densityMul = a.density === 'compact' ? 0.92 : 1.0;
  const factor = Math.round(base * densityMul * 100) / 100;
  return Math.min(1.4, Math.max(0.7, factor));
}

/** Aplica o zoom global via main. Guardado: noop se o IPC ainda não existe. */
function applyZoom(a: SettingsRecord['appearance']): void {
  try {
    const api = (window as Window & { orkestral?: Record<string, unknown> }).orkestral;
    const setZoom = api?.['system:set-zoom'] as
      | ((req: { factor: number }) => Promise<unknown>)
      | undefined;
    if (typeof setZoom === 'function') {
      void setZoom({ factor: computeZoomFactor(a) }).catch(() => {});
    }
  } catch {
    // ignore — primeiro paint antes da hidratação não pode crashar
  }
}

/** Aplica a visibilidade (Dock/tray) via main. Guardado, best-effort. */
function applyVisibility(s: SettingsRecord['system']): void {
  try {
    const api = (window as Window & { orkestral?: Record<string, unknown> }).orkestral;
    const applyVis = api?.['system:apply-visibility'] as
      | ((req: { showAppIn: SettingsRecord['system']['showAppIn'] }) => Promise<unknown>)
      | undefined;
    if (typeof applyVis === 'function') {
      void applyVis({ showAppIn: s.showAppIn }).catch(() => {});
    }
  } catch {
    // ignore
  }
}

/** Resolve o tema concreto (dark|light) aplicado no <html>. */
function resolveTheme(theme: SettingsRecord['appearance']['theme']): 'dark' | 'light' {
  if (theme === 'system') {
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }
  return theme === 'light' ? 'light' : 'dark';
}

/** Aplica os efeitos visuais das configs no documento. Seguro chamar sempre. */
export function applyAppearance(s: SettingsRecord): void {
  const root = document.documentElement;
  const a = s.appearance;
  // Accent NÃO vem mais daqui: é a cor do workspace ativo (ver
  // workspaceStore.setActive + lib/accents). Settings cuida só de tema/zoom/etc.

  // Tema: dark|light|system. Dark é o default (não precisaria de atributo, mas
  // setamos explicitamente pra ficar previsível e simétrico com o light). Em
  // "system" resolvemos via matchMedia e ainda escutamos mudanças do SO pra o
  // tema virar ao vivo quando o usuário troca o tema do sistema.
  const theme = a.theme ?? 'dark';
  root.setAttribute('data-theme', resolveTheme(theme));
  teardownSystemThemeWatch();
  if (theme === 'system' && typeof window !== 'undefined') {
    systemThemeMql = window.matchMedia('(prefers-color-scheme: light)');
    systemThemeListener = (e) => {
      root.setAttribute('data-theme', e.matches ? 'light' : 'dark');
      const current = useSettingsStore.getState().settings;
      if (current) applyCodeTheme(current);
    };
    systemThemeMql.addEventListener('change', systemThemeListener);
  }

  root.setAttribute('data-font-size', a.fontSize ?? 'md');
  root.setAttribute('data-density', a.density ?? 'comfortable');
  root.setAttribute('data-code-wrap', a.codeBlockWrap ? 'on' : 'off');
  root.setAttribute('data-wide-chat', a.extraWideChat ? 'on' : 'off');

  // Zoom global é o lever real de fontSize+density num app de px hardcoded.
  applyZoom(a);
}

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  settings: null,
  hydrated: false,
  hydrate: async () => {
    const record = await window.orkestral['settings:get']();
    applyAppearance(record);
    applyCodeTheme(record);
    applyVisibility(record.system);
    set({ settings: record, hydrated: true });
  },
  updateAppearance: async (patch) => {
    const current = get().settings;
    if (!current) return;
    const nextAppearance: SettingsRecord['appearance'] = { ...current.appearance, ...patch };
    const optimistic: SettingsRecord = { ...current, appearance: nextAppearance };
    applyAppearance(optimistic);
    applyCodeTheme(optimistic);
    set({ settings: optimistic });
    const saved = await window.orkestral['settings:update']({ appearance: nextAppearance });
    applyAppearance(saved);
    applyCodeTheme(saved);
    set({ settings: saved });
  },
  updateSystem: async (patch) => {
    const current = get().settings;
    if (!current) return;
    const nextSystem: SettingsRecord['system'] = { ...current.system, ...patch };
    set({ settings: { ...current, system: nextSystem } });
    // Visibilidade (Dock) é efeito de SO — aplica quando showAppIn muda.
    if ('showAppIn' in patch) {
      applyVisibility(nextSystem);
    }
    const saved = await window.orkestral['settings:update']({ system: nextSystem });
    set({ settings: saved });
  },
  updatePrivacy: async (patch) => {
    const current = get().settings;
    if (!current) return;
    // O request de settings:update só torna as CHAVES DE TOPO opcionais — privacy
    // continua um objeto completo. Por isso mesclamos e mandamos o objeto inteiro.
    const nextPrivacy: SettingsRecord['privacy'] = { ...current.privacy, ...patch };
    set({ settings: { ...current, privacy: nextPrivacy } });
    const saved = await window.orkestral['settings:update']({ privacy: nextPrivacy });
    set({ settings: saved });
  },
  updateAudio: async (patch) => {
    const current = get().settings;
    if (!current) return;
    const nextAudio: SettingsRecord['audio'] = { ...current.audio, ...patch };
    set({ settings: { ...current, audio: nextAudio } });
    const saved = await window.orkestral['settings:update']({ audio: nextAudio });
    set({ settings: saved });
  },
  updateAiRouting: async (patch) => {
    const current = get().settings;
    if (!current) return;
    const nextAiRouting: SettingsRecord['aiRouting'] = { ...current.aiRouting, ...patch };
    set({ settings: { ...current, aiRouting: nextAiRouting } });
    const saved = await window.orkestral['settings:update']({ aiRouting: nextAiRouting });
    set({ settings: saved });
  },
  updateKnowledge: async (patch) => {
    const current = get().settings;
    if (!current) return;
    const nextKnowledge: SettingsRecord['knowledge'] = { ...current.knowledge, ...patch };
    set({ settings: { ...current, knowledge: nextKnowledge } });
    const saved = await window.orkestral['settings:update']({ knowledge: nextKnowledge });
    set({ settings: saved });
  },
  updatePerformance: async (patch) => {
    const current = get().settings;
    if (!current) return;
    const nextPerformance: SettingsRecord['performance'] = { ...current.performance, ...patch };
    set({ settings: { ...current, performance: nextPerformance } });
    const saved = await window.orkestral['settings:update']({ performance: nextPerformance });
    set({ settings: saved });
  },
}));
