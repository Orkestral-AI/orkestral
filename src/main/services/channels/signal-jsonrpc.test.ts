import { describe, it, expect } from 'vitest';
import { encodeRequest, parseLines, type SignalRpcMessage } from './signal-jsonrpc';

describe('signal-jsonrpc', () => {
  it('encodeRequest gera JSON-RPC 2.0 com id e termina em \\n', () => {
    const line = encodeRequest(7, 'send', { recipient: ['+1'], message: 'oi' });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0', id: 7, method: 'send' });
  });

  it('parseLines separa por linha (receive + reply)', () => {
    const buf =
      '{"jsonrpc":"2.0","method":"receive","params":{"envelope":{}}}\n{"jsonrpc":"2.0","id":1,"result":{}}\n';
    const { messages } = parseLines(buf);
    const msgs: SignalRpcMessage[] = messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].method).toBe('receive');
    expect(msgs[1].id).toBe(1);
  });

  it('devolve o resto incompleto (sem \\n) pra próxima leitura', () => {
    const { messages, rest } = parseLines('{"a":1}\n{"b":2');
    expect(messages).toHaveLength(1);
    expect(rest).toBe('{"b":2');
  });

  it('ignora linhas não-JSON (logs do signal-cli)', () => {
    const { messages } = parseLines('INFO arrancando daemon\n{"jsonrpc":"2.0","id":3}\n');
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(3);
  });
});
