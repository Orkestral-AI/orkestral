import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AgentRepository } from '../db/repositories/agent.repo';
import { WorkspaceRepository } from '../db/repositories/workspace.repo';
import { RoutineRepository } from '../db/repositories/routine-goal.repo';
import { ActivityRepository } from '../db/repositories/activity.repo';
import { ensureDefaultInstructions, readRuntimeInstructionContext } from './agent-instructions';
import { scrubSpawnEnv } from './spawn-policy';
import type { AdapterType } from '../../shared/types';

const agentRepo = new AgentRepository();
const workspaceRepo = new WorkspaceRepository();
const routineRepo = new RoutineRepository();
const activityRepo = new ActivityRepository();

function buildAdapterCommand(
  adapter: AdapterType,
  model?: string | null,
): {
  command: string;
  args: string[];
  usesStdin: boolean;
} {
  switch (adapter) {
    case 'claude_local': {
      const args = ['--print', '-', '--dangerously-skip-permissions'];
      if (model && model !== 'default') args.push('--model', model);
      return { command: 'claude', args, usesStdin: true };
    }
    case 'codex_local':
      return {
        command: 'codex',
        args: ['exec', '--skip-git-repo-check', '--yolo', '-'],
        usesStdin: true,
      };
    case 'gemini_local':
      return { command: 'gemini', args: ['--prompt'], usesStdin: false };
    default:
      throw new Error(`Adapter ${adapter} não suportado pra routine`);
  }
}

/**
 * Executa uma routine. Síncrono — registra last_run_at + activity log
 * quando termina. Não interrompe o app se falhar.
 */
export async function runRoutine(routineId: string, source: 'manual' | 'scheduler'): Promise<void> {
  const routine = routineRepo.get(routineId);
  if (!routine) return;
  const agent = agentRepo.get(routine.agentId);
  if (!agent || !agent.adapterType || agent.status === 'paused') return;

  ensureDefaultInstructions(agent);
  const baseInstructions = readRuntimeInstructionContext(agent);
  const finalPrompt = baseInstructions.trim()
    ? `${baseInstructions.trim()}\n\n---\n\n${routine.prompt}`
    : routine.prompt;

  const ws = workspaceRepo.listAll().find((w) => w.id === routine.workspaceId);
  const cwd = ws?.path && existsSync(ws.path) ? ws.path : undefined;

  let cmd: ReturnType<typeof buildAdapterCommand>;
  try {
    cmd = buildAdapterCommand(agent.adapterType, agent.model);
  } catch {
    return;
  }
  const args = cmd.usesStdin ? cmd.args : [...cmd.args, finalPrompt];
  const child = spawn(cmd.command, args, { env: scrubSpawnEnv(), shell: false, cwd });
  if (cmd.usesStdin && child.stdin) {
    child.stdin.write(finalPrompt);
    child.stdin.end();
  } else if (child.stdin) {
    child.stdin.end();
  }
  child.on('close', (code) => {
    routineRepo.touchLastRun(routineId);
    activityRepo.log({
      workspaceId: routine.workspaceId,
      kind: code === 0 ? 'routine.run' : 'routine.failed',
      actorKind: 'system',
      subjectKind: 'routine',
      subjectId: routineId,
      title: `Rotina "${routine.name}" ${code === 0 ? 'rodou' : 'falhou'} (${source})`,
      payload: { exitCode: code, source },
    });
  });
}

let schedulerHandle: NodeJS.Timeout | null = null;

export function startRoutineScheduler(): void {
  if (schedulerHandle) return;
  schedulerHandle = setInterval(tick, 60_000);
  setTimeout(tick, 7_000);
}

export function stopRoutineScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}

async function tick(): Promise<void> {
  try {
    const enabled = routineRepo.listEnabled();
    const now = Date.now();
    for (const r of enabled) {
      const lastMs = r.lastRunAt ? new Date(r.lastRunAt).getTime() : 0;
      const intervalMs = Math.max(1, r.intervalMinutes) * 60_000;
      if (now - lastMs < intervalMs) continue;
      runRoutine(r.id, 'scheduler').catch(() => undefined);
    }
  } catch (err) {
    console.warn('[routines] tick erro:', err);
  }
}
