import type { Agent, AdapterType } from '../../shared/types';
import { AgentRepository } from '../db/repositories/agent.repo';
import { ensureDefaultInstructions } from './agent-instructions';
import { syncWorkspaceTeamForSources } from './source-team-sync';
import { ensureWorkspaceCoreSquad } from './workspace-agent-squad';
import { roleRuntimeDefaults } from './agent-runtime-defaults';
import { attachDefaultSkills } from './bundled-skills';

/**
 * Adapter padrão ao contratar: TODO agente (executores e líderes) usa o modelo
 * PREMIUM escolhido pelo usuário, o mesmo do orquestrador. O modelo local Forge
 * foi removido; o usuário pode trocar o modelo do agente depois.
 */
function defaultAdapterForRole(
  _role: string,
  orchestrator: Agent,
): { adapterType: AdapterType; model: string | null; adapterConfig: Record<string, unknown> } {
  return {
    adapterType: orchestrator.adapterType ?? 'claude_local',
    model: orchestrator.model ?? null,
    adapterConfig: orchestrator.adapterConfig ?? {},
  };
}

/** Decisão de idempotência do apply de hiring (vide decideHiringApply). */
export type HiringApplyDecision = 'apply' | 'skip-already-applied' | 'skip-in-flight';

/**
 * Decide se `hiring:apply-plan` deve materializar o time ou virar no-op. Pura pra
 * ser provável isolada — o cerne do fix do "botão de aprovar perde o estado e
 * manda 2-3x a mensagem de criar plano".
 *
 *  - sem proposta pendente E já existe marcador aplicado ⇒ re-fire stale (botão
 *    remontou após concluir): no-op, devolve os nomes já criados.
 *  - apply concorrente em voo na mesma sessão (2º clique enquanto o 1º espera o
 *    CEO devolver os blocos) ⇒ no-op; o 1º termina o trabalho.
 *  - caso contrário ⇒ aplica. Proposta NOVA (pendente presente) sempre aplica,
 *    mesmo que exista marcador aplicado de uma contratação anterior.
 */
export function decideHiringApply(state: {
  hasPendingProposal: boolean;
  hasAppliedMarker: boolean;
  isApplyInFlight: boolean;
}): HiringApplyDecision {
  if (!state.hasPendingProposal && state.hasAppliedMarker) return 'skip-already-applied';
  if (state.isApplyInFlight) return 'skip-in-flight';
  return 'apply';
}

export interface ParsedHiringPlanDecision {
  approved: boolean;
  agents: Array<{
    name: string;
    role: string;
    title: string;
    reportsTo?: string | null;
    capabilities?: string | null;
    /** Escolha do CEO: 'forge' (local/orkestral_local) ou 'premium' (Claude do CEO).
     *  null/ausente = política padrão por papel (defaultAdapterForRole). */
    model?: 'forge' | 'premium' | null;
  }>;
}

/** Extrai apenas os blocos `<orkestral:create-agent .../>` de um texto, sem
 *  exigir o marcador HIRING_DECISION. Usado tanto no parse do plano completo
 *  quanto no re-pedido de blocos ao CEO (quando a proposta veio só em prosa). */
export function parseCreateAgentBlocks(text: string): ParsedHiringPlanDecision['agents'] {
  const agents: ParsedHiringPlanDecision['agents'] = [];
  const rx = /<orkestral:create-agent\s+([^>]+?)\s*\/?>(?:<\/orkestral:create-agent>)?/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text))) {
    const attrs = parseAttrs(m[1] ?? '');
    const name = attrs.name?.trim();
    const role = attrs.role?.trim();
    if (!name || !role) continue;
    const modelRaw = attrs.model?.trim().toLowerCase();
    const model = modelRaw === 'forge' ? 'forge' : modelRaw === 'premium' ? 'premium' : null;
    agents.push({
      name,
      role,
      title: attrs.title?.trim() || role,
      reportsTo: attrs.reports_to?.trim() || null,
      capabilities: attrs.capabilities?.trim() || null,
      model,
    });
  }
  return agents;
}

export function parseHiringPlanDecision(text: string): ParsedHiringPlanDecision | null {
  if (!text.includes('HIRING_DECISION:')) return null;
  const approved = /HIRING_DECISION:\s*APPROVED/i.test(text);
  return { approved, agents: parseCreateAgentBlocks(text) };
}

