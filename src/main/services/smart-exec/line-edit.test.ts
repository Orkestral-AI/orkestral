import { describe, it, expect } from 'vitest';
import { parseLineEdits, applyLineEdits } from './line-edit';

describe('line-edit — edit ancorado por número de linha (âncora que não erra)', () => {
  const file = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;'].join('\n');

  it('parseia REPLACE com intervalo', () => {
    const edits = parseLineEdits('@@REPLACE 2-3\nconst b = 20;\nconst c = 30;\n@@END@@');
    expect(edits).toEqual([
      { op: 'replace', start: 2, end: 3, lines: ['const b = 20;', 'const c = 30;'] },
    ]);
  });

  it('parseia INSERT (depois da linha)', () => {
    const edits = parseLineEdits('@@INSERT 2\nconst x = 9;\n@@END@@');
    expect(edits).toEqual([{ op: 'insert', start: 2, end: 2, lines: ['const x = 9;'] }]);
  });

  it('REPLACE substitui só o intervalo e preserva o resto', () => {
    const edits = parseLineEdits('@@REPLACE 2-3\nconst b = 20;\n@@END@@');
    const out = applyLineEdits(file, edits);
    expect(out).toBe(['const a = 1;', 'const b = 20;', 'const d = 4;'].join('\n'));
  });

  it('INSERT insere DEPOIS da linha indicada', () => {
    const out = applyLineEdits(file, parseLineEdits('@@INSERT 2\nconst x = 9;\n@@END@@'));
    expect(out).toBe(
      ['const a = 1;', 'const b = 2;', 'const x = 9;', 'const c = 3;', 'const d = 4;'].join('\n'),
    );
  });

  it('REPLACE com corpo vazio DELETA o intervalo', () => {
    const out = applyLineEdits(file, parseLineEdits('@@REPLACE 2-3\n@@END@@'));
    expect(out).toBe(['const a = 1;', 'const d = 4;'].join('\n'));
  });

  it('múltiplos edits aplicam sem deslocar índices (ordem do fim pro começo)', () => {
    const raw = '@@REPLACE 1-1\nconst a = 10;\n@@END@@\n@@INSERT 4\nconst e = 5;\n@@END@@';
    const out = applyLineEdits(file, parseLineEdits(raw));
    expect(out).toBe(
      ['const a = 10;', 'const b = 2;', 'const c = 3;', 'const d = 4;', 'const e = 5;'].join('\n'),
    );
  });

  it('range fora dos limites → null (deixa o fallback)', () => {
    expect(applyLineEdits(file, parseLineEdits('@@REPLACE 2-99\nx\n@@END@@'))).toBeNull();
    expect(applyLineEdits(file, parseLineEdits('@@REPLACE 0-1\nx\n@@END@@'))).toBeNull();
  });

  it('REPLACE invertido → null', () => {
    expect(applyLineEdits(file, parseLineEdits('@@REPLACE 3-2\nx\n@@END@@'))).toBeNull();
  });

  it('REPLACEs sobrepostos → null', () => {
    const raw = '@@REPLACE 1-3\na\n@@END@@\n@@REPLACE 2-4\nb\n@@END@@';
    expect(applyLineEdits(file, parseLineEdits(raw))).toBeNull();
  });

  it('edit cobrindo >90% do arquivo → null (não é cirúrgico)', () => {
    const big = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    expect(applyLineEdits(big, parseLineEdits('@@REPLACE 1-20\nx\n@@END@@'))).toBeNull();
  });

  it('FINDING 1: INSERT dentro de um range de REPLACE → null (não corrompe)', () => {
    const f = ['function f() {', '  const a = 1;', '  const b = 2;', '  const c = 3;', '}'].join(
      '\n',
    );
    const raw = '@@REPLACE 2-4\n  const a = 10;\n@@END@@\n@@INSERT 3\n  console.log("x");\n@@END@@';
    expect(applyLineEdits(f, parseLineEdits(raw))).toBeNull();
  });

  it('FINDING 1: INSERT logo ANTES do range (start = a-1) é permitido', () => {
    const out = applyLineEdits(
      file,
      parseLineEdits('@@REPLACE 2-3\nX\n@@END@@\n@@INSERT 1\nY\n@@END@@'),
    );
    // insert depois da linha 1 (antes do bloco 2-3) + replace 2-3 → ambos aplicam
    expect(out).toBe(['const a = 1;', 'Y', 'X', 'const d = 4;'].join('\n'));
  });

  it('FINDING 2: "@@END@@" DENTRO do código novo NÃO trunca o edit', () => {
    const raw = '@@REPLACE 2-2\nconst s = "@@END@@";\nconst t = 1;\n@@END@@';
    const edits = parseLineEdits(raw);
    expect(edits).toEqual([
      { op: 'replace', start: 2, end: 2, lines: ['const s = "@@END@@";', 'const t = 1;'] },
    ]);
  });

  it('FINDING 2: cabeçalho dentro do corpo encerra o edit (vira novo edit)', () => {
    const raw = '@@INSERT 1\nlinha nova\n@@REPLACE 2-2\nX\n@@END@@';
    const edits = parseLineEdits(raw);
    expect(edits).toEqual([
      { op: 'insert', start: 1, end: 1, lines: ['linha nova'] },
      { op: 'replace', start: 2, end: 2, lines: ['X'] },
    ]);
  });

  it('sem edits / no-op → null', () => {
    expect(applyLineEdits(file, [])).toBeNull();
    expect(applyLineEdits(file, parseLineEdits('@@REPLACE 1-1\nconst a = 1;\n@@END@@'))).toBeNull();
  });

  it('preserva CRLF do arquivo', () => {
    const crlf = ['a', 'b', 'c'].join('\r\n');
    const out = applyLineEdits(crlf, parseLineEdits('@@REPLACE 2-2\nB\n@@END@@'));
    expect(out).toBe(['a', 'B', 'c'].join('\r\n'));
  });
});
