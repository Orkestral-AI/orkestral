import { themes as prismThemes, type PrismTheme } from 'prism-react-renderer';
import type { CodeThemeId } from '@shared/types';

export type { CodeThemeId };

export interface CodeThemeColors {
  bg: string;
  fg: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  variable: string;
  type: string;
  addBg: string;
  addFg: string;
  delBg: string;
  delFg: string;
  border: string;
  lineNum: string;
}

export interface AppPalette {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
}

export interface CodeThemePreset {
  id: CodeThemeId;
  label: string;
  light: { prism: PrismTheme; colors: CodeThemeColors; app: AppPalette | null };
  dark: { prism: PrismTheme; colors: CodeThemeColors; app: AppPalette | null };
}

const DRACULA_DARK_APP: AppPalette = {
  background: '#282a36',
  foreground: '#f8f8f2',
  card: '#2f3142',
  cardForeground: '#f8f8f2',
  popover: '#343648',
  popoverForeground: '#f8f8f2',
  primary: '#bd93f9',
  primaryForeground: '#282a36',
  secondary: '#44475a',
  secondaryForeground: '#f8f8f2',
  muted: '#383a4c',
  mutedForeground: '#a8acc4',
  accent: '#44475a',
  accentForeground: '#f8f8f2',
  destructive: '#ff5555',
  destructiveForeground: '#ffffff',
  border: '#3a3d4f',
  input: '#3a3d4f',
  ring: '#bd93f9',
};

const DRACULA_LIGHT_APP: AppPalette = {
  background: '#fffbeb',
  foreground: '#1f1f1f',
  card: '#fff5d6',
  cardForeground: '#1f1f1f',
  popover: '#fff5d6',
  popoverForeground: '#1f1f1f',
  primary: '#7e3aa9',
  primaryForeground: '#ffffff',
  secondary: '#fce8a3',
  secondaryForeground: '#1f1f1f',
  muted: '#f5edc8',
  mutedForeground: '#5b4a30',
  accent: '#fce8a3',
  accentForeground: '#1f1f1f',
  destructive: '#cb3a3a',
  destructiveForeground: '#ffffff',
  border: '#e8d990',
  input: '#e8d990',
  ring: '#7e3aa9',
};

const MONOKAI_DARK_APP: AppPalette = {
  background: '#272822',
  foreground: '#f8f8f2',
  card: '#2f302a',
  cardForeground: '#f8f8f2',
  popover: '#34352e',
  popoverForeground: '#f8f8f2',
  primary: '#a6e22e',
  primaryForeground: '#272822',
  secondary: '#3e3d32',
  secondaryForeground: '#f8f8f2',
  muted: '#3e3d32',
  mutedForeground: '#a6a78d',
  accent: '#3e3d32',
  accentForeground: '#f8f8f2',
  destructive: '#f92672',
  destructiveForeground: '#ffffff',
  border: '#3e3d32',
  input: '#3e3d32',
  ring: '#a6e22e',
};

const MONOKAI_LIGHT_APP: AppPalette = {
  background: '#fafafa',
  foreground: '#272822',
  card: '#ffffff',
  cardForeground: '#272822',
  popover: '#ffffff',
  popoverForeground: '#272822',
  primary: '#5d8c1f',
  primaryForeground: '#ffffff',
  secondary: '#eaeaea',
  secondaryForeground: '#272822',
  muted: '#f0f0f0',
  mutedForeground: '#5e5d52',
  accent: '#eaeaea',
  accentForeground: '#272822',
  destructive: '#e22571',
  destructiveForeground: '#ffffff',
  border: '#dcdcd0',
  input: '#dcdcd0',
  ring: '#5d8c1f',
};

const ONE_DARK_APP: AppPalette = {
  background: '#282c34',
  foreground: '#abb2bf',
  card: '#2c313a',
  cardForeground: '#abb2bf',
  popover: '#21252b',
  popoverForeground: '#abb2bf',
  primary: '#61afef',
  primaryForeground: '#282c34',
  secondary: '#3e4451',
  secondaryForeground: '#abb2bf',
  muted: '#353b45',
  mutedForeground: '#828a99',
  accent: '#3e4451',
  accentForeground: '#abb2bf',
  destructive: '#e06c75',
  destructiveForeground: '#ffffff',
  border: '#3a3f4b',
  input: '#3a3f4b',
  ring: '#61afef',
};

