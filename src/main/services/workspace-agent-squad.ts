import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRepository } from '../db/repositories/agent.repo';
import { WorkspaceSourceRepository } from '../db/repositories/workspace-source.repo';
import { ActivityRepository } from '../db/repositories/activity.repo';
import { ensureDefaultInstructions } from './agent-instructions';
import { roleRuntimeDefaults } from './agent-runtime-defaults';
import { attachDefaultSkills } from './bundled-skills';
import { inferSourceRoleFromSignals, normalizeSourceRole } from './agent-assignment-policy';
import type { AdapterType, Agent, WorkspaceSource, WorkspaceSourceRole } from '../../shared/types';

const agentRepo = new AgentRepository();
const sourceRepo = new WorkspaceSourceRepository();
const activityRepo = new ActivityRepository();

export type CoreSquadRole = 'tech-lead' | 'code-reviewer' | 'qa' | 'designer';

interface CoreSquadSpec {
  role: CoreSquadRole;
  name: string;
  title: string;
  reportsTo: 'CEO' | 'TechLead';
  premium: boolean;
  canRunCommands: boolean;
  requires: (roles: Set<WorkspaceSourceRole>) => boolean;
  capabilities: string;
  systemPrompt: string;
}

const CORE_SQUAD: CoreSquadSpec[] = [
  {
    role: 'tech-lead',
    name: 'TechLead',
    title: 'Tech Lead',
    reportsTo: 'CEO',
    premium: true,
    canRunCommands: true,
    requires: () => true,
    capabilities:
      'Architecture ownership, cross-repo technical decisions, contracts, task delegation and specialist coordination.',
    systemPrompt:
      'Você é o Tech Lead do workspace. Coordene frontend, backend, mobile, QA, designer e reviewers mantendo arquitetura, contratos e decisões técnicas coerentes entre todos os sources.',
  },
  {
    role: 'code-reviewer',
    name: 'Code Reviewer',
    title: 'Code Reviewer',
    reportsTo: 'CEO',
    premium: true,
    canRunCommands: true,
    requires: () => true,
    capabilities:
      'Staff-level code review, architecture review, frontend/backend contract validation, security, performance, tests and cost control.',
    systemPrompt:
      'Você é o agente de Code Review. Revise o projeto como um sistema inteiro: contratos entre repos, segurança, custo, performance, testes, regressões e aderência arquitetural. Não faça nitpick; encontre riscos reais.',
  },
  {
    role: 'qa',
    name: 'QA',
    title: 'QA Engineer',
    reportsTo: 'TechLead',
    premium: false,
    canRunCommands: true,
    requires: (roles) =>
      roles.has('frontend') || roles.has('backend') || roles.has('mobile') || roles.has('infra'),
    capabilities:
      'QA gate, test-plan execution, smoke tests, regression checks, design-system validation, API contracts and release confidence.',
    systemPrompt:
      'Você é o QA Gate do workspace. Seu trabalho é validar entregas antes de virarem done: entenda a issue, siga o plano de QA check por check, rode/verifique lint/typecheck/test/build/smoke quando existirem, valide design system em UI/mobile, contratos em backend/API, registre evidência objetiva e reprove sem medo quando houver risco real. Não implemente correções; devolva para o executor com instruções precisas.',
  },
  {
    role: 'designer',
    name: 'Designer',
    title: 'Product Designer',
    reportsTo: 'TechLead',
    premium: false,
    canRunCommands: false,
    requires: (roles) => roles.has('frontend') || roles.has('mobile'),
    capabilities:
      'Design system stewardship, UX consistency, accessibility, interaction quality and visual regression awareness.',
    systemPrompt:
      'Você é o Designer do workspace. Proteja design system, acessibilidade, hierarquia visual, responsividade, consistência de componentes e experiência do usuário em web/mobile.',
  },
];

function readPackageHints(source: WorkspaceSource): string {
  if (!source.path) return '';
  const hints: string[] = [];
  const pkgPath = join(source.path, 'package.json');
  try {
    if (existsSync(pkgPath)) {
      const raw = readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      hints.push(
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.scripts ?? {}),
      );
    }
  } catch {
    // best-effort
  }
  const composerPath = join(source.path, 'composer.json');
  try {
    if (existsSync(composerPath)) {
      const raw = readFileSync(composerPath, 'utf8');
      const composer = JSON.parse(raw) as {
        require?: Record<string, string>;
        'require-dev'?: Record<string, string>;
        scripts?: Record<string, unknown>;
      };
      hints.push(
        'php',
        'composer',
        ...Object.keys(composer.require ?? {}),
        ...Object.keys(composer['require-dev'] ?? {}),
        ...Object.keys(composer.scripts ?? {}),
      );
    }
  } catch {
    // best-effort
  }
  return hints.join(' ');
}

export function inferWorkspaceSourceRoles(
  sources: WorkspaceSource[],
): Map<string, WorkspaceSourceRole | null> {
  const roles = new Map<string, WorkspaceSourceRole | null>();
  for (const source of sources) {
    roles.set(
      source.id,
      inferSourceRoleFromSignals({
        source,
        packageHints: readPackageHints(source),
      }),
    );
  }
  return roles;
}

/** Roles canônicas da squad core — quando o agente já persiste uma destas no
 *  campo `role`, ela é a fonte de verdade do dedup (evita depender do nome). */
const CANONICAL_CORE_ROLES = new Set<string>(['tech-lead', 'code-reviewer', 'qa', 'designer']);

