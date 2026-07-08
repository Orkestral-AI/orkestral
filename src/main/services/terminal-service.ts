import { broadcast as hostBroadcast } from '../platform/host';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as pty from 'node-pty';

/**
 * Serviço de terminais (PTY real via node-pty). Cada terminal vive aqui no main,
 * keyed por id, e sobrevive à navegação do renderer — só morre no kill explícito
 * ou no quit do app. O I/O vai pro renderer pelo canal de eventos `terminal:data`
 * (mesmo padrão de `chat:stream`); o input/resize/kill chegam por invoke.
 */

interface TerminalInstance {
  id: string;
  proc: pty.IPty;
  cwd: string;
  /** Marcador opaco do renderer (o sourceId) pra re-associar a aba certa no re-attach. */
  meta?: string;
  lastUrl?: string;
  /** Ring buffer da saída recente — replayado quando o renderer RE-ATTACHA após um reload
   *  (o PTY sobrevive no main; sem o buffer, o contexto do terminal sumia ao recarregar). */
  buffer: string;
}

const terminals = new Map<string, TerminalInstance>();
let seq = 0;
// Teto do ring buffer por terminal (~256KB) — o bastante pra restaurar o contexto visível
// sem segurar memória sem fim num terminal de longa duração (ex.: dev server verboso).
const TERMINAL_BUFFER_CAP = 256 * 1024;

function broadcast(
  channel: 'terminal:data' | 'terminal:exit' | 'terminal:url-detected' | 'terminal:created',
  payload: unknown,
): void {
  hostBroadcast(channel, payload);
}

// Detecta a URL do dev server na saída (ex.: Vite "Local: http://localhost:5174/").
// O \x1b (ESC) é intencional: remove códigos ANSI de cor da saída do terminal.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\/?[^\s)'"]*/i;
function detectUrl(inst: TerminalInstance, data: string): void {
  const clean = data.replace(ANSI_RE, '');
  const m = clean.match(URL_RE);
  if (m && m[0] !== inst.lastUrl) {
    inst.lastUrl = m[0];
    broadcast('terminal:url-detected', { id: inst.id, url: m[0] });
  }
}

/** Shell padrão do SO (respeita $SHELL no Unix, COMSPEC no Windows). */
function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/zsh';
}

/** Copia o env removendo undefined (node-pty exige Record<string,string>). */
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v != null) out[k] = v;
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  return out;
}

export function createTerminal(opts: {
  cwd?: string;
  cols?: number;
  rows?: number;
  meta?: string;
}): {
  id: string;
} {
  const id = `term_${Date.now().toString(36)}_${seq++}`;
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : os.homedir();
  const proc = pty.spawn(defaultShell(), [], {
    name: 'xterm-256color',
    cwd,
    cols: Math.max(1, opts.cols ?? 80),
    rows: Math.max(1, opts.rows ?? 24),
    env: cleanEnv(),
  });
  const inst: TerminalInstance = { id, proc, cwd, meta: opts.meta, buffer: '' };
  proc.onData((data) => {
    // Acumula no ring buffer (capado) pro re-attach replayar o contexto após um reload.
    inst.buffer = (inst.buffer + data).slice(-TERMINAL_BUFFER_CAP);
    broadcast('terminal:data', { id, data });
    detectUrl(inst, data);
  });
  proc.onExit(({ exitCode }) => {
    terminals.delete(id);
    broadcast('terminal:exit', { id, exitCode });
  });
  terminals.set(id, inst);
  return { id };
}

/** PTYs vivos no main (sobrevivem ao reload do renderer) — pro re-attach redescobrir as abas,
 *  restaurar o buffer e voltar a poder MATAR a sessão (senão vira processo fantasma). */
export function listTerminals(): Array<{
  id: string;
  cwd: string;
  meta?: string;
  buffer: string;
}> {
  return [...terminals.values()].map((t) => ({
    id: t.id,
    cwd: t.cwd,
    meta: t.meta,
    buffer: t.buffer,
  }));
}

export function writeTerminal(id: string, data: string): void {
  terminals.get(id)?.proc.write(data);
}

/**
 * Anuncia ao renderer um terminal criado FORA dele (ex.: pelo agente via MCP) pra
 * ele aparecer na aba do source na hora — sem isso o renderer só descobriria no
 * próximo `terminal:list` (reload). `command` é só pra contexto/log na UI.
 */
export function announceAgentTerminal(id: string, sourceId: string, command: string): void {
  broadcast('terminal:created', { id, sourceId, command });
}

/** Última URL de dev server detectada no terminal mais recente de um source. */
export function getLastUrlForSource(sourceId: string): string | null {
  let best: TerminalInstance | null = null;
  for (const t of terminals.values()) {
    if (t.meta === sourceId && t.lastUrl) best = t; // o último no Map = mais recente
  }
  return best?.lastUrl ?? null;
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const proc = terminals.get(id)?.proc;
  if (!proc) return;
  try {
    proc.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
  } catch {
    // resize pode falhar se o pty acabou de morrer — ignora.
  }
}

export function killTerminal(id: string): void {
  const inst = terminals.get(id);
  if (!inst) return;
  try {
    inst.proc.kill();
  } catch {
    // já morto — ignora.
  }
  terminals.delete(id);
}

/** Mata todos os ptys — chamado no shutdown do app. */
export function killAllTerminals(): void {
  for (const inst of terminals.values()) {
    try {
      inst.proc.kill();
    } catch {
      // ignora
    }
  }
  terminals.clear();
}
