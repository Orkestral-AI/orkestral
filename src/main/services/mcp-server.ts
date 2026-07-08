/**
 * MCP server local do Orkestral — expõe ferramentas do workspace pro Claude
 * (e qualquer CLI compatível com MCP) via HTTP local na máquina.
 *
 * Por que HTTP em vez de stdio:
 *   - O Claude CLI faz spawn do server stdio em subprocesso isolado, sem
 *     acesso aos node_modules do app Electron. Em HTTP, o server roda em
 *     processo no main do Electron e mantém acesso direto ao DB.
 *   - Multiple agents/sessions podem usar o mesmo server simultaneamente.
 *
 * Protocolo: subset JSON-RPC 2.0 do Model Context Protocol — implementação
 * mínima de `initialize`, `tools/list` e `tools/call`. Suficiente pro Claude
 * Code chamar tools via tool_use.
 *
 * Workspace scoping: cada request precisa do header `x-orkestral-workspace`
 * — sem ele, retorna erro. O id é injetado pelo chat-service via mcp-config
 * antes do spawn do CLI.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { broadcast } from '../platform/host';
import { warpGrepSearch } from './smart-exec/warpgrep';
import { fastApplyEditFile } from './smart-exec/fast-apply-tool';
import {
  type AgentToolRole,
  agentMayUseTool,
  classifyAgentToolRole,
  mutatingToolRequiresAgentId,
} from './mcp-tool-scope';
import { finishAgentTraceStep, startAgentTraceStep } from './agent-trace';
import { hasApprover, requestApproval } from './permission-approvals';
import { syncWorkspaceTeamForSources } from './source-team-sync';
import { extractChecklist } from './issue-from-chat';
import { IssueRepository } from '../db/repositories/issue.repo';
import { AgentRepository } from '../db/repositories/agent.repo';
import { WorkspaceRepository } from '../db/repositories/workspace.repo';
import { GoalRepository, RoutineRepository } from '../db/repositories/routine-goal.repo';
import { CodeReviewRepository } from '../db/repositories/code-review.repo';
import { ActivityRepository } from '../db/repositories/activity.repo';
import { ExecStatsRepository } from '../db/repositories/exec-stats.repo';
import { WorkspaceSourceRepository } from '../db/repositories/workspace-source.repo';
import { IssueRelationsRepository } from '../db/repositories/issue-relations.repo';
import { isReviewLikeIssue } from './issue-plan-sequencing';

/** Escape de string pra usar dentro de RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

import type { Agent, AgentTraceEventKind, Issue, KbPageKind } from '../../shared/types';

/**
 * Resolve um agente por nome/role de forma ESTRITA pra `assign_issue`:
 *   - match exato (case-insensitive) por nome primeiro, depois por role;
 *   - se 0 ou >1 candidatos baterem, LANÇA erro listando os nomes válidos
 *     em vez de mis-rotear silenciosamente pro agente errado.
 * Sem fuzzy/substring matching — assignment de issue precisa ser determinístico.
 */
function resolveAgentStrict(agents: Agent[], lookupRaw: string): Agent {
  const lookup = lookupRaw.toLowerCase().trim();
  if (!lookup) {
    throw new Error(
      `assignee is empty. Valid agents: ${agents.map((a) => a.name).join(', ') || '(none)'}`,
    );
  }
  const byName = agents.filter((a) => a.name.toLowerCase() === lookup);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(
      `"${lookupRaw}" is ambiguous (${byName.length} agents with that name). ` +
        `Use a unique identifier. Agents: ${agents.map((a) => a.name).join(', ')}`,
    );
  }
  const byRole = agents.filter((a) => a.role.toLowerCase() === lookup);
  if (byRole.length === 1) return byRole[0];
  if (byRole.length > 1) {
    throw new Error(
      `role "${lookupRaw}" has ${byRole.length} agents — specify the NAME. ` +
        `Agents: ${agents.map((a) => `${a.name} (${a.role})`).join(', ')}`,
    );
  }
  throw new Error(
    `Agent "${lookupRaw}" does not exist in the workspace. ` +
      `Valid agents: ${agents.map((a) => a.name).join(', ') || '(none)'}. ` +
      `Call list_agents to see the correct names.`,
  );
}

/** Detecta se uma issue é uma ÉPICA (por título [ÉPICA]/[EPIC] ou label epic). */
function isEpicIssue(issue: Issue): boolean {
  const title = issue.title.trim().toUpperCase();
  if (title.startsWith('[ÉPICA]') || title.startsWith('[EPICA]') || title.startsWith('[EPIC]')) {
    return true;
  }
  return issue.labels.some((l) => l.toLowerCase() === 'epic');
}

/**
 * Threshold de similaridade de título pra considerar uma issue duplicata.
 * >= este valor (ou match exato normalizado) bloqueia a criação no create_issue.
 */
const ISSUE_DEDUP_SIMILARITY = 0.85;

