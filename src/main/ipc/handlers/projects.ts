import { registerHandler } from '../register';
import { ProjectRepository } from '../../db/repositories/project.repo';

const repo = new ProjectRepository();

export function registerProjectHandlers(): void {
  registerHandler('project:list', ({ workspaceId }) => repo.listByWorkspace(workspaceId));

  registerHandler('project:create', (input) =>
    repo.create({
      workspaceId: input.workspaceId,
      name: input.name,
      path: input.path,
      gitRemote: input.gitRemote,
      provider: input.provider,
      description: input.description,
    }),
  );

  registerHandler('project:delete', ({ projectId }) => {
    repo.delete(projectId);
    return { ok: true as const };
  });

  registerHandler('project:scan', () => ({
    ok: false as const,
    error: 'Knowledge base scan ainda não implementado',
  }));
}
