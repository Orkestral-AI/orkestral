import { registerHandler } from '../register';
import { listTraces, clearTraces } from '../../services/log-bus';
import { listAgentTraceEvents } from '../../services/agent-trace';

export function registerLogsHandlers(): void {
  registerHandler('logs:list', ({ limit }) => listTraces(limit ?? 500));
  registerHandler('logs:clear', () => {
    clearTraces();
    return { ok: true as const };
  });
  registerHandler('logs:list-agent-trace-events', (input) => listAgentTraceEvents(input));
}