const ONE_LIGHT_APP: AppPalette = {
  background: '#fafafa',
  foreground: '#383a42',
  card: '#ffffff',
  cardForeground: '#383a42',
  popover: '#ffffff',
  popoverForeground: '#383a42',
  primary: '#4078f2',
  primaryForeground: '#ffffff',
  secondary: '#e5e5e6',
  secondaryForeground: '#383a42',
  muted: '#ededee',
  mutedForeground: '#696c77',
  accent: '#e5e5e6',
  accentForeground: '#383a42',
  destructive: '#e45649',
  destructiveForeground: '#ffffff',
  border: '#d4d4d6',
  input: '#d4d4d6',
  ring: '#4078f2',
};

const TOKYO_NIGHT_APP: AppPalette = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  card: '#24283b',
  cardForeground: '#a9b1d6',
  popover: '#1f2335',
  popoverForeground: '#a9b1d6',
  primary: '#7aa2f7',
  primaryForeground: '#1a1b26',
  secondary: '#414868',
  secondaryForeground: '#c0caf5',
  muted: '#2a2f48',
  mutedForeground: '#787c99',
  accent: '#414868',
  accentForeground: '#c0caf5',
  destructive: '#f7768e',
  destructiveForeground: '#ffffff',
  border: '#2e3450',
  input: '#2e3450',
  ring: '#7aa2f7',
};

const TOKYO_DAY_APP: AppPalette = {
  background: '#e1e2e7',
  foreground: '#343b58',
  card: '#ffffff',
  cardForeground: '#343b58',
  popover: '#ffffff',
  popoverForeground: '#343b58',
  primary: '#34548a',
  primaryForeground: '#ffffff',
  secondary: '#cbcfda',
  secondaryForeground: '#343b58',
  muted: '#d3d6e0',
  mutedForeground: '#5b6079',
  accent: '#cbcfda',
  accentForeground: '#343b58',
  destructive: '#8c4351',
  destructiveForeground: '#ffffff',
  border: '#bec1cd',
  input: '#bec1cd',
  ring: '#34548a',
};

const NORD_DARK_APP: AppPalette = {
  background: '#2e3440',
  foreground: '#d8dee9',
  card: '#3b4252',
  cardForeground: '#d8dee9',
  popover: '#3b4252',
  popoverForeground: '#d8dee9',
  primary: '#88c0d0',
  primaryForeground: '#2e3440',
  secondary: '#434c5e',
  secondaryForeground: '#d8dee9',
  muted: '#3b4252',
  mutedForeground: '#a4adc0',
  accent: '#434c5e',
  accentForeground: '#d8dee9',
  destructive: '#bf616a',
  destructiveForeground: '#ffffff',
  border: '#434c5e',
  input: '#434c5e',
  ring: '#88c0d0',
};

const NORD_LIGHT_APP: AppPalette = {
  background: '#eceff4',
  foreground: '#2e3440',
  card: '#ffffff',
  cardForeground: '#2e3440',
  popover: '#ffffff',
  popoverForeground: '#2e3440',
  primary: '#5e81ac',
  primaryForeground: '#ffffff',
  secondary: '#d8dee9',
  secondaryForeground: '#2e3440',
  muted: '#e5e9f0',
  mutedForeground: '#4c566a',
  accent: '#d8dee9',
  accentForeground: '#2e3440',
  destructive: '#bf616a',
  destructiveForeground: '#ffffff',
  border: '#cbd1da',
  input: '#cbd1da',
  ring: '#5e81ac',
};

const GITHUB_DARK_APP: AppPalette = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  card: '#161b22',
  cardForeground: '#c9d1d9',
  popover: '#161b22',
  popoverForeground: '#c9d1d9',
  primary: '#58a6ff',
  primaryForeground: '#0d1117',
  secondary: '#21262d',
  secondaryForeground: '#c9d1d9',
  muted: '#161b22',
  mutedForeground: '#8b949e',
  accent: '#21262d',
  accentForeground: '#c9d1d9',
  destructive: '#f85149',
  destructiveForeground: '#ffffff',
  border: '#30363d',
  input: '#30363d',
  ring: '#58a6ff',
};

const GITHUB_LIGHT_APP: AppPalette = {
  background: '#ffffff',
  foreground: '#24292f',
  card: '#f6f8fa',
  cardForeground: '#24292f',
  popover: '#ffffff',
  popoverForeground: '#24292f',
  primary: '#0969da',
  primaryForeground: '#ffffff',
  secondary: '#eaeef2',
  secondaryForeground: '#24292f',
  muted: '#f6f8fa',
  mutedForeground: '#57606a',
  accent: '#eaeef2',
  accentForeground: '#24292f',
  destructive: '#cf222e',
  destructiveForeground: '#ffffff',
  border: '#d0d7de',
  input: '#d0d7de',
  ring: '#0969da',
};

