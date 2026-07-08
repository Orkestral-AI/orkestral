import type {
  Agent,
  SourceAgentAssignment,
  WorkspaceSource,
  WorkspaceSourceRole,
} from '../../shared/types';

export type AgentCoverageRole = WorkspaceSourceRole | 'lead' | 'review';

// Nome do agente especialista por role. Limpo e direto (sem sufixos "Web"/"App"
// nem "Agent") pra ficar no mesmo estilo de TechLead/QA/Designer.
const ROLE_LABEL: Record<WorkspaceSourceRole, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  mobile: 'Mobile',
  infra: 'Infra',
  docs: 'Docs',
  other: 'Generalist',
};

const FRONTEND_STRONG_RE =
  /\b(next|nextjs|next-intl|next\.config|react-dom|vite|vue|angular|svelte|astro|remix|tailwindcss|webpack|components\.json)\b/;
const MOBILE_STRONG_RE =
  /\b(react-native|reactnative|expo|flutter|capacitor|cordova|ionic|metro\.config|eas\.json)\b|(^|[\s/\\_.-])(android|ios)([\s/\\_.-]|$)/;
const BACKEND_STRONG_RE =
  /\b(api|server|service|node|nestjs|express|laravel|symfony|php|composer|spring|django|rails|fastify|prisma|drizzle-orm)\b/;
const INFRA_STRONG_RE =
  /\b(infra|devops|terraform|helm|k8s|kubernetes|deploy|ci|cd|docker|dockerfile|compose)\b/;
const DOCS_STRONG_RE = /\b(docs|doc|wiki|manual|readme|documentation)\b/;

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[\s_]+/g, '-');
}

export function normalizeSourceRole(value: string | null | undefined): WorkspaceSourceRole | null {
  if (!value) return null;
  const key = normalizeText(value);
  if (MOBILE_STRONG_RE.test(key) || /\bmobile\b/.test(key)) {
    return 'mobile';
  }
  if (
    /\b(frontend|front-end|front|web|webapp|ui|react|nextjs|next|vite|vue|angular|svelte|tailwind)\b/.test(
      key,
    )
  ) {
    return 'frontend';
  }
  if (
    /\b(backend|back-end|back|api|server|service|node|nest|express|laravel|symfony|php|composer|spring|django|rails|fastify|fastapi)\b/.test(
      key,
    )
  ) {
    return 'backend';
  }
  if (/\b(infra|devops|terraform|helm|k8s|kubernetes|deploy|docker|ansible|pulumi)\b/.test(key)) {
    return 'infra';
  }
  if (/\b(docs|doc|wiki|manual|documentation)\b/.test(key)) return 'docs';
  if (key === 'other' || /\b(misc|shared|common|lib|monorepo)\b/.test(key)) return 'other';
  return null;
}

function inferStrongSourceRole(input: {
  identity: string;
  packageHints: string;
}): WorkspaceSourceRole | null {
  const packageHints = normalizeText(input.packageHints);
  const identity = normalizeText(input.identity);
  const hasFrontend = FRONTEND_STRONG_RE.test(packageHints);
  const hasMobile = MOBILE_STRONG_RE.test(packageHints);
  const hasBackend = BACKEND_STRONG_RE.test(packageHints);
  const hasInfra = INFRA_STRONG_RE.test(packageHints);
  const hasDocs = DOCS_STRONG_RE.test(packageHints);

  if (hasFrontend && !hasMobile) return 'frontend';
  if (hasMobile && !hasFrontend) return 'mobile';
  if (hasFrontend && hasMobile) {
    const identityLooksMobile =
      /\b(mobile|react-native|reactnative|expo|flutter|capacitor)\b/.test(identity) ||
      /(^|[\s/\\_.-])(android|ios)([\s/\\_.-]|$)/.test(identity);
    return identityLooksMobile ? 'mobile' : 'frontend';
  }
  if (hasBackend) return 'backend';
  if (hasInfra) return 'infra';
  if (hasDocs) return 'docs';
  return null;
}

