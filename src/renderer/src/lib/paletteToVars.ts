import type { AppPalette } from './codeThemes';

/**
 * Maps a theme's UI palette → Orkestral chrome CSS vars. Chrome only:
 * --color-accent is intentionally absent (accent is the active workspace color).
 */
const PALETTE_TO_VAR: Partial<Record<keyof AppPalette, string | string[]>> = {
  background: '--color-background',
  foreground: '--color-text-primary',
  card: '--color-surface',
  popover: '--color-dialog',
  muted: '--color-surface-elevated',
  mutedForeground: ['--color-text-muted', '--color-text-faint'],
  secondaryForeground: '--color-text-secondary',
  border: ['--color-border', '--color-border-strong'],
};

/**
 * Escurece um hex por uma fração (0..1). Espelha o que o DevSenses faz no
 * sidebar (overlay `bg-black/[0.20]` sobre o background) sem precisar de um
 * campo dedicado na paleta. Ex.: Dracula bg #282a36 @0.18 → #21222c (o tom
 * escuro canônico do Dracula).
 */
function darkenHex(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * (1 - amount));
  const g = Math.round(((n >> 8) & 255) * (1 - amount));
  const b = Math.round((n & 255) * (1 - amount));
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Returns {} for null (default theme → falls back to base @theme tokens). */
export function paletteToOrkestralVars(palette: AppPalette | null): Record<string, string> {
  if (!palette) return {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(PALETTE_TO_VAR) as (keyof AppPalette)[]) {
    const varName = PALETTE_TO_VAR[key];
    const value = palette[key];
    if (!varName || typeof value !== 'string') continue;
    for (const name of Array.isArray(varName) ? varName : [varName]) {
      out[name] = value;
    }
  }
  // Sidebar: background levemente escurecido (igual ao overlay do DevSenses),
  // mantendo o sidebar um pouco mais escuro que o conteúdo sem diferença brusca.
  out['--color-sidebar'] = darkenHex(palette.background, 0.18);
  return out;
}