const SOLARIZED_DARK_APP: AppPalette = {
  background: '#002b36',
  foreground: '#839496',
  card: '#073642',
  cardForeground: '#93a1a1',
  popover: '#073642',
  popoverForeground: '#93a1a1',
  primary: '#268bd2',
  primaryForeground: '#fdf6e3',
  secondary: '#073642',
  secondaryForeground: '#93a1a1',
  muted: '#073642',
  mutedForeground: '#586e75',
  accent: '#094352',
  accentForeground: '#93a1a1',
  destructive: '#dc322f',
  destructiveForeground: '#ffffff',
  border: '#0a4452',
  input: '#0a4452',
  ring: '#268bd2',
};

const SOLARIZED_LIGHT_APP: AppPalette = {
  background: '#fdf6e3',
  foreground: '#657b83',
  card: '#eee8d5',
  cardForeground: '#586e75',
  popover: '#eee8d5',
  popoverForeground: '#586e75',
  primary: '#268bd2',
  primaryForeground: '#fdf6e3',
  secondary: '#eee8d5',
  secondaryForeground: '#586e75',
  muted: '#eee8d5',
  mutedForeground: '#93a1a1',
  accent: '#e6dfc8',
  accentForeground: '#586e75',
  destructive: '#dc322f',
  destructiveForeground: '#ffffff',
  border: '#d9d2bb',
  input: '#d9d2bb',
  ring: '#268bd2',
};

const draculaDarkPrism: PrismTheme = {
  plain: { color: '#f8f8f2', backgroundColor: '#282a36' },
  styles: [
    {
      types: ['comment', 'prolog', 'doctype', 'cdata'],
      style: { color: '#6272a4', fontStyle: 'italic' },
    },
    { types: ['punctuation'], style: { color: '#f8f8f2' } },
    { types: ['property', 'tag', 'constant', 'symbol', 'deleted'], style: { color: '#ff79c6' } },
    { types: ['boolean', 'number'], style: { color: '#bd93f9' } },
    {
      types: ['selector', 'attr-name', 'string', 'char', 'builtin', 'inserted'],
      style: { color: '#f1fa8c' },
    },
    { types: ['operator', 'entity', 'url', 'variable'], style: { color: '#f8f8f2' } },
    { types: ['atrule', 'attr-value', 'function', 'class-name'], style: { color: '#50fa7b' } },
    { types: ['keyword'], style: { color: '#ff79c6' } },
    { types: ['regex', 'important'], style: { color: '#ffb86c' } },
  ],
};

// Alucard — Dracula's official light variant
const draculaLightPrism: PrismTheme = {
  plain: { color: '#1f1f1f', backgroundColor: '#fffbeb' },
  styles: [
    {
      types: ['comment', 'prolog', 'doctype', 'cdata'],
      style: { color: '#635196', fontStyle: 'italic' },
    },
    { types: ['punctuation'], style: { color: '#1f1f1f' } },
    { types: ['property', 'tag', 'constant', 'symbol', 'deleted'], style: { color: '#cf3a92' } },
    { types: ['boolean', 'number'], style: { color: '#7e3aa9' } },
    {
      types: ['selector', 'attr-name', 'string', 'char', 'builtin', 'inserted'],
      style: { color: '#3a7d34' },
    },
    { types: ['operator', 'entity', 'url', 'variable'], style: { color: '#1f1f1f' } },
    { types: ['atrule', 'attr-value', 'function', 'class-name'], style: { color: '#1e7c87' } },
    { types: ['keyword'], style: { color: '#cf3a92' } },
    { types: ['regex', 'important'], style: { color: '#c45228' } },
  ],
};

const monokaiDarkPrism: PrismTheme = {
  plain: { color: '#f8f8f2', backgroundColor: '#272822' },
  styles: [
    { types: ['comment'], style: { color: '#75715e', fontStyle: 'italic' } },
    { types: ['string', 'attr-value'], style: { color: '#e6db74' } },
    { types: ['punctuation', 'operator'], style: { color: '#f8f8f2' } },
    { types: ['keyword', 'tag', 'constant', 'symbol'], style: { color: '#f92672' } },
    { types: ['number', 'boolean'], style: { color: '#ae81ff' } },
    { types: ['function', 'class-name'], style: { color: '#a6e22e' } },
    { types: ['variable', 'attr-name', 'property'], style: { color: '#fd971f' } },
  ],
};

