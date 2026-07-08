import { registerHandler } from '../register';
import * as sentry from '../../services/sentry';

export function registerSentryHandlers(): void {
  registerHandler('sentry:get-account', ({ workspaceId }) => sentry.getConnection(workspaceId));

  registerHandler('sentry:connect', (req) => sentry.connect(req));

  registerHandler('sentry:disconnect', ({ workspaceId }) => {
    sentry.disconnect(workspaceId);
    return { ok: true as const };
  });

  registerHandler('sentry:list-issues', ({ workspaceId, limit }) =>
    sentry.listIssues(workspaceId, limit),
  );

  registerHandler('sentry:get-issue', ({ workspaceId, issueId }) =>
    sentry.getIssueDetail(workspaceId, issueId),
  );

  // Pede pro agente (CEO por padrão, ou o escolhido) analisar e corrigir um erro.
  registerHandler('sentry:analyze-issue', ({ workspaceId, issueId, agentId }) =>
    sentry.analyzeIssue({ workspaceId, issueId, agentId: agentId ?? null }),
  );

  // Ajuste do workspace: intervalo de auto-refresh.
  registerHandler('sentry:get-automation', ({ workspaceId }) => sentry.getAutomation(workspaceId));
  registerHandler('sentry:set-automation', (req) => sentry.setAutomation(req));

  // Regras de automação (várias por workspace) + histórico de execuções.
  registerHandler('sentry:list-rules', ({ workspaceId }) => sentry.listRules(workspaceId));
  registerHandler('sentry:save-rule', (req) => sentry.saveRule(req));
  registerHandler('sentry:delete-rule', ({ ruleId }) => {
    sentry.deleteRule(ruleId);
    return { ok: true as const };
  });
  registerHandler('sentry:list-runs', ({ workspaceId, limit }) =>
    sentry.listRuns(workspaceId, limit),
  );

  // Liga o watcher que age nas issues novas conforme a automação de cada workspace.
  sentry.startSentryWatcher();
}
