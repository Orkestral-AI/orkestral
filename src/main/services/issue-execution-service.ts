/**
 * Executa uma issue rodando o agente atribuído como subprocesso Claude.
 *
 * Pipeline:
 *   1. Lê issue + agente assignee
 *   2. Cria IssueRun em status='running' + atualiza issue.status='in_progress'
 *   3. Sobe MCP server local + escreve mcp-config dedicado
 *   4. Determina cwd: se issue.metadata.kind='kb-analysis', usa source.path;
 *      caso contrário, usa workspace primary source path.
 *   5. Monta prompt = AGENTS.md do agente + contexto + description da issue
 *   6. Spawn `claude --print --mcp-config --output-format stream-json …`
 *   7. Stream output → adiciona comentário automático ao terminar (resumo)
 *   8. Status final: success → done; failure → blocked + error_message
 *
 * Cancelável via `cancelIssueExecution(issueId)`.
 *
 * Broadcasta eventos `issue:execution-event` durante o ciclo pra UI mostrar
 * progresso live.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

import { broadcast } from '../platform/host';

import { join } from 'node:path';

import { IssueRepository } from '../db/repositories/issue.repo';
import { WorkspaceRepository } from '../db/repositories/workspace.repo';
import { IssueRelationsRepository } from '../db/repositories/issue-relations.repo';
import { AgentRepository } from '../db/repositories/agent.repo';
import { GoalRepository } from '../db/repositories/routine-goal.repo';
import { WorkspaceSourceRepository } from '../db/repositories/workspace-source.repo';
import { SettingsRepository } from '../db/repositories/settings.repo';
import {
  ensureDefaultInstructions,
  modelFamilyGuidance,
  readRuntimeInstructionContext,
  UI_QUALITY_PROTOCOL,
} from './agent-instructions';
import { trace } from './log-bus';
import { mt } from '../i18n';
import { getSmartExecConfig, referencePricingForModel } from './smart-exec/config';
import { runSmartExecution } from './smart-exec/orchestrator';
import { validateForgeOutput } from './engine-v2/validate-output';
import { classifyIssue, isPlanningIssue } from './smart-exec/classifier';
import { runOpenClawGateway } from './openclaw-client';
import { runCursorCloud } from './cursor-cloud-client';
import {
  appendSyntheticAgentTool,
  postAgentMessageToSession,
  buildMcpConfigForRun,
  modelScopeForAgent,
  codexMcpArgs,
  globalAgentDirective,
  buildSourcesContextBlock,
  emitSyntheticAgentPhase,
  finishSyntheticAgentStream,
  startSyntheticAgentStream,
  requestPlanCompletionReport,
  requestPlanReplanning,
  requestSubEpicPlanTurn,
} from './chat-service';
import { SkillRepository } from '../db/repositories/skill.repo';
import { recordExecutionLearning, getRelevantLearnings } from './kb-learning';
import { KbPageRepository } from '../db/repositories/kb-page.repo';
import { maybeReviewForSkill } from './skill-review';
import { decideLocalEscalation } from './model-routing-policy';
import { applyProviderApiKey } from './provider-auth';
import { ensureBundledSkills } from './bundled-skills';
import { buildMultiAgentInstructions, startMultiAgentRun } from './multi-agent-orchestrator';
import { isUnavailableExecAdapter, unavailableAdapterMessage } from './adapter-availability';
import {
  resolveSpawnPolicy,
  applyClaudePolicy,
  applyClaudeEffort,
  resolveReasoningEffort,
  applyCodexPolicy,
  scrubSpawnEnv,
  declaredEnvKeys,
} from './spawn-policy';
import { execStatsRepo, computeCounterfactualSavedUsd } from '../db/repositories/exec-stats.repo';
import { forgeEditExamplesRepo } from '../db/repositories/forge-edit-examples.repo';
import { maybeAutoVerifyGoal, maybeRequestGoalConvergence } from './goal-verification-service';
import { IssueExecutionEventRepository } from '../db/repositories/issue-execution-event.repo';
import { gitCombinedDiff, gitDiff, gitStatus } from './git-service';
import { createIssueChangeSnapshot, readIssueChangeSnapshot } from './issue-change-snapshot';
import { finishAgentTraceStep, recordAgentTraceStep, startAgentTraceStep } from './agent-trace';
import {
  firstRunnablePlanIssue,
  isReviewLikeIssue,
  isSubEpicIssue,
  nextRunnablePlanIssue,
  orderPlanChildren,
  runnablePlanIssueWave,
} from './issue-plan-sequencing';
import { decideReviewRun } from './issue-review-routing';
import { ensureSourceFresh } from './source-freshness-service';
import { canReplan, shouldForcePremiumReplan } from './issue-replanning';
import { shouldAnnouncePreview } from './preview-manager';
import {
  beginQaValidation,
  findQaAgent,
  getLatestQaValidation,
  isQaAgent,
  renderQaRuntimeBlock,
} from './qa-validation-service';
import { randomUUID } from 'node:crypto';
import type {
  Issue,
  AdapterType,
  WorkspaceSource,
  Agent,
  AgentRuntimeConfig,
  TaskRisk,
  IssueExecutionEvent,
  IssueVerificationState,
  ExecutionCheckbox,
} from '../../shared/types';

const issueRepo = new IssueRepository();
const relationsRepo = new IssueRelationsRepository();
const agentRepo = new AgentRepository();
const goalRepo = new GoalRepository();
const sourceRepo = new WorkspaceSourceRepository();
const skillRepo = new SkillRepository();
const settingsRepo = new SettingsRepository();
const issueExecutionEventRepo = new IssueExecutionEventRepository();

const TASK_RISK_RANK: Record<TaskRisk, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

function isTaskRiskAllowed(risk: TaskRisk, maxRisk: TaskRisk): boolean {
  return TASK_RISK_RANK[risk] <= TASK_RISK_RANK[maxRisk];
}

/**
 * Adapters que suportam execução de issue. CLIs locais rodam via spawn;
 * openclaw_gateway (WebSocket RPC) e cursor_cloud (cliente de rede) rodam via
 * cliente Node dedicado mais abaixo.
 */
const ISSUE_EXEC_ADAPTERS: AdapterType[] = [
  'claude_local',
  'codex_local',
  'orkestral_local',
  // gemini_local / opencode_local / pi_local / grok_local ficam FORA: ainda não
  // têm integração de execução real (antes caíam silenciosamente no Claude).
  // Permanecem visíveis no registry/onboarding, mas não executam issues.
  'cursor_local',
  'openclaw_gateway',
  'cursor_cloud',
];

function isIssueExecAdapter(t: AdapterType | null | undefined): t is AdapterType {
  return !!t && ISSUE_EXEC_ADAPTERS.includes(t);
}

interface ActiveRun {
  issueId: string;
  /** Subprocesso do CLI (Claude/Codex). Ausente em runs de rede/Forge. */
  child?: ChildProcess;
  /** Cancela um run de rede (openclaw/cursor) ou Forge sem subprocesso. */
  abort?: AbortController;
  runId: string;
  cancelled: boolean;
}

interface IssueChangeFileSummary {
  path: string;
  additions: number;
  deletions: number;
}

interface IssueChangeSummary {
  sourceId: string;
  sourceLabel: string;
  issueId: string;
  issueKey: number;
  issueTitle: string;
  snapshotId?: string;
  files: IssueChangeFileSummary[];
  additions: number;
  deletions: number;
}
const activeRuns = new Map<string, ActiveRun>();

// Workspaces com a execução HALTED pelo botão de parar (stop global). Enquanto
// halted, NENHUM run novo inicia (executeIssue/maybeAutoExecuteIssue retornam cedo) —
// impede que cancelar um run em cascata re-dispare o próximo do plano. Limpa quando o
// usuário manda uma nova mensagem (sendMessage chama clearExecutionHalt).
const haltedWorkspaces = new Set<string>();

export function isExecutionHalted(workspaceId: string): boolean {
  return haltedWorkspaces.has(workspaceId);
}

export function clearExecutionHalt(workspaceId: string): void {
  haltedWorkspaces.delete(workspaceId);
}

/**
 * STOP GLOBAL: para TUDO no workspace agora — mata todos os runs ativos (SIGTERM→
 * SIGKILL via cancelIssueExecution), limpa a fila e HALTA o auto-avanço do plano. O
 * halt é setado ANTES de cancelar pra a cascata de 'close' não re-disparar o próximo.
 * Limpa-se na próxima mensagem do usuário. Retorna quantos runs foram cancelados.
 */
export function stopAllExecution(workspaceId: string): { cancelled: number } {
  haltedWorkspaces.add(workspaceId);
  let cancelled = 0;
  const inWs = (issueId: string): boolean => issueRepo.get(issueId)?.workspaceId === workspaceId;
  // Fila primeiro (jobs ainda não iniciados), depois os ativos (mata os processos).
  for (const job of [...runQueue]) {
    if (inWs(job.issueId) && cancelIssueExecution(job.issueId)) cancelled += 1;
  }
  for (const active of [...activeRuns.values()]) {
    if (inWs(active.issueId) && cancelIssueExecution(active.issueId)) cancelled += 1;
  }
  return { cancelled };
}

interface IssueChatMirror {
  issueId: string;
  runId: string;
  sessionId: string;
}

const activeIssueChatMirrors = new Map<string, IssueChatMirror>();
const completedIssueChatMirrors = new Set<string>();

/**
 * Fila global de execução. Criar uma épica + N sub-issues disparava N execuções
 * em paralelo — cada uma sobe um CLI premium (claude) e/ou carrega o modelo
 * local, estourando RAM/CPU e TRAVANDO a máquina. Agora permitimos até
 * MAX_CONCURRENT_RUNS runs SIMULTÂNEOS, com dois gates de segurança:
 *   (a) no MESMO source/workspace, no máx. SOURCE_MAX_CONCURRENT runs ao mesmo
 *       tempo (as issues de um plano são particionadas por arquivo, então
 *       paralelismo moderado no mesmo repo é seguro; serializar em 1 anulava o
 *       cap global no caso comum de plano single-repo);
 *   (b) o Orkestral Forge (orkestral_local) é um único processo de modelo local
 *       — fica ESTRITAMENTE serializado (no máx. 1 run Forge por vez).
 * Runs que não podem iniciar com segurança ficam na fila e tentamos o próximo
 * elegível.
 */
const MAX_CONCURRENT_RUNS = 8;
/**
 * Runs simultâneos no MESMO source/repo. As sub-issues de um plano são
 * particionadas por arquivo (files=/checklist), então rodar 3 em paralelo no
 * mesmo repo raramente colide — e destrava o caso comum (plano inteiro num
 * repo só), que antes serializava tudo em 1 e anulava o cap global.
 */
const SOURCE_MAX_CONCURRENT = 3;

/** Metadados de cada job na fila/ativo — usados pra gating de concorrência. */
interface QueuedRun {
  issueId: string;
  runId: string;
  rootTraceId: string;
  run: () => Promise<void>;
  /** Chave do source/workspace alvo — runs com a mesma chave nunca concorrem. */
  sourceKey: string;
  /** adapterType efetivo do agente — Forge (orkestral_local) é serializado. */
  adapterType: AdapterType;
}

let activeRunCount = 0;
const runQueue: QueuedRun[] = [];
/** Runs ATIVOS por source/workspace key — teto SOURCE_MAX_CONCURRENT por source. */
const activeSourceCounts = new Map<string, number>();
/** Há um run do Forge (orkestral_local) ativo? Mantém Forge serializado. */
let forgeActive = false;

/** Forge é serializado (1 por vez); demais adapters só dependem do sourceKey. */
function isForgeAdapter(t: AdapterType): boolean {
  return t === 'orkestral_local';
}

function adapterSessionName(adapter: AdapterType): string {
  switch (adapter) {
    case 'claude_local':
      return 'Claude Code';
    case 'codex_local':
      return 'Codex';
    case 'cursor_local':
    case 'cursor_cloud':
      return 'Cursor';
    case 'openclaw_gateway':
      return 'OpenClaw';
    case 'orkestral_local':
      return 'Forge local';
    default:
      return 'CLI premium';
  }
}

function sessionUsageImpact(
  adapter: AdapterType,
  tokensIn: number | null,
  tokensOut: number | null,
): string {
  if (adapter === 'orkestral_local') return 'Forge local · sessão premium preservada';
  const total = (tokensIn ?? 0) + (tokensOut ?? 0);
  const level =
    total >= 12_000 ? 'alto' : total >= 3_000 ? 'moderado' : total > 0 ? 'leve' : 'monitorado';
  return `uso ${level} da sessão ${adapterSessionName(adapter)}`;
}

function pumpRunQueue(): void {
  // Varre a fila procurando o PRÓXIMO job elegível (não necessariamente o 1º):
  // se o primeiro colide com um source ativo (ou é Forge com Forge ativo),
  // tentamos o seguinte. Para quando nenhum job restante é elegível ou o cap
  // global foi atingido.
  while (activeRunCount < MAX_CONCURRENT_RUNS && runQueue.length > 0) {
    const idx = runQueue.findIndex((q) => canStart(q));
    if (idx === -1) break; // nenhum job elegível agora — espera um ativo terminar
    const job = runQueue.splice(idx, 1)[0];
    activeRunCount += 1;
    activeSourceCounts.set(job.sourceKey, (activeSourceCounts.get(job.sourceKey) ?? 0) + 1);
    if (isForgeAdapter(job.adapterType)) forgeActive = true;
    void job.run().finally(() => {
      activeRunCount -= 1;
      const left = (activeSourceCounts.get(job.sourceKey) ?? 1) - 1;
      if (left <= 0) activeSourceCounts.delete(job.sourceKey);
      else activeSourceCounts.set(job.sourceKey, left);
      if (isForgeAdapter(job.adapterType)) forgeActive = false;
      pumpRunQueue();
    });
  }
}

/** Um job pode iniciar se o source dele tem vaga (< SOURCE_MAX_CONCURRENT) e (se Forge) não há Forge ativo. */
function canStart(job: QueuedRun): boolean {
  if ((activeSourceCounts.get(job.sourceKey) ?? 0) >= SOURCE_MAX_CONCURRENT) return false;
  if (isForgeAdapter(job.adapterType) && forgeActive) return false;
  return true;
}

function enqueueRun(job: QueuedRun): void {
  runQueue.push(job);
  pumpRunQueue();
}

/** Tokens distintivos de um source (label/role/repo/pasta), >=3 chars. */
function sourceTokens(s: WorkspaceSource): string[] {
  const raw = [s.label, s.role ?? '', s.repoFullName ?? '', s.path ?? ''].join(' ').toLowerCase();
  return [...new Set(raw.split(/[^a-z0-9]+/).filter((t) => t.length >= 3))];
}

/**
 * Resolve o source/repo ALVO de uma issue. Antes TUDO caía no source primário —
 * então toda issue rodava no MESMO repo (uma "Backend" rodava no diretório do
 * frontend!) e, dividindo o mesmo sourceKey, se serializavam mesmo sendo de repos
 * diferentes. Agora:
 *   1. `metadata.sourceId` explícito (ex.: kb-analysis) manda;
 *   2. senão, casa o source cujo token DISTINTIVO (único entre os sources, ex.:
 *      "backend"/"frontend"; "ezchat" é comum aos dois → ignorado) aparece no
 *      título+labels da issue. Só usa se o match for inequívoco (exatamente 1);
 *   3. fallback: primário (ou o primeiro).
 */
function resolveIssueSource(issue: Issue): WorkspaceSource | undefined {
  const sources = sourceRepo.listByWorkspace(issue.workspaceId);
  if (sources.length === 0) return undefined;
  const fallback = sources.find((s) => s.isPrimary) ?? sources[0];
  const meta = issue.metadata as { sourceId?: string } | null | undefined;
  if (meta?.sourceId) {
    const explicit = sources.find((s) => s.id === meta.sourceId);
    if (explicit) return explicit;
  }
  if (sources.length === 1) return fallback;

  // Frequência de cada token entre os sources → distintivo = aparece em 1 só.
  const freq = new Map<string, number>();
  const perSource = sources.map((s) => ({ s, toks: sourceTokens(s) }));
  for (const { toks } of perSource) for (const t of toks) freq.set(t, (freq.get(t) ?? 0) + 1);

  const hay = `${issue.title} ${issue.labels.join(' ')}`.toLowerCase();
  const matched = perSource.filter(({ toks }) =>
    toks.some((t) => freq.get(t) === 1 && hay.includes(t)),
  );
  return matched.length === 1 ? matched[0].s : fallback;
}

/**
 * CHECKPOINT de git por issue concluída (padrão Lovable/Cursor): commita o estado
 * do repo referenciando a issue — histórico navegável, rollback granular e diffs
 * ancorados por entrega, em vez de 30 arquivos soltos na working tree. Best-effort
 * e assíncrono: sem repo git, nada a commitar, git/identidade ausentes → silêncio.
 * --no-verify pra hooks do usuário (husky etc.) não travarem a finalização.
 */
