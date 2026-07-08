import type { AgentRuntimeConfig } from '../../shared/types';

/**
 * Defaults de `runtimeConfig` por PAPEL, aplicados ao CRIAR um agente (CEO,
 * squad e hiring). Regras de produto:
 *  - TODOS os agentes ignoram o sandbox (`bypassSandbox`) pra rodar sem prompt de
 *    permissão a cada Read/Write/Bash.
 *  - Papéis de raciocínio/revisão (CEO, TechLead, Code Reviewer, QA, Product…)
 *    usam esforço 'auto': o modelo decide sozinho quanto pensar.
 *  - Executores (Frontend, Backend, Designer, DevOps) usam modo rápido pra
 *    entregar as tarefas mais rápido.
 * Não inclui `enableSearch` (cada site decide, geralmente herdando do CEO).
 */
const EXECUTOR_ROLES = new Set([
  'frontend',
  'backend',
  'designer',
  'devops',
  'mobile',
  'fullstack',
]);

function normRole(role: string): string {
  return role
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

/** True quando o papel é um executor (entrega código), não um líder/revisor. */
export function isExecutorRole(role: string): boolean {
  return EXECUTOR_ROLES.has(normRole(role));
}

export function roleRuntimeDefaults(role: string): Partial<AgentRuntimeConfig> {
  return {
    bypassSandbox: true,
    ...(isExecutorRole(role) ? { fastMode: true } : { thinkingEffort: 'auto' }),
  };
}