/** Normaliza título: lowercase, trim, remove pontuação, colapsa espaços. */
function normalizeIssueTitle(title: string): string {
  return (title ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // remove pontuação
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Similaridade de Jaccard por tokens entre dois títulos JÁ normalizados.
 * Pura, sem deps: |interseção| / |união| dos conjuntos de palavras. Retorna
 * 0..1. Robusta a reordenação de palavras (bom pra títulos de issue).
 */
function titleSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const tok of ta) if (tb.has(tok)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Janela (ms) pra considerar uma épica "recente" no mesmo turno de planejamento. */
const EPIC_RECENT_WINDOW_MS = 5 * 60_000;
import { KbPageRepository, slugify as kbSlugify } from '../db/repositories/kb-page.repo';
import { KbLinkRepository } from '../db/repositories/kb-link.repo';
import { SkillRepository } from '../db/repositories/skill.repo';
import { searchSessions } from './session-search';
import {
  createPage as kbServiceCreatePage,
  searchPages as kbSearchPages,
  updatePage as kbServiceUpdatePage,
} from './kb-service';
import { maybeAutoExecuteIssue, startRunnablePlanIssueWave } from './issue-execution-service';
import { maybeAutoVerifyGoal } from './goal-verification-service';
// Usado só em call-time (tool send_whatsapp_image) — ciclo resolvido por live binding.
import { channelManager } from './channels/channel-manager';
// Serviços de domínio expostos como tools read-only (o agente "conhece todo o Orkestral").
import { listIssues as listSentryIssues } from './sentry';
import { listSignals as listObsSignals, getConnection as getObsConnection } from './observability';
import { listContainers as listDockerContainers, ping as dockerPing } from './docker-service';
import { gitStatus, gitCurrentBranch, gitLog } from './git-service';
import {
  createTerminal,
  writeTerminal,
  announceAgentTerminal,
  getLastUrlForSource,
} from './terminal-service';
import { captureUrlToPng } from './screenshot';
import { STARTER_TEMPLATES, selectTemplate, scaffoldFromTemplate } from './project-templates';
// Aprovação de plano (mesma lógica do botão) — importado do handler de issues.
import { decidePlan, findPendingPlanEpicId } from '../ipc/handlers/skills-issues';
import {
  buildQaVerdictIssueTransition,
  completeQaValidation,
  findOrphanedNextRoutes,
  getLatestQaValidation,
  getQaValidationScoped,
  runQaBuildGate,
  updateQaCheck,
} from './qa-validation-service';
import type { IssuePriority, IssueStatus, ExecutionCheckbox } from '../../shared/types';

const issueRepo = new IssueRepository();
const agentRepo = new AgentRepository();
const workspaceRepo = new WorkspaceRepository();

/** Prefixo de issue — MESMO algoritmo da lista (IssuesPage) pra o ref que o CEO
 *  cita bater com o que o usuário vê. */
function mcpIssuePrefix(name: string): string {
  return (
    (name || 'ORK')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 3)
      .toUpperCase() || 'ORK'
  );
}
const goalRepo = new GoalRepository();
const routineRepo = new RoutineRepository();
const codeReviewRepo = new CodeReviewRepository();
const activityRepo = new ActivityRepository();
const execStatsRepo = new ExecStatsRepository();
const sourceRepo = new WorkspaceSourceRepository();
const relationsRepo = new IssueRelationsRepository();
const kbPageRepo = new KbPageRepository();
const kbLinkRepoMcp = new KbLinkRepository();
const skillRepoMcp = new SkillRepository();

/** Broadcast pro renderer atualizar a lista de issues após mudança via MCP. */
function broadcastIssuesChanged(workspaceId: string, reason: string): void {
  broadcast('issues:changed-by-mcp', { workspaceId, reason });
}

let serverPort: number | null = null;
let serverToken: string | null = null;
let startingPromise: Promise<{ port: number; token: string }> | null = null;

const TOOL_SCHEMAS = [
  {
    name: 'list_issues',
    description:
      'List issues in the current workspace with filters. ALWAYS call before creating a new issue to detect duplicates. Accepts filters by status, priority, assignee, and label.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'],
        },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        assignee: { type: 'string', description: 'Name or role of the assignee agent' },
        label: { type: 'string', description: 'Filter by a specific label' },
        parent_issue_key: { type: 'number', description: 'List only sub-issues of this parent' },
        limit: { type: 'number', default: 50 },
      },
    },
  },
  {
    name: 'search_issues',
    description:
      'Full-text search across issues by keyword (title and description). Use to check for duplicates before creating a new issue.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term (case-insensitive)' },
        limit: { type: 'number', default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_issue',
    description:
      'Return full details of a specific issue (entire description, comments, sub-issues, parent). Use to understand context before modifying.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_key: { type: 'number', description: 'Issue number (e.g. 12 for BOR-12)' },
      },
      required: ['issue_key'],
    },
  },
  {
    name: 'create_issue',
    description:
      "Create a local issue in Orkestral. IMPORTANT: write title and description in the SAME language as the user's last message (user wrote Portuguese → answer in Portuguese; English → English). Never switch languages on your own. NEVER ask the user to open an issue manually — create it here. Always include a substantial description with context, scope, acceptance criteria, and technical hints. If you are extending work on an existing epic, pass parent_issue_key with its number to create it as a sub-issue — do NOT create orphan issues. Call list_issues first to find the related epic. Epic marker: use the [EPIC] prefix in the title (language-neutral).",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short imperative title (≤70 chars)' },
        description: {
          type: 'string',
          description:
            'Required markdown that MUST INCLUDE a `- [ ]` CHECKLIST of the small focused steps. The user sees these as checkboxes and the executor runs/marks them one by one, so a description with no `- [ ]` steps is TOO THIN (not allowed). Write each step as `- [ ] do X in <file>::<symbol> @Agent` on its own line, naming the target file AND symbol per step (vague prose makes the small local model mis-target). A short intro + scope (in/out) before the checklist is fine. Example: "Auth API.\\n- [ ] POST /auth/login route in app/api/auth/login/route.ts @Backend\\n- [ ] verify password with bcrypt in lib/auth.ts @Backend".',
        },
        assignee: {
          type: 'string',
          description: 'Name or role of the agent (call list_agents first)',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description:
            'critical = prod blocker; high = critical path; medium = normal; low = polish',
        },
        status: {
          type: 'string',
          enum: ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done'],
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Semantic labels (auth, api, ui, infra, devx, epic, bug...)',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'REAL repo-relative paths this issue touches — VERIFY each exists via kb_search/code_search BEFORE passing. CRITICAL: this aims the local executor at the right files instead of blindly exploring (which mis-targets — e.g. editing the wrong WhatsApp driver). Never guess a filename, never pass a directory; invalid paths are dropped and the executor is left to guess. List EVERY file that must change.',
        },
        done: {
          type: 'string',
          description:
            'REQUIRED verifiable completion criterion (≤140 chars): "the change is complete when ___". A single concrete, checkable test — name the symbol/file/behavior. This is the local executor\'s absolute target AND the reviewer\'s checklist; the most important field for the small model to not over-reach. Good: "ConversationController::messages() returns a paginated response with next_cursor". Bad: "pagination works".',
        },
        plan_page: {
          type: 'string',
          description:
            'Optional KB page id holding the FULL, detailed spec for this issue (the page_id returned by kb_create_page). KB-BACKED PLANNING: for any non-trivial issue (especially UI/greenfield), FIRST write a rich plan page with kb_create_page (objective, exact file paths, API contract, for UI a "## Design Spec" naming the shadcn components + empty/loading/error states + breakpoints, acceptance criteria, verification steps) and pass its id here. The issue description stays a short summary; the executor pulls the full spec from this page. This is how the premium plan reaches the executor (incl. the small local Forge) without bloating the issue.',
        },
        parent_issue_key: {
          type: 'number',
          description: 'Create as a sub-issue of this parent. Use to chain epic → tasks.',
        },
        due_date: { type: 'string', description: 'Optional ISO 8601 date (YYYY-MM-DD)' },
        goal_id: {
          type: 'string',
          description:
            'ID of the goal (Goal) this issue contributes to. Get it from get_workspace_info → goals[].id. Use when decomposing a goal into tasks.',
        },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'create_issue_plan',
    description:
      "Create an ENTIRE plan in ONE call: an epic PLUS all its sub-issues at once. PREFER THIS over many create_issue calls whenever you propose a plan with multiple sub-issues — it is far faster (a single round-trip, no chaining to read the epic key) and parents every sub-issue to the epic automatically. Write titles/descriptions in the SAME language as the user's last message. The epic gets the [EPIC] prefix automatically. Server-side dedup applies: near-duplicate sub-issues are skipped. Sub-issues are created in the given order (use it as the execution order).",
    inputSchema: {
      type: 'object',
      properties: {
        epic_title: {
          type: 'string',
          description: 'Short epic title (≤70 chars). The [EPIC] prefix is added automatically.',
        },
        epic_description: {
          type: 'string',
          description: 'Required markdown: the goal, scope (in/out) and what success looks like.',
        },
        goal_title: {
          type: 'string',
          description:
            'When the request is LARGE, set a GOAL (Objetivo): a short outcome-oriented title of what the user ultimately wants. Creating it here links the epic + ALL sub-issues to the goal in one call (progress rolls up), and it becomes the criterion you validate the delivery against at the end. Omit only for small one-off plans.',
        },
        goal_description: {
          type: 'string',
          description:
            'What success looks like for the USER (1–3 sentences) — paired with goal_title. The end state the delivery is judged by, not a task list.',
        },
        goal_id: {
          type: 'string',
          description:
            'Link the plan to an EXISTING goal instead of creating one (takes precedence over goal_title). Get it from get_workspace_info → goals[].id or a prior create_goal.',
        },
        goal_token_budget: {
          type: 'number',
          description:
            'HARD token ceiling for the goal (input+output summed across all its runs). Set it whenever the user states a cost/effort limit ("máximo de 600k tokens") — the scheduler STOPS starting new issues once spending reaches it and reports honestly. Works with goal_title (new goal) or goal_id (fills a missing budget).',
        },
        parent_epic_key: {
          type: 'number',
          description:
            'RECURSIVE PLANNING: issue_key of an EXISTING sub-epic placeholder to detail. The sub-issues are parented under IT (no new top-level epic is created; epic_title is ignored for creation). Use when a sub-plan turn asks you to detail a sub-epic of an already-approved plan — its sub-issues start automatically, no new approval gate.',
        },
        sub_issues: {
          type: 'array',
          description:
            'The sub-issues, in execution order. Each must be SMALL and focused (ideally one function/method in one file).',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short imperative title (≤70 chars)' },
              description: {
                type: 'string',
                description:
                  'Required markdown that MUST INCLUDE a `- [ ]` CHECKLIST of the small focused steps. The user sees these as checkboxes and the executor runs/marks them one by one, so a sub-issue with no `- [ ]` steps is TOO THIN (not allowed). Write each step as `- [ ] do X in <file>::<symbol> @Agent` on its own line, naming the target file AND symbol per step (vague prose makes the small local model mis-target). A 1-line intro before the checklist is fine. Example: "Auth API.\\n- [ ] POST /auth/login route in app/api/auth/login/route.ts @Backend\\n- [ ] verify password with bcrypt in lib/auth.ts @Backend".',
              },
              assignee: { type: 'string', description: 'Name or role of the agent' },
              priority: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'critical'],
              },
              labels: { type: 'array', items: { type: 'string' } },
              files: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'REAL repo-relative files this sub-issue touches — verify each exists via kb_search/code_search. Aims the executor; never guess a name or pass a directory. List EVERY file that must change.',
              },
              done: {
                type: 'string',
                description:
                  'REQUIRED verifiable completion criterion (≤140 chars): "complete when ___". One concrete, checkable test naming the symbol/file/behavior. The executor\'s absolute target and the reviewer\'s checklist.',
              },
              plan_page: {
                type: 'string',
                description:
                  'Optional KB page id (from kb_create_page) with the FULL detailed spec for THIS sub-issue. KB-backed planning: write a rich plan page per non-trivial sub-issue (paths, API contract, for UI a "## Design Spec"), pass its id here; the executor pulls the full spec from it while the description stays short.',
              },
              blocked_by: {
                type: 'array',
                items: { type: 'number' },
                description:
                  'OPTIONAL 1-based indices into THIS sub_issues array that must complete first (dependencies). The scheduler refuses to start this sub-issue until each listed sub-issue is done. A review/QA step is auto-wired to depend on every implementation step even if you omit this.',
              },
            },
            required: ['title', 'description'],
          },
        },
      },
      required: ['epic_title', 'sub_issues'],
    },
  },
  {
    name: 'update_issue_status',
    description: 'Advance the status of an issue. Use when work actually moves forward.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_key: { type: 'number' },
        status: {
          type: 'string',
          enum: ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'],
        },
      },
      required: ['issue_key', 'status'],
    },
  },
  {
    name: 'update_issue',
    description:
      'Rich update of an issue: can change title, description, priority, labels, assignee, parent, or due_date. Use to refine existing issues.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_key: { type: 'number' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        labels: { type: 'array', items: { type: 'string' } },
        assignee: { type: 'string', description: 'Agent name (null to unassign)' },
        parent_issue_key: { type: 'number', description: '0 to remove the parent' },
        due_date: { type: 'string', description: 'ISO 8601 date (empty string removes it)' },
      },
      required: ['issue_key'],
    },
  },
  {
    name: 'assign_issue',
    description: 'Reassign an issue to another agent. Shortcut for update_issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_key: { type: 'number' },
        assignee: { type: 'string', description: 'Name or role of the agent' },
      },
      required: ['issue_key', 'assignee'],
    },
  },
  {
    name: 'comment_on_issue',
    description:
      'Add a comment to an existing issue. Use to record progress, decisions, blockers, or questions instead of creating a new issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_key: { type: 'number' },
        body: { type: 'string', description: 'Comment body in markdown' },
      },
      required: ['issue_key', 'body'],
    },
  },
  {
    name: 'qa_get_validation',
    description:
      'Get the latest QA validation plan for an issue. QA agents MUST read it before validating and then mark each check one by one.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_key: { type: 'number' },
      },
      required: ['issue_key'],
    },
  },
  {
    name: 'qa_update_check',
    description:
      'Mark one QA validation check as running/passed/failed/skipped with concise evidence. Use after each test/check, not only at the end.',
    inputSchema: {
      type: 'object',
      properties: {
        validation_id: { type: 'string' },
        check_ordinal: { type: 'number' },
        status: { type: 'string', enum: ['pending', 'running', 'passed', 'failed', 'skipped'] },
        evidence: {
          type: 'string',
          description: 'Short evidence: command output, inspected file, screenshot, or reason.',
        },
      },
      required: ['validation_id', 'check_ordinal', 'status', 'evidence'],
    },
  },
  {
    name: 'qa_complete_validation',
    description:
      'Finish a QA validation with final verdict. Use passed only when all critical checks passed; failed when executor must fix; needs_human for missing credentials/ambiguous product decision.',
    inputSchema: {
      type: 'object',
      properties: {
        validation_id: { type: 'string' },
        status: { type: 'string', enum: ['passed', 'failed', 'needs_human'] },
        summary: { type: 'string', description: 'Concise final QA report with evidence.' },
      },
      required: ['validation_id', 'status', 'summary'],
    },
  },
  {
    name: 'complete_checkpoint',
    description:
      'Mark ONE step of the issue execution checklist (the "Passo a passo" / Steps shown to the user) as done, AS SOON AS you finish it and BEFORE moving to the next step (not all at the end). This is the live progress the user watches. Pass issue_key and the 1-based step number; status defaults to done, use blocked only if you genuinely cannot finish that step.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_key: { type: 'number' },
        step: {
          type: 'number',
          description: '1-based position of the checklist item you just finished.',
        },
        status: { type: 'string', enum: ['done', 'blocked'] },
      },
      required: ['issue_key', 'step'],
    },
  },
  {
    name: 'list_agents',
    description:
      'List active agents in the workspace with name, role, capabilities. ALWAYS call before assigning an issue to use the correct name.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_sources',
    description:
      'List the sources (repos/folders) attached to the workspace, with paths and roles.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_workspace_info',
    description: 'Return the mission, objectives, plan, and state of the current workspace.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'send_whatsapp_image',
    description:
      'Send an image or file FROM DISK to the user over the messaging channel (WhatsApp) of the CURRENT conversation. Use this when the user asks for an image/screenshot/file, or to show them a preview/result — e.g. take a screenshot, save it to a path, then send it. Only works when this conversation came from a channel. `path` must be an absolute path to an existing file. Optionally add a short `caption`.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to send.' },
        caption: { type: 'string', description: 'Optional short caption (WhatsApp formatting).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_sentry_issues',
    description:
      'List the most recent Sentry errors/issues for this workspace (title, level, occurrence count, affected users, last seen, permalink). Call this whenever the user asks about Sentry, errors in production, or exceptions. Requires the Sentry integration connected.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max issues (default 20).' } },
    },
  },
  {
    name: 'list_observability_signals',
    description:
      'List observability signals (errors, incidents, logs) from connected providers (New Relic / Better Stack) for this workspace. Use when the user asks about monitoring, incidents, uptime, or app health.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max signals per provider (default 15).' },
      },
    },
  },
  {
    name: 'list_code_reviews',
    description:
      'List recent automated code reviews (PR title, status, recommendation, risk, counts of bugs/security/suggestions). Use when the user asks about code reviews or PRs.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max reviews (default 20).' } },
    },
  },
  {
    name: 'get_code_review',
    description:
      'Get one code review in detail, including its findings/comments (file, line, kind, severity, message). Get the id from list_code_reviews.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Code review id.' } },
      required: ['id'],
    },
  },
  {
    name: 'list_goals',
    description:
      'List the GOALS (Objetivos) of this workspace with their status and progress (%). Use when the user asks about goals, objectives, or overall progress.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_routines',
    description:
      'List the scheduled routines (recurring agent tasks) of this workspace with interval, enabled state, and next run.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_docker_containers',
    description:
      'List Docker containers on this machine (name, image, state, status). Use when the user asks about Docker, containers, or what is running.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'git_status',
    description:
      'Git status of a source repo: current branch, ahead/behind, changed files, and recent commits. Pass `source` (the source label) or omit to use the primary source.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'Source label (optional).' } },
    },
  },
  {
    name: 'scaffold_project',
    description:
      'GREENFIELD ONLY: scaffold a NEW project from a known-good base (official create-next-app / create-vite + shadcn) instead of generating package.json/tsconfig/structure from scratch (which ships amateur, broken, orphaned code). Use this as the FIRST step of any new project. Picks the template from the request (or pass `template`). The source repo dir MUST be empty. After it returns, the team customizes ON TOP of a base that already builds. Templates: nextjs-shadcn (default for UI products), vite-react-shadcn, node-api.',
    inputSchema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'What the user wants to build — used to pick the best template.',
        },
        template: {
          type: 'string',
          description:
            'Optional explicit template name: nextjs-shadcn | vite-react-shadcn | node-api. Omit to auto-pick from `request`.',
        },
        source: { type: 'string', description: 'Source label (optional; default = primary).' },
      },
    },
  },
  {
    name: 'get_activity',
    description:
      'Recent activity feed of this workspace (chats, proposals, runs, events) with actor and title. Use when the user asks what happened recently / latest activity.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max entries (default 25).' } },
    },
  },
  {
    name: 'get_economics',
    description:
      'Cost/economics summary: how much work the local model (Forge) resolved vs premium escalations, premium USD spent, and estimated savings. Use when the user asks about cost, savings, or Forge usage.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'run_in_orkestral_terminal',
    description:
      'Run a command in the REAL Orkestral terminal of a source (the visible node-pty terminal in the Fontes IDE) — e.g. `npm run dev` / `npm start` to boot the project. Output streams LIVE into the app terminal and Orkestral auto-detects the dev-server URL and opens the preview. Use this to START/RUN the project so the user sees it inside Orkestral — NOT your own ephemeral shell (which dies and is invisible). Returns the terminal id; the process keeps running after your turn.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run (e.g. "npm run dev").' },
        source: { type: 'string', description: 'Source label (optional; defaults to primary).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'capture_preview',
    description:
      "Take a screenshot of the running app/dev-server and return the PNG file path. Call AFTER run_in_orkestral_terminal booted the dev server (Orkestral detected its URL). Then send the PNG to the user with send_whatsapp_image. Optionally pass `url` to capture a specific address, or `wait_ms` to wait for the page to render (default 1500). This is how you 'send a print of the screen'.",
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source label (optional; defaults to primary).' },
        url: { type: 'string', description: 'Explicit URL to capture (optional).' },
        wait_ms: { type: 'number', description: 'Wait before capturing, ms (default 1500).' },
      },
    },
  },
  {
    name: 'approve_and_execute_plan',
    description:
      "Approve a plan (epic + sub-issues) you created with create_issue_plan and START its execution — EXACTLY like the user clicking the 'Approve and execute' button. This releases the sub-issues from backlog and kicks off the execution wave (the team runs them). ALWAYS use this to approve/run a plan; do NOT manually flip issue statuses or 'run waves' yourself. If you omit epic_id, it approves the plan PENDING approval from THIS conversation.",
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: {
          type: 'string',
          description: 'Epic issue id (optional; defaults to the pending plan from this chat).',
        },
      },
    },
  },
  {
    name: 'create_goal',
    description:
      "Create a GOAL (Objetivo) capturing what the user ultimately wants — the success criterion you (the CEO) validate the delivery against AT THE END. ALWAYS create one FIRST when the user's request is LARGE (multi-phase / many sub-issues / 'build X', 'implement the whole Y'). The goal is the source of truth for \"did we deliver what was asked?\"; link the epic + sub-issues to it via goal_id (on create_issue_plan / create_issue) so progress rolls up automatically. Write title/description in the SAME language as the user. Returns goal_id — reuse it when creating the plan.",
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short outcome-oriented title of what the user wants achieved (≤90 chars).',
        },
        description: {
          type: 'string',
          description:
            'What success looks like for the USER (1–3 sentences): the end state to validate against. NOT a task list — the criterion the delivery is judged by.',
        },
        due_date: { type: 'string', description: 'Optional ISO 8601 date (YYYY-MM-DD).' },
        token_budget: {
          type: 'number',
          description:
            'Optional HARD token budget (input+output summed across all runs linked to this goal). When set, the automatic convergence loop stops and reports honestly once spending reaches it, instead of replanning forever. Use for long-horizon goals when the user states a cost/effort ceiling.',
        },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'update_goal_status',
    description:
      'Change the status of a goal (Goal). Use after verifying that a goal was REALLY achieved (not just that the tasks finished): status="achieved". Get the goal_id from get_workspace_info → goals[].id or from create_goal.',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: { type: 'string', description: 'Goal ID' },
        status: { type: 'string', enum: ['active', 'achieved', 'archived'] },
      },
      required: ['goal_id', 'status'],
    },
  },
  {
    name: 'get_open_work_summary',
    description:
      'Return an executive summary of open work: counts by status, top assignees, blocked issues, average age. Use at the start of planning to understand the current load.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'code_search',
    description:
      'Natural-language CODE search over a workspace source (WarpGrep). Give a description of what you are looking for ("where is the phone-number validation", "the WhatsApp webhook handler") and it returns the most relevant FILES with the matching line snippets — ranked by structural relevance (a match in a function/export name beats a match in a comment). Use this to find the right files to read/edit BEFORE guessing paths. Cheaper and more accurate than reading files blindly.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language description of the code to find' },
        source: {
          type: 'string',
          description: 'Optional source label to search; defaults to the primary source',
        },
        limit: { type: 'number', default: 6 },
      },
      required: ['query'],
    },
  },
  {
    name: 'add_issue_dependency',
    description:
      'Wire a REAL dependency between two issues: the blocked issue only starts after the blocker finishes. Use ONLY when one task genuinely needs the other\'s output (e.g. Frontend blocked by Design) — independent issues must have no edge so the scheduler runs them in parallel. Prose like "only start after #2" does NOT gate the scheduler; this tool does.',
    inputSchema: {
      type: 'object',
      properties: {
        blocker_issue_key: {
          type: 'number',
          description: 'issue_key of the issue that must finish FIRST',
        },
        blocked_issue_key: { type: 'number', description: 'issue_key of the issue that waits' },
      },
      required: ['blocker_issue_key', 'blocked_issue_key'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Orkestral Fast Apply: apply a code edit to ONE file WITHOUT retyping old text. WHEN TO USE (decision rule): any edit changing MORE than ~10 lines, edits in MULTIPLE spots of the same file, or rewriting a whole function/block — it costs a fraction of the output tokens of exact search/replace and merges deterministically. For tiny 1-5 line tweaks your native editor is fine. Pass the repo-relative `path` and a `code_edit` snippet containing ONLY the code that changes, with `// ... existing code ...` markers (any comment syntax) standing in for unchanged parts; include 1-2 real original lines around each change as anchors. For a NEW file, pass the full content without markers. Returns applied=true + changed-line count, or applied=false with the reason (add more anchor context and retry, or fall back to your native editor).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative path of the file to edit/create' },
        code_edit: {
          type: 'string',
          description:
            'Only the changed code, with `// ... existing code ...` markers around it (full content for a new file)',
        },
        instructions: {
          type: 'string',
          description: 'Optional one-line intent of the edit (guides the merge fallback)',
        },
        source: {
          type: 'string',
          description: 'Optional source label to edit in; defaults to the primary source',
        },
      },
      required: ['path', 'code_edit'],
    },
  },
  // ---------- Knowledge Base ----------
  {
    name: 'kb_search',
    description:
      'Hybrid local search (BM25 + semantic embeddings) over the workspace knowledge base AND the indexed real source code. CALL BEFORE answering any technical/conceptual question. Returns KB pages (docs, architecture, decisions) AND actual code snippets — code hits have sourceKind="code" with file:line provenance (file, startLine, endLine).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms (can be a phrase or keywords)' },
        limit: { type: 'number', default: 10 },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['doc', 'index', 'auto-generated', 'agent-memory'] },
          description: 'Optional page kinds to include.',
        },
        source_id: { type: 'string', description: 'Optional KB source id to filter by.' },
        require_usage: {
          type: 'boolean',
          description: 'Only return pages that have been used in previous retrievals.',
        },
        min_score: { type: 'number', description: 'Optional minimum combined rerank score.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kb_get_page',
    description:
      'Return the FULL content of a KB page by id or slug. Use after kb_search to read it in depth.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Page UUID OR slug (e.g. "repo-ezchat-frontend")' },
      },
      required: ['page_id'],
    },
  },
  {
    name: 'kb_get_page_tree',
    description:
      'Return the hierarchical tree of KB pages (titles + ids, no content). Use to understand the structure before searching.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kb_get_backlinks',
    description:
      'List pages that reference (via wikilink) the target page. Use to discover additional context about a concept.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
      },
      required: ['page_id'],
    },
  },
  {
    name: 'kb_create_page',
    description:
      'Create a NEW page in the knowledge base. Use to record important learnings/decisions as PERSISTENT MEMORY — so you (or other agents) can retrieve them in future sessions. Accepts markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content_md: { type: 'string', description: 'Content in markdown' },
        parent_page_id: { type: 'string', description: 'Parent page UUID (optional)' },
        source_id: {
          type: 'string',
          description:
            'Workspace source id this page belongs to. Required for repository analysis pages.',
        },
        kind: {
          type: 'string',
          enum: ['doc', 'agent-memory', 'auto-generated'],
          default: 'agent-memory',
          description:
            'auto-generated for repo analysis; agent-memory for learnings; doc for formal notes',
        },
      },
      required: ['title', 'content_md'],
    },
  },
  {
    name: 'kb_link_pages',
    description:
      'Create a reference (wikilink) from one page to another. Use to build the knowledge graph explicitly.',
    inputSchema: {
      type: 'object',
      properties: {
        source_page_id: { type: 'string' },
        target_page_id: { type: 'string' },
        label: { type: 'string', description: 'Descriptive link text (e.g. "depends on")' },
      },
      required: ['source_page_id', 'target_page_id'],
    },
  },
  {
    name: 'session_search',
    description:
      'Full-text search over PAST conversations in this workspace (your and other agents’ chat history). Use it to recall what was already discussed/decided before — "did we talk about X?", "what did the user say about Y?" — instead of asking the user to repeat themselves. Returns matching snippets with the session title.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for in past conversations' },
        limit: { type: 'number', default: 6 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_user_profile',
    description:
      'Read the persistent profile of the USER in this workspace — who they are, their role, preferences, communication style, recurring asks. Consult it to tailor your work to them. Empty on a fresh workspace.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_user_profile',
    description:
      'Persist something durable you learned ABOUT THE USER (a stable preference, their role/stack, how they like to work, a recurring pet peeve) so future sessions remember it. Do NOT store one-off task details, secrets, or transient context. Default mode appends a bullet; use replace only to rewrite the whole profile.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The fact/preference to remember (one or a few lines)',
        },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'Default: append' },
      },
      required: ['content'],
    },
  },
  // ---------- Skills (auto-curadoria: o agente aprende técnicas reutilizáveis) ----------
  {
    name: 'skill_list',
    description:
      'List the reusable skills available in this workspace (name + description). Skills are short procedural playbooks the team learned. Check this when starting a non-trivial task to reuse a known technique instead of rediscovering it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skill_view',
    description: 'Read the full content of a skill by name or slug (the step-by-step playbook).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name or slug' } },
      required: ['name'],
    },
  },
  {
    name: 'skill_create',
    description:
      'Save a NEW reusable skill after you discover a non-obvious technique, fix, gotcha, or repeatable procedure that future tasks in this workspace would benefit from. Write it as a concise procedural playbook (steps, pitfalls, verification). Do NOT save one-off facts (use the KB for those) or anything secret. The skill auto-attaches to the team so everyone benefits.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short imperative name, e.g. "Add a z-api WhatsApp webhook"',
        },
        description: { type: 'string', description: 'One line: when to use this skill' },
        content: {
          type: 'string',
          description: 'Markdown playbook: steps, pitfalls, how to verify',
        },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'skill_improve',
    description:
      'Improve an existing AGENT-created skill when you learned something new about it (a better step, a fixed pitfall). Append a note or replace the content. Skills installed by the user/marketplace are protected and cannot be changed here.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name or slug to improve' },
        content: { type: 'string', description: 'New/extra markdown content' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'Default: append' },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'approval_prompt',
    description:
      'Gate interno de permissão do Orkestral — chamado automaticamente pelo runtime; nunca chame diretamente.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object' },
        tool_use_id: { type: 'string' },
      },
    },
  },
];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolTraceContext {
  runId?: string;
  issueId?: string;
  issueKey?: string;
  agentId?: string;
  agentName?: string;
  parentId?: string;
  /**
   * Classe de role do caller resolvida a partir do `x-orkestral-agent-id` (quando
   * presente e válido pro workspace). `undefined` = caller anônimo → scoping de
   * tools não se aplica (gate cross-workspace já barra mutação anônima). Resolvida
   * em handleRequest pra não re-buscar o agente em cada tool.
   */
  agentRole?: AgentToolRole;
}

function jsonRpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const RETRIEVAL_TOOLS = new Set([
  'kb_search',
  'kb_get_page',
  'kb_get_page_tree',
  'kb_get_backlinks',
  'session_search',
  'code_search',
  'list_issues',
  'get_issue',
  'qa_get_validation',
  'list_sources',
  'list_agents',
  'get_user_profile',
]);

const LEARNING_TOOLS = new Set(['kb_create_page', 'skill_create', 'update_user_profile']);

/**
 * Lista de tools visível pra um agente, dada sua classe de role. Usada no
 * `tools/list` pra não anunciar tools que o agente não pode chamar. Sem agente
 * identificado, mantém o catálogo completo (comportamento legado).
 *
 * `approval_prompt` PRECISA ser anunciada: o Claude Code atual VALIDA o tool
 * passado em `--permission-prompt-tool` contra o `tools/list` e aborta com
 * "MCP tool ... not found" se ele não estiver lá (versões antigas não validavam
 * — por isso o filtro anterior passava despercebido). A própria description dela
 * já instrui "chamado automaticamente pelo runtime; nunca chame diretamente", e
 * ela é read-only (só pergunta ao operador), então anunciar é seguro.
 */
function toolSchemasForRole(role: AgentToolRole | null): typeof TOOL_SCHEMAS {
  if (!role) return TOOL_SCHEMAS;
  return TOOL_SCHEMAS.filter((s) => agentMayUseTool(role, s.name));
}

function kindForTool(name: string): AgentTraceEventKind {
  if (RETRIEVAL_TOOLS.has(name)) return 'retrieve';
  if (LEARNING_TOOLS.has(name)) return 'learn';
  return 'tool';
}

function titleForTool(name: string, args: Record<string, unknown>): string {
  const q = typeof args.query === 'string' ? args.query.trim() : '';
  if (name === 'kb_search') return q ? `Buscando na KB: ${truncate(q, 90)}` : 'Buscando na KB';
  if (name === 'code_search')
    return q ? `Buscando no código: ${truncate(q, 90)}` : 'Buscando no código';
  if (name === 'edit_file') {
    const p = typeof args.path === 'string' ? args.path.trim() : '';
    return p ? `Aplicando edit em ${truncate(p, 90)}` : 'Aplicando edit (fast-apply)';
  }
  if (name === 'session_search')
    return q ? `Buscando em conversas: ${truncate(q, 90)}` : 'Buscando em conversas';
  if (name === 'kb_get_page') return 'Lendo página da KB';
  if (name === 'kb_create_page') return 'Criando memória/página na KB';
  if (name === 'comment_on_issue') return 'Comentando na issue';
  if (name === 'update_issue_status') return 'Atualizando status da issue';
  if (name === 'qa_get_validation') return 'Lendo plano de QA';
  if (name === 'qa_update_check') return 'Atualizando check de QA';
  if (name === 'qa_complete_validation') return 'Finalizando validação QA';
  return `Executando ${name}`;
}

function truncate(value: string, max = 240): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function sanitizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const lower = key.toLowerCase();
    if (/token|secret|password|auth|credential|api_?key/.test(lower)) {
      out[key] = '[redacted]';
      continue;
    }
    if (lower === 'content_md' || lower === 'content' || lower === 'prompt' || lower === 'body') {
      out[key] = typeof value === 'string' ? truncate(value, 180) : '[omitted]';
      continue;
    }
    if (typeof value === 'string') out[key] = truncate(value);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null)
      out[key] = value;
    else if (Array.isArray(value)) out[key] = { type: 'array', length: value.length };
    else if (value && typeof value === 'object') out[key] = { type: 'object' };
  }
  return out;
}

function summarizeToolResult(result: unknown): Record<string, unknown> {
  if (Array.isArray(result)) return { resultType: 'array', count: result.length };
  if (typeof result === 'string') return { resultType: 'text', length: result.length };
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    return {
      resultType: 'object',
      keys: Object.keys(obj).slice(0, 12),
      ...(Array.isArray(obj.hits) ? { hits: obj.hits.length } : {}),
      ...(Array.isArray(obj.items) ? { items: obj.items.length } : {}),
      ...(Array.isArray(obj.content) ? { contentItems: obj.content.length } : {}),
    };
  }
  return { resultType: typeof result };
}

async function handleMethod(
  workspaceId: string,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
  traceContext?: ToolTraceContext,
): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'orkestral-mcp', version: '1.0.0' },
      };

    case 'tools/list':
      // Anuncia só as tools que o role do caller pode chamar (catálogo completo
      // se o caller for anônimo). Evita o modelo tentar uma tool que vai dar 403.
      return { tools: toolSchemasForRole(traceContext?.agentRole ?? null) };

    case 'tools/call': {
      const name = params.name as string;
      const args = (params.arguments as Record<string, unknown>) ?? {};
      // (A) CROSS-WORKSPACE: mutating tools EXIGEM agent-id válido pro workspace.
      //     handleRequest já validou que, se o header veio, o agente pertence ao
      //     workspace (senão 403 HTTP). Aqui barramos a mutação ANÔNIMA: sem
      //     agentRole resolvido (header ausente) → recusa as mutating tools.
      if (mutatingToolRequiresAgentId(name, !!traceContext?.agentRole)) {
        throw new Error(
          `403 — tool "${name}" muta o workspace e exige um x-orkestral-agent-id válido ` +
            `(agente pertencente a este workspace). Header ausente: requisição recusada.`,
        );
      }
      // (B) PER-AGENT TOOL SCOPING: o role do caller limita o conjunto de tools.
      //     Caller anônimo (sem agentRole) mantém o catálogo completo (legado).
      if (traceContext?.agentRole && !agentMayUseTool(traceContext.agentRole, name)) {
        throw new Error(
          `403 — a role "${traceContext.agentRole}" deste agente não tem permissão pra a tool ` +
            `"${name}". Use as tools de leitura/seu escopo, ou peça ao orquestrador.`,
        );
      }
      const traceable = traceContext?.runId || traceContext?.issueId;
      const step = traceable
        ? startAgentTraceStep({
            workspaceId,
            runId: traceContext?.runId,
            issueId: traceContext?.issueId,
            issueKey: traceContext?.issueKey,
            agentId: traceContext?.agentId,
            agentName: traceContext?.agentName,
            parentId: traceContext?.parentId,
            kind: kindForTool(name),
            title: titleForTool(name, args),
            payload: {
              toolName: name,
              args: sanitizeToolArgs(args),
            },
          })
        : null;
      // Tolerância a erro: uma falha de tool (chave inexistente, assignee inválido,
      // etc.) volta como RESULTADO (isError:true) com a mensagem — o modelo lê e se
      // autocorrige — em vez de um erro de protocolo JSON-RPC que aborta o run.
      try {
        const result = await callTool(
          workspaceId,
          name,
          args,
          sessionId,
          traceContext?.agentId,
          traceContext,
        );
        if (step) {
          finishAgentTraceStep(step.id, {
            status: 'completed',
            summary: 'Tool executada com sucesso.',
            payload: {
              toolName: name,
              args: sanitizeToolArgs(args),
              result: summarizeToolResult(result),
            },
          });
        }
        return {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (step) {
          finishAgentTraceStep(step.id, {
            status: 'failed',
            summary: msg,
            payload: {
              toolName: name,
              args: sanitizeToolArgs(args),
            },
          });
        }
        return {
          content: [
            {
              type: 'text',
              text: `Tool "${name}" failed: ${msg}\n\nFix the arguments and try again (check names/keys with list_issues / list_agents). Do not give up after one tool error.`,
            },
          ],
          isError: true,
        };
      }
    }

    case 'notifications/initialized':
      return null;

    default:
      throw new Error(`Method not found: ${method}`);
  }
}

