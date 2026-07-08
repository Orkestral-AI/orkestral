import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appInfo } from '../platform/host';

/**
 * Histórico de input do REPL persistido em disco — sobrevive entre sessões.
 *
 * Formato: um arquivo texto simples (`<userData>/cli-history`), uma linha por
 * entrada, mais recente por último. O append é barato (appendFileSync de uma
 * linha); o arquivo só é reescrito inteiro quando passa do teto de reescrita
 * (~600 linhas), quando é aparado pras últimas `HISTORY_CAP`. Tudo aqui é
 * best-effort: I/O falhou (disco cheio, sem permissão…) → segue sem histórico,
 * NUNCA lança pra cima.
 */

/** Máximo de entradas mantidas (em memória e ao reescrever o arquivo). */
export const HISTORY_CAP = 500;

/** Acima disso o append reescreve o arquivo aparado pras últimas HISTORY_CAP. */
const REWRITE_THRESHOLD = 600;

/**
 * Núcleo PURO do histórico: anexa `line` em `lines` ignorando vazios, dedupando
 * consecutivos idênticos e aparando pro `cap` (mantém as mais recentes).
 * Devolve um array NOVO quando muda; o mesmo array quando não há o que fazer.
 */
export function pushLine(lines: string[], line: string, cap: number): string[] {
  const trimmed = line.trim();
  if (!trimmed) return lines;
  if (lines[lines.length - 1] === trimmed) return lines;
  const next = [...lines, trimmed];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

function historyFilePath(): string {
  return join(appInfo.path('userData'), 'cli-history');
}

/** Linhas não-vazias do arquivo, na ordem (mais recente por último). */
function readLines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Carrega o histórico persistido (mais recente por último), já aparado pras
 * últimas HISTORY_CAP entradas. Arquivo ausente/ilegível → lista vazia.
 */
export function loadHistory(): string[] {
  try {
    const lines = readLines(historyFilePath());
    return lines.length > HISTORY_CAP ? lines.slice(lines.length - HISTORY_CAP) : lines;
  } catch {
    return [];
  }
}

/**
 * Persiste uma linha enviada no fim do arquivo. Vazios e repetições consecutivas
 * são ignorados. Caminho quente = UM appendFileSync; só reescreve o arquivo
 * inteiro (aparado pro cap) quando ele passa de REWRITE_THRESHOLD linhas.
 */
export function appendHistory(line: string): void {
  try {
    const trimmed = line.trim();
    if (!trimmed) return;
    const file = historyFilePath();
    let lines: string[] = [];
    try {
      lines = readLines(file);
    } catch {
      // Arquivo ainda não existe — primeira gravação cria.
    }
    if (lines[lines.length - 1] === trimmed) return; // dedupe consecutivo
    mkdirSync(dirname(file), { recursive: true });
    if (lines.length + 1 > REWRITE_THRESHOLD) {
      const next = pushLine(lines, trimmed, HISTORY_CAP);
      writeFileSync(file, `${next.join('\n')}\n`, 'utf8');
    } else {
      appendFileSync(file, `${trimmed}\n`, 'utf8');
    }
  } catch {
    // Best-effort: histórico persistente nunca derruba o REPL.
  }
}
