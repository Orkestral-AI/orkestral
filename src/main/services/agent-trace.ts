import { broadcast } from '../platform/host';
import {
  agentTraceEventRepo,
  type CreateAgentTraceEventInput,
} from '../db/repositories/agent-trace-event.repo';
import { trace } from './log-bus';
import type {
  AgentTraceEvent,
  AgentTraceEventKind,
  AgentTraceEventStatus,
  TraceLevel,
} from '../../shared/types';

function levelForStatus(status: AgentTraceEventStatus): TraceLevel {
  if (status === 'failed') return 'error';
  if (status === 'skipped') return 'warn';
  if (status === 'completed') return 'success';
  return 'info';
}

function scopeForKind(kind: AgentTraceEventKind): string {
  return `agent:${kind}`;
}

function broadcastAgentTraceEvent(event: AgentTraceEvent): void {
  broadcast('agent-trace:event', event);
}

export function startAgentTraceStep(input: CreateAgentTraceEventInput): AgentTraceEvent {
  const event = agentTraceEventRepo.create({ ...input, status: input.status ?? 'started' });
  broadcastAgentTraceEvent(event);
  trace({
    level: levelForStatus(event.status),
    source: 'issue',
    scope: scopeForKind(event.kind),
    workspaceId: event.workspaceId,
    agentId: event.agentId,
    agentName: event.agentName,
    issueKey: event.issueKey,
    message: event.title,
  });
  return event;
}

export function finishAgentTraceStep(
  id: string,
  patch: {
    status?: AgentTraceEventStatus;
    summary?: string | null;
    payload?: Record<string, unknown> | null;
    durationMs?: number | null;
  } = {},
): AgentTraceEvent | null {
  const event = agentTraceEventRepo.complete(id, patch);
  if (!event) return null;
  broadcastAgentTraceEvent(event);
  trace({
    level: levelForStatus(event.status),
    source: 'issue',
    scope: scopeForKind(event.kind),
    workspaceId: event.workspaceId,
    agentId: event.agentId,
    agentName: event.agentName,
    issueKey: event.issueKey,
    durationMs: event.durationMs,
    message: event.summary ? `${event.title}: ${event.summary}` : event.title,
  });
  return event;
}

export function recordAgentTraceStep(
  input: Omit<CreateAgentTraceEventInput, 'status'> & {
    status?: AgentTraceEventStatus;
    durationMs?: number | null;
  },
): AgentTraceEvent {
  const wantedStatus = input.status ?? 'completed';
  const event = startAgentTraceStep({
    ...input,
    status: wantedStatus === 'started' ? 'started' : undefined,
  });
  if (wantedStatus === 'started') return event;
  return (
    finishAgentTraceStep(event.id, {
      status: wantedStatus,
      summary: event.summary,
      payload: event.payload,
      // step one-shot: honra a duracao informada pelo caller (senao a row recem-criada
      // resultaria em ~0ms ao recomputar now - startedAt).
      durationMs: input.durationMs ?? undefined,
    }) ?? event
  );
}

export function listAgentTraceEvents(input: {
  workspaceId: string;
  issueId?: string;
  runId?: string;
  limit?: number;
}): AgentTraceEvent[] {
  return agentTraceEventRepo.list(input);
}
