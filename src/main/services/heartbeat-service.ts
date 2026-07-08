import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, HeartbeatRun } from '../../shared/types';
import { AgentRepository } from '../db/repositories/agent.repo';
import { HeartbeatRunRepository } from '../db/repositories/heartbeat-run.repo';
import { WorkspaceRepository } from '../db/repositories/workspace.repo';
import { IssueRepository } from '../db/repositories/issue.repo';
import { ORKESTRAL_WORKSPACES_DIR } from '../db/connection';
import { ensureDefaultInstructions, readRuntimeInstructionContext } from './agent-instructions';
import {
  resolveSpawnPolicy,
  applyClaudePolicy,
  applyCodexPolicy,
  scrubSpawnEnv,
  type SpawnPolicy,
} from './spawn-policy';
import { applyProviderApiKey } from './provider-auth';
import { executeIssue, maybeAutoExecuteIssue } from './issue-execution-service';
import { getSmartExecConfig, isForgeBundled } from './smart-exec/config';
import { llamaChat } from './smart-exec/llama-runtime';

/**
 * Sistema de heartbeat:
 *
 *  - **Manual**: usuário clica "Run Heartbeat" no header → runHeartbeat()
 *  - **Scheduler**: setInterval no boot verifica a cada minuto se algum
 *    agente com heartbeatEnabled passou do seu intervalMinutes desde o
 *    último heartbeat
 *
 * Cada run:
 *   1. Cria HeartbeatRun em status 'running'
 *   2. Lê HEARTBEAT.md (instructions/HEARTBEAT.md) ou usa prompt default
 *   3. Anexa AGENTS.md como contexto
 *   4. Spawna o CLI do adapter (claude/codex/gemini) no cwd do workspace
 *   5. Aguarda terminar (sem streaming — heartbeat é síncrono pro DB)
 *   6. Finaliza HeartbeatRun + agentRepo.touchHeartbeat()
 */

const agentRepo = new AgentRepository();
const heartbeatRepo = new HeartbeatRunRepository();
const workspaceRepo = new WorkspaceRepository();
const issueRepo = new IssueRepository();

/** Processos ativos por runId (pra cancelamento). */
const activeProcesses = new Map<string, ChildProcess>();

/** Agentes com um heartbeat em andamento — pra o tick não disparar 2 runs. */
const activeAgentRuns = new Set<string>();

const DEFAULT_HEARTBEAT_PROMPT = `Write a heartbeat: review the current state of the project and answer in up to 5 bullets — blockers, risks, and prioritized next steps. This is a read-only status summary: do not attempt to edit files or call tools.`;

/**
 * Tenta delegar o heartbeat pra issues abertas atribuídas ao agente. Política:
 *
 *   1. Procura issues em `todo` (prontas pra começar) — pega a mais antiga e
 *      delega via executeIssue(). Heartbeat "consumiu" o slot trabalhando ali.
 *   2. Se não houver `todo` mas tem `in_progress` parado (sem run ativa há
 *      muito tempo), reativa via executeIssue() — issue stuck precisa de push.
 *   3. Se nada disso: retorna `null` e o caller roda o prompt isolado normal.
 *
 * Retorna a issue executada (pra logging) ou null. NÃO bloqueia — executeIssue
 * é fire-and-forget.
 */
