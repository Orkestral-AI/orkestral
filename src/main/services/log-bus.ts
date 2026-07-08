/**
 * LogBus — trace de execução unificado da plataforma.
 *
 * Coleta linhas estruturadas (TraceEntry) de qualquer subsistema (Forge, execução
 * de issues, chat, code-review) num ring buffer em memória e:
 *   1. faz `console.log` (mantém a saída no terminal do `npm run dev`);
 *   2. transmite ao vivo pro renderer via `webContents.send('logs:entry', …)`.
 *
 * A página Logs faz backfill com `listTraces()` ao abrir e depois escuta o evento.
 * Persiste no DB (tabela trace_logs, cap de 500 linhas) — vira histórico que
 * sobrevive ao restart, não só monitor ao vivo. Tudo é best-effort: se o DB não
 * estiver pronto, segue só com broadcast + console (trace nunca lança).
 */
import { broadcast as hostBroadcast } from '../platform/host';
import { traceLogRepo } from '../db/repositories/trace-log.repo';
import type { TraceEntry, TraceLevel, TraceSource } from '../../shared/types';

let seq = 0;

export interface TraceInput {
  level?: TraceLevel;
  source: TraceSource;
  message: string;
  scope?: string | null;
  workspaceId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  issueKey?: string | number | null;
  durationMs?: number | null;
  /** Também ecoa no console do main (default true). */
  echo?: boolean;
}

function broadcast(entry: TraceEntry): void {
  hostBroadcast('logs:entry', entry);
}

/** Registra uma linha de trace: guarda, ecoa no console e transmite ao renderer. */
export function trace(input: TraceInput): TraceEntry {
  seq += 1;
  const entry: TraceEntry = {
    id: `t_${Date.now().toString(36)}_${seq.toString(36)}`,
    ts: Date.now(),
    level: input.level ?? 'info',
    source: input.source,
    message: input.message,
    scope: input.scope ?? null,
    workspaceId: input.workspaceId ?? null,
    agentId: input.agentId ?? null,
    agentName: input.agentName ?? null,
    issueKey: input.issueKey ?? null,
    durationMs: input.durationMs ?? null,
  };

  try {
    traceLogRepo.insert(entry);
  } catch {
    // DB ainda não pronto (boot) ou indisponível — segue só ao vivo/console.
  }

  if (input.echo !== false) {
    const tag = `[${entry.source}]`;
    const ctx = entry.issueKey ? ` ${entry.issueKey}` : '';
    const line = `${tag}${ctx} ${entry.message}`;
    if (entry.level === 'error') console.error(line);
    else if (entry.level === 'warn') console.warn(line);
    else console.log(line);
  }

  broadcast(entry);
  return entry;
}

/** Backfill: linhas mais recentes do DB (ordem cronológica, cap 500). */
export function listTraces(limit = 500): TraceEntry[] {
  try {
    return traceLogRepo.list(limit);
  } catch {
    return [];
  }
}

/** Limpa o histórico de trace (botão "limpar" no terminal). */
export function clearTraces(): void {
  try {
    traceLogRepo.clear();
  } catch {
    /* DB indisponível — nada a limpar */
  }
}