// Monokai Light (Sublime port)
const monokaiLightPrism: PrismTheme = {
  plain: { color: '#272822', backgroundColor: '#fafafa' },
  styles: [
    { types: ['comment'], style: { color: '#75715e', fontStyle: 'italic' } },
    { types: ['string', 'attr-value'], style: { color: '#a39515' } },
    { types: ['punctuation', 'operator'], style: { color: '#272822' } },
    { types: ['keyword', 'tag', 'constant', 'symbol'], style: { color: '#e22571' } },
    { types: ['number', 'boolean'], style: { color: '#7e57c2' } },
    { types: ['function', 'class-name'], style: { color: '#5d8c1f' } },
    { types: ['variable', 'attr-name', 'property'], style: { color: '#d96f1c' } },
  ],
};

const oneDarkPrism: PrismTheme = {
  plain: { color: '#abb2bf', backgroundColor: '#282c34' },
  styles: [
    { types: ['comment'], style: { color: '#5c6370', fontStyle: 'italic' } },
    { types: ['string', 'attr-value'], style: { color: '#98c379' } },
    { types: ['keyword', 'tag'], style: { color: '#c678dd' } },
    { types: ['number', 'boolean'], style: { color: '#d19a66' } },
    { types: ['function', 'class-name'], style: { color: '#61afef' } },
    { types: ['variable', 'property'], style: { color: '#e06c75' } },
    { types: ['punctuation', 'operator'], style: { color: '#abb2bf' } },
  ],
};

// One Light (Atom official)
const oneLightPrism: PrismTheme = {
  plain: { color: '#383a42', backgroundColor: '#fafafa' },
  styles: [
    { types: ['comment'], style: { color: '#a0a1a7', fontStyle: 'italic' } },
    { types: ['string', 'attr-value'], style: { color: '#50a14f' } },
    { types: ['keyword', 'tag'], style: { color: '#a626a4' } },
    { types: ['number', 'boolean'], style: { color: '#986801' } },
    { types: ['function', 'class-name'], style: { color: '#4078f2' } },
    { types: ['variable', 'property'], style: { color: '#e45649' } },
    { types: ['punctuation', 'operator'], style: { color: '#383a42' } },
  ],
};

const tokyoNightPrism: PrismTheme = {
  plain: { color: '#a9b1d6', backgroundColor: '#1a1b26' },
  styles: [
    { types: ['comment'], style: { color: '#565f89', fontStyle: 'italic' } },
    { types: ['string', 'attr-value'], style: { color: '#9ece6a' } },
    { types: ['keyword'], style: { color: '#bb9af7' } },
    { types: ['tag'], style: { color: '#f7768e' } },
    { types: ['number', 'boolean'], style: { color: '#ff9e64' } },
    { types: ['function'], style: { color: '#7aa2f7' } },
    { types: ['class-name'], style: { color: '#7dcfff' } },
    { types: ['variable', 'property'], style: { color: '#c0caf5' } },
    { types: ['punctuation', 'operator'], style: { color: '#a9b1d6' } },
  ],
};

// Tokyo Day — light variant
const tokyoDayPrism: PrismTheme = {
  plain: { color: '#343b58', backgroundColor: '#e1e2e7' },
  styles: [
    { types: ['comment'], style: { color: '#848cb5', fontStyle: 'italic' } },
    { types: ['string', 'attr-value'], style: { color: '#587539' } },
    { types: ['keyword'], style: { color: '#7847bd' } },
    { types: ['tag'], style: { color: '#8c4351' } },
    { types: ['number', 'boolean'], style: { color: '#965027' } },
    { types: ['function'], style: { color: '#34548a' } },
    { types: ['class-name'], style: { color: '#0f4b6e' } },
    { types: ['variable', 'property'], style: { color: '#343b58' } },
    { types: ['punctuation', 'operator'], style: { color: '#343b58' } },
  ],
};

const nordPrism: PrismTheme = {
  plain: { color: '#d8dee9', backgroundColor: '#2e3440' },
  styles: [
    { types: ['comment'], style: { color: '#616e88', fontStyle: 'italic' } },
    { types: ['string', 'attr-value'], style: { color: '#a3be8c' } },
    { types: ['keyword', 'tag'], style: { color: '#81a1c1' } },
    { types: ['number', 'boolean'], style: { color: '#b48ead' } },
    { types: ['function'], style: { color: '#88c0d0' } },
    { types: ['class-name'], style: { color: '#8fbcbb' } },
    { types: ['variable', 'property'], style: { color: '#d8dee9' } },
    { types: ['punctuation', 'operator'], style: { color: '#eceff4' } },
  ],
};