export function materializeApprovedHiringPlan(input: {
  workspaceId: string;
  orchestrator: Agent;
  decision: ParsedHiringPlanDecision;
  /** Sessão de chat que aprovou o plano — propaga pras propostas de especialista
   *  aparecerem inline no chat (além do Inbox). */
  sessionId?: string;
}): Agent[] {
  if (!input.decision.approved) return [];
  const repo = new AgentRepository();
  const existing = repo.listByWorkspace(input.workspaceId);
  const created: Agent[] = [];
  const byName = new Map<string, Agent>();
  const byRole = new Map<string, Agent>();
  // Famílias de role JÁ EXISTENTES no workspace: bloqueiam recriar um especialista
  // do mesmo bucket. Specs NOVOS do mesmo plano que colapsam pro mesmo bucket
  // (ex.: "Frontend Web" + "Frontend Mobile" → 'frontend') NÃO se anulam entre si
  // — só dedupamos por role/nome exatos, senão um especialista some em silêncio.
  const existingRoleKeys = new Set<string>();
  const newRoleKeys = new Set<string>();
  for (const a of existing) byName.set(a.name.trim().toLowerCase(), a);
  for (const a of existing) {
    byRole.set(normalizeRoleKey(a.role), a);
    existingRoleKeys.add(normalizeRoleKey(a.role));
  }

  for (const spec of input.decision.agents) {
    const key = spec.name.trim().toLowerCase();
    const roleKey = normalizeRoleKey(spec.role);
    const exactRoleKey = spec.role.trim().toLowerCase();
    // Pula só se: (a) já existe agente com esse nome; (b) o bucket de role já
    // existia no workspace antes do plano; ou (c) um spec ANTERIOR do mesmo plano
    // tinha o role EXATO (mesmo papel literal), não só a mesma família normalizada.
    if (byName.has(key) || existingRoleKeys.has(roleKey) || newRoleKeys.has(exactRoleKey)) {
      console.warn(
        `[agent-from-chat] hiring spec ignorado (duplicado): name="${spec.name}" role="${spec.role}"`,
      );
      continue;
    }
    newRoleKeys.add(exactRoleKey);
    // Forge removido: todo agente usa o modelo PREMIUM do usuário (o do CEO),
    // independente da escolha 'forge'/'premium' que o CEO tenha proposto.
    const adapter = defaultAdapterForRole(spec.role, input.orchestrator);
    const createdAgent = repo.create({
      workspaceId: input.workspaceId,
      name: spec.name,
      role: spec.role,
      title: spec.title,
      adapterType: adapter.adapterType,
      adapterConfig: adapter.adapterConfig,
      model: adapter.model,
      capabilities: spec.capabilities ?? null,
      reportsTo: null,
      canCreateAgents: false,
      canAssignTasks: true,
      canEditFiles: true,
      canRunCommands: true,
      // Defaults por papel: todos ignoram sandbox; reasoning (TechLead/Reviewer/QA)
      // usa esforço 'auto', executores (Front/Back/Designer/DevOps) usam modo rápido.
      // Busca herda do CEO (default ligado).
      runtimeConfig: {
        ...roleRuntimeDefaults(spec.role),
        enableSearch: input.orchestrator.runtimeConfig?.enableSearch ?? true,
      },
    });
    try {
      ensureDefaultInstructions(createdAgent);
    } catch {
      // non-fatal
    }
    // Skills default por papel (playbooks que fazem sentido pro que o agente faz).
    attachDefaultSkills(createdAgent.id, input.workspaceId, spec.role);
    created.push(createdAgent);
    byName.set(key, createdAgent);
    byRole.set(roleKey, createdAgent);
  }

  // Lookup tolerante de chefe: `reports_to="Tech Lead"` (com espaço) precisa achar
  // o agente "TechLead" (key 'techlead'). Casa por nome compacto (sem espaços) e,
  // por fim, pelo bucket de role normalizado (tech-lead). Só re-parenta no CEO se
  // o label REALMENTE não resolver — e avisa, pra não achatar a hierarquia em silêncio.
  const compact = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '');
  const byNameCompact = new Map<string, Agent>();
  for (const [, a] of byName) byNameCompact.set(compact(a.name), a);

  for (const spec of input.decision.agents) {
    const agent = byName.get(spec.name.trim().toLowerCase());
    if (!agent) continue;
    const bossLabel = (spec.reportsTo ?? '').trim().toLowerCase();
    let boss: Agent;
    if (
      !bossLabel ||
      bossLabel === 'ceo' ||
      bossLabel === input.orchestrator.name.trim().toLowerCase()
    ) {
      boss = input.orchestrator;
    } else {
      const resolved =
        byName.get(bossLabel) ??
        byNameCompact.get(compact(bossLabel)) ??
        byRole.get(normalizeRoleKey(bossLabel));
      if (!resolved) {
        console.warn(
          `[agent-from-chat] reports_to="${spec.reportsTo}" não resolveu — re-parenteando "${spec.name}" no CEO.`,
        );
      }
      boss = resolved ?? input.orchestrator;
    }
    repo.update(agent.id, { reportsTo: boss.id });
  }

  const coreCreated = ensureWorkspaceCoreSquad({
    workspaceId: input.workspaceId,
    reason: 'approved-hiring-plan',
  });
  try {
    syncWorkspaceTeamForSources(input.workspaceId, 'approved-hiring-plan', input.sessionId);
  } catch (err) {
    console.warn('[agent-from-chat] source team sync falhou apos hiring:', err);
  }

  const allCreatedIds = new Set([...created, ...coreCreated].map((agent) => agent.id));
  return repo.listByWorkspace(input.workspaceId).filter((a) => allCreatedIds.has(a.id));
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rx = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(raw))) out[m[1]] = m[2];
  return out;
}

function normalizeRoleKey(role: string): string {
  const key = role
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (/^front-?end|ui|client/.test(key)) return 'frontend';
  if (/^back-?end|api|server/.test(key)) return 'backend';
  if (/dev-?ops|infra|platform/.test(key)) return 'devops';
  if (/qa|quality|qualidade|test|testes?/.test(key)) return 'qa';
  if (/review|revisor/.test(key)) return 'code-reviewer';
  // PT + EN: "tech lead", "líder técnico", "arquiteto".
  if (/tech-?lead|líder-?técnic|lider-?tecnic|architect|arquitet/.test(key)) return 'tech-lead';
  if (/design|ux|ui-designer/.test(key)) return 'designer';
  if (/product|pm/.test(key)) return 'product';
  return key;
}
