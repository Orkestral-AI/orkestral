import { broadcast } from '../platform/host';

/**
 * Broadcasta uma mudança de issues pra todas as janelas, pra a UI (inbox/épico/detalhe)
 * refrescar ao vivo via o listener `onIssuesChanged` (invalida as queries de issue).
 * Mesmo canal que o MCP/skills já usam.
 */
export function broadcastIssuesChanged(workspaceId: string, reason: string): void {
  broadcast('issues:changed-by-mcp', { workspaceId, reason });
}
