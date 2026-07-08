import { describe, it, expect } from 'vitest';
import { paletteToOrkestralVars } from './paletteToVars';
import type { AppPalette } from './codeThemes';

const palette: AppPalette = {
  background: '#282a36',
  foreground: '#f8f8f2',
  card: '#2f3142',
  cardForeground: '#f8f8f2',
  popover: '#21222c',
  popoverForeground: '#f8f8f2',
  primary: '#bd93f9',
  primaryForeground: '#282a36',
  secondary: '#44475a',
  secondaryForeground: '#f8f8f2',
  muted: '#343746',
  mutedForeground: '#6272a4',
  accent: '#ff79c6',
  accentForeground: '#282a36',
  destructive: '#ff5555',
  destructiveForeground: '#f8f8f2',
  border: '#3a3d4f',
  input: '#3a3d4f',
  ring: '#bd93f9',
};

describe('paletteToOrkestralVars', () => {
  it('maps chrome fields to --color-* vars', () => {
    const vars = paletteToOrkestralVars(palette);
    expect(vars['--color-background']).toBe('#282a36');
    expect(vars['--color-text-primary']).toBe('#f8f8f2');
    expect(vars['--color-surface']).toBe('#2f3142');
    expect(vars['--color-dialog']).toBe('#21222c');
    expect(vars['--color-surface-elevated']).toBe('#343746');
    expect(vars['--color-sidebar']).toBe('#21222c');
    expect(vars['--color-text-muted']).toBe('#6272a4');
    expect(vars['--color-text-secondary']).toBe('#f8f8f2');
    expect(vars['--color-border']).toBe('#3a3d4f');
    expect(vars['--color-text-faint']).toBe('#6272a4');
    expect(vars['--color-border-strong']).toBe('#3a3d4f');
  });

  it('never emits --color-accent (accent stays workspace-driven)', () => {
    const vars = paletteToOrkestralVars(palette);
    expect(vars['--color-accent']).toBeUndefined();
  });

  it('returns an empty object for a null palette (default theme)', () => {
    expect(paletteToOrkestralVars(null)).toEqual({});
  });
});
