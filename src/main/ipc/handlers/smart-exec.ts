import { registerHandler } from '../register';
import { getSmartExecConfig } from '../../services/smart-exec/config';
import { TaskExecutionRepository } from '../../db/repositories/task-execution.repo';

const recordRepo = new TaskExecutionRepository();

export function registerSmartExecHandlers(): void {
  // Config é GERENCIADA pelo app (modelo embutido) — só leitura, sem setter.
  registerHandler('smart-exec:get-config', () => getSmartExecConfig());
  registerHandler('smart-exec:list-records', ({ workspaceId, limit }) =>
    recordRepo.listByWorkspace(workspaceId, limit ?? 100),
  );
  registerHandler('smart-exec:metrics', ({ workspaceId }) =>
    recordRepo.metricsSummary(workspaceId),
  );
}