function tryDelegateToOpenIssue(
  agentId: string,
  workspaceId: string,
): { issueKey: number; reason: 'todo' | 'reactivate' } | null {
  const open = issueRepo.listByWorkspace(workspaceId, {
    assigneeAgentId: agentId,
  });

  // Épicas (issues com sub-issues) são CONTÊINERES de coordenação — NUNCA são
  // executadas direto (quem trabalha são as filhas). Excluí-las evita o heartbeat
  // re-rodar um épico (ex.: um split que virou épica) à toa.
  const isEpic = (id: string): boolean => issueRepo.listChildren(id).length > 0;

  // 1. Issues em `todo` — pega a mais antiga (createdAt ascendente)
  const todo = open
    .filter((i) => i.status === 'todo' && !isEpic(i.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (todo.length > 0) {
    const target = todo[0];
    try {
      executeIssue(target.id);
      return { issueKey: target.issueKey, reason: 'todo' };
    } catch (err) {
      console.warn(
        `[heartbeat] delegar pra ${target.issueKey} falhou:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 2. Issues `in_progress` sem progresso recente — reativar.
  // Critério: lastRun finalizado há mais de 30min OU sem run nenhuma há mais de 30min.
  const STUCK_THRESHOLD_MS = 30 * 60_000;
  const now = Date.now();
  for (const issue of open.filter((i) => i.status === 'in_progress' && !isEpic(i.id))) {
    const runs = issueRepo.listRuns(issue.id);
    const active = runs.find((r) => r.status === 'running');
    if (active) continue; // já rodando, deixa em paz
    const lastFinish = runs[0]?.finishedAt ?? issue.updatedAt;
    if (now - new Date(lastFinish).getTime() < STUCK_THRESHOLD_MS) continue;
    try {
      executeIssue(issue.id);
      return { issueKey: issue.issueKey, reason: 'reactivate' };
    } catch (err) {
      console.warn(
        `[heartbeat] reativar ${issue.issueKey} falhou:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return null;
}

/** Snapshot rápido das issues abertas pro contexto do prompt heartbeat. */
function buildOpenIssuesContext(agentId: string, workspaceId: string): string {
  const open = issueRepo.listByWorkspace(workspaceId, {
    assigneeAgentId: agentId,
  });
  const active = open.filter((i) => i.status === 'in_progress' || i.status === 'todo');
  if (active.length === 0) {
    return '\n\nNo issues currently assigned to you — you may review the workspace backlog and note potential improvements.';
  }
  const lines = active
    .slice(0, 10)
    .map(
      (i) =>
        `- [${i.status === 'in_progress' ? 'in_progress' : 'todo'}] #${i.issueKey} ${i.title} (priority=${i.priority})`,
    );
  return `\n\n## Your open issues (${active.length})\n\n${lines.join('\n')}`;
}

// Referência aos imports usados condicionalmente — silencia o linter quando
// algum branch é tree-shaken.
void maybeAutoExecuteIssue;

const LOCAL_HEARTBEAT_SYSTEM = [
  'You are an engineering agent writing a short status heartbeat about your own work.',
  'You will receive your custom instructions, the heartbeat prompt, your open issues',
  'and a summary of your recent heartbeat runs. Produce a concise status in up to 5',
  'bullets — blockers, risks and prioritized next steps. This is a read-only summary:',
  'do NOT invent issues, files or facts that are not in the provided context. Reply in',
  'the same language as the heartbeat prompt. Output only the bullets, no preamble.',
].join('\n');

/** Resumo curto das últimas runs de heartbeat pro contexto da sumarização local. */
function buildRecentRunsContext(agentId: string): string {
  const runs = heartbeatRepo.listByAgent(agentId, 5);
  if (runs.length === 0) return '\n\n## Recent heartbeats\n\nNone yet.';
  const lines = runs.map((r) => {
    const when = r.startedAt;
    const summary = (r.output ?? r.errorMessage ?? '').replace(/\s+/g, ' ').slice(0, 160);
    return `- [${r.status}] ${when}${summary ? ` — ${summary}` : ''}`;
  });
  return `\n\n## Recent heartbeats\n\n${lines.join('\n')}`;
}

/**
 * Heartbeat de "status em 5 bullets" rodado LOCALMENTE via Forge (llamaChat) —
 * é sumarização pura, não precisa de premium nem de CLI spawnado. Monta o
 * contexto (instruções do agente + issues abertas + runs recentes) e pede o
 * resumo ao modelo local. Em QUALQUER falha (modelo ausente, timeout, etc.)
 * lança — o caller cai no no-op succeeded. NUNCA quebra o fluxo.
 */
async function runLocalHeartbeatSummary(agent: Agent): Promise<string> {
  const heartbeatPrompt = readHeartbeatPrompt(agent);
  const issuesContext = buildOpenIssuesContext(agent.id, agent.workspaceId);
  const runsContext = buildRecentRunsContext(agent.id);
  const agentInstructions = readRuntimeInstructionContext(agent).trim();

  const user = [
    agentInstructions ? `## Your instructions\n\n${agentInstructions}\n` : '',
    `## Heartbeat prompt\n\n${heartbeatPrompt}`,
    issuesContext,
    runsContext,
  ]
    .filter(Boolean)
    .join('\n');

  const out = await llamaChat(getSmartExecConfig(), LOCAL_HEARTBEAT_SYSTEM, user);
  const trimmed = out.trim();
  if (!trimmed) throw new Error('Local heartbeat produced empty output');
  return trimmed;
}

interface BuildResult {
  command: string;
  args: string[];
  usesStdin: boolean;
}

function buildAdapterCommand(
  adapterType: string,
  model?: string | null,
  policy?: SpawnPolicy,
): BuildResult {
  // Default = bypass total (comportamento atual) quando não passada.
  const spawnPolicy: SpawnPolicy = policy ?? { skipPermissions: true, sandbox: false };
  switch (adapterType) {
    case 'claude_local': {
      const args = ['--print', '-'];
      applyClaudePolicy(args, spawnPolicy);
      if (model && model !== 'default') args.push('--model', model);
      return { command: 'claude', args, usesStdin: true };
    }
    case 'codex_local': {
      const args = ['exec', '--skip-git-repo-check'];
      applyCodexPolicy(args, spawnPolicy);
      args.push('-');
      return { command: 'codex', args, usesStdin: true };
    }
    case 'gemini_local':
      return { command: 'gemini', args: ['--prompt'], usesStdin: false };
    default:
      throw new Error(`Adapter ${adapterType} não suportado pra heartbeat`);
  }
}

function readHeartbeatPrompt(agent: Agent): string {
  ensureDefaultInstructions(agent);
  const dir = join(ORKESTRAL_WORKSPACES_DIR, agent.workspaceId, 'agents', agent.id, 'instructions');
  const path = join(dir, 'HEARTBEAT.md');
  if (existsSync(path)) {
    try {
      return readFileSync(path, 'utf8').trim();
    } catch {
      return DEFAULT_HEARTBEAT_PROMPT;
    }
  }
  return DEFAULT_HEARTBEAT_PROMPT;
}

function resolveCwd(agent: Agent): string | undefined {
  const ws = workspaceRepo.listAll().find((w) => w.id === agent.workspaceId);
  if (!ws?.path) return undefined;
  return existsSync(ws.path) ? ws.path : undefined;
}

/**
 * Executa um heartbeat síncrono. Resolve com a run finalizada.
 * Não usa o sistema de stream do chat — heartbeat é uma execução
 * isolada que só registra o resultado final.
 */
export async function runHeartbeat(input: {
  agentId: string;
  source: 'manual' | 'scheduler';
}): Promise<HeartbeatRun> {
  const agent = agentRepo.get(input.agentId);
  if (!agent) throw new Error(`Agente ${input.agentId} não encontrado`);
  if (agent.status === 'paused') {
    throw new Error(`Agente ${agent.name} está pausado — não pode rodar heartbeat`);
  }
  if (!agent.adapterType) {
    throw new Error(`Agente ${agent.name} não tem adapter configurado`);
  }
  // Guard de concorrência: nunca rodar 2 heartbeats do mesmo agente em paralelo
  // (o tick a cada 60s poderia disparar outro enquanto o anterior ainda roda).
  if (activeAgentRuns.has(agent.id)) {
    throw new Error(`Heartbeat de ${agent.name} já está em andamento`);
  }
  activeAgentRuns.add(agent.id);
  try {
    return await runHeartbeatInner(agent, input.source);
  } finally {
    activeAgentRuns.delete(agent.id);
  }
}

/** Adapters que têm CLI spawneável pro heartbeat. */
const HEARTBEAT_CLI_ADAPTERS = new Set(['claude_local', 'codex_local', 'gemini_local']);

async function runHeartbeatInner(
  agent: Agent,
  source: 'manual' | 'scheduler',
): Promise<HeartbeatRun> {
  const input = { source };

  // Agentes Forge (orkestral_local) e quaisquer adapters sem CLI não têm como
  // rodar o heartbeat via spawn premium. Como o heartbeat de "5 bullets de
  // status" é sumarização pura, rodamos LOCALMENTE via Forge (llamaChat) quando
  // o modelo está empacotado — barato e sem premium. Se o modelo estiver
  // ausente ou a inferência falhar, registramos uma run `succeeded` no-op (NUNCA
  // uma `failed`, que viraria retry storm e ruído na UI).
  if (!HEARTBEAT_CLI_ADAPTERS.has(agent.adapterType ?? '')) {
    const run = heartbeatRepo.start({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      source: input.source,
    });

    let output = `Heartbeat skipped: adapter "${agent.adapterType ?? 'unknown'}" has no spawnable CLI (local Forge agent).`;
    if (isForgeBundled()) {
      try {
        output = await runLocalHeartbeatSummary(agent);
      } catch (err) {
        // Modelo ausente/timeout/erro → mantém o no-op succeeded. Fallback sempre.
        console.warn(
          `[heartbeat] sumarização local de ${agent.name} falhou, no-op:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    heartbeatRepo.finish(run.id, {
      status: 'succeeded',
      output,
      exitCode: 0,
    });
    agentRepo.touchHeartbeat(agent.id);
    return heartbeatRepo.get(run.id)!;
  }

  // ⚡ NOVO: antes de rodar o prompt isolado, tenta delegar pra uma issue aberta.
  // Heartbeat deixa de ser "pensamento solto" e vira "trabalhar na fila de issues".
  // O scheduler chama heartbeat → heartbeat chama executeIssue → agente trabalha
  // na issue mais antiga com MCP tools + contexto completo.
  if (agent.adapterType === 'claude_local') {
    const delegated = tryDelegateToOpenIssue(agent.id, agent.workspaceId);
    if (delegated) {
      console.log(
        `[heartbeat] ${agent.name} delegado pra issue ${delegated.issueKey} (${delegated.reason})`,
      );
      const run = heartbeatRepo.start({
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        source: input.source,
      });
      heartbeatRepo.finish(run.id, {
        status: 'succeeded',
        output: `Delegado pra issue #${delegated.issueKey} (${delegated.reason}). O agente está trabalhando ali — veja Activity da issue pra detalhes.`,
        exitCode: 0,
      });
      agentRepo.touchHeartbeat(agent.id);
      return heartbeatRepo.get(run.id)!;
    }
  }

  // Sem issues delegáveis — roda o prompt heartbeat tradicional, com contexto
  // adicional das issues abertas pra o agente saber o estado do board.
  const heartbeatPrompt = readHeartbeatPrompt(agent);
  const issuesContext = buildOpenIssuesContext(agent.id, agent.workspaceId);
  const agentInstructions = readRuntimeInstructionContext(agent);

  const fullPrompt = agentInstructions.trim()
    ? `${agentInstructions.trim()}\n\n---\n\n${heartbeatPrompt}${issuesContext}`
    : `${heartbeatPrompt}${issuesContext}`;

  // adapterType é garantidamente não-nulo aqui: o guard acima já retornou pra
  // qualquer adapter fora de HEARTBEAT_CLI_ADAPTERS (que inclui null).
  const adapterType = agent.adapterType as string;
  let cmdSpec: BuildResult;
  try {
    cmdSpec = buildAdapterCommand(adapterType, agent.model, resolveSpawnPolicy(agent));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const run = heartbeatRepo.start({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      source: input.source,
    });
    heartbeatRepo.finish(run.id, {
      status: 'failed',
      errorMessage: msg,
    });
    // Backoff: marca o tick pra não re-disparar imediatamente (ex.: adapter
    // Forge sem suporte falharia a cada 60s pra sempre).
    agentRepo.touchHeartbeat(agent.id);
    return heartbeatRepo.get(run.id)!;
  }

  const run = heartbeatRepo.start({
    agentId: agent.id,
    workspaceId: agent.workspaceId,
    source: input.source,
  });

  return new Promise<HeartbeatRun>((resolve) => {
    const cwd = resolveCwd(agent);
    const finalArgs = cmdSpec.usesStdin ? cmdSpec.args : [...cmdSpec.args, fullPrompt];

    const heartbeatEnv = scrubSpawnEnv();
    // API key do provedor (página Provedores) → env var do CLI do agente.
    applyProviderApiKey(heartbeatEnv, agent.adapterType);
    let child: ChildProcess;
    try {
      child = spawn(cmdSpec.command, finalArgs, {
        env: heartbeatEnv,
        shell: false,
        cwd,
      });
    } catch (err) {
      heartbeatRepo.finish(run.id, {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      agentRepo.touchHeartbeat(agent.id);
      resolve(heartbeatRepo.get(run.id)!);
      return;
    }

    activeProcesses.set(run.id, child);

    let stdout = '';
    let stderr = '';

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      activeProcesses.delete(run.id);
      heartbeatRepo.finish(run.id, {
        status: 'failed',
        errorMessage: err.message,
      });
      agentRepo.touchHeartbeat(agent.id);
      resolve(heartbeatRepo.get(run.id)!);
    });

    child.on('close', (code) => {
      activeProcesses.delete(run.id);
      const success = (code === 0 || stdout.length > 0) && code !== 137;
      // Trunca output pros últimos 8000 chars (limite razoável de DB row)
      const truncatedOutput = stdout.length > 8000 ? stdout.slice(-8000) : stdout;

      if (success) {
        heartbeatRepo.finish(run.id, {
          status: 'succeeded',
          output: truncatedOutput,
          exitCode: code ?? 0,
        });
        agentRepo.touchHeartbeat(agent.id);
      } else {
        const cleanErr = stderr.replace(/Warning: no stdin data received[^\n]*\n?/g, '').trim();
        heartbeatRepo.finish(run.id, {
          status: 'failed',
          output: truncatedOutput || null,
          errorMessage: cleanErr || `Processo terminou com código ${code}`,
          exitCode: code ?? -1,
        });
        // Toca lastHeartbeatAt mesmo em FALHA pra não re-disparar a cada 60s
        // (retry storm). O agente volta a ser elegível só após o intervalo.
        agentRepo.touchHeartbeat(agent.id);
      }
      resolve(heartbeatRepo.get(run.id)!);
    });

    // Envia prompt via stdin pro claude
    if (cmdSpec.usesStdin && child.stdin) {
      child.stdin.write(fullPrompt);
      child.stdin.end();
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}

/**
 * Cancela uma run em andamento.
 */
export function cancelHeartbeat(runId: string): boolean {
  const proc = activeProcesses.get(runId);
  if (!proc) return false;
  proc.kill('SIGTERM');
  activeProcesses.delete(runId);
  heartbeatRepo.finish(runId, {
    status: 'cancelled',
    errorMessage: 'Cancelado pelo usuário',
  });
  return true;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let schedulerHandle: NodeJS.Timeout | null = null;
let stopping = false;

/**
 * Inicia o scheduler. Chamado no boot do main. A cada minuto verifica
 * agents.heartbeatEnabled e dispara heartbeats vencidos.
 */
export function startHeartbeatScheduler(): void {
  if (schedulerHandle) return;
  stopping = false;
  console.log('[heartbeat] scheduler iniciado (poll a cada 60s)');
  schedulerHandle = setInterval(tick, 60_000);
  // Primeiro tick em 5s pra capturar agentes já elegíveis
  setTimeout(tick, 5_000);
}

export function stopHeartbeatScheduler(): void {
  stopping = true;
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
  // Mata processos ativos
  for (const proc of activeProcesses.values()) {
    proc.kill('SIGTERM');
  }
  activeProcesses.clear();
}

async function tick(): Promise<void> {
  if (stopping) return;
  try {
    const candidates = agentRepo.listHeartbeatEnabled();
    const now = Date.now();
    for (const agent of candidates) {
      // Pula agente que já tem um heartbeat rodando (evita run sobreposta).
      if (activeAgentRuns.has(agent.id)) continue;
      const intervalMs = Math.max(1, agent.heartbeatIntervalMinutes) * 60_000;
      const lastMs = agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).getTime() : 0;
      if (now - lastMs < intervalMs) continue;
      // Dispara fire-and-forget — não bloqueia o tick
      runHeartbeat({ agentId: agent.id, source: 'scheduler' }).catch((err) => {
        console.warn(`[heartbeat] run pra ${agent.name} falhou:`, err);
      });
    }
  } catch (err) {
    console.warn('[heartbeat] tick erro:', err);
  }
}