function commitIssueCheckpoint(issue: Issue): void {
  const src = resolveIssueSource(issue);
  const repoPath = src?.path;
  if (!repoPath || !existsSync(join(repoPath, '.git'))) return;
  const title = issue.title.replace(/"/g, "'").slice(0, 72);
  const message = `${title} (Orkestral #${issue.issueKey})`;
  execFile('git', ['add', '-A'], { cwd: repoPath }, (addErr) => {
    if (addErr) return;
    execFile(
      'git',
      ['commit', '--no-verify', '-m', message],
      { cwd: repoPath },
      (commitErr, stdout) => {
        if (commitErr) return; // working tree limpa ou identidade não configurada
        trace({
          level: 'info',
          source: 'issue',
          scope: 'git-checkpoint',
          issueKey: issue.issueKey,
          workspaceId: issue.workspaceId,
          message: `checkpoint de git da issue #${issue.issueKey}: ${stdout.split('\n')[0]?.trim() ?? message}`,
        });
      },
    );
  });
}

/**
 * Chave de concorrência: issues no MESMO repo nunca rodam em paralelo (conflito
 * de arquivo/git); em repos DIFERENTES, rodam em paralelo. Cai pro workspaceId
 * só se não houver source.
 */
function resolveSourceKey(issue: Issue): string {
  const src = resolveIssueSource(issue);
  return src ? `src:${src.id}` : `ws:${issue.workspaceId}`;
}

type IssueExecutionEventInput = Omit<
  IssueExecutionEvent,
  'workspaceId' | 'issueKey' | 'issueTitle' | 'issueStatus' | 'parentIssueId' | 'createdAt'
> & {
  issueId: string;
};

function enrichIssueExecutionEvent(input: IssueExecutionEventInput): IssueExecutionEvent {
  const issue = issueRepo.get(input.issueId);
  const agent = issue?.assigneeAgentId ? agentRepo.get(issue.assigneeAgentId) : null;
  const source = issue ? resolveIssueSource(issue) : null;
  return {
    ...input,
    workspaceId: issue?.workspaceId ?? '',
    issueKey: issue?.issueKey ?? 0,
    issueTitle: issue?.title ?? input.message ?? 'Issue',
    issueStatus: issue?.status,
    parentIssueId: issue?.parentIssueId ?? null,
    agentId: input.agentId ?? agent?.id ?? null,
    agentName: input.agentName ?? agent?.name ?? null,
    sourceId: input.sourceId ?? source?.id ?? null,
    sourceLabel: input.sourceLabel ?? source?.label ?? null,
    createdAt: new Date().toISOString(),
  };
}

function emit(input: IssueExecutionEventInput): void {
  const event = enrichIssueExecutionEvent(input);
  try {
    issueExecutionEventRepo.record(event);
  } catch (err) {
    console.warn('[issue-exec] falha ao persistir evento de execução', err);
  }
  mirrorIssueEventToChat(event);
  broadcast('issue:execution-event', event);
}

/**
 * Board ao vivo: replica o broadcast `issues:changed-by-mcp` (mesmo canal que o
 * MCP usa) nas transições internas do serviço — started→in_progress, falha→
 * blocked, done, cancel. Sem isto, a IssuesPage só atualizava quando o agente
 * mexia via MCP; transições do próprio executor ficavam invisíveis até reload.
 */
function broadcastBoardChanged(workspaceId: string, reason: string): void {
  broadcast('issues:changed-by-mcp', { workspaceId, reason });
}

/**
 * Gate de dependência: lista as issues blockedBy ainda ABERTAS (não done/
 * cancelled) que impedem ESTA issue de executar. Vazio = liberada.
 */
function openBlockersOf(issueId: string): ReturnType<IssueRelationsRepository['openBlockers']> {
  try {
    return relationsRepo.openBlockers(issueId);
  } catch (err) {
    console.warn('[issue-exec] falha ao checar blockedBy:', err);
    return [];
  }
}

/**
 * Detecta se uma issue é uma ÉPICA (container, não unidade executável). Robusto:
 * tem filhos (mesma convenção do heartbeat) OU título [ÉPICA]/[EPIC] OU label
 * `epic`. Épicas só orquestram seus filhos — nunca devem ser auto-executadas.
 */
function isEpicIssue(issue: Issue): boolean {
  // Tem filhos → é container (épica de fato).
  if (issueRepo.listChildren(issue.id).length > 0) return true;
  // Sub-issue (tem PAI) e SEM filhos = FOLHA executável. Ignora título/label "epic"
  // soltos que o modelo às vezes coloca numa sub-task (ex.: a task de "arquitetura"
  // recebia label `epic` e o auto-executor a tratava como container → ficava "A fazer"
  // pra sempre). Quem tem pai e não tem filho SEMPRE roda.
  if (issue.parentIssueId) return false;
  // Top-level sem filhos: respeita título/label como sinal de épica (placeholder que
  // ainda vai ganhar sub-issues).
  const title = issue.title.trim().toUpperCase();
  if (title.startsWith('[ÉPICA]') || title.startsWith('[EPICA]') || title.startsWith('[EPIC]')) {
    return true;
  }
  return issue.labels.some((l) => l.toLowerCase() === 'epic');
}

function originSessionIdOf(issue: Issue): string | null {
  const meta = issue.metadata as { originSessionId?: string } | null | undefined;
  return meta?.originSessionId ?? null;
}

function shouldSkipOriginChatReport(issue: Issue): boolean {
  return completedIssueChatMirrors.has(issue.id) || activeIssueChatMirrors.has(issue.id);
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function objectArg(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return parseJsonObject(value);
  return typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractCodexToolArgs(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const structured =
    objectArg(item.arguments) ??
    objectArg(item.args) ??
    objectArg(item.input) ??
    objectArg(item.params);
  if (structured && Object.keys(structured).length > 0) return structured;

  const out: Record<string, unknown> = {};
  for (const key of [
    'command',
    'cmd',
    'path',
    'file_path',
    'filePath',
    'query',
    'pattern',
    'glob',
    'patchText',
    'output',
  ]) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function chatFinalTextForIssueRun(message: string | undefined): string | undefined {
  if (!message) return undefined;
  if (/^\d+\s+arquivo\(s\)\s+alterado\(s\)\s+localmente/i.test(message.trim())) {
    return undefined;
  }
  const codeChangeIdx = message.indexOf('<orkestral:code-changes');
  if (codeChangeIdx >= 0) return message.slice(codeChangeIdx).trim();
  return (
    message.replace(/^(✅\s*)?Run (finalizado|concluído)[^\n]*(\n\n)?/i, '').trim() || undefined
  );
}

function mirrorIssueEventToChat(event: IssueExecutionEvent): void {
  const issue = issueRepo.get(event.issueId);
  if (!issue) return;
  const sessionId = originSessionIdOf(issue);
  if (!sessionId || !event.runId) return;
  const assignee = issue.assigneeAgentId ? agentRepo.get(issue.assigneeAgentId) : null;
  const agentName = assignee?.name ?? 'agente';

  if (event.type === 'queued') {
    return;
  }

  if (event.type === 'started') {
    const messageId = startSyntheticAgentStream({
      sessionId,
      runId: event.runId,
    });
    if (!messageId) return;
    activeIssueChatMirrors.set(issue.id, { issueId: issue.id, runId: event.runId, sessionId });
    completedIssueChatMirrors.delete(issue.id);
    emitSyntheticAgentPhase({
      runId: event.runId,
      phase: 'starting',
      label: event.message ?? `${agentName} começou a trabalhar`,
    });
    return;
  }

  const mirror = activeIssueChatMirrors.get(issue.id);
  if (!mirror || mirror.runId !== event.runId) return;

  if (event.type === 'phase') {
    emitSyntheticAgentPhase({
      runId: event.runId,
      phase: 'tool',
      label: event.message ?? 'Executando etapa da task',
    });
    return;
  }

  if (event.type === 'tool-use') {
    appendSyntheticAgentTool(event.runId, {
      type: 'tool-call',
      id: event.toolCallId ?? `issue:${event.issueId}:${event.toolCallCount ?? randomUUID()}`,
      toolName: event.toolName ?? 'tool',
      args:
        event.toolArgs && Object.keys(event.toolArgs).length > 0
          ? event.toolArgs
          : {
              title: `#${issue.issueKey} · chamada ${event.toolCallCount ?? ''}`.trim(),
            },
      status: event.toolStatus ?? 'pending',
    });
    emitSyntheticAgentPhase({
      runId: event.runId,
      phase: 'tool',
      label: event.toolName ?? 'Usando ferramenta',
    });
    return;
  }

  if (event.type === 'model-route') {
    emitSyntheticAgentPhase({
      runId: event.runId,
      phase: 'thinking',
      label: event.message ?? 'Roteando modelo de execução',
    });
    return;
  }

  if (event.type === 'file-change') {
    const changeLabel =
      event.message ??
      `Editing ${event.filePath ?? 'arquivo'} +${event.additions ?? 0} -${event.deletions ?? 0}`;
    emitSyntheticAgentPhase({
      runId: event.runId,
      phase: 'tool',
      label: changeLabel,
    });
    return;
  }

  if (event.type === 'error') {
    finishSyntheticAgentStream({
      runId: event.runId,
      status: 'error',
      finalText: `🚫 A issue #${issue.issueKey} ficou bloqueada — a execução não concluiu.\n\n${event.error ?? 'Sem detalhes do erro.'}`,
    });
    activeIssueChatMirrors.delete(issue.id);
    completedIssueChatMirrors.add(issue.id);
    return;
  }

  if (event.type === 'finished') {
    const cancelled = (event.message ?? '').toLowerCase().includes('cancelad');
    finishSyntheticAgentStream({
      runId: event.runId,
      status: cancelled ? 'cancelled' : 'done',
      finalText: chatFinalTextForIssueRun(event.message),
    });
    activeIssueChatMirrors.delete(issue.id);
    completedIssueChatMirrors.add(issue.id);
    return;
  }
}

/**
 * Fecha o loop chat↔background: se a issue veio de um chat
 * (metadata.originSessionId), posta o resumo do que foi feito de volta NAQUELA
 * sessão como mensagem do agente. O chat principal segue contínuo — isto só
 * acrescenta uma mensagem (não reabre run nem bloqueia).
 */
function reportToOriginSession(issue: Issue, summary: string): void {
  if (shouldSkipOriginChatReport(issue)) return;
  const meta = issue.metadata as { originSessionId?: string } | null | undefined;
  if (!meta?.originSessionId) return;
  // Sub-issue de um plano: o desfecho entra no relatório CONSOLIDADO da épica
  // (maybeReportPlanCompletion), não num ping por sub-issue — senão N sub-issues
  // viram N mensagens soltas poluindo o chat. Só issues STANDALONE pingam aqui.
  if (issue.parentIssueId) return;
  const assignee = issue.assigneeAgentId ? agentRepo.get(issue.assigneeAgentId) : null;
  const who = assignee?.name ?? 'o time';
  const metadata = issue.metadata as { lastCodeChangeBlock?: string } | null | undefined;
  const finalSummary =
    metadata?.lastCodeChangeBlock && !summary.includes('<orkestral:code-changes')
      ? [summary, metadata.lastCodeChangeBlock].filter(Boolean).join('\n\n')
      : summary;
  const text = `✅ **${issue.title}** concluída por ${who}.\n\n${finalSummary}`;
  try {
    postAgentMessageToSession(meta.originSessionId, text);
  } catch (err) {
    console.warn('[issue-exec] falha ao reportar no chat de origem:', err);
  }
}

/**
 * NARRAÇÃO VIVA: posta um ping CURTO no chat de origem a CADA avanço do plano ("terminei X,
 * começando Y"). Sub-issues não pingam o relatório completo (reportToOriginSession retorna cedo
 * pra elas), então sem isto o chat fica MUDO durante toda a execução. Aditivo: não substitui o
 * relatório consolidado da épica no fim; só dá ritmo ao chat enquanto roda.
 */
function narratePlanProgress(completed: Issue, next: Issue | null, moreInWave: number): void {
  // NÃO usa shouldSkipOriginChatReport aqui: sub-issues de plano viram "chat mirror" durante a
  // execução, e aquele guard as pularia → a narração (que é o ponto) nunca sairia. A narração é
  // uma mensagem CURTA de transição, distinta do mirror do stream; deve sair pra issue com origem.
  const meta = completed.metadata as { originSessionId?: string } | null | undefined;
  const sessionId = meta?.originSessionId;
  if (!sessionId) return;
  const text = next
    ? mt(
        `✅ **${completed.title}** concluída. Começando agora: **${next.title}**.`,
        `✅ **${completed.title}** done. Starting now: **${next.title}**.`,
      )
    : moreInWave > 0
      ? mt(
          `✅ **${completed.title}** concluída. Seguindo com mais ${moreInWave} em paralelo.`,
          `✅ **${completed.title}** done. Continuing with ${moreInWave} more in parallel.`,
        )
      : null;
  if (!text) return;
  try {
    postAgentMessageToSession(sessionId, text);
  } catch (err) {
    console.warn('[issue-exec] falha na narração de progresso:', err);
  }
}

/**
 * Reporta no chat de origem quando a issue termina SEM ser sucesso (bloqueada ou
 * cancelada). Antes só o sucesso voltava pro chat; um fim bloqueado deixava o
 * chat mudo e dava a falsa impressão de "ainda rodando / já pronto" (o badge de
 * alteração de código aparece antes da issue fechar). Fecha o loop nos dois fins.
 */
function reportTerminalToOriginSession(
  issue: Issue,
  status: 'blocked' | 'cancelled',
  detail: string,
): void {
  // Um fim bloqueado/cancelado de uma sub-issue também precisa EMPURRAR o plano:
  // senão o irmão seguinte de uma épica sequencial fica órfão (só os caminhos de
  // park/done avançavam). scheduleParkedAdvance é idempotente (guard terminal +
  // setImmediate) e já chama maybeStartNextPlanIssue + maybeReportPlanCompletion,
  // então cobre o avanço e a consolidação do plano sem duplo-avanço.
  scheduleParkedAdvance(issue.id);
  if (shouldSkipOriginChatReport(issue)) return;
  const meta = issue.metadata as { originSessionId?: string } | null | undefined;
  if (!meta?.originSessionId) return;
  // Sub-issue de plano: o bloqueio aparece no relatório consolidado da épica, não
  // num ping individual (evita o spam de "⚠️ bloqueada / não foi possível aplicar
  // o edit" por sub-issue). scheduleParkedAdvance acima já empurrou o plano.
  if (issue.parentIssueId) return;
  const icon = status === 'cancelled' ? '⏸' : '⚠️';
  const label = status === 'cancelled' ? 'cancelada' : 'bloqueada — precisa de atenção';
  const text = `${icon} **${issue.title}** — ${label}.\n\n${detail.trim().slice(0, 400)}`;
  try {
    postAgentMessageToSession(meta.originSessionId, text);
  } catch (err) {
    console.warn('[issue-exec] falha ao reportar fim no chat de origem:', err);
  }
}

/**
 * Fecha o loop do PLANO: quando TODAS as sub-issues de uma épica (vinda de um
 * chat) atingem estado terminal (done/blocked/cancelled), o CEO CONSOLIDA os
 * resultados e responde no chat — o usuário pediu algo e precisa do desfecho
 * (o que foi feito, o que aprovar, próximos passos), não issues no limbo.
 * Idempotente via flag `planReportSent` na metadata da épica. Seguro chamar em
 * todo fim de sub-issue: só dispara quando o plano inteiro terminou.
 */
function maybeReportPlanCompletion(finished: Issue): void {
  // A RAIZ do plano é a épica TOP-LEVEL (sobe a árvore inteira — HORIZON Fase 1:
  // com sub-épicas aninhadas, a sessão de origem e o gate de aprovação vivem na
  // raiz, não no pai imediato) OU a própria issue (issue ÚNICA sem épica).
  const root = rootPlanIssueOf(finished);
  const rootId = root.id;
  const meta =
    (root.metadata as { originSessionId?: string; planReportSent?: boolean } | null) ?? {};
  if (!meta.originSessionId || meta.planReportSent) return;
  const isTerminal = (s: string): boolean => s === 'done' || s === 'blocked' || s === 'cancelled';
  // "Assentada" = terminal OU estacionada sem ator (in_review aguardando humano /
  // aprovação). Sem isso, um irmão estacionado em in_review travava a épica pra
  // sempre. Quem está de fato rodando (in_review com run ativo) NÃO conta como
  // assentada — `isParkedNoActor` já exclui issues com run ativo —, então a épica
  // continua aberta até o trabalho real terminar. RECURSIVA: uma sub-épica conta
  // como assentada quando TODOS os filhos dela assentaram (o rollup não fecha a
  // pai se um filho estacionou em in_review, mas o plano do avô não pode congelar
  // por isso — mesmo racional do nível 1, aplicado em profundidade).
  const isSettled = (c: Issue, depth = 0): boolean => {
    if (isTerminal(c.status) || isParkedNoActor(c)) return true;
    if (depth >= 16) return false;
    const kids = issueRepo.listChildren(c.id);
    return kids.length > 0 && kids.every((k) => isSettled(k, depth + 1));
  };
  const children = issueRepo.listChildren(rootId);
  const lastAgentBody = (issueId: string): string =>
    [...issueRepo.listComments(issueId)].reverse().find((cm) => cm.authorKind === 'agent')?.body ??
    '';

  let results: Array<{ ref: string; title: string; status: string; summary: string }>;
  if (children.length > 0) {
    // Épica: só fecha quando TODAS as sub-issues assentaram (terminal ou parada
    // sem ator, aguardando revisão humana).
    if (!children.every((c) => isSettled(c))) return;
    // REVIEW FINAL DO ÉPICO (uma vez, no fim): em vez de revisar cada sub-issue, o Code
    // Reviewer valida o CONJUNTO na issue PAI. Dispara UMA vez (flag epicReviewed) e só
    // reporta a conclusão DEPOIS do veredito — economia: 1 review no fim, não N por
    // sub-issue. Issue única (sem filhos) cai no else e segue o review normal.
    const epicCodeReviewer = findCodeReviewer(root.workspaceId);
    const epicReviewed =
      (root.metadata as { epicReviewed?: boolean } | null)?.epicReviewed === true;
    if (
      epicCodeReviewer &&
      !epicReviewed &&
      root.status !== 'cancelled' &&
      children.some((c) => c.status === 'done') && // só revisa se houve entrega real
      // Gate de qualidade SEM pagamento duplo: plano que já contém um filho de
      // revisão/QA CONCLUÍDO (ex.: "QA: validação final") já pagou o gate — pula o
      // review da épica. Sem filho de review, o review final roda MESMO com a
      // épica já 'done' pelo rollup: antes o guard `!== 'done'` fazia o rollup
      // sempre vencer a corrida e este caminho era código morto (piloto Pulso).
      !children.some((c) => isReviewLikeIssue(c) && c.status === 'done')
    ) {
      issueRepo.update(root.id, { metadata: { ...meta, epicReviewed: true } });
      const freshRoot = issueRepo.get(root.id) ?? root;
      const epicExecutor = freshRoot.assigneeAgentId ?? epicCodeReviewer.id;
      startReview(freshRoot, epicExecutor, epicCodeReviewer, 0, 0);
      return; // não reporta ainda — o review final fecha (approve→done) ou pede ajustes
    }
    results = children.map((c) => ({
      ref: `#${c.displayKey ?? c.issueKey}`,
      title: c.title,
      status: c.status,
      summary: lastAgentBody(c.id),
    }));
  } else {
    // Issue única: fecha quando ela mesma terminou.
    if (!isTerminal(root.status)) return;
    results = [
      {
        ref: `#${root.displayKey ?? root.issueKey}`,
        title: root.title,
        status: root.status,
        summary: lastAgentBody(root.id),
      },
    ];
  }
  // Marca ANTES de disparar (idempotência: turn que falha, ou duas sub-issues
  // terminando quase juntas, não geram dois relatórios).
  issueRepo.update(root.id, { metadata: { ...meta, planReportSent: true } });
  void requestPlanCompletionReport({
    sessionId: meta.originSessionId,
    planTitle: root.title,
    results,
  });
  // LOOP DE CONVERGÊNCIA (HORIZON Fase 2): o plano assentou — se o OBJETIVO ainda
  // não fechou (progress < 100), o CEO re-entra com o delta e abre as issues do
  // gap (respeitando token_budget + caps). 100% cai no maybeAutoVerifyGoal normal.
  maybeRequestGoalConvergence(root.goalId);
}

/**
 * Retorno CONTÍNUO da revisão no chat de origem: quem está revisando e o veredito
 * (requer mudanças / aprovado). Antes, "requer mudanças" re-executava em silêncio
 * e o usuário ficava sem saber o que houve — sem fluidez. Conciso (1 linha cada).
 */
function reportReviewToOriginSession(
  issue: Issue,
  kind: 'sent_for_review' | 'changes_requested' | 'approved',
  reviewerName: string | undefined,
  executorName: string | undefined,
  detail: string,
): void {
  const meta = issue.metadata as { originSessionId?: string } | null | undefined;
  if (!meta?.originSessionId) return;
  // "Enviado pra revisão" é puro ruído transitório (a timeline + o painel de
  // progresso já mostram). E sub-issues de um plano são resumidas UMA vez no
  // relatório consolidado — não pingam veredito por sub-issue. Só STANDALONE pinga.
  if (kind === 'sent_for_review' || issue.parentIssueId) return;
  const who = reviewerName ?? mt('o revisor', 'the reviewer');
  let text: string;
  if (kind === 'changes_requested') {
    const exec = executorName ?? mt('o responsável', 'the owner');
    text = mt(
      `🔁 **${who}** revisou **${issue.title}** e pediu ajustes — **${exec}** está corrigindo.\n\n${detail.trim().slice(0, 380)}`,
      `🔁 **${who}** reviewed **${issue.title}** and requested changes — **${exec}** is fixing it.\n\n${detail.trim().slice(0, 380)}`,
    );
  } else {
    text = mt(
      `✅ **${who}** aprovou **${issue.title}**.`,
      `✅ **${who}** approved **${issue.title}**.`,
    );
  }
  try {
    postAgentMessageToSession(meta.originSessionId, text);
  } catch (err) {
    console.warn('[review] falha ao reportar revisão no chat:', err);
  }
}

// ── Cadeia de VALIDAÇÃO hierárquica (reports_to) ──────────────────────────────
// O executor (modelo local/fraco) NÃO fecha a issue sozinho: ao concluir, o
// trabalho sobe pro gestor a quem ele responde (reports_to) VALIDAR. Se aprova,
// sobe mais um nível até o topo (CEO). Se reprova, volta pro executor corrigir.
// O CEO comanda o exército e valida no topo. Caps evitam loop infinito.
const MAX_REVIEW_DEPTH = 3; // níveis de gestor que revisam acima do executor
const MAX_REVIEW_ATTEMPTS = 2; // idas-e-vindas executor↔gestor antes de pedir humano
// Teto de re-execuções corretivas após reprovação no review, contado pelo
// `reexecuteCount` PERSISTIDO na metadata (robusto a perda de review.attempts, que
// causava loop infinito). O executor re-tenta LOCAL com o foco do revisor; estourou →
// estaciona pra humano em vez de re-executar à toa. Só atinge issues SEM pai
// (standalone) e o review final do épico — sub-issues nem são revisadas.
const MAX_REEXECUTE_ATTEMPTS = 2;
// Replanejamento de ciclo fechado: quantas vezes o CEO pode RE-ENTRAR pra
// corrigir o plano por DIVERGÊNCIA (sub-issue travada / revisor reprovando) antes
// de parar e pedir humano. Cap POR PLANO (na metadata da raiz) — junto com
// MAX_REVIEW_ATTEMPTS, garante que replanejar nunca vira loop infinito.
const MAX_REPLAN_ATTEMPTS = 2;

interface ReviewMeta {
  /** Dono do trabalho (responsável) — NUNCA muda. O assigneeAgentId da issue
   *  continua sendo este durante a revisão; o revisor age via reviewerAgentId. */
  executorAgentId: string;
  /** Quem está revisando agora (gestor/code-reviewer). É o "ator atual" enquanto
   *  status==='in_review' — não vira responsável da issue. */
  reviewerAgentId?: string;
  depth: number;
  attempts: number;
  /** Já pedimos UMA vez o veredito explícito (re-prompt forçado)? Limita a 1 nudge
   *  antes de estacionar pra humano — nunca aprova por silêncio. */
  verdictNudged?: boolean;
}

/** Ator que DEVE rodar agora: o revisor enquanto a issue está em revisão; senão o
 *  responsável (assignee). Mantém o responsável fixo — a revisão não o reatribui. */
function currentActorId(issue: Issue): string | null {
  const review = (issue.metadata as { review?: ReviewMeta } | null)?.review;
  if (issue.status === 'in_review' && review?.reviewerAgentId) return review.reviewerAgentId;
  return issue.assigneeAgentId;
}

function isCodeReviewerAgent(agent: Agent | null | undefined): boolean {
  if (!agent) return false;
  return /code[-\s_]?review|reviewer/.test(
    `${agent.role} ${agent.name} ${agent.title ?? ''}`.toLowerCase(),
  );
}

function isLeadAgent(agent: Agent | null | undefined): boolean {
  if (!agent) return false;
  return /tech[-\s_]?lead|architect|lead/.test(
    `${agent.role} ${agent.name} ${agent.title ?? ''}`.toLowerCase(),
  );
}

function findCodeReviewer(workspaceId: string): Agent | null {
  return (
    agentRepo
      .listByWorkspace(workspaceId)
      .find((agent) => isCodeReviewerAgent(agent) && agent.status !== 'paused') ?? null
  );
}

/** Dispara o gestor pra REVISAR o trabalho na issue (reassign + run em modo review). */
function startReview(
  issue: Issue,
  executorAgentId: string,
  manager: Agent,
  depth: number,
  attempts: number,
): void {
  const exec = agentRepo.get(executorAgentId);
  if (isQaAgent(manager)) {
    try {
      beginQaValidation({
        issue,
        executorAgentId,
        qaAgentId: manager.id,
      });
    } catch (err) {
      console.warn('[qa] falha ao iniciar validação:', err instanceof Error ? err.message : err);
    }
  }
  const review: ReviewMeta = { executorAgentId, reviewerAgentId: manager.id, depth, attempts };
  // NUNCA reatribui o responsável (assigneeAgentId): o revisor age via reviewerAgentId
  // (resolvido por currentActorId). O responsável continua o executor.
  issueRepo.update(issue.id, {
    status: 'in_review',
    metadata: { ...((issue.metadata as Record<string, unknown>) ?? {}), review },
  });
  // Preenche o campo dedicado de revisor (sidebar) em vez de mexer no responsável.
  // addReviewer é idempotente (dedupe por issue+agent).
  try {
    relationsRepo.addReviewer(issue.id, manager.id, 'reviewer');
  } catch {
    // registro de revisor é best-effort — não bloqueia o fluxo de review
  }
  issueRepo.addComment({
    issueId: issue.id,
    body: `↑ @${exec?.name ?? 'executor'} concluiu — @${manager.name}, valide o trabalho.`,
    authorKind: 'system',
  });
  setImmediate(() => {
    try {
      executeIssue(issue.id);
    } catch (err) {
      console.warn('[review] falha ao acionar gestor:', err instanceof Error ? err.message : err);
    }
  });
}

/**
 * Gate REAL de `done` via approvers (tabela issueReviewers, role='approver'):
 * - 'rejected'  → algum approver reprovou; issue NÃO conclui, volta pra blocked.
 * - 'pending'   → há approver obrigatório sem decisão; fica "aguardando aprovação"
 *                 (in_review), NÃO conclui.
 * - 'approved'  → todos os approvers obrigatórios aprovaram (ou não há approvers).
 */
function approverGateState(issueId: string): 'approved' | 'pending' | 'rejected' {
  const approvers = relationsRepo.getApprovers(issueId);
  if (approvers.length === 0) return 'approved';
  if (approvers.some((a) => a.decision === 'rejected')) return 'rejected';
  if (approvers.some((a) => a.decision !== 'approved')) return 'pending';
  return 'approved';
}

/**
 * Aplica o gate de approvers antes de marcar como done. Retorna true se a issue
 * pode concluir; caso contrário transiciona pro estado correto (blocked quando
 * rejeitada, in_review quando aguardando aprovação) + comenta, e retorna false.
 */
function passesApproverGate(issue: Issue, summary: string): boolean {
  const gate = approverGateState(issue.id);
  if (gate === 'approved') return true;
  if (gate === 'rejected') {
    issueRepo.update(issue.id, { status: 'blocked' });
    // Veredito de verificação NEGATIVO: o aprovador reprovou → o trabalho local
    // existe mas não passou. Pending (else, aguardando aprovação) fica NULL.
    stampVerifiedVerdict(issue.id, false);
    issueRepo.addComment({
      issueId: issue.id,
      body: mt(
        '⛔ Um aprovador reprovou esta issue — não pode concluir. Ajuste o trabalho e solicite nova aprovação.',
        '⛔ An approver rejected this issue — it cannot be completed. Address the feedback and request approval again.',
      ),
      authorKind: 'system',
    });
  } else {
    const parked = issueRepo.update(issue.id, { status: 'in_review' });
    // Aguardando aprovação manual: sem run ativo até um aprovador agir. Marca a
    // flag persistida pra que o irmão seguinte do plano não fique travado.
    markParkedNoActor(parked);
    issueRepo.addComment({
      issueId: issue.id,
      body: mt(
        '⏳ Trabalho concluído — aguardando aprovação dos aprovadores obrigatórios antes de finalizar.',
        '⏳ Work complete — waiting on required approvers before this issue can be finalized.',
      ),
      authorKind: 'system',
    });
  }
  reportToOriginSession(issueRepo.get(issue.id) ?? issue, summary);
  // Parked (in_review aguardando aprovação) ou blocked (rejeitada) também precisam
  // empurrar o plano — senão o irmão seguinte trava ao chegar pelo caminho
  // finalizeIssue(..., true) que retorna aqui antes do bloco de avanço.
  scheduleParkedAdvance(issue.id);
  return false;
}

/**
 * Um issue que parou sem run ativo (parked aguardando veredito/aprovação) ou
 * terminou (done/blocked/cancelled) por um caminho que NÃO dispara o avanço do
 * plano precisa empurrar o sequenciador — senão o irmão seguinte nunca inicia e
 * a épica nunca consolida. Deferido com setImmediate pra o `finally` de
 * runIssueAsync já ter tirado este run de activeRuns; só então isParkedNoActor
 * enxerga o park. O guard evita avançar se um ator voltou a rodar nesse meio-tempo.
 */
function scheduleParkedAdvance(issueId: string): void {
  setImmediate(() => {
    const current = issueRepo.get(issueId);
    if (!current) return;
    const terminal =
      current.status === 'done' || current.status === 'blocked' || current.status === 'cancelled';
    if (!isParkedNoActor(current) && !terminal) return;
    maybeStartNextPlanIssue(current);
    maybeReportPlanCompletion(current);
  });
}

/**
 * Replanejamento de CICLO FECHADO: uma sub-issue de plano DIVERGIU (parou sem ator
 * após esgotar a revisão automática, ou o revisor reprovou repetidamente). O plano
 * congelado não se resolve sozinho → o CEO RE-ENTRA: recebe o estado do plano + o
 * contexto da falha/feedback do revisor e emite um PATCH (sub-issue corretiva re-
 * escopada / re-delegada). É uma ADIÇÃO aos pontos de divergência existentes — NÃO
 * substitui o park (needs_verdict / attempts-exhausted): a issue já estacionou
 * sem ator; isto só dispara a correção. Caps: só roda quando há sessão de origem
 * (CEO no chat) e um budget POR PLANO (replanCount < MAX_REPLAN_ATTEMPTS) — junto
 * com MAX_REVIEW_ATTEMPTS, não há loop. Forge-first/barato por padrão; premium só
 * em alto risco sob autonomia alta. Idempotente: marca o budget ANTES de disparar.
 */
function maybeReplanOnDivergence(
  divergedIssue: Issue,
  reason: 'attempts_exhausted' | 'review_rejected',
  reviewerFeedback: string,
): void {
  // Raiz do plano = a épica (se é sub-issue) OU a própria issue (top-level única).
  // Replanejar só faz sentido pra trabalho de PLANO sob uma épica com sessão de
  // origem (onde o CEO vive). Issue única sem épica → segue o caminho de park/humano.
  const rootId = divergedIssue.parentIssueId;
  if (!rootId) return;
  const root = issueRepo.get(rootId);
  if (!root) return;
  const sessionId = originSessionIdOf(root) ?? originSessionIdOf(divergedIssue);

  // Budget POR PLANO (na metadata da raiz): nunca replaneja além do cap.
  const rootMeta = (root.metadata as Record<string, unknown> | null) ?? {};
  const replanCount = (rootMeta.replanCount as number | undefined) ?? 0;
  if (
    !canReplan({
      hasOriginSession: !!sessionId,
      replanCount,
      maxReplanAttempts: MAX_REPLAN_ATTEMPTS,
    })
  ) {
    // Sem sessão (sem CEO no chat) → silencioso: o caminho de park/humano cobre.
    // Budget estourado → avisa que precisa de decisão humana sobre o plano.
    if (sessionId && replanCount >= MAX_REPLAN_ATTEMPTS) {
      issueRepo.addComment({
        issueId: divergedIssue.id,
        body: mt(
          '⚠️ Replanejamento automático esgotado — precisa de decisão humana sobre o plano.',
          '⚠️ Automatic replanning budget exhausted — the plan needs a human decision.',
        ),
        authorKind: 'system',
      });
    }
    return;
  }
  if (!sessionId) return; // canReplan já garantiu; narrowing pro TS.
  // Marca o budget ANTES de disparar (idempotência: dois divergências quase juntas
  // não disparam dois replanejamentos). Re-fetch + spread pra não clobberar o resto.
  issueRepo.update(root.id, {
    metadata: { ...rootMeta, replanCount: replanCount + 1 },
  });

  const refOf = (i: Issue): string => `#${i.displayKey ?? i.issueKey}`;
  const siblings = orderedPlanChildren(root.id);
  // Quantos filhos a épica tinha ANTES do turno do CEO — pra confirmar depois que
  // o replanejamento REALMENTE parentou uma corretiva (e não nasceu órfã).
  const childCountBefore = siblings.length;
  const planState =
    siblings.length > 0
      ? siblings.map((c) => ({ ref: refOf(c), title: c.title, status: c.status }))
      : [{ ref: refOf(root), title: root.title, status: root.status }];

  // Alto risco → premium sob autonomia alta (manda-e-dorme, sem revisão humana no
  // caminho, então a correção precisa ser confiável). Barato/Forge-first caso contrário.
  const highStakes =
    divergedIssue.priority === 'critical' ||
    divergedIssue.labels.some((l) => /security|payment|migration|prod/i.test(l));
  const forcePremium = shouldForcePremiumReplan({
    highStakes,
    autonomyLevel: workspaceAutonomyLevel(divergedIssue.workspaceId),
  });

  void requestPlanReplanning({
    sessionId,
    planTitle: root.title,
    parentEpicId: root.id,
    divergedRef: refOf(divergedIssue),
    divergedTitle: divergedIssue.title,
    divergedDescription: divergedIssue.description ?? '',
    reason,
    reviewerFeedback,
    planState,
    forcePremium,
  })
    .then(() => {
      // Confirma que o CEO REALMENTE parentou uma corretiva sob a épica. Se o modelo
      // bagunçou o UUID da raiz, a corretiva nasce órfã (top-level) e o ciclo não
      // fecha: devolve o budget (decrementa na contagem FRESCA, sem clobberar outro
      // replan concorrente) e sinaliza decisão humana — em vez de consumir uma
      // tentativa num no-op e deixar o plano estacionado em silêncio.
      const producedCorrective = orderedPlanChildren(root.id).length > childCountBefore;
      if (!producedCorrective) {
        const freshRoot = issueRepo.get(root.id);
        const freshMeta = (freshRoot?.metadata as Record<string, unknown> | null) ?? {};
        const freshCount = (freshMeta.replanCount as number | undefined) ?? 0;
        if (freshRoot && freshCount > 0) {
          issueRepo.update(root.id, { metadata: { ...freshMeta, replanCount: freshCount - 1 } });
        }
        issueRepo.addComment({
          issueId: divergedIssue.id,
          body: mt(
            '⚠️ Replanejamento automático não produziu uma sub-issue corretiva — precisa de decisão humana sobre o plano.',
            '⚠️ Automatic replanning did not produce a corrective sub-issue — the plan needs a human decision.',
          ),
          authorKind: 'system',
        });
        return;
      }
      // O CEO criou a sub-issue corretiva (backlog, sob a épica). O sequenciador
      // promove backlog→todo e a executa — o park da issue divergida já a deixou
      // transparente, então a corretiva entra como próximo passo do plano.
      const fresh = issueRepo.get(divergedIssue.id);
      if (fresh) scheduleParkedAdvance(fresh.id);
      else startFirstPlanIssue(root.id);
    })
    .catch((err) => {
      console.warn('[replan] turno de replanejamento do CEO falhou:', err);
    });
}

/** Exit reasons que representam um desfecho de RESOLUÇÃO local (Forge). */
const LOCAL_OUTCOME_EXIT_REASONS = ['local_resolved', 'local_resolved_premium_assisted'];

/**
 * Veredito de verificação HONESTO: estampa `verified` no run local que produziu
 * o trabalho desta issue. Acha o run mais recente cujo exit_reason é local (via
 * listRuns, desc startedAt) e registra o veredito — guardado a runs locais pra
 * NÃO contar runs premium/só-revisão na taxa de correção. Read-only + aditivo:
 * o recordVerifiedOutcome é defensivo e nunca derruba o finalize.
 */
function stampVerifiedVerdict(issueId: string, verified: boolean): void {
  const runs = issueRepo.listRuns(issueId);
  const localRun = runs.find(
    (run) => !!run.exitReason && LOCAL_OUTCOME_EXIT_REASONS.includes(run.exitReason),
  );
  if (localRun) {
    execStatsRepo.recordVerifiedOutcome(localRun.id, verified);
  }
  // RAG-de-edits (HORIZON Fase 4): o review é o gate de qualidade. Os edits
  // candidatos (via `edit_file`) de TODOS os runs desta issue assentam junto com
  // ela: verificada → ACEITOS (few-shot do estilo real do repo nos merges
  // futuros); senão → descartados (não ensina o merge com edit ruim). Código LOCAL.
  for (const run of runs) {
    if (verified) forgeEditExamplesRepo.promoteByRun(run.id);
    else forgeEditExamplesRepo.rejectByRun(run.id);
  }
}

/**
 * Remove as flags de convergência de review da metadata (mantém o resto intacto).
 * Usado ao finalizar a issue pra que reviewFocus/reexecuteCount/forcePremiumNextRun
 * não vazem em runs futuros não relacionados.
 */
function clearReviewConvergenceMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const {
    reviewFocus: _reviewFocus,
    reexecuteCount: _reexecuteCount,
    forcePremiumNextRun: _forcePremiumNextRun,
    forceVerdictNextRun: _forceVerdictNextRun,
    ...rest
  } = meta;
  return rest;
}

function finalizeIssue(issue: Issue, summary: string, markDone: boolean): void {
  if (markDone && !passesApproverGate(issue, summary)) return;
  if (markDone) {
    // Verificação: uma mudança de código que existe mas NÃO passou (ou não pôde
    // rodar) a validação não pode chegar a 'done' silenciosamente. Mantém o
    // status='done' (pra o sequenciador/épica seguir tratando como terminal) +
    // flag verification='unverified' + comentário + surfacing no chat. Verificado
    // e não-código (default 'not_applicable') seguem o caminho atual sem mudança.
    const current = issueRepo.get(issue.id) ?? issue;
    const meta = (current.metadata as { verification?: IssueVerificationState } | null) ?? {};
    if ((meta.verification ?? 'not_applicable') === 'unverified') {
      const doneUnverified = issueRepo.update(issue.id, {
        status: 'done',
        metadata: {
          ...clearReviewConvergenceMeta((current.metadata as Record<string, unknown>) ?? {}),
          verification: 'unverified',
        },
      });
      // Provenance honesta: chegou a 'done' mas SEM verificação → veredito negativo
      // pro run local (produziu trabalho mas não passou/não pôde rodar a validação).
      stampVerifiedVerdict(issue.id, false);
      issueRepo.addComment({
        issueId: issue.id,
        body: mt(
          '⚠️ Concluída SEM verificação — a mudança de código não passou (ou não pôde rodar) a validação. Revise antes de confiar.',
          '⚠️ Marked done UNVERIFIED — the code change did not pass (or could not run) validation. Review before relying on it.',
        ),
        authorKind: 'system',
      });
      reportToOriginSession(
        doneUnverified,
        [
          summary,
          mt(
            '⚠️ Concluída sem verificação automática.',
            '⚠️ Completed without automatic verification.',
          ),
        ].join('\n\n'),
      );
      maybeStartNextPlanIssue(doneUnverified);
      maybeReportPlanCompletion(doneUnverified);
      return;
    }
  }
  const finalIssue = markDone
    ? issueRepo.update(issue.id, { status: 'done' })
    : (issueRepo.get(issue.id) ?? issue);
  if (finalIssue.status === 'done') {
    // Só reporta "✅ concluída" no chat quando REALMENTE concluiu. Park (in_review
    // aguardando veredito/aprovação) já reportou via reportReviewToOriginSession;
    // disparar aqui mostraria um "concluída" falso num issue que não concluiu.
    reportToOriginSession(finalIssue, summary);
    // Checkpoint de git: cada issue concluída vira um commit no repo alvo.
    commitIssueCheckpoint(finalIssue);
    // Preview: assim que o projeto fica runnable (scaffold pronto), avisa UMA vez no chat e
    // acende o card (que tem o botão Play). Não sobe o dev server sozinho — o usuário inicia.
    try {
      if (shouldAnnouncePreview(finalIssue.workspaceId)) {
        const sess = (finalIssue.metadata as { originSessionId?: string } | null)?.originSessionId;
        if (sess) {
          postAgentMessageToSession(
            sess,
            mt(
              '▶️ **Preview liberado.** O scaffold tá pronto — abra o painel à direita e clique em Play pra subir o app e ver a tela (o primeiro boot leva alguns segundos, e o time ainda pode estar trabalhando em partes do projeto).',
              '▶️ **Preview unlocked.** The scaffold is ready — open the right panel and hit Play to boot the app and see the screen (first boot takes a few seconds, and the team may still be working on parts of the project).',
            ),
          );
        }
      }
    } catch (err) {
      console.warn('[issue-exec] falha ao anunciar preview:', err);
    }
    // LIVE UPDATE do preview: a issue editou arquivos → manda o webview recarregar (pega rotas/
    // páginas novas que o HMR do dev server às vezes não reflete sozinho). Mesmo canal do chat.
    broadcast('preview:reload', {});
    // REDE DE SEGURANÇA do checklist: issue concluída (e VERIFICADA, pois o ramo unverified
    // retornou antes) = todos os passos feitos. O executor roda a issue como bloco, então marca
    // os checkboxes que sobraram pendentes pra o card nunca ficar 0/N numa issue done. A marcação
    // AO VIVO (executor marcando cada um) é melhor, mas isto garante consistência no fim.
    try {
      const cbMeta = finalIssue.metadata as {
        kind?: string;
        checkboxes?: ExecutionCheckbox[];
      } | null;
      if (
        cbMeta?.kind === 'execution-plan' &&
        cbMeta.checkboxes?.some((c) => c.status !== 'done')
      ) {
        const checkboxes = cbMeta.checkboxes.map((c) =>
          c.status === 'done'
            ? c
            : { ...c, status: 'done' as const, completedAt: new Date().toISOString() },
        );
        issueRepo.update(finalIssue.id, {
          metadata: { ...cbMeta, kind: 'execution-plan', checkboxes },
        });
        broadcastBoardChanged(finalIssue.workspaceId, 'checkbox-settled');
      }
    } catch (err) {
      console.warn('[issue-exec] falha ao fechar checkboxes:', err);
    }
    // Aprovada/finalizada: limpa as flags de convergência de review (reviewFocus/
    // reexecuteCount/forcePremiumNextRun) pra não vazarem em runs futuros não
    // relacionados. Re-fetch + spread pra não clobberar o resto da metadata.
    const meta = (finalIssue.metadata as Record<string, unknown> | null) ?? {};
    if ('reviewFocus' in meta || 'reexecuteCount' in meta || 'forcePremiumNextRun' in meta) {
      issueRepo.update(finalIssue.id, { metadata: clearReviewConvergenceMeta(meta) });
    }
    // Done VERIFICADO: chegou aqui só depois de passesApproverGate (markDone) OU
    // do caminho de review já aprovado (markDone=false, status já 'done'). Veredito
    // positivo pro run local que produziu o trabalho. Só estampa runs locais.
    stampVerifiedVerdict(finalIssue.id, true);
    // Objetivo: se esta issue fechou o objetivo (100%), o CEO valida a ENTREGA
    // contra ele (auto-disparo; dedup por verifySessionId). Recalc + verify.
    maybeAutoVerifyGoal(finalIssue.goalId);
    // Reconcilia o badge: o caminho de aprovação por review (markDone=false) pula o
    // bloco unverified acima, então uma metadata 'unverified' herdada do run Forge
    // ficaria contradizendo run.verified=1. Promove pra 'verified' (re-fetch + spread
    // pra não clobberar o resto da metadata).
    const reconciled = issueRepo.get(finalIssue.id);
    const reconciledMeta =
      (reconciled?.metadata as { verification?: IssueVerificationState } | null) ?? {};
    if (reconciledMeta.verification === 'unverified') {
      issueRepo.update(finalIssue.id, {
        metadata: { ...reconciledMeta, verification: 'verified' },
      });
    }
    maybeStartNextPlanIssue(finalIssue);
    // Plano inteiro terminou? → CEO consolida e responde no chat (só dispara
    // quando todas as sub-issues da épica estão em estado terminal).
    maybeReportPlanCompletion(finalIssue);
  } else if (!markDone) {
    // Park sem ator (needs_verdict / tentativas esgotadas): o issue fica em
    // in_review transparente ao sequenciador, mas o park precisa empurrar o avanço.
    scheduleParkedAdvance(finalIssue.id);
  }
}

function orderedPlanChildren(parentIssueId: string): Issue[] {
  return orderPlanChildren(issueRepo.listChildren(parentIssueId));
}

/** Issue com dependência blockedBy ainda aberta → o sequenciador a pula. */
function isBlockedByOpenDep(issue: Pick<Issue, 'id'>): boolean {
  return openBlockersOf(issue.id).length > 0;
}

/**
 * Flag PERSISTIDA na metadata: a issue está parada num estado não-terminal
 * (in_review/blocked) mas SEM nenhum run/ator pra avançá-la — revisão automática
 * esgotou as tentativas (precisa de humano) ou aguarda aprovação manual. Como é
 * persistida, o sequenciador volta a destravar a épica mesmo após restart (o Map
 * `activeRuns`, em memória, não sobrevive a restart).
 */
const PARKED_NO_ACTOR_FLAG = 'parkedNoActor';

/** Marca a issue como "estacionada sem ator", preservando a metadata existente. */
function markParkedNoActor(issue: Issue): void {
  const meta = (issue.metadata as Record<string, unknown> | null) ?? {};
  // Park = a convergência automática terminou (qualquer retomada é humana), então
  // limpa os flags de review (reviewFocus/reexecuteCount/forcePremiumNextRun) pra
  // não vazarem num re-exec manual futuro desta issue. Demais metadata preservada.
  issueRepo.update(issue.id, {
    metadata: { ...clearReviewConvergenceMeta(meta), [PARKED_NO_ACTOR_FLAG]: true },
  });
}

/**
 * A issue está estacionada SEM ator? Só conta enquanto ela continua num estado
 * não-terminal e SEM run ativo: se voltou a rodar (in_progress / run em
 * activeRuns) a flag persistida é ignorada, então não há risco de flag obsoleta.
 */
function isParkedNoActor(issue: Pick<Issue, 'id' | 'status'>): boolean {
  if (issue.status !== 'in_review' && issue.status !== 'blocked') return false;
  if (activeRuns.has(issue.id) || runQueue.some((j) => j.issueId === issue.id)) return false;
  const full = issueRepo.get(issue.id);
  const meta = (full?.metadata as Record<string, unknown> | null) ?? {};
  return meta[PARKED_NO_ACTOR_FLAG] === true;
}

export function startFirstPlanIssue(parentIssueId: string): boolean {
  const children = orderedPlanChildren(parentIssueId);
  const firstRunnable = firstRunnablePlanIssue(children, isBlockedByOpenDep, isParkedNoActor);
  return firstRunnable ? maybeAutoExecuteIssue(firstRunnable) : false;
}

/** Sobe a cadeia parentIssueId até a issue RAIZ do plano (a épica top-level). */
function rootPlanIssueOf(issue: Issue): Issue {
  let current = issue;
  for (let depth = 0; depth < 16 && current.parentIssueId; depth += 1) {
    const parent = issueRepo.get(current.parentIssueId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/** Título "limpo" de uma épica pra casar com a página `CONTRACT: <nome>` do KB. */
function epicContractName(title: string): string {
  return title
    .replace(/^\s*\[[^\]]+\]\s*/, '')
    .trim()
    .toLowerCase();
}

/**
 * CONTRATOS entre sub-épicas (HORIZON Fase 1.3): monta o bloco de prompt com as
 * páginas KB `CONTRACT: <nome>` relevantes pra esta issue — o contrato da PRÓPRIA
 * cadeia de épicas (o que esta sub-árvore deve expor) e os contratos das
 * sub-épicas de que os ancestrais DEPENDEM (o que consumir, mesmo já entregues —
 * por isso getRelations().blockedBy, não openBlockers). Clamp por página + cap de
 * páginas pra não estourar o contexto. Best-effort: qualquer falha → ''.
 */
function buildContractsBlock(issue: Issue): string {
  try {
    if (!issue.parentIssueId) return '';
    const pages = new KbPageRepository()
      .listByWorkspace(issue.workspaceId)
      .filter((p) => /^\s*contract\s*:/i.test(p.title));
    if (pages.length === 0) return '';
    const nameOfPage = (t: string): string =>
      t
        .replace(/^\s*contract\s*:/i, '')
        .trim()
        .toLowerCase();

    // Épicas-alvo: a cadeia de ancestrais + os bloqueadores (épicas) de cada uma.
    const targets = new Map<string, 'own' | 'dependency'>();
    let current: Issue | null = issueRepo.get(issue.parentIssueId);
    for (let depth = 0; depth < 8 && current; depth += 1) {
      targets.set(epicContractName(current.title), 'own');
      for (const blocker of relationsRepo.getRelations(current.id).blockedBy) {
        const name = epicContractName(blocker.title);
        if (!targets.has(name)) targets.set(name, 'dependency');
      }
      current = current.parentIssueId ? issueRepo.get(current.parentIssueId) : null;
    }

    const CONTRACT_MAX = 2500;
    const MAX_PAGES = 4;
    const sections: string[] = [];
    for (const page of pages) {
      if (sections.length >= MAX_PAGES) break;
      const kind = targets.get(nameOfPage(page.title));
      if (!kind) continue;
      const md = page.contentMd?.trim();
      if (!md) continue;
      const body =
        md.length > CONTRACT_MAX
          ? `${md.slice(0, CONTRACT_MAX)}\n…(contrato truncado — leia com kb_get_page({page_id: "${page.id}"}))`
          : md;
      const roleLine =
        kind === 'own'
          ? '(the contract THIS subtree must expose — implement exactly this)'
          : '(a dependency you CONSUME — match its shapes exactly, do not reinvent)';
      sections.push(`### ${page.title.trim()} ${roleLine}\n\n${body}`);
    }
    if (sections.length === 0) return '';
    return [
      '## Contracts between subsystems (from the Knowledge Base — the seams MUST fit)',
      '',
      ...sections,
    ].join('\n\n');
  } catch {
    return '';
  }
}

/**
 * Onda de execução RECURSIVA (HORIZON Fase 1.1 — o fractal): desce a árvore de
 * sub-épicas. Filho runnable que é FOLHA → executa; que é SUB-ÉPICA com plano →
 * ativa e dispara a onda dos filhos DELA; que é sub-épica PLACEHOLDER (sem filhos)
 * → turno de PLANEJAMENTO do sub-orquestrador (Fase 1.2). Sub-épicas já ativas
 * também são bombeadas (um blocker de outra sub-árvore pode ter destravado issues
 * lá dentro). `visited` corta ciclo de parent (defensivo — update_issue permite
 * re-parentar).
 */
export function startRunnablePlanIssueWave(
  parentIssueId: string,
  visited: Set<string> = new Set(),
): number {
  if (visited.has(parentIssueId)) return 0;
  visited.add(parentIssueId);
  const children = orderedPlanChildren(parentIssueId);
  const runnable = runnablePlanIssueWave(children, isBlockedByOpenDep, isParkedNoActor);
  let started = 0;
  for (const child of runnable) {
    const ready =
      child.status === 'backlog' ? issueRepo.update(child.id, { status: 'todo' }) : child;
    const childCount = issueRepo.listChildren(ready.id).length;
    if (isSubEpicIssue(ready, childCount)) {
      started += startSubEpicIssue(ready, childCount, visited);
    } else if (maybeAutoExecuteIssue(ready)) {
      started += 1;
    }
  }
  for (const child of children) {
    if (child.status !== 'in_progress' || visited.has(child.id)) continue;
    if (issueRepo.listChildren(child.id).length === 0) continue;
    started += startRunnablePlanIssueWave(child.id, visited);
  }
  return started;
}

/**
 * Ativa uma SUB-ÉPICA runnable. Com filhos = sub-plano já detalhado: marca
 * in_progress e desce a onda. Sem filhos = placeholder aguardando detalhamento:
 * pede o turno de planejamento do sub-orquestrador; se não houver como planejar
 * (sem sessão de origem / sem orquestrador), cai no comportamento antigo e
 * executa como folha — um placeholder jamais pode congelar o plano.
 */
function startSubEpicIssue(subEpic: Issue, childCount: number, visited: Set<string>): number {
  if (childCount > 0) {
    if (subEpic.status === 'todo' || subEpic.status === 'backlog') {
      issueRepo.update(subEpic.id, { status: 'in_progress' });
    }
    return startRunnablePlanIssueWave(subEpic.id, visited);
  }
  if (requestSubEpicPlanning(subEpic)) return 1;
  return maybeAutoExecuteIssue(subEpic) ? 1 : 0;
}

/**
 * Turno de PLANEJAMENTO do sub-orquestrador (HORIZON Fase 1.2): a sub-épica
 * placeholder vira um plano próprio. O orquestrador re-entra na sessão de origem
 * com um prompt oculto: Conselho local curto → publicar página `CONTRACT:` no KB
 * (Fase 1.3) → `create_issue_plan` com `parent_epic_key` da sub-épica (o plano já
 * foi aprovado na raiz — os filhos nascem em `todo` e a onda dispara sozinha).
 * Idempotente via flag `subPlanRequested` na metadata. Retorna true se o turno
 * foi pedido (ou já estava em andamento).
 */
function requestSubEpicPlanning(subEpic: Issue): boolean {
  const meta = (subEpic.metadata as Record<string, unknown> | null) ?? {};
  if (meta.subPlanRequested === true) return true;
  const root = rootPlanIssueOf(subEpic);
  const sessionId = originSessionIdOf(subEpic) ?? originSessionIdOf(root);
  const orchestrator = agentRepo.getOrchestrator(subEpic.workspaceId);
  if (!sessionId || !orchestrator) return false;
  issueRepo.update(subEpic.id, {
    status: 'in_progress',
    metadata: { ...meta, subPlanRequested: true },
  });
  const siblings = subEpic.parentIssueId ? orderedPlanChildren(subEpic.parentIssueId) : [];
  trace({
    level: 'info',
    source: 'issue',
    scope: 'sub-plan',
    issueKey: subEpic.issueKey,
    workspaceId: subEpic.workspaceId,
    message: `sub-épica #${subEpic.issueKey} enviada pro turno de planejamento do sub-orquestrador`,
  });
  void requestSubEpicPlanTurn({
    sessionId,
    subEpicKey: subEpic.issueKey,
    subEpicTitle: subEpic.title,
    subEpicDescription: subEpic.description ?? '',
    rootPlanTitle: root.title,
    siblings: siblings
      .filter((s) => s.id !== subEpic.id)
      .map((s) => ({ key: s.issueKey, title: s.title, status: s.status })),
    // GOTCHAS NO PLANEJAMENTO (HORIZON Fase 4): aprendizados/bloqueios de
    // execuções passadas da mesma stack entram ANTES do plano nascer — o segundo
    // projeto não repete o erro do primeiro.
    learnings: getRelevantLearnings(
      subEpic.workspaceId,
      `${subEpic.title}\n${subEpic.description ?? ''}`,
      3,
      resolveIssueSource(subEpic)?.id ?? null,
    ),
  }).catch((err) => {
    console.warn('[sub-plan] turno de planejamento da sub-épica falhou:', err);
  });
  return true;
}

function maybeStartNextPlanIssue(completedIssue: Issue): boolean {
  if (!completedIssue.parentIssueId) return false;
  const waveStarted = startRunnablePlanIssueWave(completedIssue.parentIssueId);
  if (waveStarted > 0) {
    narratePlanProgress(completedIssue, null, waveStarted);
    return true;
  }
  const siblings = orderedPlanChildren(completedIssue.parentIssueId);
  const next = nextRunnablePlanIssue(completedIssue, siblings, isBlockedByOpenDep, isParkedNoActor);
  if (next) {
    const ready = next.status === 'backlog' ? issueRepo.update(next.id, { status: 'todo' }) : next;
    const started = maybeAutoExecuteIssue(ready);
    if (started) narratePlanProgress(completedIssue, ready, 0);
    return started;
  }
  // FRACTAL (HORIZON Fase 1.1): nada a avançar NESTE nível. Se a sub-épica pai
  // acabou de assentar via rollup (o update→done do repo já a fechou), o plano do
  // AVÔ precisa avançar — sobe um nível tratando a sub-épica como "concluída".
  const parent = issueRepo.get(completedIssue.parentIssueId);
  if (
    parent?.parentIssueId &&
    (parent.status === 'done' || parent.status === 'cancelled' || parent.status === 'blocked')
  ) {
    // COSTURA (HORIZON Fase 3): sub-épica fechou com contrato publicado → gera a
    // issue [INTEGRATION] que valida o contrato de forma EXECUTÁVEL antes dos
    // consumidores rodarem. A onda do avô (recursão abaixo) já a dispara.
    if (parent.status === 'done') maybeCreateIntegrationIssue(parent);
    return maybeStartNextPlanIssue(parent);
  }
  return false;
}

/**
 * Issue de INTEGRAÇÃO por costura (HORIZON Fase 3): quando uma SUB-ÉPICA com
 * página `CONTRACT:` publicada fecha, cria-se automaticamente uma issue folha
 * `[INTEGRATION]` sob o AVÔ que valida o contrato contra a implementação REAL —
 * teste executável (chamar endpoint, checar tabela, renderizar componente), não
 * leitura. Consumidores ainda não iniciados que dependiam da sub-épica passam a
 * depender TAMBÉM da integração (o gate fica na costura). Idempotente via flag
 * `integrationIssueCreated` na metadata da sub-épica. Best-effort: nunca lança.
 */
function maybeCreateIntegrationIssue(subEpic: Issue): void {
  try {
    if (!subEpic.parentIssueId || subEpic.status !== 'done') return;
    const meta = (subEpic.metadata as Record<string, unknown> | null) ?? {};
    if (meta.integrationIssueCreated === true) return;
    if (issueRepo.listChildren(subEpic.id).length === 0) return; // placeholder nunca detalhado
    const contractName = epicContractName(subEpic.title);
    const page = new KbPageRepository().listByWorkspace(subEpic.workspaceId).find(
      (p) =>
        /^\s*contract\s*:/i.test(p.title) &&
        p.title
          .replace(/^\s*contract\s*:/i, '')
          .trim()
          .toLowerCase() === contractName,
    );
    if (!page) return; // sem contrato publicado → sem costura declarada pra validar

    // Marca ANTES de criar (duas folhas fechando quase juntas não duplicam).
    issueRepo.update(subEpic.id, {
      metadata: { ...meta, integrationIssueCreated: true },
    });

    const assignee =
      findQaAgent(subEpic.workspaceId) ?? findCodeReviewer(subEpic.workspaceId) ?? null;
    const cleanName = subEpic.title.replace(/^\s*\[[^\]]+\]\s*/, '').trim();
    const originSessionId =
      originSessionIdOf(subEpic) ?? originSessionIdOf(rootPlanIssueOf(subEpic));
    const integration = issueRepo.create({
      workspaceId: subEpic.workspaceId,
      title: `[INTEGRATION] Contrato: ${cleanName}`.slice(0, 90),
      description: [
        `A sub-épica "${subEpic.title}" fechou e publicou o contrato \`${page.title.trim()}\` (KB page_id: ${page.id}).`,
        'Valide o contrato contra a implementação REAL — evidência executável, não leitura:',
        `- [ ] Ler o contrato (kb_get_page page_id="${page.id}") e listar cada promessa (endpoints/eventos/tabelas/componentes)`,
        '- [ ] Exercitar cada promessa de verdade (chamar o endpoint com payload real, checar a tabela, renderizar o componente) e comparar shapes com o contrato',
        '- [ ] Registrar a evidência por item em comment_on_issue; divergência PEQUENA → corrigir aqui; GRANDE → reabrir issue precisa apontando o contrato',
      ].join('\n'),
      status: assignee ? 'todo' : 'backlog',
      priority: 'high',
      labels: ['integration'],
      assigneeAgentId: assignee?.id ?? null,
      parentIssueId: subEpic.parentIssueId,
      goalId: subEpic.goalId,
      metadata: {
        ...(originSessionId ? { originSessionId } : {}),
        done: `contrato "${cleanName}" validado com evidência executável por item`,
        integrationOfIssueId: subEpic.id,
        planPageId: page.id,
      },
    });
    // Gate NA COSTURA: consumidores ainda não iniciados que dependiam da sub-épica
    // passam a depender também da validação de integração. Só com assignee capaz de
    // executá-la — senão a issue vira gate sem ator e congelaria os consumidores.
    if (assignee) {
      for (const consumer of relationsRepo.getRelations(subEpic.id).blocking) {
        const c = issueRepo.get(consumer.id);
        if (!c || (c.status !== 'todo' && c.status !== 'backlog')) continue;
        try {
          relationsRepo.addDependency(subEpic.workspaceId, integration.id, c.id);
        } catch (err) {
          console.warn('[integration] aresta de dependência ignorada:', err);
        }
      }
    }
    trace({
      level: 'info',
      source: 'issue',
      scope: 'integration',
      issueKey: integration.issueKey,
      workspaceId: subEpic.workspaceId,
      message: `costura: criada ${integration.title} pra validar o contrato da sub-épica #${subEpic.issueKey}`,
    });
    broadcastBoardChanged(subEpic.workspaceId, 'integration-issue');
  } catch (err) {
    console.warn('[integration] criação da issue de integração falhou:', err);
  }
}

/**
 * RETOMADA NO BOOT: re-dispara o trabalho que ficou PARADO quando o app fechou.
 * Roda UMA vez no boot, DEPOIS do recoverInterruptedWork (que devolve as issues
 * interrompidas pra `todo`). Reusa o sequenciador (respeita deps/ordem/anti-dup):
 *   - cada ÉPICA ativa (não-terminal, com filho pendente) → re-dispara a onda runnable;
 *   - cada issue SOLTA (sem épica-pai) em `todo` com ator → auto-executa.
 * Nada de plano não-aprovado roda: issues não-aprovadas ficam em `backlog`, não `todo`,
 * e a onda só promove backlog→todo dentro de um plano JÁ em andamento.
 */
export function resumeInterruptedWork(): { plans: number; issues: number } {
  let plans = 0;
  let issues = 0;
  for (const workspace of new WorkspaceRepository().listAll()) {
    const all = issueRepo.listByWorkspace(workspace.id);
    for (const epic of all) {
      if (!isEpicIssue(epic)) continue;
      if (epic.status === 'done' || epic.status === 'cancelled') continue;
      const children = orderedPlanChildren(epic.id);
      const hasPending = children.some((c) => c.status === 'todo' || c.status === 'in_progress');
      if (!hasPending) continue;
      const started = startRunnablePlanIssueWave(epic.id);
      if (started > 0) {
        plans += 1;
        issues += started;
      }
    }
    for (const issue of all) {
      if (issue.parentIssueId || isEpicIssue(issue) || issue.status !== 'todo') continue;
      if (maybeAutoExecuteIssue(issue)) issues += 1;
    }
    // RETOMADA FRIA (HORIZON Fase 2): issue folha em `in_progress` SEM run ativo é
    // órfã — o status avançou mas o run morreu com o app (o recoverInterruptedWork
    // só cobre issues cujo run 'running'/'queued' ficou registrado). Antes ficava
    // parada até intervenção manual. Devolve pra `todo` e re-executa com os guards
    // normais (assignee/adapter/pausa/halt) do maybeAutoExecuteIssue.
    for (const issue of all) {
      if (issue.status !== 'in_progress' || isEpicIssue(issue)) continue;
      if (!issue.assigneeAgentId) continue;
      const runs = issueRepo.listRuns(issue.id);
      if (runs.some((r) => r.status === 'running' || r.status === 'queued')) continue;
      const fresh = issueRepo.update(issue.id, { status: 'todo' });
      issueRepo.addComment({
        issueId: issue.id,
        authorKind: 'system',
        body: '⚠️ Retomada fria: a issue estava em andamento sem nenhum run ativo (órfã de um fechamento) — re-disparada.',
      });
      if (maybeAutoExecuteIssue(fresh)) issues += 1;
    }
  }
  if (plans > 0 || issues > 0) {
    console.log(`[boot] resume: re-disparados ${plans} plano(s) + ${issues} issue(s) paradas.`);
  }
  return { plans, issues };
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

async function collectIssueChangeSummary(
  source: WorkspaceSource | null | undefined,
  issue: Issue,
  agent: Agent,
): Promise<IssueChangeSummary | null> {
  if (!source?.path) return null;
  try {
    const status = await gitStatus(source.path);
    if (status.files.length === 0) return null;
    const files: IssueChangeFileSummary[] = [];
    for (const file of status.files.slice(0, 120)) {
      let additions = 0;
      let deletions = 0;
      if (file.staged) {
        const diff = await gitDiff(source.path, file.path, true);
        const counted = countDiffLines(diff);
        additions += counted.additions;
        deletions += counted.deletions;
      }
      if (file.unstaged) {
        const diff = await gitDiff(source.path, file.path, false);
        const counted = countDiffLines(diff);
        additions += counted.additions;
        deletions += counted.deletions;
      }
      files.push({ path: file.path, additions, deletions });
    }
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    const patch = await gitCombinedDiff(
      source.path,
      files.map((file) => file.path),
    );
    const snapshot = createIssueChangeSnapshot({
      workspaceId: issue.workspaceId,
      sourceId: source.id,
      issueId: issue.id,
      files: files.map((file) => file.path),
      patch,
    });
    trace({
      level: 'success',
      source: 'issue',
      scope: 'changes',
      workspaceId: issue.workspaceId,
      issueKey: issue.issueKey,
      agentId: agent.id,
      agentName: agent.name,
      message: `diff capturado · ${files.length} arquivo(s) · +${additions} -${deletions} · ${source.label}${snapshot ? ' · undo transacional pronto' : ''}`,
    });
    return {
      sourceId: source.id,
      sourceLabel: source.label,
      issueId: issue.id,
      issueKey: issue.issueKey,
      issueTitle: issue.title,
      snapshotId: snapshot?.id,
      files,
      additions,
      deletions,
    };
  } catch (err) {
    trace({
      level: 'warn',
      source: 'issue',
      scope: 'changes',
      workspaceId: issue.workspaceId,
      issueKey: issue.issueKey,
      agentId: agent.id,
      agentName: agent.name,
      message: `nao foi possivel capturar diff: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }
}

function xmlAttr(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderCodeChangeSummaryBlock(summary: IssueChangeSummary | null): string {
  if (!summary || summary.files.length === 0) return '';
  const fileLines = summary.files
    .map(
      (file) =>
        `<file path="${xmlAttr(file.path)}" additions="${file.additions}" deletions="${file.deletions}" />`,
    )
    .join('\n');
  return [
    `<orkestral:code-changes source_id="${xmlAttr(summary.sourceId)}" source_label="${xmlAttr(
      summary.sourceLabel,
    )}" issue_id="${xmlAttr(summary.issueId)}" issue_key="${summary.issueKey}" issue_title="${xmlAttr(summary.issueTitle)}"${summary.snapshotId ? ` snapshot_id="${xmlAttr(summary.snapshotId)}"` : ''} files="${summary.files.length}" additions="${summary.additions}" deletions="${summary.deletions}">`,
    fileLines,
    '</orkestral:code-changes>',
  ].join('\n');
}

function rememberIssueChangeBlock(issue: Issue, changeBlock: string, snapshotId?: string): void {
  if (!changeBlock.trim() && !snapshotId) return;
  issueRepo.update(issue.id, {
    metadata: {
      ...((issue.metadata as Record<string, unknown>) ?? {}),
      ...(changeBlock.trim() ? { lastCodeChangeBlock: changeBlock } : {}),
      // Snapshot do patch real do Forge → o reviewer recebe o DIFF concreto
      // (<orkestral:forge-diff>) em vez de re-descobrir via `git diff`.
      ...(snapshotId ? { lastChangeSnapshotId: snapshotId } : {}),
    },
  });
}

/** Economia estimada de UM run local (counterfactual): o premium não rodou. */
interface IssueLocalEconomics {
  savedUsd: number;
  inputTokens: number;
  outputTokens: number;
  priceLabel: string;
}

/** Formata USD pequeno legível (sub-cent vira "<$0.01"). */
function formatSavedUsd(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * Persiste a economia counterfactual do run na metadata da issue (UI mostra o chip
 * "economizou ~$X"). Aditivo — re-busca a issue pra não clobberar outros campos.
 */
function rememberIssueLocalEconomics(issue: Issue, econ: IssueLocalEconomics): void {
  const fresh = issueRepo.get(issue.id) ?? issue;
  issueRepo.update(issue.id, {
    metadata: {
      ...((fresh.metadata as Record<string, unknown>) ?? {}),
      localEconomics: econ,
    },
  });
}

/** Máximo de chars do diff embutido no prompt do reviewer (evita estourar contexto). */
const FORGE_DIFF_PROMPT_MAX_CHARS = 16000;

/**
 * Diff REAL do Forge pro reviewer: lê o snapshot do patch persistido em
 * metadata.lastChangeSnapshotId e o injeta como bloco <orkestral:forge-diff>. Assim
 * o revisor confere EXATAMENTE o que mudou (não re-descobre via `git diff`, que pode
 * ter divergido). Retorna '' se não houver snapshot/patch (cai no fluxo antigo).
 */
function renderForgeDiffForReview(issue: Issue): string {
  const snapshotId = (issue.metadata as { lastChangeSnapshotId?: string } | null)
    ?.lastChangeSnapshotId;
  if (!snapshotId) return '';
  try {
    const { record, patch } = readIssueChangeSnapshot(issue.workspaceId, snapshotId);
    if (!patch.trim()) return '';
    const truncated =
      patch.length > FORGE_DIFF_PROMPT_MAX_CHARS
        ? patch.slice(0, FORGE_DIFF_PROMPT_MAX_CHARS) +
          '\n… (diff truncado — leia os arquivos afetados para o restante)'
        : patch;
    return [
      `<orkestral:forge-diff files="${record.files.length}">`,
      truncated,
      '</orkestral:forge-diff>',
    ].join('\n');
  } catch {
    return '';
  }
}

/**
 * Persiste o veredito de verificação na metadata, preservando o resto (re-busca a
 * issue pra não sobrescrever lastCodeChangeBlock/parkedNoActor — issueRepo.update
 * troca a metadata por inteiro).
 */
function rememberIssueVerification(issue: Issue, state: IssueVerificationState): void {
  const current = issueRepo.get(issue.id) ?? issue;
  const meta = (current.metadata as Record<string, unknown> | null) ?? {};
  issueRepo.update(issue.id, { metadata: { ...meta, verification: state } });
}

/** Um run desta issue é de REVISÃO (gestor validando) e não de execução? */
function isReviewRun(issue: Issue, agentId: string): boolean {
  const review = (issue.metadata as { review?: ReviewMeta } | null)?.review;
  return !!review && agentId !== review.executorAgentId;
}

/**
 * Decide o destino da issue após um run de SUCESSO: sobe pro gestor validar,
 * sobe mais um nível, volta pro executor corrigir, ou finaliza de vez.
 */
/**
 * Nível de autonomia do workspace — guardado no runtimeConfig do orquestrador
 * (CEO, 1 por workspace). Governa quanto o time finaliza sozinho vs. sobe pra
 * revisão. Default 'medium'.
 */
function workspaceAutonomyLevel(workspaceId: string): 'low' | 'medium' | 'high' {
  const ceo = agentRepo.getOrchestrator(workspaceId);
  const rc = (ceo?.runtimeConfig ?? {}) as { autonomyLevel?: 'low' | 'medium' | 'high' };
  return rc.autonomyLevel ?? 'medium';
}

function routeReviewOrFinish(issueId: string, ranAgentId: string, summary: string): void {
  const issue = issueRepo.get(issueId);
  if (!issue) return;
  const ranAgent = agentRepo.get(ranAgentId);
  const review = (issue.metadata as { review?: ReviewMeta } | null)?.review;

  // (A) Foi um run de REVISÃO (o gestor acabou de validar).
  if (review && ranAgentId !== review.executorAgentId) {
    const decision = decideReviewRun({
      issueStatus: issue.status,
      attempts: review.attempts,
      maxAttempts: MAX_REVIEW_ATTEMPTS,
    });
    // Reprovado (gestor reassinou de volta pro executor + status todo): re-executa
    // o executor pra corrigir. RETORNO CONTÍNUO: conta no chat o veredito de
    // "requer mudanças" ANTES de re-executar — antes era silencioso.
    if (decision === 'reexecute') {
      // Veredito NEGATIVo: o revisor pediu mudanças → o trabalho local produzido
      // não passou na verificação. Estampa antes da re-execução (que cria novo run).
      stampVerifiedVerdict(issue.id, false);
      reportReviewToOriginSession(
        issue,
        'changes_requested',
        ranAgent?.name,
        agentRepo.get(review.executorAgentId)?.name,
        summary,
      );
      // Convergência: o comentário corretivo do revisor (último 'agent') tem que
      // ENTRAR no prompt da re-execução — senão o Forge local recebe instrução
      // byte-idêntica e reproduz o mesmo edit errado. Persiste como reviewFocus +
      // conta a tentativa (bounded por MAX_REVIEW_ATTEMPTS, que estaciona pra
      // humano). NUNCA força premium: economia é o pilar — o local tenta de novo
      // com o foco do revisor e, se não converge, ESTACIONA (sem escalar). Re-fetch
      // + spread pra não clobberar lastCodeChangeBlock/verification/parkedNoActor.
      const reviewFocus = [...issueRepo.listComments(issue.id)]
        .reverse()
        .find((cm) => cm.authorKind === 'agent')?.body;
      const fresh = issueRepo.get(issue.id);
      const currentMeta = (fresh?.metadata as Record<string, unknown> | null) ?? {};
      const reexecuteCount = ((currentMeta.reexecuteCount as number | undefined) ?? 0) + 1;

      // CAP ROBUSTO de convergência: usa o contador PERSISTIDO (reexecuteCount), NÃO
      // o review.attempts (que se perdia entre runs → o cap nunca disparava → loop
      // infinito). Esgotou as tentativas corretivas → estaciona pra humano em vez de
      // re-executar pra sempre.
      if (reexecuteCount > MAX_REEXECUTE_ATTEMPTS) {
        const parked = issueRepo.update(issue.id, { status: 'in_review' });
        markParkedNoActor(parked);
        const shortReason = (reviewFocus ?? summary).replace(/\s+/g, ' ').trim().slice(0, 240);
        issueRepo.addComment({
          issueId: issue.id,
          body: `❌ Não consegui resolver esta issue — a revisão reprovou ${MAX_REEXECUTE_ATTEMPTS}x seguidas e o trabalho não passou. Precisa de você.\n\nÚltimo veredito do revisor: ${shortReason}${(reviewFocus ?? summary).length > 240 ? '…' : ''}`,
          authorKind: 'system',
        });
        finalizeIssue(parked, summary, false);
        maybeReplanOnDivergence(parked, 'attempts_exhausted', reviewFocus ?? summary);
        return;
      }

      // Re-executa LOCAL com o foco do revisor (não escala pro premium — o executor
      // faz o trabalho; premium não é a muleta de cada tropeço). Bounded pelo cap
      // acima: esgotou as tentativas corretivas → estaciona pra humano.
      issueRepo.update(issue.id, {
        metadata: {
          ...currentMeta,
          ...(reviewFocus ? { reviewFocus } : {}),
          reexecuteCount,
        },
      });
      // CICLO FECHADO: revisor reprovando REPETIDAMENTE é divergência. Ao cruzar o
      // limiar, o CEO RE-ENTRA pra re-escopar/re-delegar (corretivas). Dispara uma vez
      // (=== 2); o budget por plano evita repetir.
      if (reexecuteCount === 2) {
        maybeReplanOnDivergence(issue, 'review_rejected', reviewFocus ?? summary);
      }
      // ÉPICO reprovado no review FINAL: não existe "re-executar épico" (ele orquestra
      // filhos). O replan acima já pode ter criado sub-issues corretivas; estaciona o
      // épico pra humano até elas rodarem/o dono decidir, em vez de re-orquestrar à toa.
      if (isEpicIssue(issue)) {
        const parkedEpic = issueRepo.update(issue.id, { status: 'in_review' });
        markParkedNoActor(parkedEpic);
        return;
      }
      setImmediate(() => {
        try {
          executeIssue(issue.id);
        } catch (err) {
          console.warn('[review] re-exec do executor falhou:', err);
        }
      });
      return;
    }
    if (decision === 'terminal') {
      return;
    }
    // Revisor encerrou o run SEM veredito explícito (nem aprovou via status=done
    // nem reassinou pro executor). Não concluímos por silêncio: estaciona in_review
    // SEM ator (a flag persistida deixa a épica assentar e o irmão seguinte rodar)
    // e pede um veredito explícito.
    if (decision === 'needs_verdict') {
      const reviewMeta = (issue.metadata as { review?: ReviewMeta } | null)?.review;
      // Re-prompt FORÇADO uma vez antes de estacionar: o reviewer (CLI claude_local)
      // às vezes escreve o veredito em prosa mas ESQUECE de chamar update_issue_status.
      // Damos UMA última passada forçando o veredito explícito. Se ainda não vier,
      // estaciona pra humano (NUNCA aprova por silêncio). Bounded por verdictNudged.
      if (reviewMeta && !reviewMeta.verdictNudged) {
        const freshMeta =
          (issueRepo.get(issue.id)?.metadata as Record<string, unknown> | null) ?? {};
        issueRepo.update(issue.id, {
          status: 'in_review',
          metadata: {
            ...freshMeta,
            review: { ...reviewMeta, verdictNudged: true },
            forceVerdictNextRun: true,
          },
        });
        issueRepo.addComment({
          issueId: issue.id,
          body: mt(
            '⏳ Revisor encerrou sem veredito — pedindo o veredito EXPLÍCITO numa última passada (aprovar ou pedir ajustes).',
            '⏳ Reviewer ended without a verdict — asking for the EXPLICIT verdict in a final pass (approve or request changes).',
          ),
          authorKind: 'system',
        });
        setImmediate(() => {
          try {
            executeIssue(issue.id);
          } catch (err) {
            console.warn('[review] re-prompt de veredito falhou:', err);
          }
        });
        return;
      }
      // Já foi pedido o veredito e ainda não veio → estaciona pra humano (sem
      // ator); não conclui por silêncio.
      const parked = issueRepo.update(issue.id, { status: 'in_review' });
      markParkedNoActor(parked);
      issueRepo.addComment({
        issueId: issue.id,
        body: mt(
          '⏳ Revisor encerrou sem veredito explícito — marque APROVADO (update_issue_status status=done) ou peça ajustes. Não concluo por silêncio.',
          '⏳ Reviewer ended without an explicit verdict — approve (update_issue_status status=done) or request changes. Not completed by silence.',
        ),
        authorKind: 'system',
      });
      reportReviewToOriginSession(parked, 'sent_for_review', ranAgent?.name, undefined, summary);
      finalizeIssue(parked, summary, false);
      return;
    }

    // Gate REAL de approvers: a cadeia de review (reportsTo) é separada dos
    // approvers explícitos. Mesmo aprovado pelo gestor, se há approver pendente
    // ou rejeitado a issue não conclui (fica blocked/in_review com comentário).
    if (!passesApproverGate(issue, summary)) return;

    // Aprovado via token afirmativo (status='done'): decideReviewRun só retorna
    // 'approve' quando a issue já está 'done', então o update é no-op defensivo.
    const approvedIssue =
      issue.status === 'done' ? issue : issueRepo.update(issue.id, { status: 'done' });
    reportReviewToOriginSession(approvedIssue, 'approved', ranAgent?.name, undefined, summary);
    const codeReviewer = findCodeReviewer(approvedIssue.workspaceId);
    // Lead aprovou mas o trabalho ainda NÃO passou pelo Code Reviewer → sobe pro
    // reviewer (validação de código). Code Reviewer aprovou → é a validação final,
    // finaliza (o CEO faz o RELATÓRIO no chat, não mais uma revisão).
    const needsCodeReview =
      isLeadAgent(ranAgent) &&
      codeReviewer &&
      codeReviewer.id !== ranAgent?.id &&
      !isCodeReviewerAgent(agentRepo.get(review.executorAgentId));
    if (needsCodeReview && codeReviewer && review.depth + 1 < MAX_REVIEW_DEPTH) {
      startReview(approvedIssue, ranAgentId, codeReviewer, review.depth + 1, review.attempts);
    } else {
      finalizeIssue(approvedIssue, summary, false); // topo da validação → done de verdade
    }
    return;
  }

  // (B) Foi um run de EXECUÇÃO — precisa de VALIDAÇÃO antes de fechar.
  // SUB-ISSUE (tem pai): NÃO revisa individualmente. Revisar cada sub-issue dispara um
  // review (premium) por issue — caro e causava o vai-e-vem executor↔revisor (loop). O
  // Code Reviewer roda UMA vez no FIM, na issue PAI/épico (maybeReportPlanCompletion).
  // A sub-issue conclui e o sequenciador segue pro próximo irmão. Issues SEM pai
  // (standalone) continuam revisadas normalmente abaixo.
  if (issue.parentIssueId) {
    finalizeIssue(issue, summary, true);
    return;
  }
  const attempts = review && review.executorAgentId === ranAgentId ? review.attempts + 1 : 0;
  if (attempts > MAX_REVIEW_ATTEMPTS) {
    const parked = issueRepo.update(issue.id, { status: 'in_review' });
    // Estacionada SEM ator: nenhum run vai retomá-la sozinho (precisa de humano).
    // Marca a flag persistida pra não travar os irmãos do plano nem após restart.
    markParkedNoActor(parked);
    // Feedback = última fala do revisor/executor (a razão da reprovação).
    const reviewerFeedback =
      [...issueRepo.listComments(issue.id)].reverse().find((cm) => cm.authorKind === 'agent')
        ?.body ?? summary;
    // Mensagem CLARA de não-resolução (não o genérico "esgotou as tentativas"): diz
    // que NÃO fechou, quantas tentativas, e o MOTIVO (resumo do veredito do revisor).
    const shortReason = reviewerFeedback.replace(/\s+/g, ' ').trim().slice(0, 240);
    issueRepo.addComment({
      issueId: issue.id,
      body: `❌ Não consegui resolver esta issue — a revisão reprovou ${MAX_REVIEW_ATTEMPTS}x seguidas e o trabalho não passou. Precisa de você.\n\nÚltimo veredito do revisor: ${shortReason}${reviewerFeedback.length > 240 ? '…' : ''}`,
      authorKind: 'system',
    });
    finalizeIssue(parked, summary, false);
    // CICLO FECHADO: a sub-issue divergiu (esgotou a revisão). Antes de o plano
    // congelar, o CEO RE-ENTRA e pode emitir um PATCH (sub-issue corretiva re-
    // escopada). Adição ao park (acima) — não o substitui; budget POR PLANO evita loop.
    maybeReplanOnDivergence(parked, 'attempts_exhausted', reviewerFeedback);
    return;
  }
  // O Code Reviewer SEMPRE valida trabalho de CÓDIGO de um executor (não o próprio
  // reviewer) — inclusive em autonomia alta, que é o ponto de ter um Code Reviewer.
  // Trabalho que NÃO mexeu código (ex.: investigação) não precisa de code review.
  // Sem Code Reviewer: cai no gestor (reportsTo); autonomia alta sem reviewer
  // finaliza direto ("manda e dorme").
  const touchedCode = !!(issue.metadata as { lastCodeChangeBlock?: string } | null)
    ?.lastCodeChangeBlock;
  const ranIsReviewer = isCodeReviewerAgent(ranAgent);
  const codeReviewer = findCodeReviewer(issue.workspaceId);
  const manager = ranAgent?.reportsTo ? agentRepo.get(ranAgent.reportsTo) : null;
  let reviewer: Agent | null = null;
  if (touchedCode && !ranIsReviewer && codeReviewer && codeReviewer.id !== ranAgentId) {
    reviewer = codeReviewer;
  } else if (manager && workspaceAutonomyLevel(issue.workspaceId) !== 'high') {
    reviewer = manager;
  }
  if (reviewer) {
    reportReviewToOriginSession(issue, 'sent_for_review', reviewer.name, undefined, summary);
    startReview(issue, ranAgentId, reviewer, 0, attempts);
    return;
  }
  finalizeIssue(issue, summary, true);
}

/** Há plano PENDENTE pra esta sessão? (os canais usam pra saber se "aprovar" se aplica). */
export function hasPendingPlanForSession(workspaceId: string, sessionId: string): boolean {
  return issueRepo.listByWorkspace(workspaceId).some((i) => {
    const plan = (i.metadata as { plan?: { status?: string; sessionId?: string } } | null)?.plan;
    return plan?.status === 'pending' && plan.sessionId === sessionId;
  });
}

/**
 * Aprova (e executa) o plano pendente de uma sessão. NÚCLEO compartilhado entre o card do
 * chat (issues:run-plan) e a aprovação por canal (WhatsApp "aprovar"). `selectedEpicIds`
 * limita aos épicos escolhidos (+ filhos); `replanEpics` segura o épico e registra o
 * comentário. Sem opts = aprova o plano TODO. Backward-compatible.
 */
export function approveSessionPlan(
  workspaceId: string,
  sessionId: string,
  opts?: { selectedEpicIds?: string[]; replanEpics?: Array<{ epicId: string; comment: string }> },
): { started: number; approvedPlans: number } {
  let started = 0;
  let approvedPlans = 0;
  const now = new Date().toISOString();
  const issues = issueRepo.listByWorkspace(workspaceId);
  if (!hasPendingPlanForSession(workspaceId, sessionId)) return { started: 0, approvedPlans: 0 };

  // `undefined` = sem seleção (aprova tudo, legado). `[]` = usuário desmarcou TODOS →
  // aprova NADA (não o plano inteiro), evitando execução não intencionada.
  const sel = opts?.selectedEpicIds !== undefined ? new Set(opts.selectedEpicIds) : null;
  const replanMap = new Map((opts?.replanEpics ?? []).map((r) => [r.epicId, r.comment]));
  const isSelected = (i: Issue): boolean =>
    !sel || sel.has(i.id) || (!!i.parentIssueId && sel.has(i.parentIssueId));
  const isHeld = (i: Issue): boolean =>
    replanMap.has(i.id) || (!!i.parentIssueId && replanMap.has(i.parentIssueId));

  for (const [epicId, comment] of replanMap) {
    if (comment.trim()) {
      issueRepo.addComment({
        issueId: epicId,
        body: `📝 Refinar antes de executar: ${comment.trim()}`,
        authorKind: 'user',
      });
    }
  }
  for (const issue of issues) {
    const metadata = (issue.metadata ?? {}) as Record<string, unknown>;
    const plan = metadata.plan as
      | ({ status?: string; sessionId?: string } & Record<string, unknown>)
      | undefined;
    if (plan?.status === 'pending' && plan.sessionId === sessionId) {
      if (isHeld(issue) || !isSelected(issue)) continue;
      issueRepo.update(issue.id, {
        metadata: {
          ...metadata,
          plan: { ...plan, status: 'approved', decidedAt: now, decisionSource: 'chat' },
        },
      });
      approvedPlans++;
    }
  }
  for (const issue of issues) {
    const meta = issue.metadata as { originSessionId?: string } | null;
    if (meta?.originSessionId !== sessionId) continue;
    if (issue.status !== 'backlog' && issue.status !== 'todo') continue;
    if (!issue.assigneeAgentId) continue;
    if (issueRepo.listChildren(issue.id).length > 0) continue;
    if (isHeld(issue) || !isSelected(issue)) continue;
    try {
      executeIssue(issue.id);
      started++;
    } catch (err) {
      console.warn('[approveSessionPlan] falha ao executar', issue.issueKey, err);
    }
  }
  return { started, approvedPlans };
}

/**
 * Dispara a execução da issue em background. Retorna o runId imediatamente
 * (não aguarda terminar). Os events são emitidos via broadcast.
 */
export function executeIssue(issueId: string): { runId: string } {
  const issue = issueRepo.get(issueId);
  if (!issue) throw new Error(`Issue ${issueId} não encontrada`);
  // Execução HALTED (usuário apertou parar): não inicia run novo. Lança pra o caller
  // (re-exec/sequenciador) tratar como no-op; o halt limpa na próxima mensagem.
  if (haltedWorkspaces.has(issue.workspaceId)) {
    throw new Error(`Execução pausada pelo usuário no workspace ${issue.workspaceId}`);
  }
  // Anti-duplicação: já rodando OU já enfileirada não pode entrar de novo —
  // senão "Executar" (ou um auto-exec concorrente) spawna 2 runs da mesma issue.
  if (activeRuns.has(issueId) || runQueue.some((j) => j.issueId === issueId)) {
    throw new Error(`Issue ${issue.issueKey} já está em execução`);
  }

  // Gate de dependência REAL: issue com blockedBy ainda aberto (não done/
  // cancelled) não executa — bloquear com erro claro em vez de rodar fora de ordem.
  const blockers = openBlockersOf(issueId);
  if (blockers.length > 0) {
    const list = blockers.map((b) => `#${b.issueKey}`).join(', ');
    throw new Error(
      `Issue ${issue.issueKey} está bloqueada por dependência(s) ainda aberta(s): ${list}. Conclua-as antes de executar.`,
    );
  }

  // Ator atual = revisor (enquanto in_review) ou o responsável. O responsável
  // (assigneeAgentId) NUNCA muda na revisão — quem age muda via review.reviewerAgentId.
  const actorId = currentActorId(issue);
  if (!actorId) {
    throw new Error(
      `Issue ${issue.issueKey} sem agente assignee. Atribua um agente antes de executar.`,
    );
  }
  const agent = agentRepo.get(actorId);
  if (!agent) {
    throw new Error(`Agente da issue ${issue.issueKey} não existe mais`);
  }
  if (!agent.adapterType || !ISSUE_EXEC_ADAPTERS.includes(agent.adapterType)) {
    // Adapters meia-bomba conhecidos → mensagem honesta "em breve".
    if (agent.adapterType && isUnavailableExecAdapter(agent.adapterType)) {
      throw new Error(unavailableAdapterMessage(agent.adapterType));
    }
    throw new Error(
      `Agente "${agent.name}" usa adapter "${agent.adapterType}" — execução de issue não disponível para esse adapter.`,
    );
  }

  // Execução normal entra em progresso; execução de revisão permanece em
  // review. Antes toda review era sobrescrita para in_progress, gerando o
  // efeito visual review → queued/running → review e deixando o fluxo instável.
  const reviewExecution = isReviewRun(issue, agent.id);
  issueRepo.update(issueId, { status: reviewExecution ? 'in_review' : 'in_progress' });

  // Feedback em TEMPO REAL: quando um agente é escalado pra revisar, ele comenta NA
  // HORA que está analisando — em vez de silêncio até o veredito. Só na passada
  // normal (no re-prompt forçado de veredito, forceVerdictNextRun, o prompt já
  // avisa que é a última passada, então não duplica).
  if (
    reviewExecution &&
    !(issue.metadata as { forceVerdictNextRun?: boolean } | null)?.forceVerdictNextRun
  ) {
    const rMeta = (issue.metadata as { review?: ReviewMeta } | null)?.review;
    const execName = rMeta
      ? (agentRepo.get(rMeta.executorAgentId)?.name ?? 'o executor')
      : 'o executor';
    issueRepo.addComment({
      issueId,
      body: `🔍 **${agent.name}** está analisando o trabalho de **${execName}**…`,
      authorKind: 'agent',
      authorAgentId: agent.id,
    });
  }

  // Cria IssueRun em 'queued' (na fila) gravando o adapterType do agente. O
  // serviço promove pra 'running' (markRunRunning) quando o run de fato inicia.
  const run = issueRepo.startRun({
    issueId,
    agentId: agent.id,
    status: 'queued',
    adapterType: agent.adapterType,
  });
  const rootTrace = startAgentTraceStep({
    workspaceId: issue.workspaceId,
    runId: run.id,
    issueId: issue.id,
    issueKey: issue.issueKey,
    agentId: agent.id,
    agentName: agent.name,
    kind: 'run',
    title: `Executando issue ${issue.issueKey}: ${issue.title}`,
    payload: {
      adapterType: agent.adapterType,
      model: agent.model ?? null,
      priority: issue.priority,
      labels: issue.labels,
    },
  });
  startMultiAgentRun({
    issue,
    runId: run.id,
    agentId: agent.id,
    agentName: agent.name,
    parentTraceId: rootTrace.id,
  });

  emit({
    type: 'queued',
    issueId,
    runId: run.id,
    message: `${agent.name} aguardando janela segura de execução`,
  });
  trace({
    level: 'info',
    source: 'issue',
    scope: 'run',
    issueKey: issue.issueKey,
    workspaceId: issue.workspaceId,
    agentId: agent.id,
    agentName: agent.name,
    message: `${agent.name} começou a trabalhar em "${issue.title}"`,
  });

  // Enfileira com gating de concorrência: runs no mesmo source nunca concorrem,
  // e o Forge fica serializado (ver pumpRunQueue/canStart).
  enqueueRun({
    issueId: issue.id,
    runId: run.id,
    rootTraceId: rootTrace.id,
    run: () =>
      runIssueAsync(issue, agent, run.id, rootTrace.id).catch((err) => {
        console.error('[issue-exec] unexpected error:', err);
      }),
    sourceKey: resolveSourceKey(issue),
    adapterType: agent.adapterType,
  });

  return { runId: run.id };
}

/**
 * Decide se uma issue recém-criada deve disparar execução automática do agente
 * assignee. Centraliza a regra pros 3 callsites: handler IPC `issue:create-full`,
 * processIssueBlocksInText (blocos no chat) e MCP tool `create_issue`.
 *
 * Critérios (qualquer um dispara):
 *   1. Label `auto-exec` presente — convenção explícita.
 *   2. Metadata `kind=kb-analysis` com `autoExec: true` — análise de source.
 *   3. Status já vem como `todo` E há assignee de adapter claude_local — assume
 *      que o criador quer execução imediata. `backlog` NÃO dispara.
 *
 * Retorna `false` (não dispara) se:
 *   - sem assignee, ou
 *   - assignee não usa claude_local (executeIssue ainda não suporta outros), ou
 *   - assignee está pausado.
 */
export function maybeAutoExecuteIssue(issue: Issue): boolean {
  if (!issue.assigneeAgentId) return false;
  // Execução HALTED (stop global do usuário): não auto-avança o plano.
  if (haltedWorkspaces.has(issue.workspaceId)) return false;
  // ÉPICA = container, não unidade executável. Auto-executar uma épica spawna um
  // run de escopo amplo (o executor faz o trabalho macro da épica em vez da
  // sub-issue folha) — o bug real de "escopo errado". Épicas só orquestram seus
  // filhos via o sequenciador; quem roda são as folhas. Detecção robusta: tem
  // filhos (mesma convenção do heartbeat) OU título [ÉPICA]/[EPIC] OU label epic.
  if (isEpicIssue(issue)) return false;
  // Issue que o próprio executor abriu pra si durante o chat dele (reporter ===
  // assignee): ele já está fazendo o trabalho inline na conversa. Auto-executar
  // aqui spawnaria um run DUPLICADO da mesma task. O delegation real (CEO →
  // especialista) tem reporter ≠ assignee, então segue normal.
  if (issue.reporterAgentId && issue.reporterAgentId === issue.assigneeAgentId) return false;
  const agent = agentRepo.get(issue.assigneeAgentId);
  if (!agent || !isIssueExecAdapter(agent.adapterType)) return false;
  if (agent.status === 'paused') return false;

  // ORÇAMENTO HONESTO (HORIZON Fase 2): goal com token_budget ESTOURADO → nenhuma
  // issue nova inicia pelo scheduler. O loop de convergência posta o report de
  // parada com o número (rate-limited); quem decide continuar (subir o teto,
  // cortar escopo) é o usuário. Execução manual (executeIssue direto) não passa
  // por aqui — decisão explícita do usuário continua valendo.
  if (issue.goalId) {
    const goal = goalRepo.get(issue.goalId);
    if (
      goal?.tokenBudget &&
      goal.tokenBudget > 0 &&
      goal.status === 'active' &&
      goalRepo.spentTokens(goal.id) >= goal.tokenBudget
    ) {
      maybeRequestGoalConvergence(goal.id);
      return false;
    }
  }

  const meta = issue.metadata as { kind?: string; autoExec?: boolean } | null;
  const shouldRun =
    issue.labels.includes('auto-exec') ||
    (meta?.kind === 'kb-analysis' && !!meta.autoExec) ||
    issue.status === 'todo';
  if (!shouldRun) return false;

  // Já em execução OU já enfileirada? Não dispara de novo (anti-duplicação).
  if (activeRuns.has(issue.id) || runQueue.some((j) => j.issueId === issue.id)) return false;

  // Dependência blockedBy ainda aberta → não auto-executa (gate real). O
  // sequenciador segue pra próxima elegível quando o bloqueador fechar.
  if (openBlockersOf(issue.id).length > 0) return false;

  setImmediate(() => {
    try {
      executeIssue(issue.id);
    } catch (err) {
      console.warn(
        `[issue-exec] auto-exec falhou pra ${issue.issueKey}:`,
        err instanceof Error ? err.message : err,
      );
    }
  });
  return true;
}

/**
 * Cancela um run ENFILEIRADO (ainda não iniciou): finaliza o IssueRun como
 * cancelled e marca a issue como `cancelled`. Cancelamento é uma decisão
 * terminal do usuário; reabrir depois precisa ser explícito, não automático.
 * O caller é responsável por já ter removido o job da runQueue.
 */
function cancelQueuedRun(job: QueuedRun): void {
  const issue = issueRepo.finishRunAndSetStatus(
    job.runId,
    { status: 'cancelled', exitReason: 'cancelled_in_queue' },
    job.issueId,
    { status: 'cancelled' },
  );
  issueRepo.addComment({
    issueId: job.issueId,
    body: '⏸ Execução cancelada antes de sair da fila.',
    authorKind: 'system',
  });
  finishAgentTraceStep(job.rootTraceId, {
    status: 'skipped',
    summary: 'Execução cancelada antes de sair da fila.',
    payload: { status: 'cancelled', queued: true },
  });
  emit({
    type: 'finished',
    issueId: job.issueId,
    runId: job.runId,
    message: 'Cancelada antes de iniciar',
  });
  broadcastBoardChanged(issue.workspaceId, 'issue-cancel-queued');
}

export function cancelIssueExecution(issueId: string): boolean {
  // (A) Run ENFILEIRADO (ainda não iniciou): varre a runQueue. Antes só
  // activeRuns era checado → uma issue "queued" iniciava mesmo após cancelar.
  const queuedIdx = runQueue.findIndex((job) => job.issueId === issueId);
  if (queuedIdx >= 0) {
    const [job] = runQueue.splice(queuedIdx, 1);
    cancelQueuedRun(job);
    return true;
  }

  const active = activeRuns.get(issueId);
  if (!active) return false;
  // Marca cancelado mas NÃO remove de activeRuns aqui — o handler 'close' do run
  // (CLI) precisa ler `active.cancelled` pra finalizar o run no estado
  // 'cancelled'. A remoção acontece lá (runIssueAsync) quando o processo morre.
  active.cancelled = true;
  // Run de rede/Forge (sem subprocesso): aborta via AbortController e atualiza o
  // status da issue AQUI — esses caminhos não passam pelo handler 'close' do CLI,
  // então sem isto a issue ficaria presa em `in_progress` (travando o plano).
  if (!active.child) {
    active.abort?.abort();
    issueRepo.finishRun(active.runId, { status: 'cancelled', exitReason: 'cancelled' });
    const issue = issueRepo.get(issueId);
    if (issue && issue.status !== 'done') {
      if (issue.status !== 'cancelled') issueRepo.update(issueId, { status: 'cancelled' });
      issueRepo.addComment({
        issueId,
        body: '⏸ Execução cancelada pelo usuário.',
        authorKind: 'system',
      });
      emit({
        type: 'finished',
        issueId,
        runId: active.runId,
        message: 'Cancelada',
      });
      reportTerminalToOriginSession(issue, 'cancelled', 'Execução cancelada pelo usuário.');
      broadcastBoardChanged(issue.workspaceId, 'issue-cancel-active');
    }
    return true;
  }
  try {
    if (!active.child.killed) active.child.kill('SIGTERM');
  } catch {
    /* já morto */
  }
  // Fallback: se o SIGTERM não derrubar o processo (travado em syscall) em 3s,
  // força SIGKILL. Sem isso, "Cancelar execução" deixava o child zumbi vivo
  // segurando um slot da fila.
  const child = active.child;
  const killTimer = setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL');
    } catch {
      /* já morto */
    }
  }, 3000);
  if (typeof killTimer.unref === 'function') killTimer.unref();
  return true;
}

export function cancelIssueExecutionByRunId(runId: string): boolean {
  for (const active of activeRuns.values()) {
    if (active.runId === runId) {
      return cancelIssueExecution(active.issueId);
    }
  }
  const queuedIdx = runQueue.findIndex((job) => job.runId === runId);
  if (queuedIdx >= 0) {
    const [job] = runQueue.splice(queuedIdx, 1);
    cancelQueuedRun(job);
    return true;
  }
  return false;
}

async function runIssueAsync(
  issue: Issue,
  agent: import('../../shared/types').Agent,
  runId: string,
  rootTraceId?: string,
): Promise<void> {
  const finishRootTrace = (
    status: 'completed' | 'failed' | 'skipped',
    summary: string,
    payload?: Record<string, unknown>,
  ): void => {
    if (!rootTraceId) return;
    finishAgentTraceStep(rootTraceId, { status, summary, payload });
  };
  // Registra o run em activeRuns ANTES de qualquer roteamento de adapter: assim
  // Forge (orkestral_local) e adapters de rede (openclaw/cursor_cloud) — que não
  // têm subprocesso — também ficam canceláveis (via AbortController) e o guard
  // anti-duplicação (activeRuns.has) cobre todos os caminhos, não só o do CLI.
  // O caminho do CLI substitui o entry abaixo, anexando o `child`.
  const abort = new AbortController();
  activeRuns.set(issue.id, { issueId: issue.id, runId, cancelled: false, abort });
  // Promove o run de 'queued' (na fila) → 'running' agora que ele de fato iniciou.
  issueRepo.markRunRunning(runId, agent.adapterType);
  const cancelledNow = (): boolean => activeRuns.get(issue.id)?.cancelled ?? false;
  const cancelledByUser = (): boolean =>
    cancelledNow() || issueRepo.get(issue.id)?.status === 'cancelled';
  try {
    emit({
      type: 'started',
      issueId: issue.id,
      runId,
      message: `${agent.name} começou a trabalhar`,
    });
    // Board ao vivo: started → in_progress visível na IssuesPage sem depender do MCP.
    broadcastBoardChanged(issue.workspaceId, 'issue-run-started');
    ensureDefaultInstructions(agent);
    ensureBundledSkills(issue.workspaceId);

    // 1. Toggle "Ferramentas de browser (Chrome)" do agente. O config MCP é
    // montado MAIS ABAIXO (após resolver o adapter/model), reusando o mesmo
    // wiring do chat (buildMcpConfigForRun) — assim o executor herda orkestral +
    // MCPs do marketplace + playwright, em vez de só o orkestral hardcoded.
    const chromeEnabled = (agent.adapterConfig as Record<string, unknown> | null)?.chrome === true;

    // 2. Resolve cwd a partir do source ALVO da issue (ver resolveIssueSource):
    // issue de Backend roda no repo do backend, de Frontend no do frontend — não
    // mais tudo no primário.
    let cwd: string | undefined;
    let targetSource = resolveIssueSource(issue);
    if (targetSource?.path) {
      try {
        const sync = await ensureSourceFresh(targetSource, {
          waitForAnalysis: true,
          onPhase: (message) =>
            emit({
              type: 'phase',
              issueId: issue.id,
              runId,
              sourceId: targetSource?.id ?? null,
              sourceLabel: targetSource?.label ?? null,
              message,
            }),
        });
        if (sync) {
          targetSource = sync.source;
          emit({
            type: 'phase',
            issueId: issue.id,
            runId,
            sourceId: targetSource.id,
            sourceLabel: targetSource.label,
            message: sync.message,
          });
        }
      } catch (err) {
        // Freshness é OTIMIZAÇÃO, NUNCA gate: sync/reindex do source falhou → segue
        // com o estado atual (o agente lê os arquivos reais). Jamais mata a issue.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[issue-exec] freshness do source falhou (seguindo): ${msg}`);
        emit({
          type: 'phase',
          issueId: issue.id,
          runId,
          sourceId: targetSource?.id ?? null,
          sourceLabel: targetSource?.label ?? null,
          message: `Sync do source pulado (${msg}) — seguindo com o estado atual`,
        });
      }
    }
    if (targetSource?.path && existsSync(targetSource.path)) cwd = targetSource.path;
    console.log(
      `[issue-exec] cwd=${cwd ?? '<none>'} source=${targetSource?.label ?? '<none>'} agent=${agent.name}`,
    );

    // 2.5 Roteamento por adapter. Agentes executores (Orkestral Forge / modelo
    // local) geram um diff via llama.cpp e o APP aplica/valida — sem custo de
    // API. Tarefas de risco / sem modelo local / falha local escalam pro modelo
    // premium (spawn abaixo com um adapter premium resolvido). Premium continua
    // inalterado pros agentes claude_local/codex_local.
    let effectiveAdapter: AdapterType = agent.adapterType ?? 'claude_local';
    let effectiveModel: string | null = agent.model ?? null;
    // Este run escalou do Forge pro premium? Grava exitReason no IssueRun final.
    let escalatedToPremium = false;

    const routingSettings = settingsRepo.get().aiRouting;
    const reviewingRun = isReviewRun(issue, agent.id);
    // Planejamento/spec/arquitetura/review → roda no MODELO do agente (premium
    // configurado, ex.: Opus), NÃO no Forge executor: o deliverable é um documento,
    // não um diff. Só vale pra agente NÃO-Forge (um agente configurado como
    // orkestral_local roda Forge mesmo em planejamento — escolha do dono). Gating por
    // KIND da issue, não por papel: um Lead fazendo edit de código segue no Forge (economia).
    const planningKind = agent.adapterType !== 'orkestral_local' && isPlanningIssue(issue);
    const hybridForgeFirst =
      agent.adapterType !== 'orkestral_local' &&
      !planningKind &&
      // Smart-exec desligado = não existe tentativa Forge; sem este gate o run
      // premium atravessava o branch de escalação mesmo assim e gravava comentário
      // "Forge escalou" + exit_reason='escalated_to_premium' falsos em TODA issue.
      getSmartExecConfig().enabled &&
      routingSettings.enabled &&
      !routingSettings.requireApprovalForLocal &&
      (routingSettings.mode === 'local_assist' || routingSettings.mode === 'local_first');
    // Run de REVIEW NÃO entra no Forge-first/escalação: um reviewer claude_local
    // detourava pelo Forge (10min à toa), falhava, e caía na escalação premium —
    // que só é gated pra orkestral_local, então um claude_local furava o pilar de
    // economia. Review roda direto o CLI do reviewer (correto).
    if (!reviewingRun && (agent.adapterType === 'orkestral_local' || hybridForgeFirst)) {
      const cfg = getSmartExecConfig();
      // Convergência: após o modelo local falhar review 2x, metadata marca
      // forcePremiumNextRun — pula a tentativa Forge (que re-rodaria o mesmo edit
      // determinístico) e cai direto na escalação premium abaixo. Consome a flag
      // (re-fetch + spread) pra não repetir o pulo no run seguinte. MAX_REVIEW_ATTEMPTS
      // segue limitando o total, então não há loop infinito.
      const forgeMeta = (issue.metadata as Record<string, unknown> | null) ?? {};
      const forcePremiumNextRun = forgeMeta.forcePremiumNextRun === true;
      if (forcePremiumNextRun) {
        issueRepo.update(issue.id, {
          metadata: { ...forgeMeta, forcePremiumNextRun: false },
        });
      }
      let escalateReason = forcePremiumNextRun
        ? 'modelo local falhou a revisão repetidas vezes — escalando pro premium'
        : hybridForgeFirst
          ? 'roteamento híbrido local não concluiu'
          : 'modelo local desligado nas configurações';
      let forgeTraceId: string | null = null;
      if (cfg.enabled && !forcePremiumNextRun) {
        const hybridClassification = classifyIssue(issue, { config: cfg, repoPath: cwd });
        const riskAllowed = isTaskRiskAllowed(
          hybridClassification.risk,
          routingSettings.maxLocalRisk,
        );
        const premiumTarget =
          agent.adapterType === 'orkestral_local'
            ? resolvePremiumFallback(issue.workspaceId)
            : { adapterType: effectiveAdapter, model: effectiveModel };
        if (hybridForgeFirst && !riskAllowed) {
          escalateReason = `risco ${hybridClassification.risk} acima do limite local ${routingSettings.maxLocalRisk}; CLI premium preserva contexto e permissões`;
          trace({
            level: 'info',
            source: 'model-routing',
            scope: 'issue-run',
            issueKey: issue.issueKey,
            workspaceId: issue.workspaceId,
            agentId: agent.id,
            agentName: agent.name,
            message: `[hybrid] issue ${issue.issueKey}: ${premiumTarget.adapterType} direto · risk=${hybridClassification.risk} maxLocal=${routingSettings.maxLocalRisk} · contexto CLI preservado`,
          });
        } else {
          trace({
            level: 'success',
            source: 'model-routing',
            scope: 'issue-run',
            issueKey: issue.issueKey,
            workspaceId: issue.workspaceId,
            agentId: agent.id,
            agentName: agent.name,
            message: `[hybrid] issue ${issue.issueKey}: ${premiumTarget.adapterType} preservado como fallback · tentando Forge local primeiro · mode=${routingSettings.mode} risk=${hybridClassification.risk}`,
          });
          emit({
            type: 'model-route',
            issueId: issue.id,
            runId,
            message: `Forge local tentando primeiro · fallback ${premiumTarget.adapterType}`,
            modelRoute: {
              from: premiumTarget.adapterType,
              to: 'orkestral_local',
              reason: `mode=${routingSettings.mode}; risk=${hybridClassification.risk}`,
              localUsed: true,
              premiumUsed: false,
            },
          });
          const forgeTrace = startAgentTraceStep({
            workspaceId: issue.workspaceId,
            runId,
            issueId: issue.id,
            issueKey: issue.issueKey,
            agentId: agent.id,
            agentName: agent.name,
            parentId: rootTraceId,
            kind: 'generate',
            title: 'Tentando resolver com Orkestral Forge local',
            payload: {
              cwd,
              adapterType: agent.adapterType,
              fallbackAdapter: premiumTarget.adapterType,
              routingMode: routingSettings.mode,
              risk: hybridClassification.risk,
            },
          });
          forgeTraceId = forgeTrace.id;
          try {
            // Feedback progressivo: cada marco do Forge (explorar → gerar →
            // reescrever → aplicar → validar) vira um evento na timeline da issue.
            const onForgePhase = (message: string): void =>
              emit({
                type: 'phase',
                issueId: issue.id,
                runId,
                sourceId: targetSource?.id ?? null,
                sourceLabel: targetSource?.label ?? null,
                message,
              });
            // COMPORTAMENTO DO AGENTE + BEST-OF-N: o Forge tenta resolver LOCALMENTE
            // até N vezes (config do usuário) antes de cair pro premium. CADA retry
            // SOBE A TEMPERATURA de amostragem — sem isso a geração gulosa (temp 0)
            // produziria o MESMO output e a retry seria inútil. Com temperatura
            // crescente cada tentativa é um CANDIDATO diverso, e o verificador
            // determinístico (apply + validação dentro do runSmartExecution) fica com
            // o primeiro que de fato passa. Só escala depois de esgotar as N
            // (resolveAiRoutingSettings já limita a [1..5]).
            const rawAttempts = routingSettings.localAttemptsBeforeFallback;
            const maxLocalAttempts = Number.isFinite(rawAttempts)
              ? Math.max(1, Math.min(Math.round(rawAttempts), 5))
              : 2;
            // Orçamento WALL-CLOCK da fase local: cada tentativa re-roda o smart-exec
            // inteiro e mói minutos — N tentativas viravam ~13min antes de escalar. Depois
            // deste teto NÃO re-tenta local: escala pro premium CLI (que edita direto com
            // tools e CONCLUI). A 1ª tentativa sempre roda; o teto corta só as repetições.
            const LOCAL_PHASE_BUDGET_MS = 240_000; // 4min
            const localPhaseStart = Date.now();
            // Temp 0 na 1ª (determinística); sobe nas seguintes pra diversificar.
            const ATTEMPT_TEMPS = [0, 0.35, 0.6, 0.8, 0.95];
            const cfgForAttempt = (attempt: number): typeof cfg =>
              attempt === 1
                ? cfg
                : {
                    ...cfg,
                    local: {
                      ...cfg.local,
                      samplingTemperature:
                        ATTEMPT_TEMPS[Math.min(attempt - 1, ATTEMPT_TEMPS.length - 1)],
                      samplingSeed: attempt * 1009 + 17,
                    },
                  };
            let outcome = await runSmartExecution(
              issue,
              cwd,
              cfgForAttempt(1),
              runId,
              onForgePhase,
              effectiveAdapter,
              effectiveModel,
            );
            for (
              let attempt = 2;
              attempt <= maxLocalAttempts &&
              !outcome.handled &&
              // premium_edit já decidiu (o premium é determinístico): não re-tenta em
              // loop com temperatura como o modelo local; vai direto pro run completo.
              !outcome.skipLocalRetry &&
              Date.now() - localPhaseStart < LOCAL_PHASE_BUDGET_MS;
              attempt++
            ) {
              onForgePhase(
                mt(
                  `Forge tentando de novo localmente (tentativa ${attempt} de ${maxLocalAttempts})…`,
                  `Forge retrying locally (attempt ${attempt} of ${maxLocalAttempts})…`,
                ),
              );
              outcome = await runSmartExecution(
                issue,
                cwd,
                cfgForAttempt(attempt),
                runId,
                onForgePhase,
                effectiveAdapter,
                effectiveModel,
              );
            }
            // MOTOR-V2 GATE: o Forge aplicou? Os arquivos mudados TÊM que passar nos gates
            // (import real + substância + compila o projeto). Reprovou = não aceita como
            // feito, escala pro premium em vez de shipar lixo (o buraco do chatbot_v3).
            if (cwd && outcome.handled && outcome.filesChanged.length > 0) {
              const verdict = validateForgeOutput(cwd, outcome.filesChanged);
              if (!verdict.ok) {
                onForgePhase(
                  mt(
                    `Forge aplicou mas reprovou no gate (${verdict.reasons[0]}). Escalando pro premium…`,
                    `Forge applied but failed the gate (${verdict.reasons[0]}). Escalating to premium…`,
                  ),
                );
                outcome = {
                  ...outcome,
                  handled: false,
                  validationResult: 'failed',
                  escalate: `engine-v2 gate: ${verdict.reasons.join(' | ')}`,
                  failureReason: verdict.reasons.join(' | '),
                };
              }
            }
            finishAgentTraceStep(forgeTrace.id, {
              status: outcome.handled ? 'completed' : 'skipped',
              summary: outcome.handled
                ? 'Forge aplicou o patch localmente e preservou a sessão premium do usuário.'
                : `Forge não resolveu localmente: ${outcome.escalate ?? 'motivo desconhecido'}`,
              payload: {
                handled: outcome.handled,
                filesChanged: outcome.filesChanged,
                escalate: outcome.escalate ?? null,
                metrics: outcome.metrics,
              },
            });
            trace({
              level: outcome.handled ? 'success' : 'warn',
              source: 'forge',
              scope: 'outcome',
              issueKey: issue.issueKey,
              workspaceId: issue.workspaceId,
              agentId: agent.id,
              agentName: agent.name,
              message: outcome.handled
                ? 'resolvido localmente pelo Forge · sessão premium preservada'
                : `escalando pro premium: ${outcome.escalate ?? 'motivo desconhecido'}`,
            });
            if (outcome.handled) {
              const changeSummary = await collectIssueChangeSummary(targetSource, issue, agent);
              const changeBlock = renderCodeChangeSummaryBlock(changeSummary);
              rememberIssueChangeBlock(issue, changeBlock, changeSummary?.snapshotId);
              // Veredito de verificação do Forge: validationResult 'passed' = verificado;
              // 'skipped'/'failed' com código tocado = não verificado (inclui o caso P0-3
              // de "sem comando de validação"); sem código tocado = não se aplica.
              const touchedCode = !!changeBlock.trim() || (changeSummary?.files.length ?? 0) > 0;
              // A2 — PHANTOM-DONE: uma issue de CÓDIGO (backend/frontend/api…) que conclui
              // SEM tocar arquivo nenhum não é "não se aplica" — é entrega FANTASMA (alegou
              // pronto e não mudou nada; era a raiz das APIs "done" sem route.ts). Marca
              // 'unverified' (⚠️ aviso + veredito negativo), em vez de done limpo. Issues
              // não-código (qa/design/docs, que escrevem no KB) seguem 'not_applicable'.
              const rawLabels = (issue as { labels?: unknown }).labels;
              const labelStr = (
                Array.isArray(rawLabels) ? rawLabels.join(' ') : String(rawLabels ?? '')
              ).toLowerCase();
              const isCodeIssue =
                /\b(backend|frontend|fullstack|full-stack|api|infra|devops)\b/.test(labelStr);
              // Se a issue PRODUZIU um deliverable (spec/design/QA — documento, não código),
              // é 'not_applicable' mesmo com label de código: não é entrega fantasma, é
              // trabalho não-código legítimo (o KB-backed planning gera bastante). Sem isto
              // a A2 poluiria o run com ⚠️ falso em todo trabalho de spec.
              const producedDeliverable = !!outcome.deliverable;
              const verification: IssueVerificationState = !touchedCode
                ? isCodeIssue && !producedDeliverable
                  ? 'unverified'
                  : 'not_applicable'
                : outcome.validationResult === 'passed'
                  ? 'verified'
                  : 'unverified';
              rememberIssueVerification(issue, verification);
              const filesChanged =
                changeSummary?.files.map((file) => file.path) ?? outcome.filesChanged;
              if (changeSummary) {
                for (const file of changeSummary.files) {
                  emit({
                    type: 'file-change',
                    issueId: issue.id,
                    runId,
                    sourceId: changeSummary.sourceId,
                    sourceLabel: changeSummary.sourceLabel,
                    filePath: file.path,
                    additions: file.additions,
                    deletions: file.deletions,
                    message: `Editing ${file.path} +${file.additions} -${file.deletions}`,
                  });
                }
              }
              // Contabilidade: o Forge resolveu 100% localmente — registra o run
              // como resolução local.
              execStatsRepo.recordOutcome(runId, 'local_resolved');
              // ECONOMIA VISÍVEL (counterfactual): o premium não rodou nesta
              // resolução; estimamos o que TERIA custado (tokens evitados × preço de
              // referência) e registramos no run (agrega no dashboard) + na issue
              // (chip).
              const cfInTokens = outcome.metrics.estimatedPremiumInputTokensAvoided;
              const cfOutTokens = outcome.metrics.estimatedPremiumOutputTokensAvoided;
              execStatsRepo.recordCounterfactual(runId, cfInTokens, cfOutTokens);
              // Economia VISÍVEL relativa ao MODELO/ESFORÇO do usuário (o premium = o
              // modelo do CEO), não um baseline fixo de Sonnet. Sem CEO → default.
              const orchForPrice =
                agentRepo.listByWorkspace(issue.workspaceId).find((a) => a.isOrchestrator) ?? null;
              const orchPriceEffort = (
                orchForPrice?.adapterConfig as Record<string, unknown> | undefined
              )?.effort;
              const refPricing = referencePricingForModel(
                orchForPrice?.model ?? null,
                typeof orchPriceEffort === 'string' ? orchPriceEffort : null,
              );
              const savedUsd = computeCounterfactualSavedUsd(
                cfInTokens,
                cfOutTokens,
                refPricing.inputUsdPerMTok,
                refPricing.outputUsdPerMTok,
              );
              if (savedUsd > 0) {
                rememberIssueLocalEconomics(issue, {
                  savedUsd,
                  inputTokens: cfInTokens,
                  outputTokens: cfOutTokens,
                  priceLabel: refPricing.label,
                });
              }
              // RAG-de-edits: registra os edits lazy aplicados como CANDIDATOS
              // (status 'candidate'); viram exemplos ACEITOS só quando o review
              // aprovar a issue (stampVerifiedVerdict → promoteByRun). Local-only.
              for (const ae of outcome.acceptedEdits ?? []) {
                forgeEditExamplesRepo.record({
                  workspaceId: issue.workspaceId,
                  runId,
                  issueId: issue.id,
                  file: ae.file,
                  symbol: ae.symbol,
                  instruction: ae.instruction,
                  acceptedEdit: ae.acceptedEdit,
                  editFormat: 'lazy',
                });
              }
              issueRepo.finishRunAndSetStatus(
                runId,
                {
                  status: 'done',
                  outputSummary: `🪶 ${outcome.diffSummary}`,
                  toolCallCount: 0,
                  adapterType: 'orkestral_local',
                  // Mesmo literal de recordOutcome acima (senão finishRun sobrescreveria
                  // o exit_reason gravado lá na mesma linha).
                  exitReason: 'local_resolved',
                },
                issue.id,
                { status: 'in_review' },
              );
              const economyLine =
                savedUsd > 0
                  ? `\n\n💰 Economia estimada: ~${formatSavedUsd(savedUsd)} que o premium gastaria (${refPricing.label}).`
                  : '';
              // Deliverable NON-CODE (Design/QA): posta o markdown limpo, SEM o
              // wrapper de código ("Resolvido localmente / Revise o diff em Code
              // changes") que não faz sentido pra uma spec/relatório.
              const deliverableBody = outcome.deliverable
                ? `${
                    outcome.deliverable.kind === 'design'
                      ? '📐 **Especificação de design** _(escrita localmente pelo Orkestral Forge)_'
                      : '✅ **Relatório de QA** _(escrito localmente pelo Orkestral Forge)_'
                  }\n\n${outcome.deliverable.markdown}${economyLine}`
                : `🪶 Resolvido localmente pelo **Orkestral Forge** preservando a sessão premium.\n\n${outcome.diffSummary}${economyLine}\n\n_Revise o diff em Code changes._`;
              issueRepo.addComment({
                issueId: issue.id,
                body: deliverableBody,
                authorKind: 'system',
              });
              emit({ type: 'finished', issueId: issue.id, runId, message: outcome.diffSummary });
              finishRootTrace('completed', outcome.diffSummary, {
                mode: 'forge',
                filesChanged,
              });
              recordExecutionLearning({
                issue,
                agentName: agent.name,
                summary: outcome.diffSummary,
                filesChanged,
                outcome: 'done',
                runId,
                modelUsed: 'local',
                verification,
                changeBlock,
                contextPack: buildIssueContext(issue),
                metrics: outcome.metrics as unknown as Record<string, unknown>,
                source: targetSource,
              });
              recordAgentTraceStep({
                workspaceId: issue.workspaceId,
                runId,
                issueId: issue.id,
                issueKey: issue.issueKey,
                agentId: agent.id,
                agentName: agent.name,
                parentId: rootTraceId,
                kind: 'learn',
                status: 'completed',
                title: 'Registrando aprendizado da execução local',
                summary: 'A solução local foi salva como memória operacional para futuras tarefas.',
                payload: {
                  filesChanged,
                  metrics: outcome.metrics,
                },
              });
              // ECONOMIA: o skill-review spawna `claude --print` (gasto premium).
              // Num run resolvido 100% LOCAL pelo Forge com premium DESLIGADO, não
              // gasta Claude pra extrair skill — pula. (Premium ligado, ou agente
              // não-local, mantém o skill-review.)
              const skillReviewAllowed =
                agent.adapterType !== 'orkestral_local' ||
                routingSettings.allowPremiumFallback === true;
              if (skillReviewAllowed) {
                void maybeReviewForSkill({
                  issue,
                  agentName: agent.name,
                  summary: outcome.diffSummary,
                  filesChanged,
                  premium: premiumTarget,
                }).catch(() => {});
              }
              routeReviewOrFinish(
                issue.id,
                agent.id,
                [
                  `🪶 Resolvido localmente pelo Orkestral Forge.\n\n${outcome.diffSummary}`,
                  changeBlock,
                  '_Revise o diff em Code changes._',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
              );
              return;
            }
            escalateReason = outcome.escalate ?? 'execução local não concluiu';
          } catch (err) {
            escalateReason = err instanceof Error ? err.message : String(err);
            if (forgeTraceId) {
              finishAgentTraceStep(forgeTraceId, {
                status: 'failed',
                summary: escalateReason,
              });
            }
            console.warn('[smart-exec] execução local falhou, escalando:', err);
          }
        }
      }
      // Gate de escalação premium. Aplica-se a agentes Forge local E a agentes não-Forge
      // que rodaram Forge-first (hybridForgeFirst): sem isso, um claude_local escalava
      // INCONDICIONALMENTE a cada falha de edit (sem teto de orçamento → "escalou várias
      // vezes"). Agora ambos passam por decideLocalEscalation (teto de 1/issue + bloqueia
      // quando o fallback está desligado), reduzindo escalação na fonte.
      if (agent.adapterType === 'orkestral_local' || hybridForgeFirst) {
        const meta = (issue.metadata as Record<string, unknown> | null) ?? {};
        const escalations =
          typeof meta.premiumEscalations === 'number' ? meta.premiumEscalations : 0;
        // Orçamento por issue: uma única escalação no ciclo de vida. Loops
        // review→reexecute não podem reescalar a mesma issue de novo. EXCEÇÃO: a
        // escalação FORÇADA de convergência (forcePremiumNextRun, após o Forge
        // falhar a revisão 2x) tem que passar — senão a issue cai num beco sem
        // saída 'blocked'. Ela ignora o orçamento e NÃO o consome (MAX_REVIEW_ATTEMPTS
        // segue como teto global, então não há loop).
        const overBudget = escalations >= 1 && !forcePremiumNextRun;
        // ECONOMIA É O PILAR (inegociável p/ agente LOCAL): premium NUNCA escala
        // por padrão. Só escala com opt-in EXPLÍCITO nas Settings (=== true).
        // Decisão na função PURA testável decideLocalEscalation (cobre
        // forcePremiumNextRun, orçamento e o pilar).
        // (Agentes claude_local nem entram neste gate — o guard de adapterType
        // acima preserva o fallback deles.)
        const escalationDecision = decideLocalEscalation({
          allowPremiumFallback: routingSettings.allowPremiumFallback,
          escalations,
          forcePremiumNextRun,
        });
        if (escalationDecision === 'block') {
          const reason = overBudget
            ? mt(
                'Orçamento de escalação premium da issue esgotado (1x).',
                'Issue premium-escalation budget exhausted (1x).',
              )
            : mt(
                'Fallback premium desabilitado nas configurações.',
                'Premium fallback disabled in settings.',
              );
          execStatsRepo.recordOutcome(runId, 'blocked_local');
          issueRepo.finishRunAndSetStatus(
            runId,
            {
              status: 'failed',
              outputSummary: `🪶 ${escalateReason}`,
              toolCallCount: 0,
            },
            issue.id,
            { status: 'blocked' },
          );
          issueRepo.addComment({
            issueId: issue.id,
            body: mt(
              `🪶 O Orkestral Forge não conseguiu resolver localmente e o premium não foi acionado (${reason}). Motivo da falha local: ${escalateReason}. Precisa de ajuda para destravar esta issue.`,
              `🪶 Orkestral Forge could not resolve this locally and premium was not used (${reason}). Local failure reason: ${escalateReason}. Needs help to unblock this issue.`,
            ),
            authorKind: 'system',
          });
          trace({
            level: 'warn',
            source: 'model-routing',
            scope: 'issue-run',
            issueKey: issue.issueKey,
            workspaceId: issue.workspaceId,
            agentId: agent.id,
            agentName: agent.name,
            message: `[hybrid] issue ${issue.issueKey}: bloqueado local (sem premium) · ${reason} · ${escalateReason}`,
          });
          emit({ type: 'finished', issueId: issue.id, runId, message: escalateReason });
          finishRootTrace('skipped', escalateReason, { mode: 'blocked_local', reason });
          // Fecha o loop no chat de origem E empurra o plano: sem isto, uma
          // sub-issue bloqueada no Forge local travava o irmão seguinte da épica
          // sequencial (este caminho retornava sem reportar nem avançar).
          reportTerminalToOriginSession(issue, 'blocked', escalateReason);
          return;
        }
        // Vai escalar: contabiliza o gasto do orçamento na metadata da issue.
        // A escalação FORÇADA de convergência NÃO conta contra o orçamento — ela é
        // uma tentativa extra deliberada do convergidor, não um gasto comum.
        if (!forcePremiumNextRun) {
          issueRepo.update(issue.id, {
            metadata: { ...meta, premiumEscalations: escalations + 1 },
          });
        }
      }
      // Economia de execução: registra que este run escalou pro premium.
      execStatsRepo.recordOutcome(runId, 'escalated_to_premium');
      escalatedToPremium = true;
      // Fallback premium: resolve um adapter premium real pra rodar o agente.
      const fb =
        agent.adapterType === 'orkestral_local'
          ? resolvePremiumFallback(issue.workspaceId)
          : { adapterType: effectiveAdapter, model: effectiveModel };
      effectiveAdapter = fb.adapterType;
      effectiveModel = fb.model;
      trace({
        level: 'warn',
        source: 'model-routing',
        scope: 'issue-run',
        issueKey: issue.issueKey,
        workspaceId: issue.workspaceId,
        agentId: agent.id,
        agentName: agent.name,
        message: `[hybrid] issue ${issue.issueKey}: Forge local → ${fb.adapterType} · motivo: ${escalateReason}`,
      });
      emit({
        type: 'model-route',
        issueId: issue.id,
        runId,
        message: `Forge local escalou para ${fb.adapterType}`,
        modelRoute: {
          from: 'orkestral_local',
          to: fb.adapterType,
          reason: escalateReason,
          localUsed: true,
          premiumUsed: true,
        },
      });
      issueRepo.addComment({
        issueId: issue.id,
        body: `↗︎ Orkestral Forge escalou pro modelo premium (${fb.adapterType}): ${escalateReason}`,
        authorKind: 'system',
      });
      recordAgentTraceStep({
        workspaceId: issue.workspaceId,
        runId,
        issueId: issue.id,
        issueKey: issue.issueKey,
        agentId: agent.id,
        agentName: agent.name,
        parentId: rootTraceId,
        kind: 'fallback',
        status: 'completed',
        title: 'Escalando para modelo premium',
        summary: escalateReason,
        payload: {
          fallbackAdapter: fb.adapterType,
          fallbackModel: fb.model,
        },
      });
    }

    // 2.7 MCP bundle (adapter já resolvido). Reusa o wiring do chat → o executor
    // herda orkestral (sempre) + os MCPs do MARKETPLACE ATACHADOS A ESTE agente
    // (exclusivo por agente, via agentSkills) + playwright.
    const mcpSkills = skillRepo.listByAgent(agent.id).filter((s) => s.kind === 'mcp');
    const mcpBundle = await buildMcpConfigForRun(
      `issue-${runId}`,
      issue.workspaceId,
      mcpSkills,
      modelScopeForAgent(effectiveAdapter, effectiveModel),
      chromeEnabled,
      undefined,
      {
        runId,
        issueId: issue.id,
        issueKey: issue.issueKey,
        agentId: agent.id,
        agentName: agent.name,
        parentId: rootTraceId,
      },
    );

    // 3. Monta prompt. Se este run é de REVISÃO (o gestor validando o trabalho
    // do subordinado), injeta o MODO REVISÃO em vez do "execute a tarefa".
    const agentInstructions = readRuntimeInstructionContext(agent);
    const contextBlock = buildIssueContext(issue);
    // Skills de INSTRUÇÃO atachadas: só o ÍNDICE (nome + descrição). Colar o
    // conteúdo inteiro custava vários k de tokens por run e re-ensinava o harness
    // (playbook de refactor num greenfield de UI). O agente puxa sob demanda.
    const skillIndex = skillRepo
      .listByAgent(agent.id)
      .filter((s) => s.kind === 'instruction' && s.state === 'active' && s.content?.trim())
      .map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ''} (slug: ${s.slug})`)
      .join('\n');
    const skillsBlock = skillIndex
      ? `## Skills available (pull on demand)\nRead a skill's full playbook with \`skill_view\` when it fits the task:\n${skillIndex}`
      : '';
    // Contexto de sources do workspace (o executor precisa saber os OUTROS repos,
    // não só o cwd) + regras globais — paridade com o chat.
    const sourcesContext = buildSourcesContextBlock(
      sourceRepo.listByWorkspace(issue.workspaceId),
      targetSource ?? null,
    );
    const reviewMeta = (issue.metadata as { review?: ReviewMeta } | null)?.review;
    const reviewing = isReviewRun(issue, agent.id);
    const qaValidation = reviewing && isQaAgent(agent) ? getLatestQaValidation(issue.id) : null;
    const executorName = reviewMeta
      ? (agentRepo.get(reviewMeta.executorAgentId)?.name ?? 'o executor')
      : 'o executor';

    // Re-prompt FORÇADO de veredito (o reviewer encerrou sem veredito na passada
    // anterior). Injeta uma linha dura no topo do prompt de review e CONSOME a flag
    // (pra não persistir além desta passada — verdictNudged já limita a 1).
    const forceVerdict =
      reviewing &&
      (issue.metadata as { forceVerdictNextRun?: boolean } | null)?.forceVerdictNextRun === true;
    if (forceVerdict) {
      const fm = (issueRepo.get(issue.id)?.metadata as Record<string, unknown> | null) ?? {};
      const { forceVerdictNextRun: _drop, ...restMeta } = fm;
      issueRepo.update(issue.id, { metadata: restMeta });
    }
    const forceVerdictLines = forceVerdict
      ? [
          mt(
            '⚠️ ESTA É SUA ÚLTIMA PASSADA. Você DEVE emitir o veredito AGORA via ferramenta: APROVAR = `update_issue_status` status=done; PEDIR AJUSTES = `update_issue_status` status=todo (NÃO reatribua a issue — você é o revisor, o responsável continua o executor). Resposta só em prosa, sem a chamada, será tratada como PEDIDO DE AJUSTES.',
            '⚠️ THIS IS YOUR FINAL PASS. You MUST emit the verdict NOW via a tool: APPROVE = `update_issue_status` status=done; REQUEST CHANGES = `update_issue_status` status=todo (do NOT reassign the issue — you are the reviewer, the assignee stays the executor). A prose-only answer without the tool call is treated as REQUEST CHANGES.',
          ),
          '',
        ]
      : [];

    const taskLines =
      reviewing && qaValidation
        ? [
            ...forceVerdictLines,
            `# QA VALIDATION MODE — validate @${executorName}'s delivery`,
            '',
            `You are the QA gate for issue "${issue.title}". Do NOT implement the task and do NOT approve by intuition.`,
            '',
            renderQaRuntimeBlock(qaValidation),
            '',
            '## Mandatory QA workflow',
            '',
            '1. Call `qa_get_validation` for this issue and follow the checks in order.',
            '2. For each check, inspect the issue, diff, KB, affected files, commands, screenshots or logs needed.',
            '3. After each check, call `qa_update_check` with `check_ordinal`, status and concise evidence.',
            '4. Run available verification commands when safe: lint, typecheck, unit tests, build, e2e/smoke. If no command exists, mark evidence as a gap instead of pretending.',
            '5. For UI/design changes, validate design-system tokens/components, responsiveness, accessibility basics and visual consistency.',
            '5b. OPERATE the UI, not just read it: boot the app (or use the running preview) and click through every visible control — search inputs must filter, add/edit buttons must do something (even against local mock state), nav items must lead somewhere real. A control that does NOTHING on interaction fails the check; so does a nav item pointing at a page that does not exist.',
            '5c. For UI issues, capture VISUAL evidence: call `capture_preview` (with the dev server running) and attach the screenshot as evidence on the relevant check — compare what you SEE against the Design Spec (palette, layout, hierarchy). If the screen looks bare/unstyled, the check fails even when the code builds.',
            '6. For backend/API changes, validate contracts, status codes, auth assumptions, persistence and frontend/mobile consumers.',
            '7. Finish with `qa_complete_validation`:',
            '   - `passed` only if critical checks passed with evidence.',
            '   - `failed` if executor must fix something; then `comment_on_issue` and `update_issue_status` to `todo` (do NOT reassign — you are the reviewer; the executor stays the assignee).',
            '   - `needs_human` only for credentials, inaccessible environment, or product ambiguity.',
            '',
            `If approved, call \`update_issue_status\` issue_key=${issue.issueKey} status=done. If failed, do NOT fix it yourself.`,
          ]
        : reviewing
          ? [
              ...forceVerdictLines,
              `# REVIEW MODE — validate the work of @${executorName}`,
              '',
              `You are the MANAGER. Do NOT redo the task: VALIDATE what @${executorName} delivered on issue "${issue.title}".`,
              '',
              // Critério verificável de "pronto" (contrato de execução): o reviewer
              // confere a mudança CONTRA ele, não contra sua intuição.
              ...((issue.metadata as { done?: string } | null)?.done?.trim()
                ? [
                    `## DONE criterion (the SINGLE thing to verify):`,
                    (issue.metadata as { done?: string }).done!.trim(),
                    '',
                  ]
                : []),
              // Diff REAL do Forge embutido: o reviewer já vê o patch exato.
              ...(() => {
                const diff = renderForgeDiffForReview(issue);
                return diff
                  ? ['The exact changes the executor made (review THIS patch first):', diff, '']
                  : [];
              })(),
              'Steps:',
              '1. Review the patch above (and Read/Grep the affected files if it was truncated) against',
              '   the DONE criterion + the project standards.',
              '2. Verify: does it ACTUALLY satisfy `done`? does it break anything? did it touch only the',
              '   right files? Did it NOT rebuild something that already existed, and NOT delete unrelated code?',
              '3. QUALITY VERDICT (required — state it explicitly in your comment): does this resolve the',
              '   issue? YES or NO + one sentence why, referencing the DONE criterion.',
              '4. ACT (required, via MCP):',
              `   - APPROVED → \`comment_on_issue\` (the YES verdict + 1 line on what you validated) + \`update_issue_status\` \`issue_key=${issue.issueKey}\` \`status=done\`.`,
              `   - NEEDS FIXES → \`comment_on_issue\` (the NO verdict + EXACTLY what to correct) + \`update_issue_status\` \`status=todo\`. Do NOT reassign the issue (you are the reviewer; @${executorName} stays the assignee) and do NOT fix it yourself.`,
              '',
              'Be fast and to the point. You command the army — here your job is to guarantee quality.',
            ]
          : [
              // Convergência: numa re-execução pós-review, o comentário corretivo do
              // revisor foi persistido em metadata.reviewFocus. Prepende-o em destaque
              // (não enterrado no fim) pra o premium fazer EXATAMENTE o que foi pedido.
              ...((issue.metadata as { reviewFocus?: string } | null)?.reviewFocus
                ? [
                    `## Reviewer requested changes (HIGHEST PRIORITY — do EXACTLY this):\n${(issue.metadata as { reviewFocus?: string }).reviewFocus}`,
                    '',
                  ]
                : []),
              `# Your current task: ${issue.title}`,
              '',
              issue.description ?? '(sem descrição)',
              '',
              '## How to deliver',
              '',
              '- Do the work via tool calls now — the plan above is already approved. The feature ALREADY EXISTING is normal: alter/extend it, it is not a blocker.',
              '- FILE EDITS — decision rule: changing MORE than ~10 lines, several spots in one file, or a whole function/block → use the `edit_file` MCP tool (send only the changed code with `// ... existing code ...` markers + 1-2 original anchor lines; a fraction of the output tokens of retyping exact old text). Tiny 1-5 line tweaks → your native editor is fine. If `edit_file` reports a failed merge, add more anchor context or fall back to your native editor.',
              '- Non-trivial task? `skill_list`/`skill_view` first to reuse a known playbook; if you discover a non-obvious technique worth keeping, save it with `skill_create`.',
              '- Shell commands must be non-interactive and fast (no watchers/prompts — a hung command kills the run).',
              '- Block (`status=blocked` + `comment_on_issue`) ONLY for a missing credential, an irreversible destructive step, or a product contradiction with no safe default. Otherwise pick the sane path, do it, and note the decision in a short comment.',
              '- Before handing off, check your diff against the DONE criterion and the KB spec above (no stub/placeholder/half-done), and VERIFY it works: build/typecheck passes; for UI, the screen really renders at its route.',
              `- Then call \`update_issue_status\` with \`issue_key=${issue.issueKey}\` and \`status=in_review\` (your manager validates). If you are at the top of the hierarchy, use \`status=done\`.`,
              // Issue de EXECUÇÃO cujo dono é o QA (ex.: "validação final e2e"):
              // sem isto o QA validava por LEITURA de código (aconteceu no piloto
              // Pulso — zero screenshots, zero interação). O modo QA de review
              // (beginQaValidation) só cobre quando o QA é REVISOR de outra issue.
              ...(isQaAgent(agent)
                ? [
                    '',
                    '## QA EVIDENCE BAR (you are QA — evidence means OPERATING, not reading)',
                    '- Reading code or "the build passes" is NOT valid evidence of a working flow.',
                    '- Boot the app (or use the running preview) and EXERCISE the real flows this issue names — click, type, submit. A control that does nothing, or a flow that dead-ends, FAILS.',
                    '- Capture visual proof with `capture_preview` and reference it in your issue comment; compare what you SEE against the Design Spec.',
                    '- Report per-step evidence via `comment_on_issue` (what you did → what happened). State gaps honestly instead of papering over them.',
                  ]
                : []),
            ];
    // KB-backed planning: se a issue aponta pra uma página de planejamento DETALHADA no
    // KB (metadata.planPageId, gravada pelo CEO no planning com kb_create_page), injeta a
    // SPEC COMPLETA como bloco autoritativo. É aqui que a riqueza do premium chega ao
    // executor sem inchar a descrição da issue. Fallback silencioso se a página sumiu.
    let planSpecBlock = '';
    const planPageId = (issue.metadata as { planPageId?: unknown } | null)?.planPageId;
    if (typeof planPageId === 'string' && planPageId.trim()) {
      try {
        // ISOLAMENTO: getScoped (não get) — a página DEVE pertencer ao workspace da issue,
        // senão um agente injetaria conteúdo de KB de outro workspace só sabendo o UUID.
        const planPage = new KbPageRepository().getScoped(issue.workspaceId, planPageId.trim());
        const md = planPage?.contentMd?.trim();
        if (md) {
          // Clamp: a página pode ter dezenas de KB; sem teto estoura o contexto e trunca
          // silenciosamente o resto do prompt. Corta com aviso explícito de truncagem.
          const PLAN_MAX = 8000;
          const body =
            md.length > PLAN_MAX
              ? `${md.slice(0, PLAN_MAX)}\n\n…(plano truncado — leia a página completa com kb_get_page({page_id: "${planPageId.trim()}"}))`
              : md;
          planSpecBlock = [
            '## Full plan — authoritative spec (from the Knowledge Base)',
            '',
            'This is the COMPLETE specification for this task. Follow it precisely: file paths,',
            'design requirements, acceptance criteria and verification steps. The issue',
            'description is only a summary — THIS page is the source of truth.',
            '',
            body,
          ].join('\n');
        } else if (planPage === null) {
          // Página referenciada NÃO existe/não é deste workspace: não bloqueia, mas NÃO
          // esconde — registra um comentário visível (o executor roda sem a spec rica).
          issueRepo.addComment({
            issueId: issue.id,
            body: `⚠️ A página de planejamento referenciada (plan_page) não foi encontrada neste workspace — execução segue sem a spec detalhada do KB.`,
            authorKind: 'system',
          });
        }
      } catch {
        /* erro de leitura — segue sem ela (fallback, não bloqueia) */
      }
    }

    // CONTRATOS entre sub-épicas (HORIZON Fase 1.3): o executor recebe as páginas
    // KB `CONTRACT:` relevantes — o contrato da própria sub-árvore (o que ela deve
    // EXPOR) e os das sub-épicas de que o pai DEPENDE (o que consumir). É o que faz
    // as costuras entre subsistemas baterem: implementa-se contra contrato
    // publicado, não contra chute. Best-effort: sem contrato, bloco vazio.
    const contractsBlock = buildContractsBlock(issue);

    // Checklist de execução (Passo a passo) → instrui o executor AGÊNTICO a marcar cada item AO
    // VIVO via complete_checkpoint conforme conclui (não tudo no fim). Forge single-shot ignora a
    // tool; a rede de segurança no finalizeIssue fecha o resto no done. Vazio = filtrado abaixo.
    const checklistBlock = ((): string => {
      const m = issue.metadata as { kind?: string; checkboxes?: ExecutionCheckbox[] } | null;
      if (m?.kind !== 'execution-plan' || !m.checkboxes?.length) return '';
      const itemsRaw = m.checkboxes.map((c, i) => `${i + 1}. ${c.instruction}`).join('\n');
      const items =
        itemsRaw.length > 4000 ? `${itemsRaw.slice(0, 4000)}\n…(checklist truncada)` : itemsRaw;
      return [
        '## EXECUTION CHECKLIST (report progress LIVE)',
        `This issue has a step-by-step checklist (issue_key=${issue.issueKey}). As you FINISH each ` +
          'step, IMMEDIATELY call the `complete_checkpoint` tool with that issue_key and the step ' +
          'number, BEFORE moving to the next step (never all at the end). This is the live progress ' +
          'the user watches. Use status="blocked" only for a step you genuinely cannot finish.',
        items,
      ].join('\n\n');
    })();
    // Contexto ESTÁVEL entre runs do MESMO agente (diretiva, AGENTS.md, skills,
    // sources): no Claude vai como system prompt (--append-system-prompt) — o
    // prefixo idêntico entre runs consecutivos acerta o prompt cache do provider
    // (sub-issues de um épico rodam em sequência, dentro do TTL do cache).
    // Codex/rede não têm flag equivalente e recebem tudo concatenado (prompt).
    const stableContext = [
      // false SEMPRE: run de issue é EXECUÇÃO, mesmo quando o ator é o orquestrador
      // (ex.: CEO como reviewer) — a variante orquestradora mandaria decompor/criar
      // issues, o oposto do deliverable de um run (executar/dar veredito).
      globalAgentDirective(false),
      agentInstructions.trim(),
      modelFamilyGuidance(effectiveAdapter, effectiveModel),
      skillsBlock,
      sourcesContext,
    ]
      .filter(Boolean)
      .join('\n\n');
    // Barra de qualidade de UI: injetada POR ISSUE (no taskPrompt, fora do prefixo
    // estável → não quebra o prompt cache) quando a task toca frontend. O protocolo
    // premium do orquestrador nunca chega ao executor; sem este bloco a tela sai
    // crua (form default do browser).
    const uiHint =
      /\b(ui|ux|frontend|front-end|design|layout|tela|screen|page|página|dashboard|components?|componentes?|css|tailwind|estilos?|styles?|landing|login|signup)\b/i;
    const uiText = [issue.title, issue.description ?? '', issue.labels.join(' ')].join(' ');
    const executorRole = `${agent.role ?? ''} ${agent.title ?? ''}`;
    const uiQualityBlock =
      uiHint.test(uiText) || /front|design|\bui\b/i.test(executorRole)
        ? UI_QUALITY_PROTOCOL.trim()
        : '';
    const taskPrompt = [
      planSpecBlock,
      contractsBlock,
      checklistBlock,
      uiQualityBlock,
      '---',
      contextBlock,
      '---',
      ...taskLines,
    ]
      .filter(Boolean)
      .join('\n\n');
    const prompt = [stableContext, taskPrompt].join('\n\n');

    // 3.5 Gate honesto: adapters meia-bomba (gemini/opencode/pi/grok) NÃO têm
    // integração de execução real — antes caíam silenciosamente no binário do
    // Claude (uma mentira). Falham aqui com mensagem clara em vez de fingir.
    if (isUnavailableExecAdapter(effectiveAdapter)) {
      const msg = unavailableAdapterMessage(effectiveAdapter);
      issueRepo.finishRunAndSetStatus(runId, { status: 'failed', errorMessage: msg }, issue.id, {
        status: 'blocked',
      });
      issueRepo.addComment({ issueId: issue.id, body: `❌ ${msg}`, authorKind: 'system' });
      emit({ type: 'error', issueId: issue.id, runId, error: msg });
      finishRootTrace('failed', msg, { adapterType: effectiveAdapter });
      reportTerminalToOriginSession(issue, 'blocked', msg);
      return;
    }

    // 4a. Adapters de rede (sem spawn de CLI): OpenClaw Gateway (WebSocket RPC)
    // e Cursor Cloud (cliente de rede). Executam via cliente Node e finalizam o
    // run com o texto retornado. Não usam o MCP server local nem stream-json.
    if (effectiveAdapter === 'openclaw_gateway' || effectiveAdapter === 'cursor_cloud') {
      const cfg = (agent.adapterConfig ?? {}) as Record<string, unknown>;
      const netRunId = `issue-${randomUUID()}`;
      const networkTrace = startAgentTraceStep({
        workspaceId: issue.workspaceId,
        runId,
        issueId: issue.id,
        issueKey: issue.issueKey,
        agentId: agent.id,
        agentName: agent.name,
        parentId: rootTraceId,
        kind: 'generate',
        title: `Executando via ${effectiveAdapter}`,
        payload: { adapterType: effectiveAdapter },
      });
      let netOutput = '';
      const onNetChunk = (chunk: string): void => {
        netOutput += chunk;
      };
      try {
        let netResult: { ok: boolean; summary: string | null; errorMessage?: string };
        if (effectiveAdapter === 'openclaw_gateway') {
          const scopesRaw = cfg.scopes;
          const scopes = Array.isArray(scopesRaw)
            ? (scopesRaw.filter((s) => typeof s === 'string') as string[])
            : typeof scopesRaw === 'string'
              ? scopesRaw
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
              : null;
          const strategyRaw =
            typeof cfg.sessionKeyStrategy === 'string' ? cfg.sessionKeyStrategy : '';
          const strategy =
            strategyRaw === 'run' || strategyRaw === 'fixed' || strategyRaw === 'issue'
              ? strategyRaw
              : 'issue';
          netResult = await runOpenClawGateway({
            url: String(cfg.url ?? ''),
            authToken: (cfg.authToken as string) ?? (cfg.token as string) ?? null,
            password: (cfg.password as string) ?? null,
            clientId: (cfg.clientId as string) ?? null,
            scopes,
            sessionKeyStrategy: strategy,
            sessionKey: (cfg.sessionKey as string) ?? null,
            agentId: agent.id,
            runId: netRunId,
            issueId: issue.id,
            prompt,
            timeoutMs: 20 * 60 * 1000,
            disableDeviceAuth: cfg.disableDeviceAuth === true,
            devicePrivateKeyPem: (cfg.devicePrivateKeyPem as string) ?? null,
            onLog: (stream, chunk) => {
              if (stream === 'stdout') onNetChunk(chunk);
            },
          });
        } else {
          netResult = await runCursorCloud({
            config: cfg,
            workspaceRepoUrl: cwd ?? null,
            prompt,
            runId: netRunId,
            agentName: agent.name,
            onLog: (stream, chunk) => {
              if (stream === 'stdout') onNetChunk(chunk);
            },
          });
        }

        // Cancelado durante o run de rede: o cancel já finalizou o run +
        // atualizou o status. Não sobrescreve com done/blocked.
        if (cancelledByUser()) {
          finishAgentTraceStep(networkTrace.id, {
            status: 'skipped',
            summary: 'Execução cancelada pelo usuário.',
          });
          finishRootTrace('skipped', 'Execução cancelada pelo usuário.', { status: 'cancelled' });
          return;
        }
        if (netResult.ok) {
          const summary =
            netResult.summary?.trim() ||
            netOutput.trim().slice(0, 400) ||
            '✅ Run remoto finalizado.';
          issueRepo.finishRunAndSetStatus(
            runId,
            { status: 'done', outputSummary: summary, toolCallCount: 0 },
            issue.id,
            { status: 'in_review' },
          );
          issueRepo.addComment({ issueId: issue.id, body: summary, authorKind: 'system' });
          // Run remoto não captura diff local → sem mudança de código a verificar
          // aqui; preserva o caminho atual de done registrando o veredito pra UI/audit.
          rememberIssueVerification(issue, 'not_applicable');
          emit({ type: 'finished', issueId: issue.id, runId, message: summary });
          finishAgentTraceStep(networkTrace.id, { status: 'completed', summary });
          finishRootTrace('completed', summary, { adapterType: effectiveAdapter });
          routeReviewOrFinish(issue.id, agent.id, summary);
          trace({
            level: 'success',
            source: 'issue',
            scope: 'run',
            issueKey: issue.issueKey,
            workspaceId: issue.workspaceId,
            agentId: agent.id,
            agentName: agent.name,
            message: `${agent.name} finalizou "${issue.title}" via ${effectiveAdapter}`,
          });
        } else {
          const msg = netResult.errorMessage ?? 'Execução de rede falhou.';
          issueRepo.finishRunAndSetStatus(
            runId,
            { status: 'failed', errorMessage: msg },
            issue.id,
            { status: 'blocked' },
          );
          issueRepo.addComment({
            issueId: issue.id,
            body: `❌ Execução falhou:\n\n\`\`\`\n${msg}\n\`\`\``,
            authorKind: 'system',
          });
          emit({ type: 'error', issueId: issue.id, runId, error: msg });
          finishAgentTraceStep(networkTrace.id, { status: 'failed', summary: msg });
          finishRootTrace('failed', msg, { adapterType: effectiveAdapter });
          reportTerminalToOriginSession(issue, 'blocked', msg);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        issueRepo.finishRunAndSetStatus(runId, { status: 'failed', errorMessage: msg }, issue.id, {
          status: 'blocked',
        });
        issueRepo.addComment({
          issueId: issue.id,
          body: `❌ Erro fatal na execução: ${msg}`,
          authorKind: 'system',
        });
        emit({ type: 'error', issueId: issue.id, runId, error: msg });
        finishAgentTraceStep(networkTrace.id, { status: 'failed', summary: msg });
        finishRootTrace('failed', msg, { adapterType: effectiveAdapter, fatal: true });
        reportTerminalToOriginSession(issue, 'blocked', msg);
      }
      return;
    }

    // 4. Spawn do CLI do agente. Claude e Codex recebem o MESMO bundle de MCP do
    // chat (mcpBundle): server interno orkestral + MCPs do MARKETPLACE + playwright.
    //   - Claude: arquivo --mcp-config (http) com tudo já dentro.
    //   - Codex: overrides -c mcp_servers.* derivados do bundle (codexMcpArgs).
    const isCodex = effectiveAdapter === 'codex_local';
    const cliLabel = isCodex ? 'Codex' : 'Claude';
    if (agent.adapterType !== 'orkestral_local') {
      trace({
        level: 'info',
        source: 'model-routing',
        scope: 'issue-run',
        issueKey: issue.issueKey,
        workspaceId: issue.workspaceId,
        agentId: agent.id,
        agentName: agent.name,
        message: `[hybrid] issue ${issue.issueKey}: execução direta no CLI premium (${cliLabel})`,
      });
    }
    // Permissões REAIS no spawn: bypassSandbox=true (default) mantém o
    // comportamento atual (--yolo / --dangerously-skip-permissions); só restringe
    // quando o agente pediu restrição explícita via canEditFiles/canRunCommands.
    const spawnPolicy = resolveSpawnPolicy(agent);
    let command: string;
    let args: string[];
    if (isCodex) {
      args = ['exec', '--json', '--skip-git-repo-check'];
      applyCodexPolicy(args, spawnPolicy);
      args.push(...codexMcpArgs(mcpBundle));
      if (effectiveModel && effectiveModel !== 'default') args.push('--model', effectiveModel);
      args.push('-');
      command = 'codex';
    } else {
      args = [
        '--print',
        '-',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
      ];
      applyClaudePolicy(args, spawnPolicy);
      args.push('--mcp-config', mcpBundle.claudeConfigPath);
      if (effectiveModel && effectiveModel !== 'default') args.push('--model', effectiveModel);
      // Esforço de raciocínio na EXECUÇÃO = só o do PRÓPRIO agente (sem herdar o alto do
      // CEO). Esforço alto é pra PLANEJAR (decidir o quê), não pra cada execução: forçar
      // alto fazia o premium pensar demais e cada sub-issue levar minutos. Agente sem
      // esforço próprio → default do CLI (rápido). O planejamento (chat) segue no alto.
      applyClaudeEffort(args, resolveReasoningEffort(agent));
      // Contexto estável como system prompt (prefixo cacheável); o stdin leva só
      // a tarefa (plano + checklist + issue) — ver stableContext acima.
      args.push('--append-system-prompt', stableContext);
      command = 'claude';
    }

    // Scrub primeiro (remove secrets ambiente herdados), depois reaplica os
    // envVars que o agente declarou — mesmo contrato do chat (buildSpawnEnv):
    // scrubSpawnEnv exige que o chamador reaplique os envVars do runtimeConfig,
    // senão uma key explícita declarada no agente some no spawn de issue.
    // Mesmo contrato do chat (buildSpawnEnv): passa as keys declaradas como
    // keep-list (uma key declarada com valor vazio herda o valor do shell em vez
    // de ser apagada) e só reaplica as com VALOR explícito.
    const spawnEnv: NodeJS.ProcessEnv = scrubSpawnEnv(
      process.env,
      declaredEnvKeys(agent.runtimeConfig),
    );
    const declaredEnvVars = (agent.runtimeConfig as { envVars?: AgentRuntimeConfig['envVars'] })
      .envVars;
    for (const v of declaredEnvVars ?? []) {
      if (v.key.trim() && v.value) spawnEnv[v.key] = v.value;
    }
    // API key do PROVEDOR (configurada na página Provedores) → env var do CLI.
    applyProviderApiKey(spawnEnv, command === 'codex' ? 'codex_local' : 'claude_local');
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        env: spawnEnv,
        shell: false,
        cwd,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      issueRepo.addComment({
        issueId: issue.id,
        body: `❌ Falha ao iniciar ${cliLabel} CLI: ${msg}`,
        authorKind: 'system',
      });
      issueRepo.finishRunAndSetStatus(runId, { status: 'failed', errorMessage: msg }, issue.id, {
        status: 'blocked',
      });
      emit({ type: 'error', issueId: issue.id, runId, error: msg });
      reportTerminalToOriginSession(issue, 'blocked', msg);
      return;
    }

    // Anexa o subprocesso ao registro pré-existente (criado no topo do run),
    // preservando o flag `cancelled` caso um cancel tenha chegado durante o setup
    // do MCP/prompt. Se já cancelado, mata o processo recém-criado na hora.
    const existing = activeRuns.get(issue.id);
    const alreadyCancelled = (existing?.cancelled ?? false) || cancelledByUser();
    activeRuns.set(issue.id, {
      issueId: issue.id,
      child,
      runId,
      cancelled: alreadyCancelled,
      abort,
    });
    if (alreadyCancelled) {
      try {
        if (!child.killed) child.kill('SIGTERM');
      } catch {
        /* já morto */
      }
    }

    if (!child.stdin) {
      throw new Error(`${cliLabel} CLI sem stdin`);
    }
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      // EPIPE: child fechou stdin antes — logar e ignorar, não derrubar o main.
      console.warn('[exec] stdin error (ignorado):', err?.message);
    });
    // Claude: contexto estável já foi via --append-system-prompt → stdin leva só
    // a tarefa. Codex: tudo junto (sem flag de system prompt no exec).
    child.stdin.write(isCodex ? prompt : taskPrompt);
    child.stdin.end();

    // 5. Parse stream-json — conta tool calls + emite progress + extrai usage
    let toolCallCount = 0;
    let stdoutBuffer = '';
    let stderrBuf = '';
    const claudeToolBlocks = new Map<
      number,
      { id: string; name: string; json: string; count: number }
    >();
    const nextToolCall = (): { id: string; count: number } => {
      toolCallCount++;
      return {
        id: `issue:${issue.id}:${runId}:${toolCallCount}`,
        count: toolCallCount,
      };
    };
    // Stall detection: bump a cada evento do stream. Se NENHUM evento novo chegar
    // por STALL_MS, assumimos que um tool-call ou comando shell travou (ex: o gap
    // de ~7min visto em produção entre kb_get_page_tree e kb_search) e abortamos
    // o run com erro claro — em vez de esperar o watchdog de 20min.
    let lastActivityAt = Date.now();
    const bumpActivity = (): void => {
      lastActivityAt = Date.now();
    };
    const usageState: {
      tokensIn: number | null;
      tokensOut: number | null;
      costUsd: number | null;
    } = { tokensIn: null, tokensOut: null, costUsd: null };
    // Codex pode sair com código 0 mesmo numa turn.failed/error — guardamos a
    // mensagem aqui pra tratar como falha depois do close.
    let codexFailed: string | null = null;

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      bumpActivity();
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as Record<string, unknown>;
          if (isCodex) {
            const t = String(evt.type ?? '');
            if (t === 'item.completed') {
              const item = evt.item as Record<string, unknown> | undefined;
              const itype = String(item?.type ?? '');
              // Conta tools (comandos shell + chamadas MCP); ignora texto/raciocínio.
              if (itype && itype !== 'agent_message' && itype !== 'reasoning') {
                const toolName =
                  (item?.tool_name as string | undefined) ??
                  (item?.server as string | undefined) ??
                  itype;
                const call = nextToolCall();
                const toolArgs = extractCodexToolArgs(item ?? {});
                emit({
                  type: 'tool-use',
                  issueId: issue.id,
                  runId,
                  toolName,
                  toolCallId: call.id,
                  toolStatus: 'done',
                  toolArgs,
                  toolCallCount: call.count,
                });
                recordAgentTraceStep({
                  workspaceId: issue.workspaceId,
                  runId,
                  issueId: issue.id,
                  issueKey: issue.issueKey,
                  agentId: agent.id,
                  agentName: agent.name,
                  parentId: rootTraceId,
                  kind: 'tool',
                  status: 'completed',
                  title: `Ferramenta usada: ${toolName}`,
                  payload: {
                    toolName,
                    toolCallCount: call.count,
                    toolArgs,
                    adapterType: effectiveAdapter,
                  },
                });
              }
            } else if (t === 'turn.completed') {
              const usage = evt.usage as
                | { input_tokens?: number; output_tokens?: number }
                | undefined;
              if (usage) {
                usageState.tokensIn = Number(usage.input_tokens ?? 0) || null;
                usageState.tokensOut = Number(usage.output_tokens ?? 0) || null;
              }
            } else if (t === 'error' || t === 'turn.failed') {
              const m =
                typeof evt.message === 'string'
                  ? evt.message
                  : (((evt.error as Record<string, unknown> | undefined)?.message as
                      | string
                      | undefined) ?? 'turn failed');
              codexFailed = String(m);
            }
            continue;
          }
          if (evt.type === 'stream_event') {
            const event = evt.event as Record<string, unknown> | undefined;
            if (
              event?.type === 'content_block_start' &&
              (event.content_block as { type?: string } | undefined)?.type === 'tool_use'
            ) {
              const index =
                typeof event.index === 'number' ? event.index : Number(event.index ?? 0);
              const toolName =
                (event.content_block as { name?: string } | undefined)?.name ?? 'tool';
              const block = event.content_block as { input?: unknown } | undefined;
              const call = nextToolCall();
              const initialArgs = objectArg(block?.input);
              claudeToolBlocks.set(index, {
                id: call.id,
                name: toolName,
                json: '',
                count: call.count,
              });
              emit({
                type: 'tool-use',
                issueId: issue.id,
                runId,
                toolName,
                toolCallId: call.id,
                toolStatus: 'pending',
                toolArgs: initialArgs,
                toolCallCount: call.count,
              });
              recordAgentTraceStep({
                workspaceId: issue.workspaceId,
                runId,
                issueId: issue.id,
                issueKey: issue.issueKey,
                agentId: agent.id,
                agentName: agent.name,
                parentId: rootTraceId,
                kind: 'tool',
                status: 'completed',
                title: `Ferramenta usada: ${toolName}`,
                payload: {
                  toolName,
                  toolCallCount: call.count,
                  toolArgs: initialArgs,
                  adapterType: effectiveAdapter,
                },
              });
            } else if (event?.type === 'content_block_delta') {
              const index =
                typeof event.index === 'number' ? event.index : Number(event.index ?? 0);
              const delta = event.delta as Record<string, unknown> | undefined;
              if (delta?.type === 'input_json_delta') {
                const block = claudeToolBlocks.get(index);
                if (block) block.json += (delta.partial_json as string | undefined) ?? '';
              }
            } else if (event?.type === 'content_block_stop') {
              const index =
                typeof event.index === 'number' ? event.index : Number(event.index ?? 0);
              const block = claudeToolBlocks.get(index);
              if (block) {
                const toolArgs = parseJsonObject(block.json);
                emit({
                  type: 'tool-use',
                  issueId: issue.id,
                  runId,
                  toolName: block.name,
                  toolCallId: block.id,
                  toolStatus: 'done',
                  toolArgs,
                  toolCallCount: block.count,
                });
                claudeToolBlocks.delete(index);
              }
            }
          } else if (evt.type === 'result') {
            // Evento final do Claude CLI quando --output-format=stream-json: traz
            // total_cost_usd + usage agregado da conversa toda.
            const usage = evt.usage as
              | { input_tokens?: number; output_tokens?: number }
              | undefined;
            if (usage) {
              usageState.tokensIn = Number(usage.input_tokens ?? 0) || null;
              usageState.tokensOut = Number(usage.output_tokens ?? 0) || null;
            }
            if (typeof evt.total_cost_usd === 'number') {
              usageState.costUsd = evt.total_cost_usd;
            }
          }
        } catch {
          /* linha inválida — ignora */
        }
      }
    });

    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      bumpActivity();
      stderrBuf += chunk;
    });

    // 6. Aguarda fim — com WATCHDOG. Sem o timeout, um CLI travado (nunca emite
    // 'close') deixava a Promise pendente pra sempre → activeRunCount nunca
    // decrementava → o slot ficava preso pra sempre e a fila degradava até
    // congelar. O watchdog mata o processo e libera a fila.
    const MAX_RUN_MS = 20 * 60 * 1000; // 20min — caps de execução de uma issue
    // Stall: nenhum evento (stdout/stderr) por STALL_MS → um tool-call ou comando
    // shell travou. Aborta cedo em vez de esperar os 20min do watchdog global.
    const STALL_MS = 4 * 60 * 1000; // 4min sem nenhuma saída do CLI
    const STALL_CHECK_MS = 30 * 1000; // checa a cada 30s
    const killChild = (): void => {
      try {
        child.kill('SIGTERM');
        const k = setTimeout(() => {
          try {
            if (!child.killed) child.kill('SIGKILL');
          } catch {
            /* já morto */
          }
        }, 3000);
        if (typeof k.unref === 'function') k.unref();
      } catch {
        /* já morto */
      }
    };
    const exitCode = await new Promise<number>((resolve) => {
      let settled = false;
      const done = (code: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        clearInterval(stallTimer);
        resolve(code);
      };
      const watchdog = setTimeout(() => {
        killChild();
        done(-2); // -2 = timeout global (distingue de erro de spawn -1)
      }, MAX_RUN_MS);
      if (typeof watchdog.unref === 'function') watchdog.unref();
      const stallTimer = setInterval(() => {
        if (Date.now() - lastActivityAt >= STALL_MS) {
          killChild();
          done(-3); // -3 = stall (sem eventos por STALL_MS)
        }
      }, STALL_CHECK_MS);
      if (typeof stallTimer.unref === 'function') stallTimer.unref();
      child.on('close', (code) => done(code ?? 0));
      child.on('error', () => done(-1));
    });
    const active = activeRuns.get(issue.id);
    activeRuns.delete(issue.id);

    if (active?.cancelled) {
      issueRepo.finishRun(runId, { status: 'cancelled', exitReason: 'cancelled' });
      // Tira a issue de `in_progress` (senão o sequenciador a vê eternamente
      // ativa e trava o plano inteiro). `cancelled` é estado terminal e o
      // sequenciador o trata como "não-pendência", liberando os irmãos.
      const current = issueRepo.get(issue.id);
      if (current && current.status !== 'done' && current.status !== 'cancelled') {
        issueRepo.update(issue.id, { status: 'cancelled' });
      }
      issueRepo.addComment({
        issueId: issue.id,
        body: '⏸ Execução cancelada pelo usuário.',
        authorKind: 'system',
      });
      emit({ type: 'finished', issueId: issue.id, runId, message: 'Cancelada' });
      finishRootTrace('skipped', 'Execução cancelada pelo usuário.', { status: 'cancelled' });
      reportTerminalToOriginSession(issue, 'cancelled', 'Execução cancelada pelo usuário.');
      return;
    }

    if (exitCode !== 0 || codexFailed) {
      const cleanErr = (codexFailed ?? stderrBuf)
        .replace(/Warning: no stdin data received[^\n]*\n?/g, '')
        .trim();
      // Mensagem CLARA do que houve (o "saiu com código 1" sozinho não dizia nada).
      // Quando o CLI não retorna stderr, o caso mais comum é não estar instalado/
      // autenticado. E se foi um FALLBACK do Forge, explica o porquê + a saída.
      const genericExit =
        cleanErr.slice(0, 400) ||
        `O ${cliLabel} encerrou com erro (código ${exitCode}) sem retornar detalhes — provavelmente o ${cliLabel} CLI não está instalado ou autenticado nesta máquina.`;
      const msg =
        exitCode === -2
          ? `O ${cliLabel} excedeu o tempo limite (20min) e foi encerrado.`
          : exitCode === -3
            ? `O ${cliLabel} travou: nenhuma atividade por 4min (provável tool-call ou comando shell pendurado). Run abortado.`
            : escalatedToPremium
              ? `O modelo local (Forge) não conseguiu e o fallback premium também falhou — ${genericExit} Se você não usa premium, desligue o fallback em Configurações › Comportamento do agente: a issue bloqueia localmente pedindo ajuda em vez de tentar o premium.`
              : genericExit;
      issueRepo.finishRunAndSetStatus(
        runId,
        {
          status: 'failed',
          errorMessage: msg,
          exitCode,
          tokensIn: usageState.tokensIn,
          tokensOut: usageState.tokensOut,
          costUsd: usageState.costUsd,
          toolCallCount,
          adapterType: effectiveAdapter,
          exitReason: escalatedToPremium ? 'escalated_to_premium' : null,
        },
        issue.id,
        { status: 'blocked' },
      );
      issueRepo.addComment({
        issueId: issue.id,
        body: `❌ Execução falhou:\n\n\`\`\`\n${msg}\n\`\`\``,
        authorKind: 'system',
      });
      emit({ type: 'error', issueId: issue.id, runId, error: msg });
      finishRootTrace('failed', msg, {
        exitCode,
        tokensIn: usageState.tokensIn,
        tokensOut: usageState.tokensOut,
        toolCallCount,
      });
      reportTerminalToOriginSession(issue, 'blocked', msg);
      return;
    }

    // 7. Sucesso — registra resumo. Agent normalmente já moveu pra done via
    // update_issue_status. Se não, deixa em in_progress pra usuário revisar.
    const { tokensIn, tokensOut, costUsd } = usageState;
    // NEUTRO de propósito (sem ✅ verde): o run do CLI TERMINOU, mas se a issue foi
    // RESOLVIDA é a revisão/approver que decide depois. O ✅ aqui fazia parecer
    // "feito" mesmo quando o reviewer ia reprovar — o "nem falou se fez". O veredito
    // real (✅ aprovado / 🔁 mudanças / ⚠️ estacionado) é comunicado pelo routeReviewOrFinish.
    const summary = `Run concluído · ${toolCallCount} ações · ${sessionUsageImpact(
      effectiveAdapter,
      tokensIn,
      tokensOut,
    )}`;
    const changeSummary = await collectIssueChangeSummary(targetSource, issue, agent);
    const changeBlock = renderCodeChangeSummaryBlock(changeSummary);
    // Persiste o snapshotId TAMBÉM no caminho premium/CLI: senão o .patch criado por
    // collectIssueChangeSummary fica órfão (vaza disco) E o reviewer deste run não
    // recebe o <orkestral:forge-diff> embutido (cairia no git-diff antigo).
    rememberIssueChangeBlock(issue, changeBlock, changeSummary?.snapshotId);
    const filesChanged = changeSummary?.files.map((file) => file.path) ?? [];
    // Run premium/CLI é auto-verificante (o agente rodou as próprias checagens);
    // mantém o comportamento atual (chega a done) registrando o veredito pra UI/audit.
    rememberIssueVerification(
      issue,
      changeBlock.trim() || filesChanged.length > 0 ? 'verified' : 'not_applicable',
    );
    const userSummary = [summary, changeBlock].filter(Boolean).join('\n\n');
    issueRepo.finishRun(runId, {
      status: 'done',
      outputSummary: summary,
      exitCode,
      tokensIn,
      tokensOut,
      costUsd,
      toolCallCount,
      adapterType: effectiveAdapter,
      exitReason: escalatedToPremium ? 'escalated_to_premium' : null,
    });
    issueRepo.addComment({
      issueId: issue.id,
      body: summary,
      authorKind: 'system',
    });
    emit({
      type: 'finished',
      issueId: issue.id,
      runId,
      message: userSummary,
      toolCallCount,
    });
    finishRootTrace('completed', summary, {
      exitCode,
      tokensIn,
      tokensOut,
      costUsd,
      toolCallCount,
      filesChanged,
    });
    // KB cresce: grava o aprendizado desta execução premium.
    recordExecutionLearning({
      issue,
      agentName: agent.name,
      summary,
      filesChanged,
      outcome: 'done',
      runId,
      modelUsed: escalatedToPremium ? 'hybrid' : 'premium',
      verification: changeBlock.trim() || filesChanged.length > 0 ? 'verified' : 'not_applicable',
      toolCallCount,
      changeBlock,
      contextPack: contextBlock,
      metrics: {
        tokensIn,
        tokensOut,
        costUsd,
        escalatedToPremium,
        adapterType: effectiveAdapter,
      },
      source: targetSource,
    });
    recordAgentTraceStep({
      workspaceId: issue.workspaceId,
      runId,
      issueId: issue.id,
      issueKey: issue.issueKey,
      agentId: agent.id,
      agentName: agent.name,
      parentId: rootTraceId,
      kind: 'learn',
      status: 'completed',
      title: 'Registrando aprendizado da execução',
      summary: `A execução foi salva como memória operacional para futuras tarefas (${filesChanged.length} arquivo(s)).`,
      payload: { filesChanged },
    });
    // Auto-melhoria (fire-and-forget): runs premium com trabalho real podem virar skill.
    void maybeReviewForSkill({
      issue,
      agentName: agent.name,
      summary,
      filesChanged,
      premium: resolvePremiumFallback(issue.workspaceId),
      nonTrivial: toolCallCount >= 3,
    }).catch(() => {});
    routeReviewOrFinish(issue.id, agent.id, userSummary);
    trace({
      level: 'success',
      source: 'issue',
      scope: 'run',
      issueKey: issue.issueKey,
      workspaceId: issue.workspaceId,
      agentId: agent.id,
      agentName: agent.name,
      message: `${agent.name} finalizou "${issue.title}" · ${toolCallCount} ferramentas`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[issue-exec] erro fatal:', err);
    issueRepo.finishRunAndSetStatus(runId, { status: 'failed', errorMessage: msg }, issue.id, {
      status: 'blocked',
    });
    issueRepo.addComment({
      issueId: issue.id,
      body: `❌ Erro fatal na execução: ${msg}`,
      authorKind: 'system',
    });
    // KB cresce: grava o bloqueio pra próxima execução não repetir o erro.
    recordExecutionLearning({
      issue,
      agentName: agent.name,
      summary: `Execution failed: ${msg}`,
      filesChanged: [],
      outcome: 'blocked',
      runId,
      modelUsed: 'unknown',
      verification: 'unverified',
      details: `This task previously FAILED with: ${msg}. Investigate the root cause before retrying the same approach.`,
      source: resolveIssueSource(issue),
    });
    emit({ type: 'error', issueId: issue.id, runId, error: msg });
    finishRootTrace('failed', msg, { fatal: true });
    reportTerminalToOriginSession(issue, 'blocked', msg);
    trace({
      level: 'error',
      source: 'issue',
      scope: 'run',
      issueKey: issue.issueKey,
      workspaceId: issue.workspaceId,
      agentId: agent.id,
      agentName: agent.name,
      message: `${agent.name} falhou em "${issue.title}": ${msg}`,
    });
  } finally {
    // Limpa o registro em todos os caminhos (Forge/rede retornam cedo e não
    // passam pelo delete do CLI). Idempotente: o caminho do CLI já removeu.
    activeRuns.delete(issue.id);
    // Board ao vivo: emite o estado final (done/blocked/cancelled) pra IssuesPage.
    broadcastBoardChanged(issue.workspaceId, 'issue-run-settled');
  }
}

