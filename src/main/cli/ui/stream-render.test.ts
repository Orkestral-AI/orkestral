import { describe, it, expect } from 'vitest';
import { StreamAccumulator, messagePartsToBlocks, type StreamBlock } from './stream-render';

function textBlocks(blocks: readonly StreamBlock[]): string[] {
  return blocks.filter((b) => b.kind === 'text').map((b) => (b.kind === 'text' ? b.text : ''));
}

describe('StreamAccumulator', () => {
  it('concatena text-delta num único bloco de texto', () => {
    const acc = new StreamAccumulator();
    acc.apply({ type: 'message-start', runId: 'r', messageId: 'm', sessionId: 's' } as never);
    acc.apply({ type: 'text-delta', runId: 'r', messageId: 'm', delta: 'Olá' } as never);
    acc.apply({ type: 'text-delta', runId: 'r', messageId: 'm', delta: ' mundo' } as never);
    expect(acc.blocks()).toEqual([{ kind: 'text', text: 'Olá mundo' }]);
    expect(acc.text()).toBe('Olá mundo');
    expect(acc.done()).toBe(false);
  });

  it('message-end marca done', () => {
    const acc = new StreamAccumulator();
    acc.apply({ type: 'message-end', runId: 'r', messageId: 'm', status: 'done' } as never);
    expect(acc.done()).toBe(true);
  });

  it('captura o texto do erro', () => {
    const acc = new StreamAccumulator();
    acc.apply({ type: 'error', runId: 'r', messageId: 'm', error: 'boom' } as never);
    expect(acc.done()).toBe(true);
    expect(acc.error()).toBe('boom');
  });

  it('tool-call vira bloco de tool com resumo dos args', () => {
    const acc = new StreamAccumulator();
    acc.apply({
      type: 'tool-call',
      runId: 'r',
      messageId: 'm',
      part: { type: 'tool-call', id: 't1', toolName: 'Read', args: { file_path: 'src/a.ts' } },
    } as never);
    expect(acc.blocks()).toEqual([
      { kind: 'tool', id: 't1', name: 'Read', argsSummary: 'src/a.ts', status: 'pending' },
    ]);
  });

  it('tool-call com mesmo id ATUALIZA o bloco existente (dedup do re-emit)', () => {
    const acc = new StreamAccumulator();
    acc.apply({
      type: 'tool-call',
      runId: 'r',
      messageId: 'm',
      part: { type: 'tool-call', id: 't1', toolName: 'Bash', status: 'pending' },
    } as never);
    acc.apply({
      type: 'tool-call',
      runId: 'r',
      messageId: 'm',
      part: {
        type: 'tool-call',
        id: 't1',
        toolName: 'Bash',
        args: { command: 'ls -la' },
        status: 'done',
        output: 'ok',
      },
    } as never);
    const blocks = acc.blocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      kind: 'tool',
      id: 't1',
      name: 'Bash',
      argsSummary: 'ls -la',
      status: 'done',
      outputPreview: 'ok',
      outputTruncated: false,
    });
  });

  it('re-emit done com output guarda o preview (3 linhas + flag de truncado)', () => {
    const acc = new StreamAccumulator();
    acc.apply({
      type: 'tool-call',
      runId: 'r',
      messageId: 'm',
      part: { type: 'tool-call', id: 't1', toolName: 'Bash', status: 'pending' },
    } as never);
    acc.apply({
      type: 'tool-call',
      runId: 'r',
      messageId: 'm',
      part: {
        type: 'tool-call',
        id: 't1',
        toolName: 'Bash',
        status: 'done',
        output: 'linha 1\nlinha 2\nlinha 3\nlinha 4\nlinha 5',
      },
    } as never);
    const block = acc.blocks()[0];
    if (block.kind !== 'tool') throw new Error('esperava bloco de tool');
    expect(block.outputPreview).toBe('linha 1\nlinha 2\nlinha 3');
    expect(block.outputTruncated).toBe(true);
    // Re-emit posterior SEM output não apaga o preview já conhecido.
    acc.apply({
      type: 'tool-call',
      runId: 'r',
      messageId: 'm',
      part: { type: 'tool-call', id: 't1', toolName: 'Bash', status: 'done' },
    } as never);
    const after = acc.blocks()[0];
    if (after.kind !== 'tool') throw new Error('esperava bloco de tool');
    expect(after.outputPreview).toBe('linha 1\nlinha 2\nlinha 3');
    expect(after.outputTruncated).toBe(true);
  });

  it('linha longa do output corta em ~100 colunas e liga o truncated', () => {
    const acc = new StreamAccumulator();
    acc.apply({
      type: 'tool-call',
      runId: 'r',
      messageId: 'm',
      part: {
        type: 'tool-call',
        id: 't1',
        toolName: 'Bash',
        status: 'done',
        output: 'x'.repeat(300),
      },
    } as never);
    const block = acc.blocks()[0];
    if (block.kind !== 'tool') throw new Error('esperava bloco de tool');
    const preview = block.outputPreview ?? '';
    expect(preview.length).toBeLessThanOrEqual(100);
    expect(preview.endsWith('…')).toBe(true);
    expect(block.outputTruncated).toBe(true);
  });

  it('re-emit sem args preserva o argsSummary já conhecido', () => {
    const acc = new StreamAccumulator();
    acc.apply({
      type: 'tool-call',
      runId: 'r',
      messageId: 'm',
      part: { type: 'tool-call', id: 't1', toolName: 'Grep', args: { pattern: 'foo' } },
    } as never);
    acc.apply({
      type: 'tool-call',
      runId: 'r',
      messageId: 'm',
      part: { type: 'tool-call', id: 't1', toolName: 'Grep', status: 'error' },
    } as never);
    const blocks = acc.blocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'tool', argsSummary: 'foo', status: 'error' });
  });

  it('resumo de args trunca valores longos (~40 chars)', () => {
    const acc = new StreamAccumulator();
    const long = 'x'.repeat(100);
    acc.apply({
      type: 'tool-call',
      runId: 'r',
      messageId: 'm',
      part: { type: 'tool-call', id: 't1', toolName: 'Bash', args: { command: long } },
    } as never);
    const block = acc.blocks()[0];
    if (block.kind !== 'tool') throw new Error('esperava bloco de tool');
    expect(block.argsSummary.length).toBeLessThanOrEqual(40);
    expect(block.argsSummary.endsWith('…')).toBe(true);
  });

  it('texto depois de tool abre um NOVO bloco de texto (ordem preservada)', () => {
    const acc = new StreamAccumulator();
    acc.apply({ type: 'text-delta', runId: 'r', messageId: 'm', delta: 'antes' } as never);
    acc.apply({
      type: 'tool-call',
      runId: 'r',
      messageId: 'm',
      part: { type: 'tool-call', id: 't1', toolName: 'Read' },
    } as never);
    acc.apply({ type: 'text-delta', runId: 'r', messageId: 'm', delta: 'depois' } as never);
    expect(acc.blocks().map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
    expect(textBlocks(acc.blocks())).toEqual(['antes', 'depois']);
  });

  it('text-set substitui TODO o texto e mantém os blocos de tool', () => {
    const acc = new StreamAccumulator();
    acc.apply({ type: 'text-delta', runId: 'r', messageId: 'm', delta: 'rascunho' } as never);
    acc.apply({
      type: 'tool-call',
      runId: 'r',
      messageId: 'm',
      part: { type: 'tool-call', id: 't1', toolName: 'Read' },
    } as never);
    acc.apply({ type: 'text-delta', runId: 'r', messageId: 'm', delta: 'meio' } as never);
    acc.apply({ type: 'text-set', runId: 'r', messageId: 'm', text: 'final' } as never);
    // Concatenação substituída: tools primeiro (na ordem), UM bloco de texto no fim.
    expect(acc.blocks()).toEqual([
      { kind: 'tool', id: 't1', name: 'Read', argsSummary: '', status: 'pending' },
      { kind: 'text', text: 'final' },
    ]);
    expect(acc.text()).toBe('final');
  });

  it('rastreia a fase (label explícito e fallback por fase)', () => {
    const acc = new StreamAccumulator();
    expect(acc.phase()).toBeNull();
    acc.apply({
      type: 'phase',
      runId: 'r',
      messageId: 'm',
      phase: 'thinking',
      label: 'Pensando…',
    } as never);
    expect(acc.phase()).toBe('Pensando…');
    acc.apply({ type: 'phase', runId: 'r', messageId: 'm', phase: 'writing' } as never);
    expect(acc.phase()).toBe('escrevendo…');
  });

  it('message-final substitui o texto pelo canônico e atualiza status das tools', () => {
    const acc = new StreamAccumulator();
    acc.apply({
      type: 'text-delta',
      runId: 'r',
      messageId: 'm',
      delta: 'streaming trunc',
    } as never);
    acc.apply({
      type: 'tool-call',
      runId: 'r',
      messageId: 'm',
      part: { type: 'tool-call', id: 't1', toolName: 'Edit', args: { file_path: 'a.ts' } },
    } as never);
    acc.apply({
      type: 'message-final',
      runId: 'r',
      messageId: 'm',
      parts: [
        { type: 'text', text: 'texto canônico do DB' },
        {
          type: 'tool-call',
          id: 't1',
          toolName: 'Edit',
          args: { file_path: 'a.ts' },
          status: 'done',
        },
      ],
    } as never);
    expect(acc.finalText()).toBe('texto canônico do DB');
    expect(acc.blocks()).toEqual([
      { kind: 'tool', id: 't1', name: 'Edit', argsSummary: 'a.ts', status: 'done' },
      { kind: 'text', text: 'texto canônico do DB' },
    ]);
  });

  it('finalText() é null sem message-final', () => {
    const acc = new StreamAccumulator();
    acc.apply({ type: 'text-delta', runId: 'r', messageId: 'm', delta: 'oi' } as never);
    acc.apply({ type: 'message-end', runId: 'r', messageId: 'm', status: 'done' } as never);
    expect(acc.finalText()).toBeNull();
  });
});