// Nord Light (Snow Storm bg + Frost accents)
const nordLightPrism: PrismTheme = {
  plain: { color: '#2e3440', backgroundColor: '#eceff4' },
  styles: [
    { types: ['comment'], style: { color: '#7b8794', fontStyle: 'italic' } },
    { types: ['string', 'attr-value'], style: { color: '#697b3a' } },
    { types: ['keyword', 'tag'], style: { color: '#5e81ac' } },
    { types: ['number', 'boolean'], style: { color: '#b48ead' } },
    { types: ['function'], style: { color: '#5e9aa3' } },
    { types: ['class-name'], style: { color: '#3b6e6e' } },
    { types: ['variable', 'property'], style: { color: '#2e3440' } },
    { types: ['punctuation', 'operator'], style: { color: '#4c566a' } },
  ],
};

const solarizedDarkPrism: PrismTheme = {
  plain: { color: '#839496', backgroundColor: '#002b36' },
  styles: [
    { types: ['comment'], style: { color: '#586e75', fontStyle: 'italic' } },
    { types: ['string', 'attr-value'], style: { color: '#2aa198' } },
    { types: ['keyword'], style: { color: '#859900' } },
    { types: ['tag'], style: { color: '#268bd2' } },
    { types: ['number', 'boolean'], style: { color: '#d33682' } },
    { types: ['function'], style: { color: '#268bd2' } },
    { types: ['class-name'], style: { color: '#b58900' } },
    { types: ['variable', 'property'], style: { color: '#cb4b16' } },
    { types: ['punctuation', 'operator'], style: { color: '#93a1a1' } },
  ],
};

const solarizedLightPrism: PrismTheme = {
  plain: { color: '#657b83', backgroundColor: '#fdf6e3' },
  styles: [
    { types: ['comment'], style: { color: '#93a1a1', fontStyle: 'italic' } },
    { types: ['string', 'attr-value'], style: { color: '#2aa198' } },
    { types: ['keyword'], style: { color: '#859900' } },
    { types: ['tag'], style: { color: '#268bd2' } },
    { types: ['number', 'boolean'], style: { color: '#d33682' } },
    { types: ['function'], style: { color: '#268bd2' } },
    { types: ['class-name'], style: { color: '#b58900' } },
    { types: ['variable', 'property'], style: { color: '#cb4b16' } },
    { types: ['punctuation', 'operator'], style: { color: '#586e75' } },
  ],
};

const githubLightPrism: PrismTheme = {
  plain: { color: '#24292e', backgroundColor: '#ffffff' },
  styles: [
    { types: ['comment'], style: { color: '#6a737d', fontStyle: 'italic' } },
    { types: ['string', 'attr-value'], style: { color: '#032f62' } },
    { types: ['keyword'], style: { color: '#d73a49' } },
    { types: ['tag'], style: { color: '#22863a' } },
    { types: ['number', 'boolean'], style: { color: '#005cc5' } },
    { types: ['function'], style: { color: '#6f42c1' } },
    { types: ['class-name'], style: { color: '#6f42c1' } },
    { types: ['variable', 'property'], style: { color: '#e36209' } },
    { types: ['punctuation', 'operator'], style: { color: '#24292e' } },
  ],
};

const githubDarkPrism: PrismTheme = {
  plain: { color: '#c9d1d9', backgroundColor: '#0d1117' },
  styles: [
    { types: ['comment'], style: { color: '#8b949e', fontStyle: 'italic' } },
    { types: ['string', 'attr-value'], style: { color: '#a5d6ff' } },
    { types: ['keyword'], style: { color: '#ff7b72' } },
    { types: ['tag'], style: { color: '#7ee787' } },
    { types: ['number', 'boolean'], style: { color: '#79c0ff' } },
    { types: ['function'], style: { color: '#d2a8ff' } },
    { types: ['class-name'], style: { color: '#ffa657' } },
    { types: ['variable', 'property'], style: { color: '#ffa657' } },
    { types: ['punctuation', 'operator'], style: { color: '#c9d1d9' } },
  ],
};

