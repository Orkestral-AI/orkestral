import { describe, expect, it } from 'vitest';
import { scoreTrainingTrajectory, type ExecutionLearning } from './kb-learning';
import type { Issue } from '../../shared/types';

function issue(): Issue {
  return {
    id: 'issue-1',
    workspaceId: 'workspace-1',
    issueKey: 1,
    title: 'Adicionar telefone no cadastro',
    description: 'Adicionar campo phone no formulário de registro e enviar no submit.',
    status: 'done',
    priority: 'medium',
    labels: ['frontend'],
    assigneeAgentId: 'agent-1',
    reporterAgentId: null,
    parentIssueId: null,
    goalId: null,
    displayKey: null,
    childOrdinal: null,
    dueDate: null,
    completedAt: null,
    metadata: null,
    createdAt: '2026-06-14T00:00:00.000Z',
    updatedAt: '2026-06-14T00:00:00.000Z',
  };
}

function learning(overrides: Partial<ExecutionLearning> = {}): ExecutionLearning {
  return {
    issue: issue(),
    agentName: 'Frontend Web Agent',
    summary:
      'Campo phone adicionado ao RegisterFormData, input renderizado seguindo o design system e valor enviado no submit.',
    filesChanged: ['src/app/register/page.tsx', 'src/types/auth.ts'],
    outcome: 'done',
    modelUsed: 'local',
    verification: 'verified',
    changeBlock:
      '<orkestral:code-changes source_id="source-1" issue_id="issue-1"><file path="src/app/register/page.tsx" additions="8" deletions="1" /></orkestral:code-changes>',
    contextPack: '## Prior memory\nUse existing form input components.',
    source: {
      id: 'source-1',
      workspaceId: 'workspace-1',
      kind: 'github_repo',
      role: 'frontend',
      label: 'web',
      path: '/tmp/web',
      repoFullName: null,
      isPrimary: true,
      displayOrder: 0,
      lastIndexedFingerprint: null,
      lastSyncedFingerprint: null,
      freshnessStatus: 'fresh',
      lastSyncAt: null,
      syncDetails: null,
      createdAt: '2026-06-14T00:00:00.000Z',
      updatedAt: '2026-06-14T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('scoreTrainingTrajectory', () => {
  it('approves high-quality verified trajectories for post-training', () => {
    const score = scoreTrainingTrajectory(learning());

    expect(score.score).toBeGreaterThanOrEqual(0.65);
    expect(score.eligibleForAutoApproval).toBe(true);
    expect(score.rejectionReasons).toEqual([]);
  });

  it('rejects unverified or undone trajectories from auto approval', () => {
    const score = scoreTrainingTrajectory(
      learning({
        verification: 'unverified',
        details: 'Usuário clicou undo após revisar a mudança.',
      }),
    );

    expect(score.eligibleForAutoApproval).toBe(false);
    expect(score.rejectionReasons).toContain('unverified_execution');
    expect(score.rejectionReasons).toContain('undo_or_revert_signal');
  });
});
