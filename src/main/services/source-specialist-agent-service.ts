import { AgentRepository } from '../db/repositories/agent.repo';
import { ensureDefaultInstructions } from './agent-instructions';
import { syncWorkspaceTeamForSources } from './source-team-sync';
import { listSourceAgentAssignments } from './source-agent-assignment-service';
import type { Agent, WorkspaceSourceRole } from '../../shared/types';

const agentRepo = new AgentRepository();

const TITLE_BY_ROLE: Record<WorkspaceSourceRole, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  mobile: 'Mobile',
  infra: 'DevOps',
  docs: 'Docs',
  other: 'Specialist',
};

const CAPABILITIES_BY_ROLE: Record<WorkspaceSourceRole, string> = {
  frontend: 'Web UI, components, state, routing and browser integrations',
  backend: 'APIs, services, persistence, business rules and integrations',
  mobile: 'Mobile runtime, React Native/Expo, navigation, platform build and app-specific UX',
  infra: 'CI/CD, infrastructure, deployment, containers and environments',
  docs: 'Documentation, knowledge organization and developer enablement',
  other: 'General source-specific implementation and maintenance',
};

export function createSourceSpecialistAgent(input: {
  workspaceId: string;
  sourceId: string;
}): Agent {
  const assignment = listSourceAgentAssignments(input.workspaceId).find(
    (item) => item.sourceId === input.sourceId,
  );
  if (!assignment) throw new Error('Source sem plano de atribuicao');
  if (!assignment.needsNewAgent || !assignment.recommendedAgentRole) {
    throw new Error('Este source ja esta coberto por agente especialista');
  }

  const existing = agentRepo
    .listByWorkspace(input.workspaceId)
    .find((agent) =>
      `${agent.role} ${agent.name} ${agent.title ?? ''}`
        .toLowerCase()
        .includes(assignment.recommendedAgentRole!),
    );
  if (existing) return existing;

  const orchestrator = agentRepo.getOrchestrator(input.workspaceId);
  const techLead = agentRepo
    .listByWorkspace(input.workspaceId)
    .find((agent) =>
      /tech[-\s_]?lead|architect/.test(
        `${agent.role} ${agent.name} ${agent.title ?? ''}`.toLowerCase(),
      ),
    );
  const role = assignment.recommendedAgentRole;
  const title = TITLE_BY_ROLE[role];
  const agent = agentRepo.create({
    workspaceId: input.workspaceId,
    name: assignment.recommendedAgentName ?? `${title} Agent`,
    role,
    title,
    // Especialista de source é papel executor → roda no Forge (orkestral_local),
    // local-first. Antes copiava cego o adapter do CEO (Claude) — virava premium
    // sem necessidade. Líderes (premium) só nascem pela proposta do CEO.
    adapterType: 'orkestral_local',
    model: null,
    adapterConfig: {},
    reportsTo: techLead?.id ?? orchestrator?.id ?? null,
    capabilities: CAPABILITIES_BY_ROLE[role],
    canCreateAgents: false,
    canAssignTasks: false,
    canEditFiles: true,
    canRunCommands: role === 'backend' || role === 'infra' || role === 'mobile',
    systemPrompt: [
      `Você é o agente especialista ${title} do workspace.`,
      `Seu foco principal é o source "${assignment.sourceLabel}".`,
      'Antes de responder ou editar, use list_sources e kb_search para recuperar o contexto atualizado.',
      'Quando aprender uma convenção importante do source, registre na base de conhecimento.',
    ].join('\n'),
  });
  ensureDefaultInstructions(agent);
  syncWorkspaceTeamForSources(input.workspaceId, 'source-specialist-created');
  return agent;
}
