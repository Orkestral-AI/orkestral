import { describe, it, expect } from 'vitest';
import { coalesceToolOnlyMessages } from './coalesce-tool-messages';
import type { ChatMessage, MessagePart } from '../../../../shared/types';

function msg(id: string, role: 'user' | 'assistant', parts: MessagePart[]): ChatMessage {
  return { id, sessionId: 's', role, parts, status: 'done', createdAt: '2026-06-17T00:00:00Z' };
}
const tool = (name: string): MessagePart => ({
  type: 'tool-call',
  toolCallId: `c-${name}`,
  toolName: name,
  args: {},
  status: 'done',
});
const text = (t: string): MessagePart => ({ type: 'text', text: t });

describe('coalesceToolOnlyMessages — funde cards de exploração consecutivos', () => {
  it('funde mensagens assistant SÓ-tool consecutivas numa só (mantém o 1º id)', () => {
    const out = coalesceToolOnlyMessages([
      msg('a', 'assistant', [tool('Read')]),
      msg('b', 'assistant', [tool('Grep'), tool('Bash')]),
      msg('c', 'assistant', [tool('Glob')]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
    expect(out[0].parts.filter((p) => p.type === 'tool-call')).toHaveLength(4);
  });

  it('texto real no meio QUEBRA o grupo', () => {
    const out = coalesceToolOnlyMessages([
      msg('a', 'assistant', [tool('Read')]),
      msg('b', 'assistant', [text('Achei o bug.')]),
      msg('c', 'assistant', [tool('Grep')]),
    ]);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('texto VAZIO + tool ainda é tool-only (funde)', () => {
    const out = coalesceToolOnlyMessages([
      msg('a', 'assistant', [text('  '), tool('Read')]),
      msg('b', 'assistant', [tool('Grep')]),
    ]);
    expect(out).toHaveLength(1);
  });

  it('não funde user nem mensagem com thinking', () => {
    const out = coalesceToolOnlyMessages([
      msg('u', 'user', [text('faz isso')]),
      msg('a', 'assistant', [tool('Read')]),
      msg('b', 'assistant', [{ type: 'thinking', text: 'hmm' }, tool('Grep')]),
    ]);
    expect(out.map((m) => m.id)).toEqual(['u', 'a', 'b']);
  });

  it('usa o status mais recente (card fica vivo se a última ainda streama)', () => {
    const a = msg('a', 'assistant', [tool('Read')]);
    const b: ChatMessage = { ...msg('b', 'assistant', [tool('Grep')]), status: 'streaming' };
    const out = coalesceToolOnlyMessages([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('streaming');
  });
});
