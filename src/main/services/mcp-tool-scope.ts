/**
 * Autorização pura de tools do MCP local do Orkestral — SEM dependências de
 * Electron/DB pra ser unit-testável isolada. Consumida por mcp-server.ts.
 *
 * Dois eixos de segurança:
 *   (A) MUTATING_TOOLS: tools que escrevem estado compartilhado do workspace.
 *       Exigem um `x-orkestral-agent-id` válido pro workspace (gate aplicado em
 *       mcp-server, que conhece o header). Aqui só declaramos o conjunto.
 *   (B) Scoping por role: a classe do agente (orchestrator/executor/readonly)
 *       limita o conjunto de tools que ele pode chamar.
 */
import type { Agent } from '../../shared/types';

/**
 * Tools que MUTAM estado compartilhado do workspace (issues, goals, páginas/links da
 * KB, perfil, skills). O token MCP é process-wide e o header `x-orkestral-workspace`
 * é trocável, então sem identificar o caller um agente prompt-injetado poderia omitir
 * o agent-id e trocar o workspace pra escrever em outro (cross-workspace).
 *
 * Conjunto DOCUMENTAL das escritas conhecidas — mas o gate NÃO depende dele estar
 * completo: `mutatingToolRequiresAgentId` é default-DENY (allowlist = `READ_ONLY_TOOLS`),
 * então qualquer tool fora da leitura — inclusive escrita nova ainda não listada aqui —
 * já nasce exigindo `x-orkestral-agent-id` válido cujo `agent.workspaceId` === o
 * workspace pedido.
 */
export const MUTATING_TOOLS = new Set([
  'edit_file',
  'add_issue_dependency',
  'create_issue',
  'create_issue_plan',
  'update_issue',
  'assign_issue',
  'comment_on_issue',
  'update_issue_status',
  'create_goal',
  'update_goal_status',
  'kb_create_page',
  'kb_update_page',
  'kb_delete_page',
  'kb_link_pages',
  'update_user_profile',
  'skill_create',
  'skill_improve',
]);

/**
 * Tools puramente de LEITURA/análise — liberadas pra qualquer role (inclusive
 * agentes read-only).
 */
export const READ_ONLY_TOOLS = new Set([
  'kb_search',
  'kb_get_page',
  'kb_get_page_tree',
  'kb_get_backlinks',
  'session_search',
  'code_search',
  'list_issues',
  'search_issues',
  'get_issue',
  'list_sources',
  'list_agents',
  'get_workspace_info',
  'get_open_work_summary',
  'get_user_profile',
  'skill_list',
  'skill_view',
  // Gate interno de permissão (claude `--permission-prompt-tool`): não muta nada
  // — só pergunta ao operador do REPL. Precisa estar liberada pra QUALQUER role
  // (um agente readonly também dispara prompt de permissão), senão 403 negaria
  // toda tool do run restrito.
  'approval_prompt',
]);

/**
 * Tools de ORQUESTRAÇÃO reservadas a quem planeja o backlog do time
 * (CEO/orchestrator): reatribuir/refinar issues de outros e mexer em goals. Um
 * executor puro NÃO recebe estas — mexem no trabalho do time, não no próprio.
 *
 * Conservador de propósito: NÃO inclui `create_issue` (executor pode abrir
 * sub-tarefas durante a execução — fluxo existente via auto-parent/auto-exec) nem
 * as escritas de KB/skill (o prompt do executor pede `kb_create_page`,
 * `skill_create`). Tirar essas quebraria fluxos reais; só bloqueamos o que um
 * executor comprovadamente não usa.
 */
export const ORCHESTRATOR_ONLY_TOOLS = new Set([
  'assign_issue',
  'update_issue',
  'create_goal',
  'update_goal_status',
  'add_issue_dependency',
]);

/** Classe de role pra scoping de tools, derivada das flags/role do agente. */
export type AgentToolRole = 'orchestrator' | 'executor' | 'readonly';

/** Subset do Agent que a classificação consome (testável sem montar um Agent). */
export type ToolRoleInput = Pick<
  Agent,
  'role' | 'name' | 'title' | 'isOrchestrator' | 'canCreateAgents' | 'canAssignTasks'
> & { canEditFiles?: boolean; canRunCommands?: boolean };

/**
 * Classifica um agente numa classe de tool-scope, de forma CONSERVADORA pra não
 * quebrar fluxos existentes:
 *   - orchestrator: `isOrchestrator`, OU pode criar agentes/atribuir tarefas
 *     (sinais fortes de quem planeja), OU role/nome de CEO/lead/architect/manager.
 *   - readonly: não pode editar arquivos NEM rodar comandos (agente de análise).
 *   - executor: o resto (faz trabalho, mas não planeja o backlog do time).
 */
export function classifyAgentToolRole(agent: ToolRoleInput): AgentToolRole {
  const key = `${agent.role} ${agent.name} ${agent.title ?? ''}`.toLowerCase();
  if (
    agent.isOrchestrator ||
    agent.canCreateAgents ||
    agent.canAssignTasks ||
    /ceo|orchestrator|tech-?lead|architect|\blead\b|manager|coordinator/.test(key)
  ) {
    return 'orchestrator';
  }
  if (agent.canEditFiles === false && agent.canRunCommands === false) {
    return 'readonly';
  }
  return 'executor';
}

/**
 * Decide se um agente, pela sua classe de role, PODE chamar uma tool. Pura.
 * Quando o caller NÃO se identifica (role === null) mantemos o comportamento
 * legado liberal — o gate cross-workspace (que EXIGE agent-id pras mutating
 * tools) já barra escrita anônima antes de chegar aqui.
 */
export function agentMayUseTool(role: AgentToolRole | null, toolName: string): boolean {
  if (!role) return true;
  if (READ_ONLY_TOOLS.has(toolName)) return true;
  if (role === 'orchestrator') return true;
  if (role === 'readonly') return false;
  // executor: tudo MENOS as tools de orquestração do backlog do time. Mantém
  // create_issue (sub-tarefas), escritas de KB/skill e status/comentário do
  // próprio trabalho — fluxos que o prompt do executor usa de verdade.
  return !ORCHESTRATOR_ONLY_TOOLS.has(toolName);
}

/**
 * (A) Tool anônima que NÃO é de leitura? Sem role resolvido (agent-id ausente) ela
 * deve ser recusada. DEFAULT-DENY: a única allowlist anônima é `READ_ONLY_TOOLS`;
 * qualquer outra tool — incluindo escritas ainda não catalogadas em `MUTATING_TOOLS`
 * e tools futuras — exige identificação. (Allowlist invertida — listar só as escritas
 * conhecidas — deixava update_issue/update_goal_status/update_user_profile/skill_create/
 * skill_improve/kb_link_pages destravadas pra escrita anônima cross-workspace.) Pura —
 * o mcp-server traduz `true` em 403.
 */
export function mutatingToolRequiresAgentId(toolName: string, hasAgentRole: boolean): boolean {
  if (hasAgentRole) return false;
  return !READ_ONLY_TOOLS.has(toolName);
}
