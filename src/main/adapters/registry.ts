import type { AdapterDescriptor, AdapterType } from '@shared/types';
import type { AdapterModule, AdapterRegistry } from './types';
import { claudeLocal } from './impl/claude-local';
import { codexLocal } from './impl/codex-local';
import { geminiLocal } from './impl/gemini-local';
import {
  cursorCloud,
  cursorLocal,
  grokLocal,
  hermesLocal,
  opencodeLocal,
  openclawGateway,
  piLocal,
} from './impl/stubs';

/**
 * Registry singleton de adapters CLI. Ordem dos adapters define a ordem
 * de exibição na grade do onboarding.
 */
const registry: AdapterRegistry = new Map<AdapterType, AdapterModule>([
  // recomendados primeiro
  ['claude_local', claudeLocal],
  ['codex_local', codexLocal],
  // demais CLIs locais
  ['gemini_local', geminiLocal],
  ['opencode_local', opencodeLocal],
  ['pi_local', piLocal],
  ['grok_local', grokLocal],
  ['cursor_local', cursorLocal],
  ['hermes_local', hermesLocal],
  // config-driven (execução é follow-up)
  ['cursor_cloud', cursorCloud],
  ['openclaw_gateway', openclawGateway],
]);

export function listAdapterDescriptors(): AdapterDescriptor[] {
  return Array.from(registry.values()).map((m) => m.descriptor);
}

export function getAdapter(type: AdapterType): AdapterModule {
  // Forge removido: agentes legados com 'orkestral_local' caem no Claude (premium),
  // pois o adapter local não existe mais no registry.
  const resolved: AdapterType = type === 'orkestral_local' ? 'claude_local' : type;
  const m = registry.get(resolved);
  if (!m) {
    throw new Error(`Adapter desconhecido: ${type}`);
  }
  return m;
}
