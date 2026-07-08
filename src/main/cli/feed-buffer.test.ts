import { describe, it, expect } from 'vitest';
import { FeedBuffer } from './feed-buffer';

describe('FeedBuffer', () => {
  it('mantém só as últimas N linhas (cap)', () => {
    const f = new FeedBuffer(3);
    for (let i = 1; i <= 5; i++) f.push({ ts: i, text: `l${i}` });
    expect(f.lines().map((l) => l.text)).toEqual(['l3', 'l4', 'l5']);
  });

  it('lines() devolve em ordem cronológica', () => {
    const f = new FeedBuffer(10);
    f.push({ ts: 1, text: 'a' });
    f.push({ ts: 2, text: 'b' });
    expect(f.lines().map((l) => l.text)).toEqual(['a', 'b']);
  });
});
