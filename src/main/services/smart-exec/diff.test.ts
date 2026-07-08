import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isInsideRepo, applyWholeFile } from './diff';

describe('isInsideRepo — contenção de path (anti path-traversal)', () => {
  const repo = '/tmp/some/repo';

  it('aceita caminho relativo dentro do repo', () => {
    expect(isInsideRepo(repo, 'src/index.ts')).toBe(true);
    expect(isInsideRepo(repo, './src/index.ts')).toBe(true);
    expect(isInsideRepo(repo, 'a/b/c.ts')).toBe(true);
  });

  it('rejeita `..` que escapa a raiz do repo', () => {
    expect(isInsideRepo(repo, 'src/../../../tmp/evil.ts')).toBe(false);
    expect(isInsideRepo(repo, '../evil.ts')).toBe(false);
    expect(isInsideRepo(repo, '../../etc/passwd')).toBe(false);
  });

  it('rejeita caminho absoluto', () => {
    expect(isInsideRepo(repo, '/tmp/evil.ts')).toBe(false);
    expect(isInsideRepo(repo, '/etc/passwd')).toBe(false);
  });

  it('aceita `..` que volta mas continua dentro do repo', () => {
    expect(isInsideRepo(repo, 'src/sub/../index.ts')).toBe(true);
  });

  it('NÃO trata um prefixo-irmão como interno (repo vs repo-evil)', () => {
    // resolve('/tmp/some/repo', '../repo-evil/x') = /tmp/some/repo-evil/x → fora.
    expect(isInsideRepo(repo, '../repo-evil/x.ts')).toBe(false);
  });
});

describe('applyWholeFile — guarda final recusa escrita fora do repo', () => {
  it('recusa caminho com `..` traversal (applied:false) e não escreve nada', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diff-trav-'));
    try {
      const res = applyWholeFile(dir, 'src/../../../tmp/evil.ts', 'malicious');
      expect(res.applied).toBe(false);
      expect(res.error).toContain('fora do repositório');
      // nada escrito fora do repo
      expect(existsSync(resolve(dir, 'src/../../../tmp/evil.ts'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recusa caminho absoluto (applied:false) e não escreve nada', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diff-abs-'));
    const target = join(tmpdir(), `diff-abs-evil-${Date.now()}.ts`);
    try {
      const res = applyWholeFile(dir, target, 'malicious');
      expect(res.applied).toBe(false);
      expect(res.error).toContain('fora do repositório');
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aceita um caminho relativo legítimo dentro do repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diff-ok-'));
    try {
      const res = applyWholeFile(dir, 'src/ok.ts', 'export const ok = 1;\n');
      expect(res.applied).toBe(true);
      expect(existsSync(join(dir, 'src/ok.ts'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
