import { chatStreamBus, sendMessage } from '../services/chat-service';
import { resolveBootSession } from './repl-boot';
import { summarizeArgs } from './ui/stream-render';
import type { ChatStreamEvent } from '../../shared/types';

/**
 * Modo print do `orkestral -p "pergunta"` — paridade com `claude -p`: um turno
 * only, sem Ink, sem TTY. A resposta streama CRUA pro stdout (text-deltas na
 * ordem em que chegam), as tools viram linhas `⏺ name(args)` no stderr (dim
 * quando o stderr é TTY) e o processo SAI quando o run fecha:
 *
 *   exit 0 — run terminou (message-end)
 *   exit 1 — erro (boot sem workspace/agente, prompt vazio, `-p` sem valor num
 *            TTY — sem pipe não há stdin pra ler —, erro do run)
 *   exit 2 — timeout: nenhum evento do run por PRINT_IDLE_TIMEOUT_MS
 *
 * A sessão é resolvida pelo MESMO boot do REPL (repl-boot.ts) — a diferença é
 * que o print SEMPRE abre uma sessão nova, a não ser com `--continue` (aí vale
 * a semântica de retomada do REPL: última sessão com atividade < 24h).
 */

/** Sem NENHUM evento do run por esse tempo = travou → exit 2. */
const PRINT_IDLE_TIMEOUT_MS = 180_000;

/** Lê o stdin INTEIRO (pra `echo "x" | orkestral -p` e `-p -`). */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Dim ANSI só quando o stderr é TTY (e sem NO_COLOR) — em pipe sai cru. */
function dim(text: string): string {
  if (!process.stderr.isTTY || process.env.NO_COLOR) return text;
  return `\x1b[2m${text}\x1b[0m`;
}

/**
 * Espera o flush do stdout/stderr antes do exit — em pipe os writes podem
 * ficar bufferizados e um `process.exit` seco cortaria a resposta no meio.
 * Os callbacks de write rodam DEPOIS de tudo que já foi enfileirado.
 */
function flushAndExit(code: number): void {
  process.stdout.write('', () => {
    process.stderr.write('', () => process.exit(code));
  });
}

/**
 * Roda o modo print: resolve a sessão (boot do REPL), manda o prompt via
 * `sendMessage` e streama a resposta pro stdout ancorado no `message-start` da
 * sessão. NUNCA retorna — todo caminho termina em exit 0/1/2.
 */
export async function runPrintMode(opts: {
  /** Valor do `-p`: string = prompt inline; `true` (sem valor) ou `'-'` = stdin. */
  promptArg: string | boolean;
  /** `--continue`: retoma a sessão resumível em vez de abrir uma nova. */
  continueSession: boolean;
}): Promise<void> {
  // `-p` sem valor num TTY = ninguém vai pipear nada: erro de uso na hora, em
  // vez de esperar um Ctrl+D mudo. `-p -` fica de fora — é pedido EXPLÍCITO de
  // ler o stdin (o usuário sabe que precisa fechar com Ctrl+D).
  if (opts.promptArg === true && process.stdin.isTTY) {
    process.stderr.write('uso: orkestral -p "pergunta" (ou pipe via stdin)\n');
    flushAndExit(1);
    return;
  }
  const boot = resolveBootSession(!opts.continueSession);
  if (!boot.ok) {
    process.stderr.write('orkestral -p: sem workspace/agente — rode `orkestral init` antes.\n');
    flushAndExit(1);
    return;
  }

  const arg = opts.promptArg;
  const prompt = (typeof arg === 'string' && arg !== '-' ? arg : await readAllStdin()).trim();
  if (!prompt) {
    process.stderr.write('orkestral -p: prompt vazio (passe `-p "pergunta"` ou pipe no stdin).\n');
    flushAndExit(1);
    return;
  }

  const { sessionId } = boot;
  // Âncora do run: preenchida no `message-start` da NOSSA sessão. O bus é
  // global (canais, runs sintéticos…), então todo evento é filtrado por
  // runId/messageId depois de ancorar — igual ao listener do REPL.
  let runId: string | null = null;
  let messageId: string | null = null;
  // Texto já impresso no stdout — `text-set` (redesenho de checklist do engine)
  // só consegue ANEXAR num stream cru: se o texto novo é extensão do impresso,
  // escreve o sufixo; senão ignora (não dá pra "desimprimir" um pipe).
  let printed = '';
  // Tools já anunciadas no stderr — o serviço re-emite a part no done/error;
  // mesmo id = mesma linha, não duplica.
  const announcedTools = new Set<string>();

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const finish = (code: number): void => {
    if (idleTimer) clearTimeout(idleTimer);
    chatStreamBus.off('event', onEvent);
    // Resposta em pipe termina em newline (script-friendly); nada além disso.
    if (code === 0 && printed && !printed.endsWith('\n')) process.stdout.write('\n');
    flushAndExit(code);
  };
  const armIdleTimeout = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      process.stderr.write(
        `orkestral -p: sem eventos do run há ${PRINT_IDLE_TIMEOUT_MS / 1000}s — abortando.\n`,
      );
      finish(2);
    }, PRINT_IDLE_TIMEOUT_MS);
  };

  const onEvent = (e: ChatStreamEvent): void => {
    if (e.type === 'message-start') {
      if (e.synthetic || e.sessionId !== sessionId || runId) return;
      runId = e.runId;
      messageId = e.messageId;
      armIdleTimeout();
      return;
    }
    if (!runId || !messageId) return;
    if ('runId' in e && e.runId !== runId) return;
    if ('messageId' in e && e.messageId !== messageId) return;
    armIdleTimeout();
    switch (e.type) {
      case 'text-delta':
        printed += e.delta;
        process.stdout.write(e.delta);
        break;
      case 'text-set':
        if (e.text.startsWith(printed)) {
          process.stdout.write(e.text.slice(printed.length));
          printed = e.text;
        }
        break;
      case 'tool-call': {
        const part = e.part;
        if (part.type !== 'tool-call') break;
        const id = part.id ?? `${part.toolName}-${announcedTools.size}`;
        if (announcedTools.has(id)) break;
        announcedTools.add(id);
        const args = summarizeArgs(part.args);
        process.stderr.write(`${dim(`⏺ ${part.toolName || 'tool'}(${args})`)}\n`);
        break;
      }
      case 'error':
        process.stderr.write(`orkestral -p: erro no run: ${e.error || 'erro desconhecido'}\n`);
        finish(1);
        break;
      case 'message-end':
        // Nada extra no stdout — o que streamou É a resposta.
        finish(0);
        break;
      default:
        // thinking-delta/phase/message-final: bastidor — não imprime nada.
        break;
    }
  };

  chatStreamBus.on('event', onEvent);
  // Timeout já armado ANTES do send: cobre o caso do run nem começar (adapter
  // que trava no spawn não emite `message-start` nenhum).
  armIdleTimeout();
  try {
    await sendMessage({ sessionId, content: prompt });
  } catch (err) {
    process.stderr.write(
      `orkestral -p: erro ao enviar: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    finish(1);
  }
}
