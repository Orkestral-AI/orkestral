import { IssueRepository } from '../db/repositories/issue.repo';
import { executeIssue } from './issue-execution-service';
import type { Issue } from '../../shared/types';

const issueRepo = new IssueRepository();

/** Cadências suportadas pela relação monitorSchedule (Paperclip-style). */
const SCHEDULE_INTERVAL_MS: Record<string, number> = {
  hourly: 60 * 60_000,
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
};

/** Última execução de monitoramento, guardada no metadata da issue (sem migration). */
function lastMonitorRunMs(issue: Issue): number {
  const meta = (issue.metadata as { lastMonitorRunAt?: string } | null) ?? null;
  const raw = meta?.lastMonitorRunAt;
  return raw ? new Date(raw).getTime() : 0;
}

/** A issue está "due" pra um novo ciclo de monitoramento? */
function isMonitorDue(issue: Issue, schedule: string, now: number): boolean {
  const intervalMs = SCHEDULE_INTERVAL_MS[schedule];
  if (!intervalMs) return false;
  // Issue ainda em aberto não precisa de monitor — o fluxo normal de execução
  // já cuida dela. Monitor é pra re-checar trabalho terminado periodicamente.
  if (issue.status !== 'done' && issue.status !== 'cancelled') return false;
  return now - lastMonitorRunMs(issue) >= intervalMs;
}

/**
 * Dispara o ciclo de monitoramento de uma issue: re-executa o assignee pra
 * re-checar/re-validar o trabalho. Idempotente e nunca derruba o main —
 * executeIssue pode lançar (já rodando, sem assignee, bloqueada) e spawn já
 * trata error internamente.
 */
function runMonitor(issue: Issue): void {
  // Marca antes de disparar pra não re-enfileirar no próximo tick caso o run
  // demore mais que o intervalo.
  issueRepo.update(issue.id, {
    metadata: {
      ...((issue.metadata as Record<string, unknown>) ?? {}),
      lastMonitorRunAt: new Date().toISOString(),
    },
  });
  try {
    executeIssue(issue.id);
  } catch (err) {
    console.warn('[monitor] disparo da issue falhou:', err instanceof Error ? err.message : err);
  }
}

let schedulerHandle: NodeJS.Timeout | null = null;

export function startMonitorScheduler(): void {
  if (schedulerHandle) return;
  schedulerHandle = setInterval(tick, 60_000);
  setTimeout(tick, 9_000);
}

export function stopMonitorScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}

function tick(): void {
  try {
    const now = Date.now();
    for (const { issue, schedule } of issueRepo.listWithMonitorSchedule()) {
      if (isMonitorDue(issue, schedule, now)) runMonitor(issue);
    }
  } catch (err) {
    console.warn('[monitor] tick erro:', err);
  }
}