async function callTool(
  workspaceId: string,
  name: string,
  args: Record<string, unknown>,
  sessionId?: string,
  // Agente que está rodando esta tool (vem do header x-orkestral-agent-id via
  // traceContext). Usado pra CARIMBAR o autor de comentários de agente na origem
  // — sem isso o comentário fica com authorAgentId=null e a UI cai no fallback do
  // assignee ATUAL (que num review reprovado já virou o executor), atribuindo o
  // review ao agente errado.
  actingAgentId?: string | null,
  // Contexto completo do run (run/issue ids dos headers) — usado pelo edit_file
  // pra ancorar o RAG-de-edits (candidato promovido quando a issue verifica).
  traceContext?: ToolTraceContext,
): Promise<unknown> {
  switch (name) {
    case 'list_issues': {
      const status = args.status as IssueStatus | undefined;
      const priority = args.priority as IssuePriority | undefined;
      const assigneeLookup = args.assignee as string | undefined;
      const labelFilter = args.label as string | undefined;
      const parentKey = args.parent_issue_key as number | undefined;
      const limit = (args.limit as number | undefined) ?? 50;
      const agents = agentRepo.listByWorkspace(workspaceId);
      let assigneeId: string | null = null;
      if (assigneeLookup) {
        const lower = assigneeLookup.toLowerCase();
        const found =
          agents.find((a) => a.name.toLowerCase() === lower) ??
          agents.find((a) => a.role.toLowerCase() === lower);
        if (found) assigneeId = found.id;
      }
      let parentId: string | null = null;
      if (typeof parentKey === 'number') {
        const parent = issueRepo.listByWorkspace(workspaceId).find((i) => i.issueKey === parentKey);
        if (parent) parentId = parent.id;
      }
      const all = issueRepo.listByWorkspace(workspaceId);
      const filtered = all.filter((i) => {
        if (status && i.status !== status) return false;
        if (priority && i.priority !== priority) return false;
        if (assigneeId && i.assigneeAgentId !== assigneeId) return false;
        if (labelFilter && !i.labels.includes(labelFilter)) return false;
        if (parentId && i.parentIssueId !== parentId) return false;
        return true;
      });
      return filtered.slice(0, limit).map((i) => ({
        key: i.issueKey,
        title: i.title,
        status: i.status,
        priority: i.priority,
        assignee: i.assigneeAgentId
          ? (agents.find((a) => a.id === i.assigneeAgentId)?.name ?? null)
          : null,
        labels: i.labels,
        parent_key: i.parentIssueId
          ? (all.find((x) => x.id === i.parentIssueId)?.issueKey ?? null)
          : null,
        createdAt: i.createdAt,
      }));
    }

    case 'search_issues': {
      const query = String(args.query ?? '')
        .trim()
        .toLowerCase();
      if (!query) return [];
      const limit = (args.limit as number | undefined) ?? 20;
      const all = issueRepo.listByWorkspace(workspaceId);
      const agents = agentRepo.listByWorkspace(workspaceId);
      const matches = all.filter((i) => {
        const haystack = `${i.title} ${i.description ?? ''}`.toLowerCase();
        return haystack.includes(query);
      });
      return matches.slice(0, limit).map((i) => ({
        key: i.issueKey,
        title: i.title,
        status: i.status,
        priority: i.priority,
        assignee: i.assigneeAgentId
          ? (agents.find((a) => a.id === i.assigneeAgentId)?.name ?? null)
          : null,
        excerpt: (i.description ?? '').slice(0, 240),
      }));
    }

    case 'get_issue': {
      const key = args.issue_key as number;
      const all = issueRepo.listByWorkspace(workspaceId);
      const agents = agentRepo.listByWorkspace(workspaceId);
      const issue = all.find((i) => i.issueKey === key);
      if (!issue) throw new Error(`Issue ${key} não encontrada`);
      const subIssues = all
        .filter((i) => i.parentIssueId === issue.id)
        .map((i) => ({ key: i.issueKey, title: i.title, status: i.status }));
      const parent = issue.parentIssueId ? all.find((i) => i.id === issue.parentIssueId) : null;
      const comments = issueRepo.listComments(issue.id).map((c) => ({
        author: c.authorAgentId
          ? (agents.find((a) => a.id === c.authorAgentId)?.name ?? 'agent')
          : c.authorKind,
        body: c.body,
        createdAt: c.createdAt,
      }));
      return {
        key: issue.issueKey,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        priority: issue.priority,
        labels: issue.labels,
        assignee: issue.assigneeAgentId
          ? (agents.find((a) => a.id === issue.assigneeAgentId)?.name ?? null)
          : null,
        parent: parent ? { key: parent.issueKey, title: parent.title } : null,
        subIssues,
        comments,
        dueDate: issue.dueDate,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      };
    }

    case 'create_issue': {
      const title = String(args.title ?? '').trim();
      if (!title) throw new Error('title é obrigatório');
      const agents = agentRepo.listByWorkspace(workspaceId);
      const assigneeLookup = args.assignee as string | undefined;
      let assigneeId: string | null = null;
      if (assigneeLookup) {
        const lower = assigneeLookup.toLowerCase();
        const found =
          agents.find((a) => a.name.toLowerCase() === lower) ??
          agents.find((a) => a.role.toLowerCase() === lower);
        if (found) assigneeId = found.id;
      }
      let parentIssueId: string | null = null;
      const parentKey = args.parent_issue_key as number | undefined;
      if (typeof parentKey === 'number') {
        // Parent explícito SEMPRE vence.
        const parent = issueRepo.listByWorkspace(workspaceId).find((i) => i.issueKey === parentKey);
        if (parent) parentIssueId = parent.id;
      } else {
        // FIX 1 — Auto-parent determinístico (server-side). Quando o modelo cria
        // uma sub-task SEM parent_issue_key mas existe EXATAMENTE UMA épica aberta
        // recém-criada no workspace (mesmo turno de planejamento), anexa a issue
        // a ela. Conservador: só auto-parenta com candidato ÚNICO e inequívoco;
        // 0 ou >1 → deixa top-level (não chuta o parent errado). Não aplica se a
        // própria issue nova é uma épica.
        const labels = (args.labels as string[]) ?? [];
        const newIsEpic =
          title.toUpperCase().startsWith('[ÉPICA]') ||
          title.toUpperCase().startsWith('[EPICA]') ||
          title.toUpperCase().startsWith('[EPIC]') ||
          labels.some((l) => l.toLowerCase() === 'epic');
        if (!newIsEpic) {
          const cutoff = Date.now() - EPIC_RECENT_WINDOW_MS;
          const recentEpics = issueRepo
            .listByWorkspace(workspaceId)
            .filter(
              (i) =>
                isEpicIssue(i) &&
                i.status !== 'done' &&
                i.status !== 'cancelled' &&
                new Date(i.updatedAt).getTime() >= cutoff,
            );
          if (recentEpics.length === 1) {
            parentIssueId = recentEpics[0].id;
            console.log(
              `[create_issue] auto-parent: "${title}" → épica "${recentEpics[0].title}" ` +
                `(#${recentEpics[0].issueKey}) — candidato único recente, sem parent_issue_key explícito.`,
            );
          } else if (recentEpics.length > 1) {
            console.log(
              `[create_issue] auto-parent SKIP: ${recentEpics.length} épicas recentes (ambíguo) — ` +
                `"${title}" fica top-level.`,
            );
          }
        }
      }
      // DEDUP server-side: antes de inserir, compara o título normalizado com as
      // issues ABERTAS (não-done/cancelled) do workspace. Comparamos like-with-like
      // (épica vs épica, task vs task) via isEpicIssue — uma épica e uma task com
      // títulos parecidos NÃO são duplicatas. Se a similaridade >= threshold (ou
      // match exato normalizado), bloqueia e devolve a issue existente em vez de
      // criar duplicata.
      const dedupLabels = (args.labels as string[]) ?? [];
      const newIsEpic =
        /\[(épica|epica|epic)\]/i.test(title) ||
        dedupLabels.some((l) => l.toLowerCase() === 'epic');
      const normNew = normalizeIssueTitle(title);
      const existingIssues = issueRepo.listByWorkspace(workspaceId);
      let dupOf: Issue | null = null;
      let dupSim = 0;
      for (const i of existingIssues) {
        if (i.status === 'done' || i.status === 'cancelled') continue;
        if (isEpicIssue(i) !== newIsEpic) continue; // compara like-with-like
        const normEx = normalizeIssueTitle(i.title);
        const sim = normEx === normNew ? 1 : titleSimilarity(normNew, normEx);
        if (sim > dupSim) {
          dupSim = sim;
          dupOf = i;
        }
      }
      if (dupOf && dupSim >= ISSUE_DEDUP_SIMILARITY) {
        console.log(
          `[create_issue] DEDUP bloqueado: "${title}" ~ "${dupOf.title}" (#${dupOf.issueKey}) ` +
            `similaridade=${dupSim.toFixed(2)} >= ${ISSUE_DEDUP_SIMILARITY}. Não criando duplicata.`,
        );
        return {
          ok: false,
          duplicate: true,
          message:
            `Já existe uma issue muito parecida: #${dupOf.issueKey} "${dupOf.title}" ` +
            `(status=${dupOf.status}, similaridade=${dupSim.toFixed(2)}). Não criei uma duplicata. ` +
            `Se quiser estender, use parent_issue_key=${dupOf.issueKey}, ou comment_on_issue/update_issue_status nela.`,
          existing_issue_key: dupOf.issueKey,
          existing_title: dupOf.title,
          existing_status: dupOf.status,
          similarity: Number(dupSim.toFixed(2)),
        };
      }
      // Arquivos-alvo reais → metadata.affectedFiles: o classifier/executor miram
      // neles em vez de explorar o repo às cegas (acurácia do patch). VALIDAMOS
      // contra os sources: arquivos que não existem (path alucinado pelo CEO) são
      // DESCARTADOS — o executor cai na exploração WarpGrep em vez de mirar num
      // arquivo fantasma. Os descartados viram um comentário (não-bloqueante).
      const rawFiles = Array.isArray(args.files)
        ? (args.files as unknown[]).filter(
            (f): f is string => typeof f === 'string' && f.trim() !== '',
          )
        : [];
      const wsSourcePaths = sourceRepo
        .listByWorkspace(workspaceId)
        .map((s) => s.path)
        .filter((p): p is string => !!p && existsSync(p));
      // Rejeita paths inseguros (traversal/absolutos) — affectedFiles são SEMPRE
      // relativos ao source. Só valida existência quando há path local pra checar;
      // sem sources locais, mantém os relativos (não dá pra dropar o que não dá
      // pra verificar), mas ainda barra traversal.
      const isSafeRel = (rel: string): boolean =>
        !rel.startsWith('/') &&
        !rel.startsWith('\\') &&
        !rel.includes('..') &&
        !/^[a-zA-Z]:[\\/]/.test(rel);
      // Exige ARQUIVO de verdade (não diretório): um path como "routes/api/private"
      // (pasta) não é alvo editável e deixava o executor sem mira → mis-target.
      const isRealFile = (rel: string): boolean => {
        if (!isSafeRel(rel)) return false;
        return wsSourcePaths.some((root) => {
          try {
            return statSync(join(root, rel)).isFile();
          } catch {
            return false;
          }
        });
      };
      const affectedFiles =
        wsSourcePaths.length === 0 ? rawFiles.filter(isSafeRel) : rawFiles.filter(isRealFile);
      const droppedFiles = rawFiles.filter((f) => !affectedFiles.includes(f));
      // Liga a issue à sessão de chat de origem (quando o agente a cria durante um
      // run de chat) → painel de Progresso lista + resultado volta pro chat ao
      // concluir. Não altera o auto-exec abaixo (que olha assignee+status, não isto).
      const metadata: Record<string, unknown> = {};
      if (affectedFiles.length > 0) metadata.affectedFiles = affectedFiles;
      if (sessionId) metadata.originSessionId = sessionId;
      // Contrato de execução: critério verificável de "pronto" (≤140 chars) → vira
      // alvo absoluto na instrução do Forge (buildPlan) e checklist do reviewer.
      const doneCriterion = typeof args.done === 'string' ? args.done.trim().slice(0, 140) : '';
      if (doneCriterion) metadata.done = doneCriterion;
      // KB-backed planning: a issue aponta pra a página de plano DETALHADA no KB; o
      // executor (premium e Forge) injeta a spec completa de lá. Mantém a issue enxuta.
      // ISOLAMENTO: só guarda se a página EXISTE e é DESTE workspace (getScoped) — senão
      // o ref poderia apontar pra KB de outro workspace.
      const planPageRaw = typeof args.plan_page === 'string' ? args.plan_page.trim() : '';
      if (planPageRaw) {
        const pp =
          kbPageRepo.getScoped(workspaceId, planPageRaw) ??
          kbPageRepo.getBySlug(workspaceId, planPageRaw);
        if (pp) metadata.planPageId = pp.id;
      }
      // Checklist (- [ ] task @Agente) na descrição → componente Tasks (execution-plan). O
      // resto da descrição fica limpo. Mesmo extrator dos blocos do chat.
      const { description: cleanDescription, checkboxes } = extractChecklist(
        (args.description as string) ?? '',
        agents,
      );
      if (checkboxes.length >= 2) {
        metadata.kind = 'execution-plan';
        metadata.checkboxes = checkboxes;
      }
      const issue = issueRepo.create({
        workspaceId,
        title,
        description: cleanDescription,
        // Criada DURANTE um run de chat (sessionId) → nasce `backlog` e ESPERA a
        // aprovação do usuário (igual ao caminho de blocos `<orkestral:create-issue>`).
        // Nunca auto-executa direto da conversa — o usuário aprova o plano antes
        // de o agente mexer no código. Fora de chat, mantém o status pedido.
        status: sessionId ? 'backlog' : ((args.status as IssueStatus) ?? 'todo'),
        priority: (args.priority as IssuePriority) ?? 'medium',
        labels: (args.labels as string[]) ?? [],
        assigneeAgentId: assigneeId,
        parentIssueId,
        goalId: (args.goal_id as string) ?? null,
        dueDate: (args.due_date as string) ?? null,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
      // Arquivos alucinados/inseguros (não existem nos sources ou com traversal)
      // → avisa, não bloqueia. O executor vai explorar (WarpGrep) pra achar os
      // reais em vez de mirar errado.
      if (droppedFiles.length > 0) {
        issueRepo.addComment({
          issueId: issue.id,
          body: `⚠️ Arquivos ignorados do alvo (não encontrados nos sources ou path inválido): ${droppedFiles
            .map((f) => `\`${f}\``)
            .join(', ')}. O executor vai localizar os arquivos reais via busca de código.`,
          authorKind: 'system',
        });
      }
      // Issue nova vinculada a objetivo → recalcula o progresso derivado dele.
      if (issue.goalId) goalRepo.recalcProgress(issue.goalId);
      broadcastIssuesChanged(workspaceId, 'create_issue');
      // Auto-spawn FORA de chat: agente autônomo executando uma issue pode abrir
      // sub-tarefas que rodam na hora (status='todo'/label auto-exec). DENTRO de um
      // chat (sessionId), NÃO auto-executa — a issue fica `backlog` aguardando a
      // aprovação do usuário no banner/drawer do plano. Evita "mexeu no código sem
      // eu aprovar".
      if (!sessionId) maybeAutoExecuteIssue(issue);
      // Ref de display (humano) que o agente deve citar — bate com a lista.
      const wsName = workspaceRepo.list().find((w) => w.id === workspaceId)?.name ?? '';
      const pfx = mcpIssuePrefix(wsName);
      let issueRef: string;
      if (parentIssueId) {
        const parent = issueRepo.get(parentIssueId);
        const parentRef = `${pfx}-${parent?.displayKey ?? parent?.issueKey ?? '?'}`;
        issueRef = `${parentRef}.${issue.childOrdinal ?? issue.issueKey}`;
      } else {
        issueRef = `${pfx}-${issue.displayKey ?? issue.issueKey}`;
      }
      // Feedback DIRETO pro CEO (não só comentário na issue): se ele chutou arquivos
      // que não existem, devolve o aviso pra ele re-buscar os caminhos reais.
      const fileWarning =
        droppedFiles.length > 0
          ? `${droppedFiles.length} arquivo(s) IGNORADO(s) por não serem arquivos reais do repo: ${droppedFiles
              .map((f) => `\`${f}\``)
              .join(
                ', ',
              )}. Ache os caminhos REAIS via kb_search/code_search e corrija a issue — sem files válidos o executor local adivinha e mis-targeta.`
          : undefined;
      return {
        ok: true,
        issue_ref: issueRef,
        issueKey: issue.issueKey,
        id: issue.id,
        ...(fileWarning ? { warning: fileWarning } : {}),
      };
    }

    case 'create_issue_plan': {
      // Cria a épica + TODAS as sub-issues numa só chamada (em vez de N create_issue
      // sequenciais = N round-trips do agente, o que ficava lento). Reusa dedup,
      // validação de affectedFiles e o parent automático na épica.
      const epicTitleRaw = String(args.epic_title ?? '').trim();
      if (!epicTitleRaw) throw new Error('epic_title é obrigatório');
      const subsInput = Array.isArray(args.sub_issues)
        ? (args.sub_issues as Record<string, unknown>[])
        : [];
      if (subsInput.length === 0) throw new Error('sub_issues não pode ser vazio');

      // OBJETIVO (Goal): pra requisição grande, o plano se ancora num objetivo que
      // o CEO valida a entrega contra ele no fim. Liga a um existente (goal_id) OU
      // cria a partir de goal_title/goal_description. O épico + todas as sub-issues
      // herdam esse goalId → progresso rola pra cima sozinho.
      let planGoalId: string | null = null;
      // Teto de tokens declarado pelo usuário — persiste no goal (o CEO criava o
      // goal via goal_title e o teto se perdia; o run do Pulso estourou 600k→694k
      // exatamente por isso). O gate de execução vive no maybeAutoExecuteIssue.
      const goalTokenBudget =
        typeof args.goal_token_budget === 'number' && args.goal_token_budget > 0
          ? Math.floor(args.goal_token_budget)
          : null;
      const linkGoalId = typeof args.goal_id === 'string' ? args.goal_id.trim() : '';
      if (linkGoalId) {
        const existing = goalRepo.get(linkGoalId);
        if (existing && existing.workspaceId === workspaceId) {
          planGoalId = existing.id;
          if (goalTokenBudget && !existing.tokenBudget) {
            goalRepo.update(existing.id, { tokenBudget: goalTokenBudget });
          }
        }
      }
      if (!planGoalId && typeof args.goal_title === 'string' && args.goal_title.trim()) {
        const goal = goalRepo.create({
          workspaceId,
          title: args.goal_title.trim(),
          description:
            typeof args.goal_description === 'string' && args.goal_description.trim()
              ? args.goal_description.trim()
              : null,
          tokenBudget: goalTokenBudget,
        });
        planGoalId = goal.id;
      }

      const agents = agentRepo.listByWorkspace(workspaceId);
      const resolveAssignee = (name?: unknown): string | null => {
        if (typeof name !== 'string' || !name.trim()) return null;
        const lower = name.toLowerCase().trim();
        const found =
          agents.find((a) => a.name.toLowerCase() === lower) ??
          agents.find((a) => a.role.toLowerCase() === lower);
        return found?.id ?? null;
      };

      // affectedFiles: mesma regra do create_issue (relativos seguros, validados
      // contra os sources locais quando há path pra checar).
      const wsSourcePaths = sourceRepo
        .listByWorkspace(workspaceId)
        .map((s) => s.path)
        .filter((p): p is string => !!p && existsSync(p));
      const isSafeRel = (rel: string): boolean =>
        !rel.startsWith('/') &&
        !rel.startsWith('\\') &&
        !rel.includes('..') &&
        !/^[a-zA-Z]:[\\/]/.test(rel);
      const isRealFile = (rel: string): boolean =>
        isSafeRel(rel) &&
        wsSourcePaths.some((root) => {
          try {
            return statSync(join(root, rel)).isFile();
          } catch {
            return false;
          }
        });
      const validFiles = (raw: unknown): string[] => {
        const files = Array.isArray(raw)
          ? (raw as unknown[]).filter((f): f is string => typeof f === 'string' && f.trim() !== '')
          : [];
        // Exige ARQUIVO real (não diretório nem path chutado) — mesma regra do create_issue.
        return wsSourcePaths.length === 0 ? files.filter(isSafeRel) : files.filter(isRealFile);
      };

      // Dedup like-with-like contra issues ABERTAS (épica vs épica, task vs task),
      // escopado pelo MESMO pai: com sub-planos (fractal), títulos genéricos
      // legítimos ("Revisão de código", "Testes") se repetem entre sub-épicas — sem
      // o escopo, a sub-issue da sub-épica B deduplicava contra a da A e as
      // dependências cruzavam errado (mesma regra do dedup do issueRepo.create).
      const findDup = (title: string, isEpic: boolean, parentId: string | null): Issue | null => {
        const normNew = normalizeIssueTitle(title);
        let best: Issue | null = null;
        let bestSim = 0;
        for (const i of issueRepo.listByWorkspace(workspaceId)) {
          if (i.status === 'done' || i.status === 'cancelled') continue;
          if ((i.parentIssueId ?? null) !== parentId) continue;
          if (isEpicIssue(i) !== isEpic) continue;
          const normEx = normalizeIssueTitle(i.title);
          const sim = normEx === normNew ? 1 : titleSimilarity(normNew, normEx);
          if (sim > bestSim) {
            bestSim = sim;
            best = i;
          }
        }
        return best && bestSim >= ISSUE_DEDUP_SIMILARITY ? best : null;
      };

      // 1) Épica. SUB-PLANO (HORIZON Fase 1.2 — recursão): `parent_epic_key`
      // parenteia o plano numa sub-épica placeholder EXISTENTE (criada pelo plano
      // raiz) em vez de criar uma épica top-level órfã. Sem a flag, comportamento
      // clássico: reusa uma quase-igual aberta, senão cria (com prefixo [EPIC]).
      const parentEpicKey =
        typeof args.parent_epic_key === 'number' ? (args.parent_epic_key as number) : null;
      let epic: Issue | null = null;
      const isSubPlan = parentEpicKey !== null;
      if (isSubPlan) {
        epic = issueRepo.getByKey(workspaceId, parentEpicKey);
        if (!epic) throw new Error(`parent_epic_key=${parentEpicKey} não existe neste workspace`);
        // Marca como épica explícita (a detecção de sub-épica exige o marcador
        // quando ainda não há filhos) e herda/propaga o objetivo do plano raiz.
        if (!epic.labels.some((l) => l.toLowerCase() === 'epic')) {
          epic = issueRepo.update(epic.id, { labels: [...epic.labels, 'epic'] });
        }
        if (planGoalId && !epic.goalId) epic = issueRepo.update(epic.id, { goalId: planGoalId });
        if (!planGoalId && epic.goalId) planGoalId = epic.goalId;
      } else {
        const epicTitle = /\[(épica|epica|epic)\]/i.test(epicTitleRaw)
          ? epicTitleRaw
          : `[EPIC] ${epicTitleRaw}`;
        epic = findDup(epicTitle, true, null);
        if (!epic) {
          epic = issueRepo.create({
            workspaceId,
            title: epicTitle,
            description: (args.epic_description as string) ?? null,
            status: sessionId ? 'backlog' : 'todo',
            priority: 'medium',
            labels: ['epic'],
            assigneeAgentId: null,
            parentIssueId: null,
            goalId: planGoalId,
            metadata: sessionId ? { originSessionId: sessionId } : undefined,
          });
        } else if (planGoalId && !epic.goalId) {
          // Reusou uma épica aberta e agora há objetivo → vincula.
          epic = issueRepo.update(epic.id, { goalId: planGoalId });
        }
      }

      const wsName = workspaceRepo.list().find((w) => w.id === workspaceId)?.name ?? '';
      const pfx = mcpIssuePrefix(wsName);
      const epicRef = `${pfx}-${epic.displayKey ?? epic.issueKey}`;

      // 2) Sub-issues na ordem dada, parenteadas na épica. Dedup contra existentes
      //    E dentro do próprio lote (não cria duas quase-iguais).
      const created: { issueKey: number; ref: string; title: string }[] = [];
      const skipped: { title: string; existing_issue_key: number }[] = [];
      const batchNorms: string[] = [];
      // Mapa índice (1-based em sub_issues) → issue resolvida (criada OU deduplicada
      // pra existente), pra resolver os `blocked_by` declarados. Issues criadas neste
      // lote ficam separadas pra auto-fiação impl→review e auto-execução pós-deps.
      const indexToIssue = new Map<number, Issue>();
      const createdIssues: Issue[] = [];
      for (let subIdx = 0; subIdx < subsInput.length; subIdx += 1) {
        const sub = subsInput[subIdx];
        const oneBased = subIdx + 1;
        const title = String(sub.title ?? '').trim();
        if (!title) continue;
        const normT = normalizeIssueTitle(title);
        if (
          batchNorms.some((t) => t === normT || titleSimilarity(t, normT) >= ISSUE_DEDUP_SIMILARITY)
        ) {
          continue;
        }
        const dup = findDup(title, false, epic.id);
        if (dup) {
          skipped.push({ title, existing_issue_key: dup.issueKey });
          // Dedup → o `blocked_by` que aponta pra este índice resolve pra existente.
          indexToIssue.set(oneBased, dup);
          continue;
        }
        batchNorms.push(normT);
        const files = validFiles(sub.files);
        const metadata: Record<string, unknown> = {};
        if (files.length > 0) metadata.affectedFiles = files;
        if (sessionId) metadata.originSessionId = sessionId;
        const subDone = typeof sub.done === 'string' ? sub.done.trim().slice(0, 140) : '';
        if (subDone) metadata.done = subDone;
        const subPlanRaw = typeof sub.plan_page === 'string' ? sub.plan_page.trim() : '';
        if (subPlanRaw) {
          const pp =
            kbPageRepo.getScoped(workspaceId, subPlanRaw) ??
            kbPageRepo.getBySlug(workspaceId, subPlanRaw);
          if (pp) metadata.planPageId = pp.id;
        }
        // Checklist (- [ ] task @Agente) na descrição → componente Tasks (execution-plan).
        const { description: cleanSubDescription, checkboxes: subCheckboxes } = extractChecklist(
          (sub.description as string) ?? '',
          agents,
        );
        if (subCheckboxes.length >= 2) {
          metadata.kind = 'execution-plan';
          metadata.checkboxes = subCheckboxes;
        }
        const issue = issueRepo.create({
          workspaceId,
          title,
          description: cleanSubDescription,
          status: sessionId ? 'backlog' : 'todo',
          priority: (sub.priority as IssuePriority) ?? 'medium',
          labels: (sub.labels as string[]) ?? [],
          assigneeAgentId: resolveAssignee(sub.assignee),
          parentIssueId: epic.id,
          goalId: planGoalId,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
        created.push({
          issueKey: issue.issueKey,
          ref: `${epicRef}.${issue.childOrdinal ?? issue.issueKey}`,
          title,
        });
        indexToIssue.set(oneBased, issue);
        createdIssues.push(issue);
      }

      // 3) Dependências (blockedBy). Faz ANTES de auto-executar pra que o gate de
      //    blockers já valha (o openBlockers precisa da aresta existir).
      const addDep = (blockerId: string, blockedId: string): void => {
        if (blockerId === blockedId) return;
        try {
          relationsRepo.addDependency(workspaceId, blockerId, blockedId);
        } catch (err) {
          // addDependency rejeita ciclo — não derruba o plano inteiro por uma aresta ruim.
          console.warn('[mcp] create_issue_plan: aresta de dependência ignorada:', err);
        }
      };
      // 3a) `blocked_by` declarado: índices 1-based em sub_issues → cada bloqueador.
      for (let subIdx = 0; subIdx < subsInput.length; subIdx += 1) {
        const blocked = indexToIssue.get(subIdx + 1);
        if (!blocked) continue;
        const rawBlockedBy = subsInput[subIdx].blocked_by;
        if (!Array.isArray(rawBlockedBy)) continue;
        for (const ref of rawBlockedBy) {
          const blocker = typeof ref === 'number' ? indexToIssue.get(ref) : undefined;
          if (blocker) addDep(blocker.id, blocked.id);
        }
      }
      // 3b) Auto-fiação "revisão por último": mesmo sem `blocked_by`, toda sub-issue de
      //     IMPLEMENTAÇÃO (não-review) bloqueia cada sub-issue de revisão/QA. Garante
      //     que a "Revisão de código" só rode depois das issues de código.
      const reviewSubs = createdIssues.filter((i) => isReviewLikeIssue(i));
      const implSubs = createdIssues.filter((i) => !isReviewLikeIssue(i));
      for (const review of reviewSubs) {
        for (const impl of implSubs) addDep(impl.id, review.id);
      }

      // 4) Auto-execução. SUB-PLANO: a raiz já passou pelo gate de aprovação do
      //    usuário — o detalhamento NÃO re-pede aprovação (o fractal congelaria a
      //    cada nível). Ativa a sub-épica e dispara a onda recursiva (que promove
      //    backlog→todo e respeita blockedBy). Plano clássico: fora de chat
      //    auto-executa; no chat fica backlog aguardando aprovação (igual create_issue).
      if (isSubPlan) {
        if (epic.status === 'todo' || epic.status === 'backlog') {
          issueRepo.update(epic.id, { status: 'in_progress' });
        }
        const rootApproved = ((): boolean => {
          let cur: Issue | null = epic;
          for (let d = 0; d < 16 && cur?.parentIssueId; d += 1) {
            cur = issueRepo.get(cur.parentIssueId);
          }
          const plan = (cur?.metadata as { plan?: { status?: string } } | null)?.plan;
          return plan?.status === 'approved';
        })();
        if (rootApproved || !sessionId) startRunnablePlanIssueWave(epic.id);
      } else if (!sessionId) {
        for (const issue of createdIssues) maybeAutoExecuteIssue(issue);
      }

      // Progresso do objetivo reflete as issues recém-ligadas.
      if (planGoalId) goalRepo.recalcProgress(planGoalId);
      broadcastIssuesChanged(workspaceId, 'create_issue_plan');
      return {
        ok: true,
        epic_ref: epicRef,
        epicKey: epic.issueKey,
        goal_id: planGoalId,
        created_count: created.length,
        created,
        skipped_duplicates: skipped,
      };
    }

    case 'update_issue': {
      const key = args.issue_key as number;
      const all = issueRepo.listByWorkspace(workspaceId);
      const target = all.find((i) => i.issueKey === key);
      if (!target) throw new Error(`Issue ${key} não encontrada`);
      const agents = agentRepo.listByWorkspace(workspaceId);
      const patch: Parameters<typeof issueRepo.update>[1] = {};
      if (typeof args.title === 'string') patch.title = args.title;
      if (typeof args.description === 'string') patch.description = args.description;
      if (typeof args.priority === 'string') patch.priority = args.priority as IssuePriority;
      if (Array.isArray(args.labels)) patch.labels = args.labels as string[];
      if (typeof args.due_date === 'string') {
        patch.dueDate = args.due_date.trim() === '' ? null : args.due_date;
      }
      if (typeof args.assignee === 'string') {
        const lower = args.assignee.toLowerCase().trim();
        if (lower === '' || lower === 'null') {
          patch.assigneeAgentId = null;
        } else {
          const found =
            agents.find((a) => a.name.toLowerCase() === lower) ??
            agents.find((a) => a.role.toLowerCase() === lower);
          patch.assigneeAgentId = found?.id ?? null;
        }
      }
      if (typeof args.parent_issue_key === 'number') {
        if (args.parent_issue_key === 0) {
          patch.parentIssueId = null;
        } else {
          const parent = all.find((i) => i.issueKey === args.parent_issue_key);
          patch.parentIssueId = parent?.id ?? null;
        }
      }
      issueRepo.update(target.id, patch);
      broadcastIssuesChanged(workspaceId, 'update_issue');
      return { ok: true, issueKey: key, updatedFields: Object.keys(patch) };
    }

    case 'assign_issue': {
      const key = args.issue_key as number;
      const assigneeLookup = String(args.assignee ?? '');
      const all = issueRepo.listByWorkspace(workspaceId);
      const target = all.find((i) => i.issueKey === key);
      if (!target) throw new Error(`Issue ${key} não encontrada`);
      const agents = agentRepo.listByWorkspace(workspaceId);
      const found = resolveAgentStrict(agents, assigneeLookup);
      issueRepo.update(target.id, { assigneeAgentId: found.id });
      broadcastIssuesChanged(workspaceId, 'assign_issue');
      return { ok: true, issueKey: key, newAssignee: found.name };
    }

    case 'comment_on_issue': {
      const key = args.issue_key as number;
      const body = String(args.body ?? '').trim();
      // Body vazio: NÃO lança (virava erro vermelho repetido no trace + turno
      // desperdiçado). Retorna um skip suave com a dica — o agente recompõe e chama
      // de novo com o texto, sem o spiral de "failed".
      if (!body) {
        return {
          ok: false,
          skipped: 'empty_body',
          hint: 'Comentário ignorado: passe o texto do comentário em `body` (não vazio).',
        };
      }
      const all = issueRepo.listByWorkspace(workspaceId);
      const target = all.find((i) => i.issueKey === key);
      if (!target) throw new Error(`Issue ${key} não encontrada`);
      const comment = issueRepo.addComment({
        issueId: target.id,
        body,
        authorKind: 'agent',
        // Carimba o agente REAL que comentou (ex.: o Code Reviewer no review),
        // imune ao assign_issue posterior e ao fallback de assignee da UI.
        authorAgentId: actingAgentId ?? null,
      });
      broadcastIssuesChanged(workspaceId, 'comment_on_issue');
      return { ok: true, commentId: comment.id, issueKey: key };
    }

    case 'qa_get_validation': {
      const key = args.issue_key as number;
      const target = issueRepo.getByKey(workspaceId, key);
      if (!target) throw new Error(`Issue ${key} não encontrada`);
      const validation = getLatestQaValidation(target.id);
      if (!validation) {
        throw new Error(
          `Issue ${key} ainda não tem plano de QA. Aguarde o gate iniciar ou peça para o CEO acionar QA.`,
        );
      }
      return validation;
    }

    case 'qa_update_check': {
      const validationId = String(args.validation_id ?? '').trim();
      const ordinal = Number(args.check_ordinal);
      const status = String(args.status ?? '') as Parameters<typeof updateQaCheck>[0]['status'];
      const evidence = String(args.evidence ?? '').trim();
      if (!validationId) throw new Error('validation_id é obrigatório');
      if (!Number.isFinite(ordinal) || ordinal <= 0) throw new Error('check_ordinal inválido');
      if (!['pending', 'running', 'passed', 'failed', 'skipped'].includes(status)) {
        throw new Error('status de check QA inválido');
      }
      if (!evidence) throw new Error('evidence é obrigatório');
      // Escopo: a validação tem que ser DESTE workspace. Sem isso, um agente do
      // workspace A poderia atualizar checks de QA do workspace B só passando o UUID.
      if (!getQaValidationScoped(workspaceId, validationId)) {
        throw new Error(`Validação QA "${validationId}" não encontrada`);
      }
      const validation = updateQaCheck({
        validationId,
        ordinal,
        status,
        evidence,
      });
      broadcastIssuesChanged(workspaceId, 'qa_update_check');
      return validation;
    }

    case 'complete_checkpoint': {
      const key = args.issue_key as number;
      const step = Number(args.step);
      const status: ExecutionCheckbox['status'] = args.status === 'blocked' ? 'blocked' : 'done';
      if (!Number.isFinite(step) || step <= 0) throw new Error('step inválido');
      const target = issueRepo.listByWorkspace(workspaceId).find((i) => i.issueKey === key);
      if (!target) throw new Error(`Issue ${key} não encontrada`);
      const meta = target.metadata as { kind?: string; checkboxes?: ExecutionCheckbox[] } | null;
      if (meta?.kind !== 'execution-plan' || !Array.isArray(meta.checkboxes)) {
        throw new Error('essa issue não tem checklist de execução');
      }
      if (step > meta.checkboxes.length) throw new Error('step fora do range da checklist');
      // SÓ marca o checkbox (visual ao vivo). NÃO mexe no status da issue — quem fecha a issue é
      // o executor (finalizeIssue), pra não dar done prematuro/duplo.
      const checkboxes = meta.checkboxes.map((c, i) =>
        i === step - 1
          ? {
              ...c,
              status,
              completedAt: status === 'done' ? new Date().toISOString() : c.completedAt,
            }
          : c,
      );
      issueRepo.update(target.id, { metadata: { ...meta, kind: 'execution-plan', checkboxes } });
      broadcastIssuesChanged(workspaceId, 'checkbox-live');
      return {
        ok: true,
        done: checkboxes.filter((c) => c.status === 'done').length,
        total: checkboxes.length,
      };
    }

    case 'qa_complete_validation': {
      const validationId = String(args.validation_id ?? '').trim();
      const status = String(args.status ?? '') as Parameters<
        typeof completeQaValidation
      >[0]['status'];
      const summary = String(args.summary ?? '').trim();
      if (!validationId) throw new Error('validation_id é obrigatório');
      if (!['passed', 'failed', 'needs_human'].includes(status)) {
        throw new Error('status final de QA inválido');
      }
      if (!summary) throw new Error('summary é obrigatório');
      // Escopo: a validação tem que ser DESTE workspace (anti cross-workspace).
      if (!getQaValidationScoped(workspaceId, validationId)) {
        throw new Error(`Validação QA "${validationId}" não encontrada`);
      }
      // ⛔ GATE DE BUILD DETERMINÍSTICO: a QA não pode dar "passed" se o projeto NÃO
      // COMPILA. O agente escrevia "PASS" sem rodar nada (entrega oca passava verde).
      // Aqui o SISTEMA roda o build de verdade e, se falhar, FORÇA o veredito a 'failed'
      // com o erro real — a palavra do agente não passa por cima do exit code.
      let finalStatus = status;
      let finalSummary = summary;
      if (status === 'passed') {
        // Resolve o repo: primário, senão o 1º source do workspace (greenfield: o
        // primário pode não estar setado ainda). Sem isso o gate era PULADO em silêncio
        // exatamente no greenfield — o cenário do run quebrado.
        const repo =
          sourceRepo.getPrimary(workspaceId)?.path ??
          sourceRepo.listByWorkspace(workspaceId).find((s) => s.path)?.path;
        const gate = runQaBuildGate(repo);
        if (gate.ran && !gate.ok) {
          finalStatus = 'failed';
          finalSummary =
            `⛔ REPROVADO pelo gate automático: \`${gate.command}\` FALHOU (o agente havia reportado "passed", mas o projeto não compila).\n\n` +
            '```\n' +
            gate.output +
            '\n```\n\n— veredito original do agente —\n' +
            summary;
        } else {
          // Rotas Next órfãs (route.ts/page.tsx fora de app/) — o build passa mas a rota
          // não existe. Gate determinístico: se há órfãs, REPROVA com a lista pra mover.
          const orphans = findOrphanedNextRoutes(repo);
          if (orphans.length > 0) {
            finalStatus = 'failed';
            finalSummary =
              `⛔ REPROVADO pelo gate automático: ${orphans.length} rota(s) Next ÓRFÃ(s) fora de ` +
              '`app/` — o Next ignora, então a rota NÃO existe. Mova para `app/.../route.ts` ' +
              '(API) ou `app/.../page.tsx` (página):\n' +
              orphans.map((o) => `- \`${o}\``).join('\n') +
              '\n\n— veredito original do agente —\n' +
              summary;
          }
        }
      }
      const validation = completeQaValidation({
        validationId,
        status: finalStatus,
        summary: finalSummary,
      });
      const target = issueRepo.get(validation.issueId);
      const executor = validation.executorAgentId
        ? agentRepo.get(validation.executorAgentId)
        : null;
      const qaAgent = validation.qaAgentId ? agentRepo.get(validation.qaAgentId) : null;
      if (target) {
        const transition = buildQaVerdictIssueTransition({
          issue: target,
          validation,
          status: finalStatus,
          summary: finalSummary,
          executorName: executor?.name ?? null,
          qaName: qaAgent?.name ?? null,
        });
        const updated = issueRepo.update(target.id, transition.patch);
        if (updated.parentIssueId) issueRepo.syncEpicStatus(updated.parentIssueId);
        issueRepo.addComment({
          issueId: validation.issueId,
          body: transition.visibilityComment,
          authorKind: 'system',
        });
      }
      issueRepo.addComment({
        issueId: validation.issueId,
        body: `🧪 **QA ${finalStatus.toUpperCase()}**\n\n${finalSummary}`,
        authorKind: 'agent',
        authorAgentId: validation.qaAgentId,
      });
      broadcastIssuesChanged(workspaceId, 'qa_complete_validation');
      return validation;
    }

    case 'get_open_work_summary': {
      const all = issueRepo.listByWorkspace(workspaceId);
      const agents = agentRepo.listByWorkspace(workspaceId);
      const open = all.filter((i) => i.status !== 'done' && i.status !== 'cancelled');
      const byStatus: Record<string, number> = {};
      const byPriority: Record<string, number> = {};
      const byAssignee: Record<string, number> = {};
      let blocked = 0;
      const now = Date.now();
      const ages: number[] = [];
      for (const i of open) {
        byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
        byPriority[i.priority] = (byPriority[i.priority] ?? 0) + 1;
        if (i.status === 'blocked') blocked++;
        const assignee = i.assigneeAgentId
          ? (agents.find((a) => a.id === i.assigneeAgentId)?.name ?? 'unknown')
          : 'unassigned';
        byAssignee[assignee] = (byAssignee[assignee] ?? 0) + 1;
        ages.push(now - new Date(i.createdAt).getTime());
      }
      const avgAgeDays =
        ages.length === 0
          ? 0
          : Math.round(ages.reduce((a, b) => a + b, 0) / ages.length / 86_400_000);
      return {
        totalOpen: open.length,
        byStatus,
        byPriority,
        byAssignee,
        blockedCount: blocked,
        avgAgeDays,
        topPriorityOpen: open
          .filter((i) => i.priority === 'critical' || i.priority === 'high')
          .slice(0, 8)
          .map((i) => ({
            key: i.issueKey,
            title: i.title,
            status: i.status,
            priority: i.priority,
          })),
      };
    }

    case 'update_issue_status': {
      const key = args.issue_key as number;
      const status = args.status as IssueStatus;
      const issue = issueRepo.listByWorkspace(workspaceId).find((i) => i.issueKey === key);
      if (!issue) throw new Error(`Issue ${key} não encontrada`);
      const meta = (issue.metadata as Record<string, unknown> | null) ?? {};
      // AUTO-REPORTE DE REVISÃO: quando o EXECUTOR (actingAgentId presente) marca a
      // própria issue como `in_review`, isso é o HAND-OFF "terminei, revisem" — NÃO um
      // estado "aguardando aprovação humana". O Inbox lista só `in_review` SEM
      // `metadata.review`, então um in_review cru piscava lá ("aprovar"?) e sumia quando
      // o startReview carimbava o review (corrida exposta pelo poll de 8s). Carimbamos o
      // mesmo `review` que o startReview usaria (executor = quem reportou) ATOMICAMENTE
      // com o status → o Inbox nunca vê a janela transitória. Não mexe em quem já está
      // em revisão (review existente) nem em aprovação humana pendente (parkedNoActor).
      const isExecutorSelfReport =
        status === 'in_review' && !!actingAgentId && !meta.review && meta.parkedNoActor !== true;
      if (isExecutorSelfReport) {
        issueRepo.update(issue.id, {
          status,
          metadata: { ...meta, review: { executorAgentId: actingAgentId, depth: 0, attempts: 0 } },
        });
      } else {
        issueRepo.update(issue.id, { status });
      }
      // Rollup da épica pai + recalc/AUTO-VERIFICAÇÃO dos objetivos: quando a issue
      // (tipicamente aprovada pelo reviewer) fecha o objetivo (100%), o CEO valida
      // a ENTREGA contra ele. maybeAutoVerifyGoal recalcula + dispara só no 100%.
      const epicNewStatus = issueRepo.syncEpicStatus(issue.parentIssueId);
      maybeAutoVerifyGoal(issue.goalId);
      if (epicNewStatus) {
        const epic = issue.parentIssueId ? issueRepo.get(issue.parentIssueId) : null;
        maybeAutoVerifyGoal(epic?.goalId);
      }
      broadcastIssuesChanged(workspaceId, 'update_issue_status');
      return { ok: true, issueKey: key, newStatus: status };
    }

    case 'list_agents': {
      const agents = agentRepo.listByWorkspace(workspaceId);
      return agents.map((a) => ({
        name: a.name,
        role: a.role,
        title: a.title,
        adapterType: a.adapterType,
        status: a.status,
        isOrchestrator: a.isOrchestrator,
      }));
    }

    case 'list_sources': {
      const sources = sourceRepo.listByWorkspace(workspaceId);
      return sources.map((s) => ({
        label: s.label,
        kind: s.kind,
        role: s.role,
        path: s.path,
        repoFullName: s.repoFullName,
        isPrimary: s.isPrimary,
      }));
    }

    case 'send_whatsapp_image': {
      if (!sessionId) throw new Error('Sem sessão de chat ativa pra enviar mídia');
      const path = String(args.path ?? '').trim();
      if (!path) throw new Error('path é obrigatório');
      const caption = args.caption ? String(args.caption) : undefined;
      const sent = await channelManager.sendMediaToSession(sessionId, path, caption);
      if (!sent) {
        return {
          sent: false,
          reason:
            'Esta conversa não veio de um canal (WhatsApp), então não há para quem enviar mídia.',
        };
      }
      return { sent: true, path };
    }

    case 'list_sentry_issues': {
      const limit = Number(args.limit ?? 20);
      const issues = await listSentryIssues(workspaceId, limit);
      return issues.map((i) => ({
        shortId: i.shortId,
        title: i.title,
        level: i.level,
        count: i.count,
        userCount: i.userCount,
        culprit: i.culprit,
        lastSeen: i.lastSeen,
        permalink: i.permalink,
      }));
    }

    case 'list_observability_signals': {
      const limit = Number(args.limit ?? 15);
      const providers = (['new_relic', 'better_stack'] as const).filter((p) =>
        getObsConnection(workspaceId, p),
      );
      if (providers.length === 0) {
        return { connected: false, message: 'Nenhum provider de observabilidade conectado.' };
      }
      const out: Array<Record<string, unknown>> = [];
      for (const provider of providers) {
        try {
          const signals = await listObsSignals({ workspaceId, provider, limit });
          for (const s of signals) {
            out.push({
              provider: s.provider,
              kind: s.kind,
              title: s.title,
              service: s.service,
              severity: s.severity,
              count: s.count,
              lastSeen: s.lastSeen,
              url: s.url,
            });
          }
        } catch (err) {
          out.push({ provider, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return out;
    }

    case 'list_code_reviews': {
      const limit = Number(args.limit ?? 20);
      return codeReviewRepo.listByWorkspace(workspaceId, limit).map((r) => ({
        id: r.id,
        repo: r.repoFullName,
        pr: r.prNumber,
        prTitle: r.prTitle,
        status: r.status,
        recommendation: r.recommendation,
        riskLevel: r.riskLevel,
        rating: r.rating,
        bugCount: r.bugCount,
        securityCount: r.securityCount,
        suggestionCount: r.suggestionCount,
        totalComments: r.totalComments,
        url: r.htmlUrl,
        createdAt: r.createdAt,
      }));
    }

    case 'get_code_review': {
      const id = String(args.id ?? '').trim();
      if (!id) throw new Error('id é obrigatório');
      const review = codeReviewRepo.get(id);
      if (!review || review.workspaceId !== workspaceId)
        throw new Error('Code review não encontrado');
      const comments = codeReviewRepo.listComments(id);
      return {
        id: review.id,
        repo: review.repoFullName,
        pr: review.prNumber,
        prTitle: review.prTitle,
        status: review.status,
        recommendation: review.recommendation,
        riskLevel: review.riskLevel,
        summary: review.summary,
        highlights: review.highlights,
        concerns: review.concerns,
        url: review.htmlUrl,
        findings: comments.map((c) => ({
          file: c.filePath,
          line: c.lineStart,
          kind: c.kind,
          severity: c.severity,
          title: c.title,
          message: c.message,
        })),
      };
    }

    case 'list_goals': {
      return goalRepo.listByWorkspace(workspaceId).map((g) => ({
        id: g.id,
        title: g.title,
        status: g.status,
        progress: g.progress,
        dueDate: g.dueDate,
        completedAt: g.completedAt,
      }));
    }

    case 'list_routines': {
      return routineRepo.listByWorkspace(workspaceId).map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        intervalMinutes: r.intervalMinutes,
        enabled: r.enabled,
        lastRunAt: r.lastRunAt,
        nextRunAt: r.nextRunAt,
      }));
    }

    case 'list_docker_containers': {
      const health = await dockerPing();
      if (health.status !== 'connected') {
        return { connected: false, status: health.status, message: health.message };
      }
      const { containers } = await listDockerContainers();
      return containers.map((c) => ({
        name: c.name,
        image: c.image,
        state: c.state,
        status: c.status,
      }));
    }

    case 'scaffold_project': {
      const sources = sourceRepo.listByWorkspace(workspaceId);
      if (sources.length === 0) throw new Error('Nenhum source anexado ao workspace');
      const wantLabel = String(args.source ?? '')
        .trim()
        .toLowerCase();
      const target = wantLabel
        ? sources.find((s) => s.label.toLowerCase() === wantLabel)
        : (sources.find((s) => s.isPrimary) ?? sources[0]);
      if (!target?.path) throw new Error('Source sem caminho local válido');
      const requested = String(args.template ?? '').trim();
      const tpl = requested
        ? (STARTER_TEMPLATES.find((t) => t.name === requested) ??
          selectTemplate(String(args.request ?? '')))
        : selectTemplate(String(args.request ?? ''));
      const result = await scaffoldFromTemplate(target.path, tpl);
      return {
        ok: result.ok,
        template: tpl.name,
        label: tpl.label,
        designSystem: tpl.designSystem,
        ranCommands: result.ranCommands,
        failedCommand: result.failedCommand,
        note: result.ok
          ? `Base "${tpl.label}" criada e pronta (builda). Agora CUSTOMIZE em cima dela — não recrie config/estrutura.`
          : `Scaffold falhou em: ${result.failedCommand}. Ajuste e tente de novo, ou crie a base manualmente.`,
        output: result.output,
      };
    }

    case 'git_status': {
      const sources = sourceRepo.listByWorkspace(workspaceId);
      if (sources.length === 0) throw new Error('Nenhum source anexado ao workspace');
      const wantLabel = String(args.source ?? '')
        .trim()
        .toLowerCase();
      const target = wantLabel
        ? sources.find((s) => s.label.toLowerCase() === wantLabel)
        : (sources.find((s) => s.isPrimary) ?? sources[0]);
      if (!target?.path || !existsSync(target.path)) {
        throw new Error('Source sem caminho local válido (repo não clonado?)');
      }
      const [status, branch, commits] = await Promise.all([
        gitStatus(target.path),
        gitCurrentBranch(target.path).catch(() => null),
        gitLog(target.path, { limit: 8 }).catch(() => []),
      ]);
      return {
        source: target.label,
        branch: branch ?? status.branch,
        ahead: status.ahead,
        behind: status.behind,
        changedFiles: status.files.map((f) => ({
          path: f.path,
          staged: f.staged,
          unstaged: f.unstaged,
        })),
        recentCommits: commits.map((c) => ({
          sha: c.shortSha,
          subject: c.subject,
          author: c.authorName,
          when: c.relativeDate,
        })),
      };
    }

    case 'get_activity': {
      const limit = Number(args.limit ?? 25);
      return activityRepo.listByWorkspace(workspaceId, limit).map((a) => ({
        kind: a.kind,
        actor: a.actorKind,
        title: a.title,
        createdAt: a.createdAt,
      }));
    }

    case 'get_economics': {
      return execStatsRepo.getEconomics();
    }

    case 'run_in_orkestral_terminal': {
      const command = String(args.command ?? '').trim();
      if (!command) throw new Error('command é obrigatório');
      const sources = sourceRepo.listByWorkspace(workspaceId);
      if (sources.length === 0) throw new Error('Nenhum source anexado ao workspace');
      const wantLabel = String(args.source ?? '')
        .trim()
        .toLowerCase();
      const target = wantLabel
        ? sources.find((s) => s.label.toLowerCase() === wantLabel)
        : (sources.find((s) => s.isPrimary) ?? sources[0]);
      if (!target?.path || !existsSync(target.path)) {
        throw new Error('Source sem caminho local válido (repo não clonado?)');
      }
      const { id } = createTerminal({ cwd: target.path, meta: target.id });
      writeTerminal(id, command + '\n');
      announceAgentTerminal(id, target.id, command);
      return {
        ok: true,
        terminal_id: id,
        source: target.label,
        cwd: target.path,
        note: 'Rodando no terminal do Orkestral (visível na IDE). O preview abre quando a URL do dev server for detectada. Depois use capture_preview pra tirar o print.',
      };
    }

    case 'capture_preview': {
      const sources = sourceRepo.listByWorkspace(workspaceId);
      const wantLabel = String(args.source ?? '')
        .trim()
        .toLowerCase();
      const target = wantLabel
        ? sources.find((s) => s.label.toLowerCase() === wantLabel)
        : (sources.find((s) => s.isPrimary) ?? sources[0]);
      let url = String(args.url ?? '').trim();
      if (!url && target) url = getLastUrlForSource(target.id) ?? '';
      if (!url) {
        return {
          ok: false,
          reason:
            'Nenhuma URL de dev server detectada ainda. Rode run_in_orkestral_terminal (ex.: npm run dev), aguarde subir, e tente de novo — ou passe `url`.',
        };
      }
      const waitMs = Number(args.wait_ms ?? 1500);
      const outPath = join(tmpdir(), `orkestral-preview-${Date.now()}.png`);
      await captureUrlToPng(url, outPath, waitMs);
      return { ok: true, path: outPath, url };
    }

    case 'approve_and_execute_plan': {
      let epicId = String(args.epic_id ?? '').trim();
      if (!epicId && sessionId) {
        epicId = findPendingPlanEpicId(workspaceId, sessionId) ?? '';
      }
      if (!epicId) {
        return {
          ok: false,
          reason:
            'Nenhum plano pendente de aprovação nesta conversa. Crie um com create_issue_plan ou passe epic_id.',
        };
      }
      const res = decidePlan({ epicIssueId: epicId, decision: 'approve' });
      return { ok: true, approved: true, executed: res.executed, epic_id: epicId };
    }

    case 'code_search': {
      const q = String(args.query ?? '').trim();
      if (!q) throw new Error('query é obrigatório');
      const sources = sourceRepo.listByWorkspace(workspaceId);
      if (sources.length === 0) throw new Error('Nenhum source anexado ao workspace');
      const wantLabel = String(args.source ?? '')
        .trim()
        .toLowerCase();
      const target = wantLabel
        ? sources.find((s) => s.label.toLowerCase() === wantLabel)
        : (sources.find((s) => s.isPrimary) ?? sources[0]);
      if (!target?.path || !existsSync(target.path)) {
        throw new Error(
          wantLabel
            ? `Source "${args.source}" não encontrado ou sem path local`
            : 'Nenhum source com path local neste workspace',
        );
      }
      const rawLimit = (args.limit as number | undefined) ?? 6;
      const limit = Math.min(Math.max(1, rawLimit), 20);
      const res = warpGrepSearch(target.path, q, { maxResults: limit });
      return {
        source: target.label,
        keywords: res.keywords,
        scanned: res.scanned,
        results: res.hits.map((h) => ({
          file: h.file,
          score: h.score,
          matches: h.matches.map((m) => `${m.line}: ${m.text}`),
        })),
      };
    }

    case 'add_issue_dependency': {
      const blockerKey = args.blocker_issue_key as number;
      const blockedKey = args.blocked_issue_key as number;
      const all = issueRepo.listByWorkspace(workspaceId);
      const blocker = all.find((i) => i.issueKey === blockerKey);
      const blocked = all.find((i) => i.issueKey === blockedKey);
      if (!blocker) throw new Error(`Issue ${blockerKey} não encontrada`);
      if (!blocked) throw new Error(`Issue ${blockedKey} não encontrada`);
      // addDependency rejeita ciclo (mesma proteção do caminho create_issue_plan).
      relationsRepo.addDependency(workspaceId, blocker.id, blocked.id);
      broadcastIssuesChanged(workspaceId, 'add_issue_dependency');
      return { ok: true, blocker: blockerKey, blocked: blockedKey };
    }

    case 'edit_file': {
      const relPath = String(args.path ?? '').trim();
      const codeEdit = String(args.code_edit ?? '');
      if (!relPath || !codeEdit.trim()) throw new Error('path e code_edit são obrigatórios');
      const sources = sourceRepo.listByWorkspace(workspaceId);
      const wantLabel = String(args.source ?? '')
        .trim()
        .toLowerCase();
      const target = wantLabel
        ? sources.find((s) => s.label.toLowerCase() === wantLabel)
        : (sources.find((s) => s.isPrimary) ?? sources[0]);
      if (!target?.path || !existsSync(target.path)) {
        throw new Error(
          wantLabel
            ? `Source "${args.source}" não encontrado ou sem path local`
            : 'Nenhum source com path local neste workspace',
        );
      }
      return await fastApplyEditFile({
        repoPath: target.path,
        relPath,
        codeEdit,
        instructions: typeof args.instructions === 'string' ? args.instructions : undefined,
        workspaceId,
        runId: traceContext?.runId ?? null,
        issueId: traceContext?.issueId ?? null,
      });
    }

    case 'get_workspace_info': {
      const ws = workspaceRepo.listAll().find((w) => w.id === workspaceId);
      if (!ws) throw new Error('Workspace não encontrado');
      return {
        name: ws.name,
        companyName: ws.companyName,
        mission: ws.mission,
        objectives: ws.objectives,
        // Objetivos ativos (entidades Goal) — o norte do trabalho. Cada um traz
        // progresso derivado das issues vinculadas. Use create_issue com
        // goal_id pra ligar trabalho novo a um objetivo.
        goals: goalRepo
          .listByWorkspace(workspaceId)
          .filter((g) => g.status === 'active')
          .map((g) => ({
            id: g.id,
            title: g.title,
            description: g.description,
            progress: g.progress,
          })),
        path: ws.path,
        planMode: ws.planMode,
      };
    }

    case 'create_goal': {
      const title = String(args.title ?? '').trim();
      if (!title) throw new Error('Objetivo precisa de um título.');
      const description =
        typeof args.description === 'string' && args.description.trim()
          ? args.description.trim()
          : null;
      const dueDate =
        typeof args.due_date === 'string' && args.due_date.trim() ? args.due_date : null;
      const tokenBudget =
        typeof args.token_budget === 'number' && args.token_budget > 0
          ? Math.floor(args.token_budget)
          : null;
      const goal = goalRepo.create({ workspaceId, title, description, dueDate, tokenBudget });
      broadcastIssuesChanged(workspaceId, 'create_goal');
      return { goal_id: goal.id, title: goal.title };
    }

    case 'update_goal_status': {
      const goalId = String(args.goal_id ?? '');
      const status = args.status as 'active' | 'achieved' | 'archived';
      const goal = goalRepo.get(goalId);
      if (!goal || goal.workspaceId !== workspaceId)
        throw new Error(`Objetivo ${goalId} não encontrado`);
      const updated = goalRepo.update(goalId, { status });
      broadcastIssuesChanged(workspaceId, 'update_goal_status');
      return { ok: true, goalId, status: updated.status };
    }

    // ---------- Knowledge Base ----------
    case 'kb_search': {
      const q = String(args.query ?? '').trim();
      if (!q) return [];
      // Cap o limit pra evitar varredura/serialização gigante que poderia
      // travar o handler síncrono no main thread do Electron.
      const rawLimit = (args.limit as number | undefined) ?? 10;
      const limit = Math.min(Math.max(1, rawLimit), 50);
      return kbSearchPages(workspaceId, q, limit, {
        kinds: Array.isArray(args.kinds) ? (args.kinds as KbPageKind[]) : undefined,
        sourceId: typeof args.source_id === 'string' ? args.source_id : undefined,
        requireUsage: args.require_usage === true,
        minScore: typeof args.min_score === 'number' ? args.min_score : undefined,
      });
    }

    case 'kb_get_page': {
      const ref = String(args.page_id ?? '').trim();
      if (!ref) throw new Error('page_id é obrigatório');
      // Tenta UUID (escopado no workspace), depois slug. getScoped impede um
      // agente do workspace A de ler páginas do workspace B passando o UUID.
      let page = kbPageRepo.getScoped(workspaceId, ref);
      if (!page) page = kbPageRepo.getBySlug(workspaceId, ref);
      if (!page) throw new Error(`Página "${ref}" não encontrada`);
      const backlinks = kbLinkRepoMcp.backlinksToPage(page.id);
      return {
        id: page.id,
        title: page.title,
        slug: page.slug,
        kind: page.kind,
        contentMd: page.contentMd ?? '',
        parentId: page.parentId,
        backlinks: backlinks.map((b) => ({
          title: b.sourcePageTitle,
          slug: b.sourcePageSlug,
        })),
      };
    }

    case 'kb_get_page_tree': {
      const tree = kbPageRepo.tree(workspaceId);
      // Cap defensivo: uma KB enorme serializada inteira (síncrono no main
      // thread) poderia travar o handler. Limita o total de nós retornados.
      const MAX_TREE_NODES = 2000;
      const out: unknown[] = [];
      let truncated = false;
      const flatten = (nodes: typeof tree, depth = 0): void => {
        for (const n of nodes) {
          if (out.length >= MAX_TREE_NODES) {
            truncated = true;
            return;
          }
          out.push({
            id: n.id,
            slug: n.slug,
            title: n.title,
            depth,
            kind: n.kind,
            descendantCount: n.descendantCount,
          });
          flatten(n.children, depth + 1);
        }
      };
      flatten(tree);
      if (truncated) {
        out.push({
          note: `árvore truncada em ${MAX_TREE_NODES} nós — use kb_search pra encontrar páginas específicas.`,
        });
      }
      return out;
    }

    case 'kb_get_backlinks': {
      const pageId = String(args.page_id ?? '').trim();
      if (!pageId) throw new Error('page_id é obrigatório');
      // Escopado no workspace pra não vazar backlinks de outro workspace.
      let page = kbPageRepo.getScoped(workspaceId, pageId);
      if (!page) page = kbPageRepo.getBySlug(workspaceId, pageId);
      if (!page) throw new Error(`Página "${pageId}" não encontrada`);
      return kbLinkRepoMcp.backlinksToPage(page.id);
    }

    case 'kb_create_page': {
      const title = String(args.title ?? '').trim();
      const content = String(args.content_md ?? '').trim();
      if (!title) throw new Error('title é obrigatório');
      if (!content) throw new Error('content_md é obrigatório');
      let parentId: string | null = null;
      let inheritedSourceId: string | null = null;
      const parentRef = args.parent_page_id as string | undefined;
      if (parentRef) {
        // Escopado: não deixar anexar uma página nova sob um parent de outro workspace.
        let parent = kbPageRepo.getScoped(workspaceId, parentRef);
        if (!parent) parent = kbPageRepo.getBySlug(workspaceId, parentRef);
        if (!parent) throw new Error(`Parent page "${parentRef}" não encontrada`);
        parentId = parent.id;
        inheritedSourceId = parent.sourceId ?? null;
      } else {
        // Auto-parent: se o título tem sufixo "— <source.label>" e existe
        // root "Repo: <label>" no workspace, anexa automaticamente. Evita o
        // problema do agente esquecer parent_page_id e a página ficar órfã
        // como root paralela na sidebar.
        const sources = sourceRepo.listByWorkspace(workspaceId);
        for (const src of sources) {
          // matchea " — ezchat-backend" (em-dash ou hyphen) no fim do título
          const suffixRegex = new RegExp(`[—-]\\s*${escapeRegex(src.label)}\\s*$`, 'i');
          if (!suffixRegex.test(title)) continue;
          const rootSlug = kbSlugify(`Repo: ${src.label}`);
          const rootPage = kbPageRepo.getBySlug(workspaceId, rootSlug);
          if (rootPage && rootPage.id !== undefined) {
            parentId = rootPage.id;
            inheritedSourceId = rootPage.sourceId ?? src.id;
            console.log(
              `[kb_create_page] auto-parent: "${title}" → "${rootPage.title}" (${src.label})`,
            );
            break;
          }
        }
      }
      const sourceId =
        typeof args.source_id === 'string' && args.source_id.trim()
          ? args.source_id.trim()
          : inheritedSourceId;
      const kind =
        (args.kind as 'doc' | 'agent-memory' | 'auto-generated' | undefined) ?? 'agent-memory';

      // Dedupe — agentes às vezes criam "Visão geral" e "Visão Geral" (só
      // capitalização diferente). Slug normaliza ambos pra `visao-geral`.
      // Se já existe NO MESMO ESCOPO, ATUALIZAMOS o conteúdo em vez de criar
      // duplicata. Nunca mescla "Overview" de backend com "Overview" de frontend.
      // O `kbServiceUpdatePage` cuida de reindexação BM25 + rebuild BKF.
      const normalizedTitle = kbSlugify(title);
      const existing = kbPageRepo.listByWorkspace(workspaceId, true).find((page) => {
        if (kbSlugify(page.title) !== normalizedTitle) return false;
        if ((page.parentId ?? null) !== parentId) return false;
        if (sourceId) return (page.sourceId ?? sourceId) === sourceId;
        return true;
      });
      const updated = existing
        ? kbServiceUpdatePage({
            pageId: existing.id,
            patch: {
              contentMd: content,
              sourceId,
              // Atualiza o parent só se o agente passou explicitamente
              ...(parentRef ? { parentId } : {}),
            },
          })
        : null;
      // `updated` null = a página existente sumiu no meio (race com a limpeza da
      // análise). Em vez de quebrar, cai pro caminho de CRIAÇÃO abaixo (recria).
      if (existing && updated) {
        try {
          syncWorkspaceTeamForSources(workspaceId, 'kb-page-updated');
        } catch (err) {
          console.warn('[kb_create_page] sync do time apos update falhou:', err);
        }
        broadcastIssuesChanged(workspaceId, 'kb_create_page');
        return {
          ok: true,
          id: updated.id,
          slug: updated.slug,
          title: updated.title,
          merged: true,
          note: 'Página já existia com mesmo título — conteúdo foi mesclado em vez de criar duplicata.',
        };
      }

      // Usa o kb-service em vez do repo direto: ele cuida de indexação BM25,
      // sync de links e regeneração debounced do snapshot BKF.
      const page = kbServiceCreatePage({
        workspaceId,
        title,
        parentId,
        kind,
        contentMd: content,
        sourceId,
      });
      try {
        syncWorkspaceTeamForSources(workspaceId, 'kb-page-created');
      } catch (err) {
        console.warn('[kb_create_page] sync do time apos create falhou:', err);
      }
      broadcastIssuesChanged(workspaceId, 'kb_create_page');
      return { ok: true, id: page.id, slug: page.slug, title: page.title };
    }

    case 'kb_link_pages': {
      const sourceRef = String(args.source_page_id ?? '').trim();
      const targetRef = String(args.target_page_id ?? '').trim();
      if (!sourceRef || !targetRef) {
        throw new Error('source_page_id e target_page_id são obrigatórios');
      }
      // Escopado: linkar só dentro do próprio workspace (sem cross-workspace).
      const source =
        kbPageRepo.getScoped(workspaceId, sourceRef) ??
        kbPageRepo.getBySlug(workspaceId, sourceRef);
      const target =
        kbPageRepo.getScoped(workspaceId, targetRef) ??
        kbPageRepo.getBySlug(workspaceId, targetRef);
      if (!source) {
        throw new Error(
          `Source page "${sourceRef}" não existe. Crie a página primeiro com kb_create_page, ` +
            `ou consulte kb_get_page_tree pra ver as páginas disponíveis.`,
        );
      }
      if (!target) {
        throw new Error(
          `Target page "${targetRef}" não existe. Crie a página alvo antes do link, ` +
            `ou use kb_search pra encontrar uma página existente com título similar.`,
        );
      }
      const existing = kbLinkRepoMcp.listForPage(source.id);
      // Adiciona o novo link mantendo os existentes
      const links = [
        ...existing.map((l) => ({
          targetKind: l.targetKind,
          targetId: l.targetId,
          targetLabel: l.targetLabel,
          targetUrl: l.targetUrl,
        })),
        {
          targetKind: 'page' as const,
          targetId: target.id,
          targetLabel: (args.label as string) ?? target.title,
        },
      ];
      kbLinkRepoMcp.setLinksForPage(workspaceId, source.id, links);
      return { ok: true, source: source.title, target: target.title };
    }

    case 'session_search': {
      const q = String(args.query ?? '').trim();
      if (!q) throw new Error('query é obrigatório');
      const rawLimit = (args.limit as number | undefined) ?? 6;
      const hits = searchSessions(workspaceId, q, Math.min(Math.max(1, rawLimit), 20));
      return hits.map((h) => ({
        session: h.title,
        role: h.role,
        when: h.createdAt,
        snippet: h.snippet,
      }));
    }

    case 'get_user_profile': {
      const ws = workspaceRepo.listAll().find((w) => w.id === workspaceId);
      return { userProfile: ws?.userProfile ?? '' };
    }

    case 'update_user_profile': {
      const content = String(args.content ?? '').trim();
      if (!content) throw new Error('content é obrigatório');
      if (content.length > 4000)
        throw new Error('content longo demais (máx ~4000 chars) — resuma o que importa');
      const ws = workspaceRepo.listAll().find((w) => w.id === workspaceId);
      if (!ws) throw new Error('Workspace não encontrado');
      const mode = args.mode === 'replace' ? 'replace' : 'append';
      const current = (ws.userProfile ?? '').trim();
      let next = mode === 'replace' ? content : `${current}\n- ${content}`.trim();
      // Cap do perfil: mantém o RECENTE (o que foi anexado agora sobrevive) e
      // descarta o topo; corta em borda de linha pra não deixar linha parcial.
      if (next.length > 8000) {
        next = next.slice(next.length - 8000);
        const nl = next.indexOf('\n');
        if (nl > 0) next = next.slice(nl + 1);
      }
      workspaceRepo.setUserProfile(workspaceId, next);
      return { ok: true, mode };
    }

    // ---------- Skills (auto-curadoria) ----------
    case 'skill_list': {
      return skillRepoMcp
        .listByWorkspace(workspaceId)
        .filter((s) => s.kind === 'instruction' && s.state === 'active')
        .map((s) => ({
          name: s.name,
          slug: s.slug,
          description: s.description,
          createdBy: s.createdBy,
        }));
    }

    case 'skill_view': {
      const ref = String(args.name ?? '')
        .trim()
        .toLowerCase();
      if (!ref) throw new Error('name é obrigatório');
      const skill = skillRepoMcp
        .listByWorkspace(workspaceId)
        .find((s) => s.name.toLowerCase() === ref || s.slug.toLowerCase() === ref);
      if (!skill)
        throw new Error(
          `Skill "${args.name}" não encontrada (use skill_list pra ver as disponíveis)`,
        );
      skillRepoMcp.bumpUse(skill.id);
      return {
        name: skill.name,
        slug: skill.slug,
        description: skill.description,
        content: skill.content,
      };
    }

    case 'skill_create': {
      const name = String(args.name ?? '').trim();
      const content = String(args.content ?? '').trim();
      if (!name || !content) throw new Error('name e content são obrigatórios');
      if (name.length > 100)
        throw new Error('name muito longo (máx ~100 chars) — use um nome curto e imperativo');
      // Guarda anti-lixo: skills são playbooks curtos, não despejos de arquivo.
      if (content.length > 8000)
        throw new Error('content longo demais p/ uma skill (máx ~8000 chars) — resuma o playbook');
      const created = skillRepoMcp.create({
        workspaceId,
        name,
        kind: 'instruction',
        description: (args.description as string) ?? null,
        content,
        createdBy: 'agent',
      });
      // Auto-attach a todos os agentes do workspace (o time inteiro aprende),
      // mesmo padrão do marketplace:install pra skills de instrução.
      for (const a of agentRepo.listByWorkspace(workspaceId)) skillRepoMcp.attach(a.id, created.id);
      return { ok: true, slug: created.slug, name: created.name };
    }

    case 'skill_improve': {
      const ref = String(args.name ?? '')
        .trim()
        .toLowerCase();
      const content = String(args.content ?? '').trim();
      // Sem args: skip suave (não erro vermelho repetido). O agente recompõe.
      if (!ref || !content) {
        return {
          ok: false,
          skipped: 'missing_args',
          hint: 'Para registrar aprendizado: passe `name` (a skill) e `content` (o que aprendeu). Se a skill não existe ainda, eu a crio.',
        };
      }
      const skill = skillRepoMcp
        .listByWorkspace(workspaceId)
        .find((s) => s.name.toLowerCase() === ref || s.slug.toLowerCase() === ref);
      // Fallback gracioso: improve numa skill inexistente = CRIAR (o agente claramente
      // quer capturar o aprendizado). Some o spiral "Skill não encontrada".
      if (!skill) {
        if (content.length > 8000)
          throw new Error(
            'content longo demais p/ uma skill (máx ~8000 chars) — resuma o playbook',
          );
        const created = skillRepoMcp.create({
          workspaceId,
          name: String(args.name ?? '').trim(),
          kind: 'instruction',
          description: (args.description as string) ?? null,
          content,
          createdBy: 'agent',
        });
        for (const a of agentRepo.listByWorkspace(workspaceId))
          skillRepoMcp.attach(a.id, created.id);
        return { ok: true, created: true, slug: created.slug, name: created.name };
      }
      // Protege skills do usuário/marketplace (como o pinning do Hermes).
      if (skill.createdBy !== 'agent') {
        throw new Error(
          `Skill "${skill.name}" foi instalada pelo usuário/marketplace e é protegida — não pode ser alterada por aqui.`,
        );
      }
      const mode = args.mode === 'replace' ? 'replace' : 'append';
      const merged = mode === 'replace' ? content : `${skill.content.trim()}\n\n${content}`.trim();
      if (merged.length > 8000) throw new Error('skill ficaria longa demais (máx ~8000 chars)');
      skillRepoMcp.update(skill.id, { content: merged });
      skillRepoMcp.bumpUse(skill.id);
      return { ok: true, slug: skill.slug, mode };
    }

    case 'approval_prompt': {
      // Gate de permissão do claude CLI (`--permission-prompt-tool`): o TEXTO
      // retornado É o protocolo — JSON `{behavior:'allow'|'deny'}` que o CLI
      // parseia (o dispatcher stringifica este objeto). Este case NUNCA lança:
      // o catch do dispatcher embrulha erros em prosa e o CLI, sem conseguir
      // parsear, negaria mudo. `requestApproval` nega sozinho no timeout.
      if (!hasApprover()) {
        return { behavior: 'deny', message: 'Nenhum aprovador interativo disponível.' };
      }
      const toolInput = (args.input as Record<string, unknown>) ?? {};
      const allow = await requestApproval({
        id: randomUUID(),
        toolName: String(args.tool_name ?? ''),
        input: toolInput,
        // Sessão do run (header x-orkestral-session) — o REPL só mostra o
        // prompt de pedidos da PRÓPRIA sessão (ou sem sessão identificada).
        sessionId: sessionId ?? null,
      });
      return allow
        ? { behavior: 'allow', updatedInput: toolInput }
        : { behavior: 'deny', message: 'Usuário negou a ação no REPL do Orkestral.' };
    }

    default:
      throw new Error(`Tool desconhecida: ${name}`);
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Compara o token do header com o segredo do server em tempo constante.
 *  Recusa header ausente/array (só string única vale). */
function tokenIsValid(headerToken: string | string[] | undefined): boolean {
  if (!serverToken || typeof headerToken !== 'string') return false;
  const provided = Buffer.from(headerToken);
  const expected = Buffer.from(serverToken);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** Rejeita requests com Origin de browser (defesa barata contra DNS-rebinding:
 *  uma página web sempre manda Origin; clientes MCP/CLI locais não). */
function hasBrowserOrigin(req: IncomingMessage): boolean {
  const origin = req.headers['origin'];
  return typeof origin === 'string' && origin.trim() !== '';
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  // Defesa anti DNS-rebinding: nenhum cliente MCP/CLI local manda Origin; uma
  // página web sempre manda. Recusa antes de tocar no token.
  if (hasBrowserOrigin(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden origin' }));
    return;
  }
  // Token + workspaceId via headers (token previne acesso de processos não-Orkestral).
  // Compare em tempo constante (o token é o único segredo que protege toda mutação).
  if (!tokenIsValid(req.headers['x-orkestral-token'])) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  const workspaceId = req.headers['x-orkestral-workspace'];
  if (typeof workspaceId !== 'string' || !workspaceId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'x-orkestral-workspace header missing' }));
    return;
  }
  // Isolamento de workspace: o token é process-wide, então o header de workspace
  // sozinho permitiria ler/escrever QUALQUER workspace trocando um header. Quando
  // o caller se identifica (x-orkestral-agent-id), validamos que esse agente
  // pertence ao workspace pedido — bloqueia acesso cross-workspace via header. Pra
  // tools MUTANTES o agent-id é OBRIGATÓRIO (gate em handleMethod): aqui resolvemos
  // o agente uma vez e derivamos a role pra o scoping por agente.
  const agentIdHeader = req.headers['x-orkestral-agent-id'];
  let agentRole: AgentToolRole | undefined;
  if (typeof agentIdHeader === 'string' && agentIdHeader) {
    const agent = agentRepo.get(agentIdHeader);
    if (!agent || agent.workspaceId !== workspaceId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent does not belong to workspace' }));
      return;
    }
    agentRole = classifyAgentToolRole(agent);
  }
  // Sessão de chat de origem (opcional): presente só em run de chat. Permite o
  // create_issue gravar metadata.originSessionId (painel de Progresso + report).
  const sessionHeader = req.headers['x-orkestral-session'];
  const sessionId = typeof sessionHeader === 'string' && sessionHeader ? sessionHeader : undefined;
  const readHeader = (name: string): string | undefined => {
    const value = req.headers[name];
    return typeof value === 'string' && value ? value : undefined;
  };
  const traceContext: ToolTraceContext = {
    runId: readHeader('x-orkestral-run'),
    issueId: readHeader('x-orkestral-issue-id'),
    issueKey: readHeader('x-orkestral-issue-key'),
    agentId: readHeader('x-orkestral-agent-id'),
    agentName: readHeader('x-orkestral-agent-name'),
    parentId: readHeader('x-orkestral-trace-parent'),
    agentRole,
  };

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, server: 'orkestral-mcp' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  readBody(req)
    .then(async (raw) => {
      let body: JsonRpcRequest | JsonRpcRequest[];
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')));
        return;
      }
      const requests = Array.isArray(body) ? body : [body];
      const responses: JsonRpcResponse[] = [];
      for (const r of requests) {
        try {
          const result = await handleMethod(
            workspaceId,
            r.method,
            r.params,
            sessionId,
            traceContext,
          );
          if (r.id !== undefined && r.id !== null) {
            responses.push({ jsonrpc: '2.0', id: r.id, result });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          responses.push(jsonRpcError(r.id ?? null, -32000, msg));
        }
      }
      // SSE-style stream HTTP (MCP HTTP transport)
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      });
      const out =
        responses.length === 0
          ? ''
          : Array.isArray(body)
            ? JSON.stringify(responses)
            : JSON.stringify(responses[0]);
      res.end(out);
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(null, -32603, msg)));
    });
}

/**
 * Sobe o servidor uma única vez no boot do app. Idempotente: chamadas
 * subsequentes recebem a mesma Promise resolvida.
 */
export function ensureMcpServerStarted(): Promise<{ port: number; token: string }> {
  if (startingPromise) return startingPromise;
  startingPromise = new Promise((resolve, reject) => {
    try {
      const server = createServer(handleRequest);
      serverToken = randomBytes(24).toString('hex');
      server.on('error', (err) => {
        console.error('[mcp] server error:', err);
        reject(err);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          serverPort = addr.port;
          console.log(`[mcp] Orkestral MCP server ouvindo em http://127.0.0.1:${serverPort}/`);
          resolve({ port: serverPort, token: serverToken! });
        } else {
          reject(new Error('endereço inválido após listen'));
        }
      });
    } catch (err) {
      reject(err);
    }
  });
  return startingPromise;
}

export function getMcpServerInfo(): { port: number; token: string } | null {
  if (!serverPort || !serverToken) return null;
  return { port: serverPort, token: serverToken };
}
