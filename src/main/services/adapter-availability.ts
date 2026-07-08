import type { AdapterType } from '../../shared/types';

/**
 * Adapters meia-bomba: visíveis no onboarding/registry, mas SEM integração de
 * execução real. Antes caíam silenciosamente no binário do Claude (uma mentira).
 * Agora falham honestamente, tanto no chat quanto na execução de issue.
 *
 * Módulo standalone (sem deps de serviço) pra evitar ciclos de import entre
 * chat-service ↔ issue-execution-service ↔ mcp-server.
 */
const UNAVAILABLE_EXEC_ADAPTERS = new Set<AdapterType>([
  'gemini_local',
  'opencode_local',
  'pi_local',
  'grok_local',
]);

function adapterDisplayName(adapter: AdapterType): string {
  switch (adapter) {
    case 'gemini_local':
      return 'Gemini';
    case 'opencode_local':
      return 'OpenCode';
    case 'pi_local':
      return 'Pi';
    case 'grok_local':
      return 'Grok';
    default:
      return adapter;
  }
}

export function isUnavailableExecAdapter(adapter: AdapterType): boolean {
  return UNAVAILABLE_EXEC_ADAPTERS.has(adapter);
}

export function unavailableAdapterMessage(adapter: AdapterType): string {
  return `${adapterDisplayName(adapter)} ainda não está disponível para execução — em breve. Use Claude/Codex/Forge por enquanto.`;
}
