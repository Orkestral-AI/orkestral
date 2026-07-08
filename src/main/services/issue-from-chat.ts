/**
 * Parser de blocos `<orkestral:create-issue>` na resposta do agente.
 *
 * Quando o CEO (ou outro agente orquestrador) precisa quebrar uma demanda em
 * subtasks, ele emite blocos estruturados na resposta. Esse módulo:
 *   1. Detecta esses blocos no texto final do assistant
 *   2. Cria as issues no DB local via IssueRepository
 *   3. Substitui cada bloco por uma referência markdown "✅ [PREFIX-N] título"
 *
 * Sintaxe esperada (atributos no formato HTML):
 *
 *   <orkestral:create-issue title="..." assignee="agent-name-or-role" priority="high" status="todo">
 *   Descrição em markdown da issue.
 *   </orkestral:create-issue>
 *
 * Atributos suportados:
 *   - title (obrigatório)
 *   - assignee (opcional) — nome OU role do agente (case-insensitive)
 *   - priority (opcional) — low|medium|high|critical
 *   - status (opcional) — backlog|todo|in_progress|done|...
 *   - labels (opcional) — CSV
 */

import { IssueRepository } from '../db/repositories/issue.repo';
import { AgentRepository } from '../db/repositories/agent.repo';
import { WorkspaceRepository } from '../db/repositories/workspace.repo';
import { GoalRepository } from '../db/repositories/routine-goal.repo';
import { maybeAutoExecuteIssue } from './issue-execution-service';
import type {
  Agent,
  ExecutionCheckbox,
  Issue,
  IssuePriority,
  IssueStatus,
  Workspace,
} from '../../shared/types';

const issueRepo = new IssueRepository();
const agentRepo = new AgentRepository();
const workspaceRepo = new WorkspaceRepository();
const goalRepo = new GoalRepository();

const BLOCK_RE = /<orkestral:create-issue([^>]*)>([\s\S]*?)<\/orkestral:create-issue>/gi;

const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(ATTR_RE)) {
    out[match[1].toLowerCase()] = match[2];
  }
  return out;
}

function resolveAssignee(needle: string | undefined, agents: Agent[]): Agent | null {
  if (!needle) return null;
  const lower = needle.toLowerCase().trim();
  // Match EXATO (nome ou role) tem prioridade e é sempre seguro.
  const exact =
    agents.find((a) => a.name.toLowerCase() === lower) ??
    agents.find((a) => a.role.toLowerCase() === lower);
  if (exact) return exact;
  // Fallback por substring: só resolve se for ÚNICO. Antes pegava o primeiro
  // `.find` (dependente da ordem da lista) — "front" podia cair em "Frontend" ou
  // "Frontend Mobile" conforme a ordem, roteando a issue pro agente errado em
  // silêncio. Em ambiguidade (>1 candidato), deixa null pra roteamento humano.
  const partial = agents.filter(
    (a) => a.name.toLowerCase().includes(lower) || a.role.toLowerCase().includes(lower),
  );
  return partial.length === 1 ? partial[0] : null;
}

// Linha de task na checklist: "- [ ] faz X @Agente" ou "- [x] feito".
const CHECKBOX_RE = /^\s*[-*]\s*\[([ xX]?)\]\s+(.+?)\s*$/;

/**
 * Extrai uma CHECKLIST de tasks do corpo do bloco (markdown checkboxes). É o que reduz a
 * quantidade de issues: o CEO cria UMA issue com várias tasks em vez de N sub-issues. Cada task
 * vira um ExecutionCheckbox (com @Agente opcional resolvendo o responsável). O resto do corpo
 * (linhas não-checkbox) continua como descrição. Se não houver checklist, devolve [] e o corpo
 * inteiro como descrição (comportamento antigo, intacto).
 */
export function extractChecklist(
  body: string,
  agents: Agent[],
): { description: string | null; checkboxes: ExecutionCheckbox[] } {
  const checkboxes: ExecutionCheckbox[] = [];
  const descLines: string[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(CHECKBOX_RE);
    if (!m) {
      descLines.push(line);
      continue;
    }
    let instruction = m[2].trim();
    let assigneeAgentId: string | null = null;
    const at = instruction.match(/@([\w-]+)\s*$/);
    if (at) {
      const ag = resolveAssignee(at[1], agents);
      if (ag) {
        assigneeAgentId = ag.id;
        instruction = instruction.replace(/@[\w-]+\s*$/, '').trim();
      }
    }
    checkboxes.push({
      id: `cb-${checkboxes.length + 1}`,
      instruction,
      targetFile: '',
      status: m[1].toLowerCase() === 'x' ? 'done' : 'pending',
      assigneeAgentId,
    });
  }
  return { description: descLines.join('\n').trim() || null, checkboxes };
}

