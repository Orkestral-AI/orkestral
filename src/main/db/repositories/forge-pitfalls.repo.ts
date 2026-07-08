/**
 * Forge removido: store de pitfalls inerte.
 *
 * O modelo local Forge saiu, então não há aprendizado de pitfalls a acumular. Mantido
 * como shim no-op pra preservar os call-sites (capsule/builder, orchestrator) sem tocar
 * o banco. A tabela `forge_pitfalls` deixou de ser usada.
 */
import type { Pitfall } from '../../../shared/types/capsule';

class ForgePitfallsRepository {
  retrieveTopK(
    _workspaceId: string,
    _query: { keywords: string[]; file: string | null },
    _k: number,
  ): Pitfall[] {
    return [];
  }
  record(_pitfall: unknown): void {
    /* no-op: aprendizado de pitfalls saiu com o Forge */
  }
}

export const forgePitfallsRepo = new ForgePitfallsRepository();
