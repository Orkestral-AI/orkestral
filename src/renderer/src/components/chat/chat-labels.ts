/**
 * Rótulo HONESTO do modelo no subtítulo das mensagens (ex.: "Build · claude_local · 19:51").
 * Um agente Forge (`orkestral_local`) é remapeado pra um CLI premium (Claude/Codex) nos
 * turnos de CHAT — a execução de código continua no Forge ($0), mas o chat não. Espelha o
 * remapeamento do backend (chat-service.ts) pra a UI não mostrar 'orkestral_local' quando o
 * turno rodou no premium. Compartilhado entre a SessionPage (chat principal) e o ChatSurface
 * (popover da IDE) — sem um importar página do outro.
 */
import { providerLabel } from '@renderer/components/ProviderIcon';

export function chatModelLabel(
  agent: { adapterType?: string | null; model?: string | null } | undefined,
  allAgents: { isOrchestrator?: boolean; adapterType?: string | null }[],
): string | undefined {
  if (!agent) return undefined;
  if (agent.model && agent.model !== 'default') return agent.model;
  // Nome AMIGÁVEL do provider (ex.: 'claude_local' → 'Claude Code') em vez do id cru — reusa
  // o catálogo único de labels do ProviderIcon (mesmo usado nas telas de agentes/issues).
  if (agent.adapterType !== 'orkestral_local')
    return agent.adapterType ? providerLabel(agent.adapterType) : undefined;
  const orch = allAgents.find((a) => a.isOrchestrator);
  const premium =
    orch && (orch.adapterType === 'claude_local' || orch.adapterType === 'codex_local')
      ? orch
      : allAgents.find((a) => a.adapterType === 'claude_local' || a.adapterType === 'codex_local');
  return providerLabel(premium?.adapterType === 'codex_local' ? 'codex_local' : 'claude_local');
}
