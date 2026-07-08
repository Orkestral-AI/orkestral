import { describe, expect, it } from 'vitest';
import {
  agentMayUseTool,
  classifyAgentToolRole,
  mutatingToolRequiresAgentId,
  type ToolRoleInput,
} from './mcp-tool-scope';

function agentFixture(overrides: Partial<ToolRoleInput> = {}): ToolRoleInput {
  return {
    role: 'engineer',
    name: 'Pat',
    title: null,
    isOrchestrator: false,
    canCreateAgents: false,
    canAssignTasks: false,
    canEditFiles: true,
    canRunCommands: true,
    ...overrides,
  };
}

describe('classifyAgentToolRole', () => {
  it('classifies isOrchestrator as orchestrator', () => {
    expect(classifyAgentToolRole(agentFixture({ isOrchestrator: true }))).toBe('orchestrator');
  });

  it('classifies agents that can assign tasks or create agents as orchestrator', () => {
    expect(classifyAgentToolRole(agentFixture({ canAssignTasks: true }))).toBe('orchestrator');
    expect(classifyAgentToolRole(agentFixture({ canCreateAgents: true }))).toBe('orchestrator');
  });

  it('classifies CEO/lead/manager names/roles as orchestrator', () => {
    expect(classifyAgentToolRole(agentFixture({ role: 'ceo' }))).toBe('orchestrator');
    expect(classifyAgentToolRole(agentFixture({ title: 'Tech Lead' }))).toBe('orchestrator');
    expect(classifyAgentToolRole(agentFixture({ role: 'manager' }))).toBe('orchestrator');
  });

  it('classifies a pure analyst (no edit, no commands) as readonly', () => {
    expect(
      classifyAgentToolRole(
        agentFixture({ role: 'analyst', canEditFiles: false, canRunCommands: false }),
      ),
    ).toBe('readonly');
  });

  it('classifies a worker that can edit/run but not orchestrate as executor', () => {
    expect(classifyAgentToolRole(agentFixture({ role: 'backend' }))).toBe('executor');
  });
});

describe('agentMayUseTool', () => {
  it('lets anonymous callers (null role) use anything — legacy behavior', () => {
    expect(agentMayUseTool(null, 'assign_issue')).toBe(true);
    expect(agentMayUseTool(null, 'create_issue')).toBe(true);
  });

  it('lets the orchestrator use every tool', () => {
    expect(agentMayUseTool('orchestrator', 'assign_issue')).toBe(true);
    expect(agentMayUseTool('orchestrator', 'update_goal_status')).toBe(true);
    expect(agentMayUseTool('orchestrator', 'create_goal')).toBe(true);
    expect(agentMayUseTool('orchestrator', 'create_issue')).toBe(true);
    expect(agentMayUseTool('orchestrator', 'kb_search')).toBe(true);
  });

  it('restricts a readonly agent to read-only tools', () => {
    expect(agentMayUseTool('readonly', 'kb_search')).toBe(true);
    expect(agentMayUseTool('readonly', 'get_issue')).toBe(true);
    expect(agentMayUseTool('readonly', 'create_issue')).toBe(false);
    expect(agentMayUseTool('readonly', 'comment_on_issue')).toBe(false);
    expect(agentMayUseTool('readonly', 'kb_create_page')).toBe(false);
  });

  it('lets an executor work but not orchestrate the team backlog', () => {
    // own-work + KB/skill writes the executor prompt actually uses
    expect(agentMayUseTool('executor', 'comment_on_issue')).toBe(true);
    expect(agentMayUseTool('executor', 'update_issue_status')).toBe(true);
    expect(agentMayUseTool('executor', 'create_issue')).toBe(true);
    expect(agentMayUseTool('executor', 'kb_create_page')).toBe(true);
    expect(agentMayUseTool('executor', 'skill_create')).toBe(true);
    expect(agentMayUseTool('executor', 'kb_search')).toBe(true);
    // orchestration-only tools are denied
    expect(agentMayUseTool('executor', 'assign_issue')).toBe(false);
    expect(agentMayUseTool('executor', 'update_issue')).toBe(false);
    expect(agentMayUseTool('executor', 'update_goal_status')).toBe(false);
    expect(agentMayUseTool('executor', 'create_goal')).toBe(false);
  });
});

describe('mutatingToolRequiresAgentId (cross-workspace gate)', () => {
  it('rejects a mutating tool when no agent role is resolved (anonymous)', () => {
    expect(mutatingToolRequiresAgentId('create_issue', false)).toBe(true);
    expect(mutatingToolRequiresAgentId('assign_issue', false)).toBe(true);
    expect(mutatingToolRequiresAgentId('comment_on_issue', false)).toBe(true);
    expect(mutatingToolRequiresAgentId('update_issue_status', false)).toBe(true);
    expect(mutatingToolRequiresAgentId('kb_create_page', false)).toBe(true);
  });

  it('allows a mutating tool once an agent role is present (identified caller)', () => {
    expect(mutatingToolRequiresAgentId('create_issue', true)).toBe(false);
    expect(mutatingToolRequiresAgentId('kb_create_page', true)).toBe(false);
  });

  it('never gates read tools on agent-id', () => {
    expect(mutatingToolRequiresAgentId('kb_search', false)).toBe(false);
    expect(mutatingToolRequiresAgentId('list_issues', false)).toBe(false);
    expect(mutatingToolRequiresAgentId('get_issue', false)).toBe(false);
  });

  it('gates the write tools that an allowlist of "known writes" used to miss', () => {
    // Estas mutam estado do workspace mas não estavam em MUTATING_TOOLS antes —
    // o default-deny (allowlist = READ_ONLY_TOOLS) as protege mesmo assim.
    expect(mutatingToolRequiresAgentId('update_issue', false)).toBe(true);
    expect(mutatingToolRequiresAgentId('update_goal_status', false)).toBe(true);
    expect(mutatingToolRequiresAgentId('kb_link_pages', false)).toBe(true);
    expect(mutatingToolRequiresAgentId('update_user_profile', false)).toBe(true);
    expect(mutatingToolRequiresAgentId('skill_create', false)).toBe(true);
    expect(mutatingToolRequiresAgentId('skill_improve', false)).toBe(true);
  });

  it('fails closed for an unknown/future tool (default-deny)', () => {
    expect(mutatingToolRequiresAgentId('totally_unknown_tool', false)).toBe(true);
    // ...mas um caller identificado segue liberado (o gate só barra anônimo).
    expect(mutatingToolRequiresAgentId('totally_unknown_tool', true)).toBe(false);
  });
});
