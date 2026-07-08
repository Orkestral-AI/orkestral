/**
 * Helpers compartilhados do marketplace: paletas de acento e utilitários de
 * model-scope. O mapa de ícones vive em ./MarketplaceIcon (componente).
 */
import type { AdapterType, MarketplaceCatalogItem, Skill } from '@shared/types';
import { ALL_MODELS_SCOPE } from '@shared/types';
import { BRANDING } from '@shared/branding';
import type { TFunction } from '@renderer/i18n';

export interface AccentClasses {
  text: string;
  bg: string;
  border: string;
  ring: string;
  dot: string;
}

const ACCENTS: Record<string, AccentClasses> = {
  'accent-purple': {
    text: 'text-accent-purple',
    bg: 'bg-accent-purple/10',
    border: 'border-accent-purple/25',
    ring: 'ring-accent-purple/40',
    dot: 'bg-accent-purple',
  },
  'accent-blue': {
    text: 'text-accent-blue',
    bg: 'bg-accent-blue/10',
    border: 'border-accent-blue/25',
    ring: 'ring-accent-blue/40',
    dot: 'bg-accent-blue',
  },
  'accent-green': {
    text: 'text-accent-green',
    bg: 'bg-accent-green/10',
    border: 'border-accent-green/25',
    ring: 'ring-accent-green/40',
    dot: 'bg-accent-green',
  },
  'accent-yellow': {
    text: 'text-accent-yellow',
    bg: 'bg-accent-yellow/10',
    border: 'border-accent-yellow/25',
    ring: 'ring-accent-yellow/40',
    dot: 'bg-accent-yellow',
  },
  'accent-red': {
    text: 'text-accent-red',
    bg: 'bg-accent-red/10',
    border: 'border-accent-red/25',
    ring: 'ring-accent-red/40',
    dot: 'bg-accent-red',
  },
  'accent-orange': {
    text: 'text-accent-orange',
    bg: 'bg-accent-orange/10',
    border: 'border-accent-orange/25',
    ring: 'ring-accent-orange/40',
    dot: 'bg-accent-orange',
  },
};

export function accentFor(accent?: string): AccentClasses {
  return (accent && ACCENTS[accent]) || ACCENTS['accent-purple'];
}

/** Formata um número de "stars" em algo curto (12000 → 12k). */
export function formatStars(n?: number): string | null {
  if (!n || n <= 0) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.0', '')}k`;
  return String(n);
}

/** Avatar do owner no GitHub a partir de uma URL de repositório. */
export function githubAvatar(repoUrl?: string | null): string | undefined {
  if (!repoUrl) return undefined;
  const m = repoUrl.match(/github\.com\/([^/?#]+)/i);
  return m ? `https://github.com/${m[1]}.png?size=80` : undefined;
}

/** Logo a exibir pro item: iconUrl explícito, senão avatar do GitHub do repo. */
export function logoSrc(item: { iconUrl?: string; repoUrl?: string }): string | undefined {
  return item.iconUrl ?? githubAvatar(item.repoUrl);
}

// ---- Model scopes --------------------------------------------------------

const ADAPTER_LABELS: Partial<Record<AdapterType, string>> = {
  claude_local: 'Claude Code',
  codex_local: 'Codex',
  gemini_local: 'Gemini',
  cursor_local: 'Cursor',
  cursor_cloud: 'Cursor Cloud',
  grok_local: 'Grok',
  hermes_local: 'Hermes',
  opencode_local: 'OpenCode',
  pi_local: 'Pi',
  openclaw_gateway: 'OpenClaw',
  // Estava FALTANDO → o modelo local aparecia como "orkestral_local" cru (P1-01).
  orkestral_local: BRANDING.forgeName,
};

export interface ModelScopeOption {
  value: string;
  label: string;
  /** Quantos agentes usam esse scope (display). */
  count: number;
}

export interface AgentLike {
  adapterType: AdapterType | null;
  model?: string | null;
}

/** Deriva os model-scopes existentes a partir dos agentes do workspace. */
export function deriveScopeOptions(agents: AgentLike[], t: TFunction): ModelScopeOption[] {
  const counts = new Map<string, number>();
  for (const a of agents) {
    if (!a.adapterType) continue;
    const scope = scopeFor(a.adapterType, a.model ?? null);
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([value, count]) => ({
    value,
    label: scopeLabel(value, t),
    count,
  }));
}

export function scopeFor(adapterType: string, model: string | null): string {
  return `${adapterType}:${model && model !== 'default' ? model : 'default'}`;
}

/** "codex_local:default" → "Codex · default". `*` → "Todos os modelos". */
export function scopeLabel(scope: string, t: TFunction): string {
  if (scope === ALL_MODELS_SCOPE) return t('pages.marketplace.allModels');
  const [adapter, model] = scope.split(':');
  const name = ADAPTER_LABELS[adapter as AdapterType] ?? adapter;
  return model && model !== 'default' ? `${name} · ${model}` : name;
}

// ---- Installed-item helpers ---------------------------------------------

export interface InstalledMeta {
  id: string;
  modelScopes: string[];
  /** true quando habilitado em todos os modelos (scope `*`). */
  allModels: boolean;
  env: Record<string, string>;
  headers: Record<string, string>;
}

/** Extrai a metadata de marketplace de um skill instalado. */
export function readInstalledMeta(skill: Skill): InstalledMeta | null {
  const config = (skill.config ?? {}) as Record<string, unknown>;
  const mk = config.marketplace as
    | { id?: string; modelInstalls?: Array<{ modelScope: string }> }
    | undefined;
  if (!mk?.id) return null;
  const installs = Array.isArray(mk.modelInstalls) ? mk.modelInstalls : [];
  const modelScopes = installs.map((i) => i.modelScope).filter(Boolean);
  const server = (config.mcpServer ?? {}) as Record<string, unknown>;
  return {
    id: mk.id,
    modelScopes,
    allModels: modelScopes.length === 0 || modelScopes.includes(ALL_MODELS_SCOPE),
    env: (server.env as Record<string, string>) ?? {},
    headers: (server.headers as Record<string, string>) ?? {},
  };
}

/** Map catalogItemId → skill instalado (pra saber o que já está instalado). */
export function buildInstalledIndex(skills: Skill[]): Map<string, Skill> {
  const map = new Map<string, Skill>();
  for (const s of skills) {
    const meta = readInstalledMeta(s);
    if (meta) map.set(meta.id, s);
  }
  return map;
}

/** Resumo legível dos scopes de um item instalado. */
export function scopeSummary(meta: InstalledMeta, t: TFunction): string {
  if (meta.allModels) return t('pages.marketplace.allModels');
  if (meta.modelScopes.length === 0) return t('pages.marketplace.noModel');
  if (meta.modelScopes.length === 1) return scopeLabel(meta.modelScopes[0], t);
  return t('pages.marketplace.modelsCount', { n: meta.modelScopes.length });
}

export { ALL_MODELS_SCOPE };
export type { MarketplaceCatalogItem };
