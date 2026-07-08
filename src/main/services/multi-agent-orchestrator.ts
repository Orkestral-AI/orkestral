import { multiAgentRepo } from '../db/repositories/multi-agent.repo';
import { recordAgentTraceStep } from './agent-trace';
import type { Issue, MultiAgentPlanRole, MultiAgentRunSummary } from '../../shared/types';

const DEFAULT_ROLES: MultiAgentPlanRole[] = [
  {
    role: 'researcher',
    title: 'Pesquisador',
    objective: 'Localizar documentação, páginas KB e arquivos prováveis antes de qualquer edição.',
    requiredEvidence: ['kb_search executado', 'arquivos/fontes candidatos identificados'],
  },
  {
    role: 'memory',
    title: 'Memória',
    objective: 'Consultar aprendizados anteriores, skills e decisões do workspace.',
    requiredEvidence: [
      'skill_list/skill_view quando aplicável',
      'learning relevante citado ou descartado',
    ],
  },
  {
    role: 'safety',
    title: 'Segurança',
    objective:
      'Detectar ações destrutivas, credenciais, comandos interativos e necessidade de permissão.',
    requiredEvidence: ['risco classificado', 'permissões necessárias registradas'],
  },
  {
    role: 'executor',
    title: 'Executor',
    objective: 'Aplicar a menor mudança suficiente e registrar o que foi feito.',
    requiredEvidence: [
      'arquivos alterados',
      'comandos executados',
      'comentário de progresso quando relevante',
    ],
  },
  {
    role: 'reviewer',
    title: 'Revisor',
    objective: 'Validar escopo, qualidade, testes e atualização da memória antes de concluir.',
    requiredEvidence: ['validação/teste realizado ou motivo de não rodar', 'status final coerente'],
  },
];

export function buildMultiAgentInstructions(): string {
  const lines = [
    '## Local multi-agent workflow',
    '',
    'Operate as a coordinated local team. Before editing, explicitly satisfy these roles in your work:',
  ];
  for (const role of DEFAULT_ROLES) {
    lines.push(
      `- ${role.title} (${role.role}): ${role.objective} Evidence: ${role.requiredEvidence.join('; ')}.`,
    );
  }
  lines.push(
    '',
    'Keep this lightweight: do not write a long essay, but make tool calls and issue comments show the evidence.',
  );
  return lines.join('\n');
}

export function startMultiAgentRun(input: {
  issue: Issue;
  runId: string;
  agentId?: string | null;
  agentName?: string | null;
  parentTraceId?: string | null;
}): MultiAgentRunSummary {
  const plan = { roles: DEFAULT_ROLES };
  const row = multiAgentRepo.createRun({
    workspaceId: input.issue.workspaceId,
    issueId: input.issue.id,
    runId: input.runId,
    plan,
  });
  for (const role of DEFAULT_ROLES) {
    multiAgentRepo.createStep({
      multiAgentRunId: row.id,
      workspaceId: input.issue.workspaceId,
      role: role.role,
      inputText: `${input.issue.issueKey}: ${input.issue.title}`,
    });
  }
  recordAgentTraceStep({
    workspaceId: input.issue.workspaceId,
    runId: input.runId,
    issueId: input.issue.id,
    issueKey: input.issue.issueKey,
    agentId: input.agentId ?? null,
    agentName: input.agentName ?? null,
    parentId: input.parentTraceId ?? null,
    kind: 'plan',
    title: 'Plano multiagente local criado',
    summary: `${DEFAULT_ROLES.length} papéis coordenados para pesquisa, memória, segurança, execução e revisão.`,
    payload: {
      multiAgentRunId: row.id,
      roles: DEFAULT_ROLES,
    },
  });
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    issueId: row.issueId,
    runId: row.runId,
    status: row.status,
    plan,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
