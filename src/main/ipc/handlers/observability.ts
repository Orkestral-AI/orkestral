import { registerHandler } from '../register';
import * as observability from '../../services/observability';

export function registerObservabilityHandlers(): void {
  registerHandler('observability:get-account', ({ workspaceId, provider }) =>
    observability.getConnection(workspaceId, provider),
  );
  registerHandler('observability:connect', (req) => observability.connect(req));
  registerHandler('observability:disconnect', ({ workspaceId, provider }) => {
    observability.disconnect(workspaceId, provider);
    return { ok: true as const };
  });
  registerHandler('observability:list-signals', (req) => observability.listSignals(req));
  registerHandler('observability:get-signal', (req) => observability.getSignalDetail(req));
  registerHandler('observability:analyze-signal', (req) => observability.analyzeSignal(req));
  registerHandler('observability:list-rules', (req) => observability.listRules(req));
  registerHandler('observability:save-rule', (req) => observability.saveRule(req));
  registerHandler('observability:delete-rule', ({ ruleId }) => {
    observability.deleteRule(ruleId);
    return { ok: true as const };
  });
  registerHandler('observability:list-runs', (req) => observability.listRuns(req));
  observability.startObservabilityWatcher();
}
