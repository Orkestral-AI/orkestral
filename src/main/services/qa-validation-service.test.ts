import { describe, expect, it } from 'vitest';
import {
  buildQaCheckPlan,
  buildQaVerdictIssueTransition,
  isQaAgent,
  shouldRouteIssueThroughQa,
} from './qa-validation-service';
import type { Agent, Issue, QaValidation } from '../../shared/types';

function issue(patch: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    workspaceId: 'workspace-1',
    issueKey: 1,
    title: 'Alterar cor do botão de login',
    description: 'Trocar botão principal da tela de login.',
    status: 'in_review',
    priority: 'medium',
    labels: ['frontend', 'ui'],
    assigneeAgentId: 'agent-1',
    reporterAgentId: null,
    parentIssueId: null,
    goalId: null,
    displayKey: 1,
    childOrdinal: null,
    dueDate: null,
    completedAt: null,
    metadata: { affectedFiles: ['src/components/LoginButton.tsx'] },
    createdAt: '2026-06-09T10:00:00.000Z',
    updatedAt: '2026-06-09T10:00:00.000Z',
    ...patch,
  };
}

function agent(patch: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    workspaceId: 'workspace-1',
    name: 'Frontend',
    role: 'frontend',
    title: 'Frontend',
    systemPrompt: '',
    adapterType: 'orkestral_local',
    adapterConfig: {},
    model: null,
    status: 'idle',
    isOrchestrator: false,
    canCreateAgents: false,
    canAssignTasks: false,
    canEditFiles: true,
    reportsTo: 'techlead-1',
    canRunCommands: true,
    runtimeConfig: {},
    heartbeatEnabled: false,
    heartbeatIntervalMinutes: 60,
    createdAt: '2026-06-09T10:00:00.000Z',
    updatedAt: '2026-06-09T10:00:00.000Z',
    ...patch,
  };
}

function validation(patch: Partial<QaValidation> = {}): QaValidation {
  return {
    id: 'validation-1',
    workspaceId: 'workspace-1',
    issueId: 'issue-1',
    executorAgentId: 'frontend-1',
    qaAgentId: 'qa-1',
    status: 'running',
    summary: null,
    startedAt: '2026-06-09T10:00:00.000Z',
    finishedAt: null,
    createdAt: '2026-06-09T10:00:00.000Z',
    updatedAt: '2026-06-09T10:00:00.000Z',
    checks: [],
    ...patch,
  };
}

describe('qa validation service', () => {
  it('builds frontend/design checks for UI issues', () => {
    const plan = buildQaCheckPlan(issue());
    const kinds = plan.map((check) => check.kind);

    expect(kinds).toContain('design-system');
    expect(kinds).toContain('ui-smoke');
    expect(kinds).toContain('accessibility');
    expect(kinds).toContain('automated-tests');
    expect(kinds).toContain('verdict');
  });

  it('builds backend contract checks for API issues', () => {
    const plan = buildQaCheckPlan(
      issue({
        title: 'Adicionar campo phone no cadastro',
        description: 'Alterar DTO e endpoint POST /register.',
        labels: ['backend', 'api'],
        metadata: { affectedFiles: ['app/Http/Controllers/AuthController.php'] },
      }),
    );
    const kinds = plan.map((check) => check.kind);

    expect(kinds).toContain('contract');
    expect(kinds).toContain('data-safety');
  });

  it('routes specialist work through QA but avoids QA/lead/reviewer loops', () => {
    expect(shouldRouteIssueThroughQa(issue(), agent())).toBe(true);
    expect(shouldRouteIssueThroughQa(issue(), agent({ role: 'qa', name: 'QA' }))).toBe(false);
    expect(shouldRouteIssueThroughQa(issue(), agent({ role: 'tech-lead', name: 'TechLead' }))).toBe(
      false,
    );
    expect(
      shouldRouteIssueThroughQa(issue(), agent({ role: 'code-reviewer', name: 'Code Reviewer' })),
    ).toBe(false);
  });

  it('detects QA agents by role/name/title', () => {
    expect(isQaAgent(agent({ role: 'qa', name: 'Quality' }))).toBe(true);
    expect(isQaAgent(agent({ role: 'frontend', name: 'Frontend' }))).toBe(false);
  });

  it('returns failed QA work to the original executor without losing metadata', () => {
    const transition = buildQaVerdictIssueTransition({
      issue: issue({
        status: 'in_review',
        assigneeAgentId: 'qa-1',
        metadata: { review: { executorAgentId: 'frontend-1', depth: 0, attempts: 0 } },
      }),
      validation: validation(),
      status: 'failed',
      summary: 'Botão ficou fora do design system.',
      executorName: 'Frontend',
      qaName: 'QA',
    });

    expect(transition.patch.status).toBe('todo');
    expect(transition.patch.assigneeAgentId).toBe('frontend-1');
    expect((transition.patch.metadata as Record<string, unknown>).review).toEqual({
      executorAgentId: 'frontend-1',
      depth: 0,
      attempts: 0,
    });
    expect(transition.visibilityComment).toContain('devolveu para @Frontend');
  });

  it('marks passed QA as done so the review chain can continue', () => {
    const transition = buildQaVerdictIssueTransition({
      issue: issue({ status: 'in_review', assigneeAgentId: 'qa-1' }),
      validation: validation(),
      status: 'passed',
      summary: 'Smoke e design system passaram.',
      executorName: 'Frontend',
      qaName: 'QA',
    });

    expect(transition.patch.status).toBe('done');
    expect(transition.visibilityComment).toContain('aprovou');
  });

  it('blocks QA when human input is required', () => {
    const transition = buildQaVerdictIssueTransition({
      issue: issue({ status: 'in_review', assigneeAgentId: 'qa-1' }),
      validation: validation(),
      status: 'needs_human',
      summary: 'Credencial externa indisponível.',
      executorName: 'Frontend',
      qaName: 'QA',
    });

    expect(transition.patch.status).toBe('blocked');
    expect(transition.patch.assigneeAgentId).toBe('qa-1');
    expect(transition.visibilityComment).toContain('decisão humana');
  });
});
