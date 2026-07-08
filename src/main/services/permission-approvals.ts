/**
 * Aprovações de permissão PENDENTES — a ponte entre a tool MCP `approval_prompt`
 * (chamada pelo claude CLI quando um run precisa de permissão pra uma tool) e o
 * aprovador interativo (o REPL da CLI, que mostra "Permitir <tool>? (y/n)").
 *
 * Módulo puro de processo (Node `EventEmitter`), SEM imports de Electron/CLI —
 * importável tanto pelo mcp-server (lado que pede) quanto pelo REPL (lado que
 * responde) sem risco de ciclo. Fluxo:
 *
 *   1. mcp-server chama `requestApproval(req)` → registra o pending e emite
 *      'request' no `approvalBus`;
 *   2. o REPL (listener de 'request') mostra o overlay y/n e responde com
 *      `resolveApproval(id, allow)`;
 *   3. a promise resolve com a decisão. Sem resposta em `timeoutMs` → nega
 *      (fail-safe: permissão nunca fica pendurada segurando o run pra sempre)
 *      e emite 'expired' com o id — o REPL derruba o overlay/fila daquele
 *      pedido em vez de deixar um prompt morto na tela.
 *
 * `hasApprover()` diz se há ALGUÉM ouvindo — sem aprovador (GUI, print mode,
 * serve headless) o chamador nega na hora em vez de esperar o timeout.
 */
import { EventEmitter } from 'node:events';

/** Pedido de aprovação de uma tool — payload emitido no evento 'request'. */
export interface ApprovalRequest {
  /** Id único deste pedido (correlaciona request ↔ resposta). */
  id: string;
  /** Nome da tool que o run quer usar (ex.: 'Bash', 'Write'). */
  toolName: string;
  /** Input da tool, como veio do CLI — mostrado como preview pro operador. */
  input: Record<string, unknown>;
  /** Sessão de chat do run (header x-orkestral-session) — null quando ausente. */
  sessionId: string | null;
}

/**
 * Bus de aprovações: emite 'request' com um `ApprovalRequest` por pedido e
 * 'expired' com o id (string) quando um pedido nega por timeout sem resposta.
 */
export const approvalBus = new EventEmitter();

/** Tempo default esperando o operador decidir antes de negar (fail-safe). */
const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;

const pending = new Map<string, (allow: boolean) => void>();

/** Há um aprovador interativo ouvindo o bus? (REPL aberto = true.) */
export function hasApprover(): boolean {
  return approvalBus.listenerCount('request') > 0;
}

/**
 * Registra o pedido e emite 'request' pro aprovador. Resolve com a decisão do
 * `resolveApproval`; sem resposta em `timeoutMs`, resolve `false` (nega), limpa
 * o pending e emite 'expired' com o id (o aprovador descarta o prompt morto).
 * Nunca rejeita — quem chama (handler da tool MCP) não pode lançar.
 */
export function requestApproval(
  req: ApprovalRequest,
  timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(req.id);
      approvalBus.emit('expired', req.id);
      resolve(false);
    }, timeoutMs);
    // Registrado ANTES do emit — um listener síncrono pode responder na hora.
    pending.set(req.id, (allow) => {
      clearTimeout(timer);
      pending.delete(req.id);
      resolve(allow);
    });
    approvalBus.emit('request', req);
  });
}

/**
 * Responde um pedido pendente. Retorna `true` se de fato resolveu um pending;
 * `false` pra id desconhecido (expirado/duplicado) — o chamador usa isso pra
 * avisar "aprovação já expirou" em vez de fingir que a decisão valeu.
 */
export function resolveApproval(id: string, allow: boolean): boolean {
  const settle = pending.get(id);
  if (!settle) return false;
  settle(allow);
  return true;
}
