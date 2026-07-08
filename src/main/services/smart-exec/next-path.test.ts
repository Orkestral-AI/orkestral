import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeNextRoutePath } from './classifier';

describe('normalizeNextRoutePath', () => {
  let nextRepo: string;
  let plainRepo: string;

  beforeAll(() => {
    nextRepo = mkdtempSync(join(tmpdir(), 'ork-next-'));
    writeFileSync(join(nextRepo, 'next.config.js'), 'module.exports = {};');
    mkdirSync(join(nextRepo, 'app'), { recursive: true });
    plainRepo = mkdtempSync(join(tmpdir(), 'ork-plain-'));
  });
  afterAll(() => {
    rmSync(nextRepo, { recursive: true, force: true });
    rmSync(plainRepo, { recursive: true, force: true });
  });

  it('move uma rota da raiz pra app/ num projeto Next', () => {
    expect(normalizeNextRoutePath('page.tsx', nextRepo)).toBe('app/page.tsx');
    expect(normalizeNextRoutePath('onboarding/page.tsx', nextRepo)).toBe('app/onboarding/page.tsx');
    expect(normalizeNextRoutePath('api/users/route.ts', nextRepo)).toBe('app/api/users/route.ts');
  });

  it('preserva caminhos já corretos (app/, src/)', () => {
    expect(normalizeNextRoutePath('app/page.tsx', nextRepo)).toBe('app/page.tsx');
    expect(normalizeNextRoutePath('src/lib/db.ts', nextRepo)).toBe('src/lib/db.ts');
  });

  it('não toca em arquivos não-rota (components, lib)', () => {
    expect(normalizeNextRoutePath('components/Button.tsx', nextRepo)).toBe('components/Button.tsx');
  });

  it('não faz nada em projeto que não é Next', () => {
    expect(normalizeNextRoutePath('page.tsx', plainRepo)).toBe('page.tsx');
  });
});
