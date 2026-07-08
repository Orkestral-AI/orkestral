import { describe, it, expect, vi } from 'vitest';

// `electron` é nativo e não importa no ambiente node do vitest — o history-store
// puxa `appInfo` do host, que só toca no `app` dentro das funções (com guarda).
vi.mock('electron', () => ({ app: undefined, BrowserWindow: undefined, safeStorage: undefined }));

import { pushLine } from './history-store';

describe('pushLine', () => {
  it('anexa a linha no fim (mais recente por último)', () => {
    expect(pushLine(['a', 'b'], 'c', 10)).toEqual(['a', 'b', 'c']);
  });

  it('dedupa repetição consecutiva (mantém o array como está)', () => {
    const lines = ['a', 'b'];
    expect(pushLine(lines, 'b', 10)).toBe(lines);
    // Repetida NÃO-consecutiva entra normal.
    expect(pushLine(lines, 'a', 10)).toEqual(['a', 'b', 'a']);
  });

  it('apara pro cap mantendo as mais recentes', () => {
    expect(pushLine(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
  });

  it('ignora linha vazia/whitespace e trima a entrada', () => {
    const lines = ['a'];
    expect(pushLine(lines, '', 10)).toBe(lines);
    expect(pushLine(lines, '   ', 10)).toBe(lines);
    expect(pushLine(lines, '  b  ', 10)).toEqual(['a', 'b']);
  });
});
