import { registerHandler } from '../register';
import { WorkspaceRepository } from '../../db/repositories/workspace.repo';
import { stopAllPreviews } from '../../services/preview-manager';

export function registerWorkspaceHandlers(): void {
  const repo = new WorkspaceRepository();

  registerHandler('workspace:list', () => repo.list());
  registerHandler('workspace:create', (req) => repo.create(req));
  registerHandler('workspace:switch', (req) => {
    // Para o dev server do workspace anterior pra não deixar processo órfão segurando a porta.
    stopAllPreviews();
    return repo.switch(req.workspaceId);
  });
  registerHandler('workspace:update', (req) => repo.updateMeta(req.workspaceId, req.patch));
  registerHandler('workspace:list-archived', () => repo.listArchived());
  registerHandler('workspace:archive', (req) => repo.archive(req.workspaceId));
  registerHandler('workspace:unarchive', (req) => repo.unarchive(req.workspaceId));
  registerHandler('workspace:delete', (req) => {
    repo.delete(req.workspaceId);
    return { ok: true as const };
  });
}