function colorsFromPrism(
  prism: PrismTheme,
  overrides: Partial<CodeThemeColors> = {},
): CodeThemeColors {
  const get = (types: string[]): string => {
    for (const t of types) {
      const found = prism.styles.find((s) => s.types.includes(t));
      if (found?.style.color) return found.style.color as string;
    }
    return prism.plain.color as string;
  };
  const bg = prism.plain.backgroundColor as string;
  const fg = prism.plain.color as string;
  return {
    bg,
    fg,
    comment: get(['comment']),
    keyword: get(['keyword']),
    string: get(['string']),
    number: get(['number']),
    function: get(['function']),
    variable: get(['variable', 'property']),
    type: get(['class-name', 'type']),
    addBg: 'rgba(46, 160, 67, 0.16)',
    addFg: '#7ee787',
    delBg: 'rgba(248, 81, 73, 0.18)',
    delFg: '#ff7b72',
    border: 'rgba(255,255,255,0.08)',
    lineNum: 'rgba(255,255,255,0.3)',
    ...overrides,
  };
}

function lightColorsFromPrism(
  prism: PrismTheme,
  overrides: Partial<CodeThemeColors> = {},
): CodeThemeColors {
  return colorsFromPrism(prism, {
    addBg: 'rgba(46, 160, 67, 0.12)',
    addFg: '#22863a',
    delBg: 'rgba(248, 81, 73, 0.12)',
    delFg: '#d73a49',
    border: 'rgba(0,0,0,0.08)',
    lineNum: 'rgba(0,0,0,0.35)',
    ...overrides,
  });
}

export const CODE_THEMES: CodeThemePreset[] = [
  {
    id: 'default',
    label: 'Default',
    light: {
      prism: prismThemes.vsLight,
      colors: lightColorsFromPrism(prismThemes.vsLight),
      app: null,
    },
    dark: { prism: prismThemes.vsDark, colors: colorsFromPrism(prismThemes.vsDark), app: null },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    light: {
      prism: draculaLightPrism,
      colors: lightColorsFromPrism(draculaLightPrism),
      app: DRACULA_LIGHT_APP,
    },
    dark: {
      prism: draculaDarkPrism,
      colors: colorsFromPrism(draculaDarkPrism),
      app: DRACULA_DARK_APP,
    },
  },
  {
    id: 'monokai',
    label: 'Monokai',
    light: {
      prism: monokaiLightPrism,
      colors: lightColorsFromPrism(monokaiLightPrism),
      app: MONOKAI_LIGHT_APP,
    },
    dark: {
      prism: monokaiDarkPrism,
      colors: colorsFromPrism(monokaiDarkPrism),
      app: MONOKAI_DARK_APP,
    },
  },
  {
    id: 'oneDark',
    label: 'One Dark',
    light: {
      prism: oneLightPrism,
      colors: lightColorsFromPrism(oneLightPrism),
      app: ONE_LIGHT_APP,
    },
    dark: { prism: oneDarkPrism, colors: colorsFromPrism(oneDarkPrism), app: ONE_DARK_APP },
  },
  {
    id: 'tokyoNight',
    label: 'Tokyo Night',
    light: {
      prism: tokyoDayPrism,
      colors: lightColorsFromPrism(tokyoDayPrism),
      app: TOKYO_DAY_APP,
    },
    dark: {
      prism: tokyoNightPrism,
      colors: colorsFromPrism(tokyoNightPrism),
      app: TOKYO_NIGHT_APP,
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    light: {
      prism: nordLightPrism,
      colors: lightColorsFromPrism(nordLightPrism),
      app: NORD_LIGHT_APP,
    },
    dark: { prism: nordPrism, colors: colorsFromPrism(nordPrism), app: NORD_DARK_APP },
  },
  {
    id: 'github',
    label: 'GitHub',
    light: {
      prism: githubLightPrism,
      colors: lightColorsFromPrism(githubLightPrism),
      app: GITHUB_LIGHT_APP,
    },
    dark: {
      prism: githubDarkPrism,
      colors: colorsFromPrism(githubDarkPrism),
      app: GITHUB_DARK_APP,
    },
  },
  {
    id: 'solarized',
    label: 'Solarized',
    light: {
      prism: solarizedLightPrism,
      colors: lightColorsFromPrism(solarizedLightPrism),
      app: SOLARIZED_LIGHT_APP,
    },
    dark: {
      prism: solarizedDarkPrism,
      colors: colorsFromPrism(solarizedDarkPrism),
      app: SOLARIZED_DARK_APP,
    },
  },
];

export function getCodeTheme(id: CodeThemeId): CodeThemePreset {
  return CODE_THEMES.find((t) => t.id === id) ?? CODE_THEMES[0];
}
