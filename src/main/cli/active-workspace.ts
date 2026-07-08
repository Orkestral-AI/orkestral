import { WorkspaceRepository } from '../db/repositories/workspace.repo';
import { SettingsRepository } from '../db/repositories/settings.repo';

/**
 * Resolve o id do workspace "ativo" pro CLI headless.
 *
 * 1. Lê o workspace persistido pelo `orkestral init` (chave `daemon` no
 *    `SettingsRepository`). É a escolha explícita do dono do daemon.
 * 2. Se não houver (init nunca rodou) OU o id apontar pra um workspace que não
 *    existe mais, cai no primeiro de `listAll()` — comportamento determinístico
 *    pra um daemon sem TTY.
 *
 * Retorna `null` quando não há nenhum workspace.
 */
export function resolveActiveWorkspaceId(): string | null {
  const workspaceRepo = new WorkspaceRepository();
  const all = workspaceRepo.listAll();
  if (all.length === 0) return null;

  const persisted = new SettingsRepository().getDaemonActiveWorkspaceId();
  if (persisted && all.some((w) => w.id === persisted)) return persisted;

  return all[0].id;
}