/**
 * BACKFILL one-shot (boot): issues criadas ANTES da extração de checklist (com '- [ ]' na
 * descrição e SEM metadata execution-plan) viram execution-plan, pra já mostrarem o componente
 * de tasks. Idempotente e convergente: após extrair, a descrição não tem mais '- [ ]'.
 */
export function backfillExecutionPlanChecklists(): number {
  let fixed = 0;
  for (const ws of workspaceRepo.listAll()) {
    const agents = agentRepo.listByWorkspace(ws.id);
    for (const issue of issueRepo.listByWorkspace(ws.id)) {
      const meta = (issue.metadata as Record<string, unknown> | null) ?? null;
      if (meta?.kind === 'execution-plan') continue;
      if (!issue.description || !CHECKBOX_RE.test(issue.description.split('\n')[0] ?? '')) {
        // teste barato falhou na 1a linha; confirma no corpo inteiro
        if (!issue.description || !issue.description.split('\n').some((l) => CHECKBOX_RE.test(l))) {
          continue;
        }
      }
      const { description, checkboxes } = extractChecklist(issue.description, agents);
      if (checkboxes.length < 2) continue;
      try {
        issueRepo.update(issue.id, {
          description,
          metadata: { ...(meta ?? {}), kind: 'execution-plan', checkboxes },
        });
        fixed++;
      } catch {
        /* não quebra o boot */
      }
    }
  }
  return fixed;
}

function normalizePriority(p: string | undefined): IssuePriority {
  const v = (p ?? '').toLowerCase();
  if (v === 'low' || v === 'medium' || v === 'high' || v === 'critical') return v;
  return 'medium';
}

function normalizeStatus(s: string | undefined): IssueStatus {
  const v = (s ?? '').toLowerCase().replace(/[-\s]/g, '_');
  const allowed: IssueStatus[] = [
    'backlog',
    'todo',
    'in_progress',
    'in_review',
    'blocked',
    'done',
    'cancelled',
  ];
  return (allowed as string[]).includes(v) ? (v as IssueStatus) : 'todo';
}

function issuePrefix(workspaceName: string): string {
  const letters = workspaceName.match(/[A-Z]/g);
  if (letters && letters.length >= 2) return letters.slice(0, 3).join('');
  return workspaceName.slice(0, 3).toUpperCase();
}

export interface CreatedIssueRef {
  id: string;
  issueKey: number;
  prefix: string;
  title: string;
  assigneeName: string | null;
}

/**
 * Processa o texto final do assistant: encontra blocos `<orkestral:create-issue>`,
 * cria as issues no DB e devolve:
 *   - rewrittenText: texto com blocos substituídos por referências markdown
 *   - createdIssues: lista das issues criadas (pra UI mostrar)
 *
 * Se nenhum bloco for encontrado, devolve o texto original sem mudanças.
 */
