import { describe, expect, it } from 'vitest';
import {
  INITIAL_PET_STATE,
  reducePetState,
  derivePetVisual,
  DONE_FLASH_MS,
  type PetState,
} from './pet-state';

const NOW = 1_000_000;

function run(events: Parameters<typeof reducePetState>[1][], now = NOW): PetState {
  return events.reduce((s, e) => reducePetState(s, e, now), INITIAL_PET_STATE);
}

describe('reducePetState', () => {
  it('started duplicado não conta duas vezes', () => {
    const s = run([
      { kind: 'exec-started', id: 'a' },
      { kind: 'exec-started', id: 'a' },
    ]);
    expect(s.activeIds).toEqual(['a']);
  });

  it('finished remove a execução e arma o flash de done', () => {
    const s = run([
      { kind: 'exec-started', id: 'a' },
      { kind: 'exec-finished', id: 'a' },
    ]);
    expect(s.activeIds).toEqual([]);
    expect(s.doneUntil).toBe(NOW + DONE_FLASH_MS);
  });

  it('finished de execução desconhecida é no-op (não pisca done do nada)', () => {
    const s = run([{ kind: 'exec-finished', id: 'ghost' }]);
    expect(s).toEqual(INITIAL_PET_STATE);
  });

  it('error remove a execução e marca erro persistente', () => {
    const s = run([
      { kind: 'exec-started', id: 'a' },
      { kind: 'exec-error', id: 'a' },
    ]);
    expect(s.activeIds).toEqual([]);
    expect(s.hasError).toBe(true);
  });

  it('exec-cleared remove sem flash de done nem erro (chat cancelado)', () => {
    const s = run([
      { kind: 'exec-started', id: 'a' },
      { kind: 'exec-cleared', id: 'a' },
    ]);
    expect(s.activeIds).toEqual([]);
    expect(s.doneUntil).toBe(0);
    expect(s.hasError).toBe(false);
    expect(derivePetVisual(s, NOW)).toBe('idle');
  });

  it('hydrate substitui as ativas e deduplica', () => {
    const s = run([
      { kind: 'exec-started', id: 'velha' },
      { kind: 'hydrate', activeIds: ['x', 'x', 'y'] },
    ]);
    expect(s.activeIds).toEqual(['x', 'y']);
  });
});

describe('derivePetVisual', () => {
  it('erro ganha de working (falha não pode ficar escondida)', () => {
    const s = run([
      { kind: 'exec-started', id: 'a' },
      { kind: 'exec-started', id: 'b' },
      { kind: 'exec-error', id: 'a' },
    ]);
    expect(s.activeIds).toEqual(['b']);
    expect(derivePetVisual(s, NOW)).toBe('error');
  });

  it('working > done: nova execução durante o flash volta pra working', () => {
    const s = run([
      { kind: 'exec-started', id: 'a' },
      { kind: 'exec-finished', id: 'a' },
      { kind: 'exec-started', id: 'b' },
    ]);
    expect(derivePetVisual(s, NOW)).toBe('working');
  });

  it('flash de done expira e cai pra idle', () => {
    const s = run([
      { kind: 'exec-started', id: 'a' },
      { kind: 'exec-finished', id: 'a' },
    ]);
    expect(derivePetVisual(s, NOW + 1)).toBe('done');
    expect(derivePetVisual(s, NOW + DONE_FLASH_MS + 1)).toBe('idle');
  });

  it('attention aparece em idle, mas não atropela working', () => {
    const idle = run([{ kind: 'attention' }]);
    expect(derivePetVisual(idle, NOW)).toBe('attention');

    const working = run([{ kind: 'attention' }, { kind: 'exec-started', id: 'a' }]);
    expect(derivePetVisual(working, NOW)).toBe('working');
  });

  it('dispensar o erro devolve o estado real', () => {
    const s = run([
      { kind: 'exec-started', id: 'a' },
      { kind: 'exec-error', id: 'a' },
      { kind: 'error-dismissed' },
    ]);
    expect(derivePetVisual(s, NOW)).toBe('idle');
  });
});
