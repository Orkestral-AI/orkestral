/**
 * Framing JSON-RPC 2.0 sobre stdio do `signal-cli jsonRpc`: cada mensagem é uma
 * linha JSON terminada em `\n`. Requests saem pelo stdin; receive/replies chegam
 * como notificações/respostas no stdout. Funções puras (testáveis sem processo).
 */

export interface SignalRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Serializa uma request JSON-RPC 2.0 terminada em `\n` (framing por linha). */
export function encodeRequest(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

/**
 * Decodifica um buffer de stdout em mensagens completas (1 por linha) + o `rest`
 * incompleto (linha sem `\n` ainda) pra concatenar na próxima leitura. Linhas que
 * não são JSON (logs do signal-cli) são ignoradas.
 */
export function parseLines(buffer: string): { messages: SignalRpcMessage[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  const messages: SignalRpcMessage[] = [];
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as SignalRpcMessage);
    } catch {
      /* linha não-JSON (log do signal-cli) — ignora */
    }
  }
  return { messages, rest };
}