/**
 * Resolve um adapter premium pra rodar o agente quando o Orkestral Forge
 * escala. Prefere o adapter do orquestrador; senão qualquer agente premium;
 * por fim, claude_local como default seguro.
 */
function resolvePremiumFallback(workspaceId: string): {
  adapterType: AdapterType;
  model: string | null;
} {
  const list = agentRepo.listByWorkspace(workspaceId);
  const orch = list.find((a) => a.isOrchestrator);
  if (orch && (orch.adapterType === 'claude_local' || orch.adapterType === 'codex_local')) {
    return { adapterType: orch.adapterType, model: orch.model ?? null };
  }
  const premium = list.find(
    (a) => a.adapterType === 'claude_local' || a.adapterType === 'codex_local',
  );
  if (premium?.adapterType) {
    return { adapterType: premium.adapterType, model: premium.model ?? null };
  }
  return { adapterType: 'claude_local', model: null };
}

function buildIssueContext(issue: Issue): string {
  const issueSource = resolveIssueSource(issue);
  const lines = [
    `## Issue ${issue.issueKey}`,
    `- Title: ${issue.title}`,
    `- Current status: ${issue.status}`,
    `- Priority: ${issue.priority}`,
    `- Labels: ${issue.labels.length > 0 ? issue.labels.join(', ') : '(nenhuma)'}`,
  ];
  // In-context learning: aprendizados de execuções passadas no mesmo workspace.
  const learnings = getRelevantLearnings(
    issue.workspaceId,
    `${issue.title}\n${issue.description ?? ''}`,
    3,
    issueSource?.id ?? null,
  );
  if (learnings) lines.push('', learnings);
  lines.push('', buildMultiAgentInstructions());
  if (issue.metadata) {
    const meta = issue.metadata as Record<string, unknown>;
    // Arquivos-alvo e critério de PRONTO viram seções EM DESTAQUE (não JSON cru
    // enterrado): o executor mira os arquivos certos em vez de adivinhar/mis-targetar.
    const affected = Array.isArray(meta.affectedFiles)
      ? (meta.affectedFiles as unknown[]).filter((f): f is string => typeof f === 'string')
      : [];
    if (affected.length > 0) {
      lines.push(
        '',
        '## Target files (edit EXACTLY these — do not invent other files)',
        ...affected.map((f) => `- ${f}`),
        'If an edit does not match in one of these files, RE-READ the file (Read) and anchor on a line that ACTUALLY exists — never force an anchor that is not literally in the file (a near-miss like `import create` vs `import { create }` will fail).',
      );
    }
    const done = typeof meta.done === 'string' ? meta.done.trim() : '';
    if (done) lines.push('', '## DONE criterion (verify your result against this)', done);
    // Resto do metadata (sem o que já foi destacado + sem o bloco de diff ruidoso):
    // referência crua e secundária.
    const rest = { ...meta };
    delete rest.affectedFiles;
    delete rest.done;
    delete rest.lastCodeChangeBlock;
    if (Object.keys(rest).length > 0) {
      lines.push('', `- Metadata: ${JSON.stringify(rest)}`);
    }
  }
  // Objetivo vinculado — dá o "porquê" pro agente trabalhar olhando pra meta.
  if (issue.goalId) {
    const goal = goalRepo.get(issue.goalId);
    if (goal) {
      lines.push(
        `\n## Objective of this issue`,
        `This task contributes to the objective "${goal.title}" (current progress: ${goal.progress}%).`,
        goal.description ? `Objective context: ${goal.description}` : '',
        `Stay focused on advancing this objective — do not do work outside its scope.`,
      );
    }
  }
  // Comentários (inclui a resposta HUMANA quando o usuário destrava a issue) —
  // numa re-execução após bloqueio, o comentário humano É a instrução a seguir.
  const comments = issueRepo.listComments(issue.id);
  if (comments.length > 0) {
    lines.push('\n## Comments (oldest → newest)');
    for (const c of comments.slice(-10)) {
      const who =
        c.authorKind === 'user' ? 'HUMANO' : c.authorKind === 'agent' ? 'agente' : 'sistema';
      lines.push(`- [${who}] ${c.body.replace(/\n+/g, ' ').slice(0, 500)}`);
    }
    lines.push(
      'If there is a recent HUMAN comment answering a blocker/question, it is the INSTRUCTION to follow — do what it asks (minimal patch) and mark it done. Do not block again for the same reason.',
    );
  }
  return lines.filter(Boolean).join('\n');
}