describe('messagePartsToBlocks', () => {
  it('tools em cima + texto concatenado num bloco no fim (layout canônico)', () => {
    expect(
      messagePartsToBlocks([
        { type: 'text', text: 'primeira parte' },
        { type: 'tool-call', id: 't1', toolName: 'Read', args: { file_path: 'src/a.ts' } },
        { type: 'text', text: 'segunda parte' },
      ]),
    ).toEqual([
      { kind: 'tool', id: 't1', name: 'Read', argsSummary: 'src/a.ts', status: 'done' },
      { kind: 'text', text: 'primeira parte\nsegunda parte' },
    ]);
  });

  it('part de erro vira texto "erro: …"; thinking é pulado; vazio dá []', () => {
    expect(
      messagePartsToBlocks([
        { type: 'thinking', text: 'pensando…' },
        { type: 'error', message: 'boom' },
      ]),
    ).toEqual([{ kind: 'text', text: 'erro: boom' }]);
    expect(messagePartsToBlocks([{ type: 'text', text: '   ' }])).toEqual([]);
  });

  it('tool sem status persiste como done (histórico nunca fica pendente)', () => {
    expect(messagePartsToBlocks([{ type: 'tool-call', toolName: 'Bash' }])).toEqual([
      { kind: 'tool', id: 'tool-auto-0', name: 'Bash', argsSummary: '', status: 'done' },
    ]);
  });

  it('part com output carrega o outputPreview (caminho do resume)', () => {
    const blocks = messagePartsToBlocks([
      { type: 'tool-call', id: 't1', toolName: 'Bash', output: 'a\nb\nc\nd', status: 'done' },
    ]);
    expect(blocks).toEqual([
      {
        kind: 'tool',
        id: 't1',
        name: 'Bash',
        argsSummary: '',
        status: 'done',
        outputPreview: 'a\nb\nc',
        outputTruncated: true,
      },
    ]);
  });
});
