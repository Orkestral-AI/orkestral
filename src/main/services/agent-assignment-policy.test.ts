import { describe, expect, it } from 'vitest';
import { inferSourceRoleFromSignals, planSourceAgentAssignments } from './agent-assignment-policy';
import type { Agent, WorkspaceSource } from '../../shared/types';

function source(overrides: Partial<WorkspaceSource>): WorkspaceSource {
  return {
    id: 'source-1',
    workspaceId: 'workspace-1',
    kind: 'github_repo',
    path: '/tmp/workspace/sources/acme__pagfy-front-end',
    repoFullName: 'acme/pagfy-front-end',
    label: 'pagfy-front-end',
    role: null,
    isPrimary: true,
    displayOrder: 0,
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    ...overrides,
  };
}

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: 'agent-1',
    workspaceId: 'workspace-1',
    name: 'CEO',
    role: 'ceo',
    title: 'CEO',
    avatar: 'default',
    adapterType: 'claude_local',
    model: null,
    adapterConfig: {},
    reportsTo: null,
    capabilities: '',
    canCreateAgents: true,
    canAssignTasks: true,
    canEditFiles: true,
    canRunCommands: true,
    isOrchestrator: true,
    systemPrompt: '',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('source agent assignment policy', () => {
  it('reclassifies a stale mobile role when strong web signals are present', () => {
    const role = inferSourceRoleFromSignals({
      source: source({ role: 'mobile' }),
      packageHints: 'react react-dom next next.config.ts tailwindcss',
    });

    expect(role).toBe('frontend');
  });

  it('does not treat a Next.js app router repository as mobile', () => {
    const role = inferSourceRoleFromSignals({
      source: source({
        label: 'customer-web',
        path: '/tmp/workspace/sources/acme__customer-web/app/layout.tsx',
        repoFullName: 'acme/customer-web',
      }),
      packageHints: 'react react-dom next next.config.ts',
    });

    expect(role).toBe('frontend');
  });

  it('classifies mobile only when real mobile runtime signals exist', () => {
    const role = inferSourceRoleFromSignals({
      source: source({
        label: 'customer-mobile',
        path: '/tmp/workspace/sources/acme__customer-mobile',
        repoFullName: 'acme/customer-mobile',
      }),
      packageHints: 'react-native expo metro.config.js eas.json',
    });

    expect(role).toBe('mobile');
  });

  it('recommends a frontend specialist for a web repo even if the source was previously mobile', () => {
    const assignments = planSourceAgentAssignments({
      sources: [source({ role: 'mobile' })],
      agents: [agent({ id: 'ceo-1' })],
      packageHintsBySourceId: {
        'source-1': 'react react-dom next vite tailwindcss',
      },
    });

    expect(assignments[0]).toMatchObject({
      sourceRole: 'frontend',
      needsNewAgent: true,
      recommendedAgentRole: 'frontend',
      recommendedAgentName: 'Frontend',
    });
  });
});
