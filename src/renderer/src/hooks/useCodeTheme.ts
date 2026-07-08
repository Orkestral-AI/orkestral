import { useSettingsStore } from '@renderer/stores/settingsStore';
import { getCodeTheme, type CodeThemePreset } from '@renderer/lib/codeThemes';

export function useCodeTheme(): {
  preset: CodeThemePreset;
  resolved: 'light' | 'dark';
  variant: CodeThemePreset['light'] | CodeThemePreset['dark'];
} {
  const appearance = useSettingsStore((s) => s.settings?.appearance);
  const themeId = appearance?.codeTheme ?? 'default';
  const mode = appearance?.theme ?? 'dark';
  const resolved: 'light' | 'dark' =
    mode === 'system'
      ? typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : mode === 'light'
        ? 'light'
        : 'dark';
  const preset = getCodeTheme(themeId);
  const variant = resolved === 'light' ? preset.light : preset.dark;
  return { preset, resolved, variant };
}
