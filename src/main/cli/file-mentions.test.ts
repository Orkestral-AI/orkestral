import { describe, it, expect } from 'vitest';
import { filterFiles, type WorkspaceFile } from './file-mentions';

const files = (...relPaths: string[]): WorkspaceFile[] => relPaths.map((relPath) => ({ relPath }));

describe('filterFiles', () => {
  it('casa por includes case-insensitive no path inteiro', () => {
    const list = files('src/main/cli/Repl.tsx', 'src/shared/types/index.ts', 'README.md');
    expect(filterFiles(list, 'SHARED')).toEqual([{ relPath: 'src/shared/types/index.ts' }]);
    expect(filterFiles(list, 'nada-disso')).toEqual([]);
  });

  it('prefix-boost: basename que COMEÇA com a query vem antes do contains', () => {
    const list = files(
      'src/replicas/config.ts', // contém "repl" no meio do path — contains
      'docs/deep/Repl-notes.md', // basename começa com "repl" — prefix
      'src/main/cli/ui/Repl.tsx', // basename começa com "repl" — prefix
    );
    expect(filterFiles(list, 'repl')).toEqual([
      { relPath: 'docs/deep/Repl-notes.md' },
      { relPath: 'src/main/cli/ui/Repl.tsx' },
      { relPath: 'src/replicas/config.ts' },
    ]);
  });

  it('respeita o cap (default 8) mesmo com mais matches', () => {
    const list = files(...Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts`));
    expect(filterFiles(list, 'file')).toHaveLength(8);
    expect(filterFiles(list, 'file', 3)).toHaveLength(3);
  });

  it('query vazia (só o `@`) lista os primeiros arquivos até o cap', () => {
    const list = files(...Array.from({ length: 12 }, (_, i) => `f${i}.ts`));
    const out = filterFiles(list, '');
    expect(out).toHaveLength(8);
    expect(out[0]).toEqual({ relPath: 'f0.ts' });
  });
});