function normalizeAgentRoleKey(
  agent: Pick<Agent, 'role' | 'name' | 'title' | 'isOrchestrator'>,
): string {
  if (agent.isOrchestrator) return 'ceo';
  // 1. Dedup por role canônica PERSISTIDA. Agentes da squad gravam role =
  // spec.role ('tech-lead', etc). Um plano em PT que cria "Líder Técnico" com
  // role='tech-lead' colide corretamente com o TechLead — sem isso, o regex EN
  // sobre o NOME falhava e duplicava o cargo.
  const persistedRole = (agent.role ?? '').trim().toLowerCase();
  if (CANONICAL_CORE_ROLES.has(persistedRole)) return persistedRole;
  // 2. Fallback heurístico (nome/título) pra agentes legados sem role canônica.
  const key = `${agent.role} ${agent.name} ${agent.title ?? ''}`.toLowerCase();
  if (/code[-\s_]?review|reviewer|revisor|quality[-\s_]?review/.test(key)) return 'code-reviewer';
  if (/tech[-\s_]?lead|líder[-\s_]?técnic|lider[-\s_]?tecnic|architect|arquitet|\blead\b/.test(key))
    return 'tech-lead';
  if (/\bqa\b|quality|qualidade|test[-\s_]?engineer|testes?/.test(key)) return 'qa';
  if (/design|designer|ux|ui[-\s_]?designer|product[-\s_]?design/.test(key)) return 'designer';
  const sourceRole = normalizeSourceRole(key);
  return sourceRole ?? key.replace(/[\s_]+/g, '-');
}

function premiumAdapter(orchestrator: Agent | null): {
  adapterType: AdapterType;
  model: string | null;
  adapterConfig: Record<string, unknown>;
} {
  return {
    adapterType: orchestrator?.adapterType ?? 'claude_local',
    model: orchestrator?.model ?? null,
    adapterConfig: orchestrator?.adapterConfig ?? {},
  };
}

function resolveReportsTo(
  spec: CoreSquadSpec,
  orchestrator: Agent | null,
  byRole: Map<string, Agent>,
): string | null {
  if (spec.reportsTo === 'CEO') return orchestrator?.id ?? null;
  return byRole.get('tech-lead')?.id ?? orchestrator?.id ?? null;
}

function coreSystemPrompt(spec: CoreSquadSpec, reason?: string): string {
  return [
    spec.systemPrompt,
    'Antes de qualquer execução, use a KB e o contexto de sources do workspace. Registre aprendizados duráveis quando descobrir padrões relevantes.',
    'Se o escopo cruzar repos, valide contratos entre os sources antes de aprovar execução ou review.',
    reason ? `Motivo de criação/sincronização: ${reason}.` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function requiredCoreSquadRoles(workspaceId: string): CoreSquadSpec[] {
  const sources = sourceRepo.listByWorkspace(workspaceId);
  const roles = new Set(
    [...inferWorkspaceSourceRoles(sources).values()].filter(
      (role): role is WorkspaceSourceRole => !!role,
    ),
  );
  return CORE_SQUAD.filter((spec) => spec.requires(roles));
}

export function ensureWorkspaceCoreSquad(input: { workspaceId: string; reason?: string }): Agent[] {
  const orchestrator = agentRepo.getOrchestrator(input.workspaceId);
  const required = requiredCoreSquadRoles(input.workspaceId);
  const existing = agentRepo.listByWorkspace(input.workspaceId);
  const byRole = new Map(existing.map((agent) => [normalizeAgentRoleKey(agent), agent]));
  const created: Agent[] = [];

  for (const spec of required) {
    if (byRole.has(spec.role)) continue;
    // Forge removido: todo agente do squad usa o modelo premium do orquestrador.
    const adapter = premiumAdapter(orchestrator);
    const systemPrompt = coreSystemPrompt(spec, input.reason);
    const agent = agentRepo.create({
      workspaceId: input.workspaceId,
      name: spec.name,
      role: spec.role,
      title: spec.title,
      adapterType: adapter.adapterType,
      model: adapter.model,
      adapterConfig: adapter.adapterConfig,
      reportsTo: resolveReportsTo(spec, orchestrator, byRole),
      capabilities: spec.capabilities,
      systemPrompt,
      canCreateAgents: false,
      canAssignTasks: spec.role === 'tech-lead' || spec.role === 'code-reviewer',
      canEditFiles: spec.role !== 'designer',
      canRunCommands: spec.canRunCommands,
      // Defaults por papel: todos ignoram sandbox; reasoning usa esforço 'auto',
      // executores usam modo rápido. Busca herda do CEO (default ligado).
      runtimeConfig: {
        ...roleRuntimeDefaults(spec.role),
        enableSearch: orchestrator?.runtimeConfig?.enableSearch ?? true,
      },
    });
    ensureDefaultInstructions(agent);
    attachDefaultSkills(agent.id, input.workspaceId, spec.role);
    created.push(agent);
    byRole.set(spec.role, agent);
  }

  for (const spec of required) {
    const agent = byRole.get(spec.role);
    if (!agent) continue;
    const reportsTo = resolveReportsTo(spec, orchestrator, byRole);
    if (reportsTo && agent.reportsTo !== reportsTo) {
      agentRepo.update(agent.id, { reportsTo });
    }
    if (
      (agent.capabilities ?? '') !== spec.capabilities &&
      !created.some((a) => a.id === agent.id)
    ) {
      agentRepo.update(agent.id, { capabilities: spec.capabilities });
    }
  }

  if (created.length > 0) {
    activityRepo.log({
      workspaceId: input.workspaceId,
      kind: 'team.core-squad.created',
      actorKind: 'system',
      subjectKind: 'workspace',
      subjectId: input.workspaceId,
      title: `Squad core criada: ${created.map((agent) => agent.name).join(', ')}`,
      payload: {
        reason: input.reason ?? 'source-sync',
        agentIds: created.map((agent) => agent.id),
        roles: created.map((agent) => agent.role),
      },
    });
  }

  return created;
}
