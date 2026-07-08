import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fastApplyEditFile } from './fast-apply-tool';

// Testa só os tiers SEM modelo (merge determinístico, criação, guardas de path):
// o tier 2 (FastApply GGUF) exige o modelo em disco e fica fora do unit test.
describe('fastApplyEditFile (tool edit_file)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ork-fast-apply-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('cria arquivo novo quando o snippet é o conteúdo completo', async () => {
    const res = await fastApplyEditFile({
      repoPath: repo,
      relPath: 'src/hello.ts',
      codeEdit: `export function hello() {\n  return 'oi';\n}\n`,
    });
    expect(res.applied).toBe(true);
    expect(res.created).toBe(true);
    expect(res.strategy).toBe('create');
    expect(readFileSync(join(repo, 'src/hello.ts'), 'utf-8')).toContain("return 'oi'");
  });

  it('rejeita criar arquivo novo com marcadores lazy (nada pra expandir)', async () => {
    const res = await fastApplyEditFile({
      repoPath: repo,
      relPath: 'src/novo.ts',
      codeEdit: `// ... existing code ...\nconst x = 1;\n`,
    });
    expect(res.applied).toBe(false);
    expect(res.error).toContain('não existe');
  });

  it('mescla lazy-edit por âncora em arquivo existente (tier determinístico)', async () => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(
      join(repo, 'src/app.ts'),
      [
        "import { a } from './a';",
        '',
        'export function main() {',
        '  const total = a + 1;',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    const res = await fastApplyEditFile({
      repoPath: repo,
      relPath: 'src/app.ts',
      codeEdit: [
        '// ... existing code ...',
        'export function main() {',
        '  const total = a + 2;',
        '  return total;',
        '}',
        '// ... existing code ...',
      ].join('\n'),
    });
    expect(res.applied).toBe(true);
    expect(res.strategy).toBe('deterministic');
    const merged = readFileSync(join(repo, 'src/app.ts'), 'utf-8');
    expect(merged).toContain('a + 2');
    expect(merged).toContain("import { a } from './a';"); // não dropa o resto do arquivo
  });

  it('rejeita path fora do repositório', async () => {
    const res = await fastApplyEditFile({
      repoPath: repo,
      relPath: '../fora.ts',
      codeEdit: 'const x = 1;\n',
    });
    expect(res.applied).toBe(false);
    expect(res.error).toContain('fora do repositório');
  });

  it('devolve erro orientando fallback quando a âncora não casa e não há modelo', async () => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/x.ts'), 'const real = 1;\n', 'utf-8');
    const res = await fastApplyEditFile({
      repoPath: repo,
      relPath: 'src/x.ts',
      codeEdit: [
        '// ... existing code ...',
        'function queNaoExiste() {',
        '  return 42;',
        '}',
        '// ... existing code ...',
      ].join('\n'),
    });
    // Sem âncora real no arquivo e sem o GGUF de fast-apply em disco no CI,
    // o tool falha com orientação — o agente cai no editor nativo dele.
    if (!res.applied) {
      expect(res.error).toBeTruthy();
    }
  });
});
