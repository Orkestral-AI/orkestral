import { describe, it, expect } from 'vitest';
import { orderBySteerPriority } from './chat-queue.repo';

// "Steer" é PRIORIDADE de fila (fura a fila), não um checkpoint mid-turn: os
// itens marcados como steer vão pra frente, mas a ordem relativa de criação
// (FIFO) é preservada dentro de cada grupo. A entrada já vem ordenada por
// createdAt.
describe('orderBySteerPriority', () => {
  const item = (id: string, kind: 'queue' | 'steer') => ({ id, kind });

  it('mantém a ordem quando não há steer (FIFO puro)', () => {
    const out = orderBySteerPriority([item('a', 'queue'), item('b', 'queue'), item('c', 'queue')]);
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('move itens steer pra frente preservando o FIFO dentro de cada grupo', () => {
    const out = orderBySteerPriority([
      item('a', 'queue'),
      item('b', 'steer'),
      item('c', 'queue'),
      item('d', 'steer'),
    ]);
    expect(out.map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('todos steer = ordem inalterada', () => {
    const out = orderBySteerPriority([item('a', 'steer'), item('b', 'steer')]);
    expect(out.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('lista vazia = vazia', () => {
    expect(orderBySteerPriority([])).toEqual([]);
  });
});