export function inferSourceRoleFromSignals(input: {
  source: Pick<WorkspaceSource, 'label' | 'repoFullName' | 'path' | 'role'>;
  packageHints?: string;
}): WorkspaceSourceRole | null {
  const identity = [input.source.label, input.source.repoFullName, input.source.path]
    .filter(Boolean)
    .join(' ');
  const strongRole = inferStrongSourceRole({
    identity,
    packageHints: input.packageHints ?? '',
  });
  const persistedRole = normalizeSourceRole(input.source.role);
  if (strongRole) return strongRole;
  if (persistedRole) return persistedRole;
  return normalizeSourceRole(identity);
}

export function inferAgentCoverageRole(
  agent: Pick<Agent, 'role' | 'name' | 'title' | 'isOrchestrator'>,
): AgentCoverageRole | null {
  const key = `${agent.role} ${agent.name} ${agent.title ?? ''}`.toLowerCase();
  if (agent.isOrchestrator || /ceo|orchestrator|tech-?lead|architect|lead/.test(key)) {
    return 'lead';
  }
  if (/review|qa|quality/.test(key)) return 'review';
  return normalizeSourceRole(key);
}

export function agentCoversSource(input: {
  agentRole: AgentCoverageRole | null;
  sourceRole: WorkspaceSourceRole | null;
  primaryOnly?: boolean;
}): boolean {
  const { agentRole, sourceRole, primaryOnly = true } = input;
  if (!agentRole) return !primaryOnly;
  if (agentRole === 'lead' || agentRole === 'review') return !primaryOnly;
  if (!sourceRole) return agentRole === 'other';
  return agentRole === sourceRole;
}

export function planSourceAgentAssignments(input: {
  sources: WorkspaceSource[];
  agents: Agent[];
  packageHintsBySourceId?: Record<string, string>;
}): SourceAgentAssignment[] {
  const agentRoles = new Map(
    input.agents.map((agent) => [agent.id, inferAgentCoverageRole(agent)]),
  );
  return input.sources.map((source) => {
    const role = inferSourceRoleFromSignals({
      source,
      packageHints: input.packageHintsBySourceId?.[source.id],
    });
    const assignedAgents = input.agents.filter((agent) =>
      agentCoversSource({
        agentRole: agentRoles.get(agent.id) ?? null,
        sourceRole: role,
        primaryOnly: true,
      }),
    );
    const supportAgents = input.agents.filter((agent) => {
      const agentRole = agentRoles.get(agent.id) ?? null;
      if (assignedAgents.some((assigned) => assigned.id === agent.id)) return false;
      if (agentRole === 'lead' || agentRole === 'review') return true;
      return role === 'mobile' && agentRole === 'frontend';
    });
    const needsNewAgent = assignedAgents.length === 0 && role !== null && role !== 'other';
    const recommendedRole = needsNewAgent ? role : null;
    const roleLabel = recommendedRole ? ROLE_LABEL[recommendedRole] : null;
    return {
      sourceId: source.id,
      sourceLabel: source.label,
      sourceRole: role,
      assignedAgentIds: assignedAgents.map((agent) => agent.id),
      assignedAgentNames: assignedAgents.map((agent) => agent.name),
      supportAgentIds: supportAgents.map((agent) => agent.id),
      supportAgentNames: supportAgents.map((agent) => agent.name),
      needsNewAgent,
      recommendedAgentRole: recommendedRole,
      recommendedAgentName: roleLabel,
      reason: buildAssignmentReason({
        role,
        assignedCount: assignedAgents.length,
        supportCount: supportAgents.length,
      }),
    };
  });
}

function buildAssignmentReason(input: {
  role: WorkspaceSourceRole | null;
  assignedCount: number;
  supportCount: number;
}): string {
  if (!input.role)
    return 'Source ainda nao foi classificado; CEO e reviewers devem inspecionar antes de criar especialista.';
  if (input.assignedCount > 0) return `Source ${input.role} coberto por agente especialista.`;
  if (input.role === 'mobile' && input.supportCount > 0) {
    return 'Mobile compartilha conceitos com frontend, mas precisa especialista proprio para runtime, navegacao, build e plataforma.';
  }
  return `Nenhum agente especialista cobre source ${input.role}.`;
}
