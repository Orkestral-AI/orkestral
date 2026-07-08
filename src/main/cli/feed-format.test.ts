import { describe, it, expect } from 'vitest';
import { feedTime, formatFeedEvent } from './feed-format';
import type { ChatMessage, ChatStreamEvent } from '../../shared/types';

function channelMessage(text: string): ChatMessage {
  return {
    id: 'm1',
    sessionId: 's1',
    role: 'user',
    parts: [{ type: 'text', text }],
    status: 'done',
    createdAt: new Date(0).toISOString(),
  };
}

describe('feedTime', () => {
  it('formata HH:MM com zero à esquerda', () => {
    const ts = new Date(2026, 0, 1, 7, 5).getTime();
    expect(feedTime(ts)).toBe('07:05');
  });
});

describe('formatFeedEvent', () => {
  it('message-start → iniciando', () => {
    const e: ChatStreamEvent = {
      type: 'message-start',
      runId: 'r',
      messageId: 'm',
      sessionId: 's',
    };
    expect(formatFeedEvent(e)).toBe('run ▸ iniciando…');
  });

  it('phase usa o label (fallback: nome da phase)', () => {
    const base = { type: 'phase', runId: 'r', messageId: 'm', phase: 'tool' } as const;
    expect(formatFeedEvent({ ...base, label: 'lendo arquivos' })).toBe('run ▸ lendo arquivos');
    expect(formatFeedEvent({ ...base })).toBe('run ▸ tool');
  });

  it('tool-call mostra o nome da tool', () => {
    const e: ChatStreamEvent = {
      type: 'tool-call',
      runId: 'r',
      messageId: 'm',
      part: { type: 'tool-call', toolName: 'Read' },
    };
    expect(formatFeedEvent(e)).toBe('run ▸ tool: Read');
  });

  it('message-end distingue done/cancelled/error', () => {
    const base = { type: 'message-end', runId: 'r', messageId: 'm' } as const;
    expect(formatFeedEvent({ ...base, status: 'done' })).toBe('run ▸ concluído');
    expect(formatFeedEvent({ ...base, status: 'cancelled' })).toBe('run ▸ cancelado');
    expect(formatFeedEvent({ ...base, status: 'error' })).toBe('run ▸ falhou');
  });

  it('user-message (canal) vira preview truncado em 60 chars', () => {
    const short = formatFeedEvent({
      type: 'user-message',
      sessionId: 's',
      message: channelMessage('oi, tudo bem?'),
    });
    expect(short).toBe('canal ◂ "oi, tudo bem?"');

    const long = formatFeedEvent({
      type: 'user-message',
      sessionId: 's',
      message: channelMessage('x'.repeat(80)),
    });
    expect(long).toBe(`canal ◂ "${'x'.repeat(60)}…"`);
  });

  it('deltas de texto/thinking não viram linha', () => {
    expect(
      formatFeedEvent({ type: 'text-delta', runId: 'r', messageId: 'm', delta: 'a' }),
    ).toBeNull();
    expect(
      formatFeedEvent({ type: 'thinking-delta', runId: 'r', messageId: 'm', delta: 'a' }),
    ).toBeNull();
  });
});