export function processIssueBlocksInText(params: {
  workspaceId: string;
  reporterAgentId: string;
  text: string;
  /** Sessão de chat de origem — pra reportar o resumo de volta ao concluir. */
  sessionId?: string;
}): { rewrittenText: string; createdIssues: CreatedIssueRef[] } {
  const { workspaceId, reporterAgentId, text, sessionId } = params;

  if (!BLOCK_RE.test(text)) {
    BLOCK_RE.lastIndex = 0;
    return { rewrittenText: text, createdIssues: [] };
  }
  BLOCK_RE.lastIndex = 0;

  const workspace = workspaceRepo.listAll().find((w) => w.id === workspaceId) as
    | Workspace
    | undefined;
  if (!workspace) return { rewrittenText: text, createdIssues: [] };

  const prefix = issuePrefix(workspace.name);
  const agents = agentRepo.listByWorkspace(workspaceId);
  const created: CreatedIssueRef[] = [];
  // Index pra resolver `parent="título-de-outra-issue-criada-na-mesma-resposta"`
  // Permite o CEO encadear hierarquia direto no plano sem precisar conhecer IDs.
  const titleToId = new Map<string, string>();

  const rewrittenText = text.replace(BLOCK_RE, (_full, attrsRaw, bodyRaw) => {
    const attrs = parseAttrs(String(attrsRaw));
    const title = (attrs.title ?? '').trim();
    if (!title) return ''; // bloco mal-formado — remove

    const assignee = resolveAssignee(attrs.assignee, agents);
    const priority = normalizePriority(attrs.priority);
    // EXECUÇÃO DIRETA (mudança pontual): quando o CEO julga a mudança pequena/acionável, marca
    // run="now" — a issue NÃO espera aprovação, roda na hora e fica FORA do board (efêmera). A
    // segurança da execução (escopo, arquivos críticos, gates) é a mesma do smart-exec normal.
    const runNow = /^(now|direct|true|1)$/i.test((attrs.run ?? '').trim());
    // Plano vindo do chat AGUARDA aprovação do usuário: nasce em 'backlog' (o
    // heartbeat só pega 'todo', então não dispara sozinho) e NÃO auto-executa.
    // Só roda quando o usuário aprova o plano (ipc issues:run-plan). Sem sessão
    // (ex.: kb-analysis), mantém o status proposto pelo agente.
    const status = runNow ? 'todo' : sessionId ? 'backlog' : normalizeStatus(attrs.status);
    const labels = (attrs.labels ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Arquivos reais (da KB) que o orquestrador apontou em `files="a, b"`. Vão pra
    // metadata.affectedFiles → o classifier/executor MIRA neles em vez de explorar
    // o repo às cegas (causa raiz dos patches errados).
    const files = (attrs.files ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // CONTRATO DE EXECUÇÃO: critério verificável de "pronto" (≤140 chars). Vai pra
    // metadata.done → buildPlan anexa como alvo absoluto na instrução do Forge e o
    // reviewer confere a mudança contra ele. É o que torna a issue executável pelo
    // modelo pequeno sem ele adivinhar escopo e "deletar código sem sentido".
    const done = (attrs.done ?? '').trim().slice(0, 140);
    // OBJETIVO: liga a issue a um Goal (goal_id da tool create_goal). Valida que o
    // objetivo existe e é deste workspace — progresso do objetivo rola pra cima.
    const goalRef = (attrs['goal-id'] ?? attrs.goal_id ?? '').trim();
    let goalId: string | null = null;
    if (goalRef) {
      const g = goalRepo.get(goalRef);
      if (g && g.workspaceId === workspaceId) goalId = g.id;
    }
    // Checklist de tasks no corpo -> UMA issue com várias tasks (reduz a quantidade de issues).
    const { description, checkboxes } = extractChecklist(String(bodyRaw), agents);

    // Resolve parent: aceita título de outra issue criada na MESMA resposta
    // (lookup via titleToId) OU ID existente no DB (UUID).
    let parentIssueId: string | null = null;
    const parentRef = attrs.parent ?? attrs['depends-on'] ?? attrs['parent-title'];
    if (parentRef) {
      const lower = parentRef.toLowerCase().trim();
      const fromBatch = [...titleToId.entries()].find(([t]) => t === lower || t.includes(lower));
      if (fromBatch) {
        parentIssueId = fromBatch[1];
      } else {
        // Tenta como UUID direto se for um id
        const existing = issueRepo.get(parentRef);
        if (existing) parentIssueId = existing.id;
      }
    }

    let issue: Issue;
    try {
      issue = issueRepo.create({
        workspaceId,
        title,
        description,
        status,
        priority,
        labels,
        assigneeAgentId: assignee?.id ?? null,
        reporterAgentId: reporterAgentId ?? null,
        parentIssueId,
        goalId,
        // Origem no chat (resultado volta como mensagem na sessão) + arquivos-alvo reais +
        // ephemeral (mudança pontual: fica fora do board) + checklist (componente Tasks).
        metadata: (() => {
          const base = {
            ...(sessionId ? { originSessionId: sessionId, originAgentId: reporterAgentId } : {}),
            ...(files.length > 0 ? { affectedFiles: files } : {}),
            ...(done ? { done } : {}),
            ...(runNow ? { ephemeral: true } : {}),
          };
          if (checkboxes.length >= 2) {
            return { kind: 'execution-plan' as const, checkboxes, ...base };
          }
          return Object.keys(base).length > 0 ? base : undefined;
        })(),
      });
    } catch (err) {
      console.error('[issue-from-chat] falha ao criar issue:', err);
      return `\n> ❌ Falha ao criar issue "${title}"\n`;
    }

    titleToId.set(title.toLowerCase(), issue.id);
    if (goalId) goalRepo.recalcProgress(goalId);
    created.push({
      id: issue.id,
      issueKey: issue.issueKey,
      prefix,
      title,
      assigneeName: assignee?.name ?? null,
    });
    // Plano do chat aguarda aprovação → NÃO auto-executa aqui (ver issues:run-plan).
    // EXCEÇÃO: run="now" (mudança pontual) executa na hora, sem aprovação. Demais origens
    // (kb-analysis etc.) seguem o auto-exec normal.
    if (!sessionId || runNow) maybeAutoExecuteIssue(issue);

    const assigneeChip = assignee?.name ? ` → \`@${assignee.name}\`` : '';
    const parentChip = parentIssueId
      ? ` · sub-issue de \`${prefix}-${created.find((c) => c.id === parentIssueId)?.issueKey ?? '?'}\``
      : '';
    return `\n> ✅ **Issue criada** \`${prefix}-${issue.issueKey}\` · ${title}${assigneeChip}${parentChip}\n`;
  });

  return { rewrittenText, createdIssues: created };
}
