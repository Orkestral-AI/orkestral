import { Bot } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { AdapterType } from '@shared/types';
import { AdapterBrandIcon } from '@renderer/components/brand-icons';
import { BRANDING } from '@shared/branding';

/**
 * Ícone do provedor a partir do adapterType OU da origem de CLI (claude, codex…).
 *
 * Resolve via `adapterBrandIcon` (fonte única das marcas — ver `brand-icons`):
 * os glifos são monocromáticos com `currentColor`, então herdam a cor do texto
 * e funcionam nos temas claro e escuro. Chaves de origem de CLI (claude, codex,
 * gemini, cursor) e nomes de provider (anthropic, openai…) são normalizados pro
 * AdapterType equivalente. Provedores desconhecidos caem num ícone genérico.
 */

/** Normaliza chaves de CLI/provider pro AdapterType correspondente. */
const PROVIDER_TO_ADAPTER: Record<string, AdapterType> = {
  claude: 'claude_local',
  anthropic: 'claude_local',
  codex: 'codex_local',
  openai: 'codex_local',
  gemini: 'gemini_local',
  google: 'gemini_local',
  grok: 'grok_local',
  xai: 'grok_local',
  cursor: 'cursor_local',
  opencode: 'opencode_local',
  pi: 'pi_local',
  hermes: 'hermes_local',
  orkestral: 'orkestral_local',
};

/** Conjunto de chaves reconhecidas (adapterTypes + chaves de CLI/provider). */
const KNOWN_ADAPTER_TYPES = new Set<string>([
  'claude_local',
  'codex_local',
  'cursor_local',
  'cursor_cloud',
  'gemini_local',
  'grok_local',
  'hermes_local',
  'opencode_local',
  'pi_local',
  'openclaw_gateway',
  'orkestral_local',
]);

function resolveAdapterType(provider?: string | null): AdapterType | null {
  if (!provider) return null;
  if (KNOWN_ADAPTER_TYPES.has(provider)) return provider as AdapterType;
  return PROVIDER_TO_ADAPTER[provider] ?? null;
}

export function ProviderIcon({
  provider,
  className,
}: {
  provider?: string | null;
  className?: string;
}) {
  const type = resolveAdapterType(provider);
  if (type) {
    return <AdapterBrandIcon type={type} className={cn('shrink-0', className)} />;
  }
  return <Bot className={cn('shrink-0', className)} />;
}

/** true se há um logo de marca pro provedor (senão é o fallback genérico). */
export function hasProviderIcon(provider?: string | null): boolean {
  return resolveAdapterType(provider) !== null;
}

const LABELS: Record<string, string> = {
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
  orkestral_local: BRANDING.forgeName,
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
};

/** Nome amigável do provedor/adapter. */
export function providerLabel(provider?: string | null): string {
  if (!provider) return 'Sem adapter';
  return LABELS[provider] ?? provider;
}
