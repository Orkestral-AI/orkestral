import { describe, it, expect } from 'vitest';
import { pickCommitted } from './segment-commit';

describe('pickCommitted', () => {
  it('nada estável quando tudo está dentro da janela de segurança', () => {
    const segs = [{ from: 0, to: 2000, text: 'oi' }];
    expect(pickCommitted(segs, 2500, 1500)).toEqual({ text: '', trimMs: 0 });
  });
  it('commita segmentos antigos e corta no fim do último estável', () => {
    const segs = [
      { from: 0, to: 1000, text: ' oi' },
      { from: 1000, to: 2000, text: ' tudo bem' },
      { from: 2000, to: 4000, text: ' agora' },
    ];
    // durationMs 4000, safety 1500 → estável: to <= 2500 → segs[0],segs[1]
    expect(pickCommitted(segs, 4000, 1500)).toEqual({ text: 'oi tudo bem', trimMs: 2000 });
  });
  it('lista vazia', () => {
    expect(pickCommitted([], 5000, 1500)).toEqual({ text: '', trimMs: 0 });
  });
  it('normaliza espaços e ignora segmentos vazios', () => {
    const segs = [
      { from: 0, to: 500, text: '  olá  ' },
      { from: 500, to: 800, text: '' },
      { from: 800, to: 1200, text: 'mundo' },
    ];
    expect(pickCommitted(segs, 4000, 1500)).toEqual({ text: 'olá mundo', trimMs: 1200 });
  });
});
