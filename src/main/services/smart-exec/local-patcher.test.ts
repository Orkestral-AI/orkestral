import { describe, it, expect } from 'vitest';
import {
  renderExamplesBlock,
  buildEditUserPrompt,
  parseFastApplyOutput,
  type LocalPatchInput,
} from './local-patcher';

const CONSTRAINTS: LocalPatchInput['constraints'] = {
  maxChangedLines: 400,
  allowedFiles: [],
  forbiddenFiles: [],
  allowNewFiles: false,
  allowPublicApiChanges: false,
  allowArchitectureChanges: false,
};

function input(over: Partial<LocalPatchInput>): LocalPatchInput {
  return {
    taskId: 't',
    filePath: 'src/a.ts',
    instruction: 'do the thing',
    constraints: CONSTRAINTS,
    fileContent: 'x'.repeat(200),
    ...over,
  };
}

describe('renderExamplesBlock — budget do few-shot (RAG-de-edits)', () => {
  it('vazio quando não há exemplos ou budget <= 0', () => {
    expect(renderExamplesBlock([], 5000)).toBe('');
    expect(
      renderExamplesBlock([{ file: 'a', symbol: null, instruction: 'i', acceptedEdit: 'e' }], 0),
    ).toBe('');
  });

  it('NENHUM exemplo fura o budget — nem o primeiro (era o bug do `shown > 0`)', () => {
    const huge = { file: 'a.ts', symbol: null, instruction: 'i', acceptedEdit: 'E'.repeat(5000) };
    // budget pequeno: o único exemplo (mesmo truncado a 1500) + header não cabe → vazio.
    expect(renderExamplesBlock([huge], 200)).toBe('');
  });

  it('trunca um acceptedEdit gigante ao teto por exemplo (não 5000 chars crus)', () => {
    const huge = { file: 'a.ts', symbol: null, instruction: 'i', acceptedEdit: 'E'.repeat(5000) };
    const block = renderExamplesBlock([huge], 50_000);
    expect(block).toContain('truncado');
    // muito menor que os 5000 chars crus (teto ~1500 + envelope)
    expect(block.length).toBeLessThan(2200);
  });

  it('respeita o teto total (para de adicionar ao estourar o budget)', () => {
    const ex = (n: number) => ({
      file: `f${n}.ts`,
      symbol: null,
      instruction: `inst ${n}`,
      acceptedEdit: 'E'.repeat(600),
    });
    // budget só comporta ~1 exemplo
    const block = renderExamplesBlock([ex(1), ex(2), ex(3)], 800);
    const count = (block.match(/--- example/g) ?? []).length;
    expect(count).toBeLessThanOrEqual(1);
  });
});

describe('buildEditUserPrompt — budget COMPARTILHADO file+examples', () => {
  it('file + examples nunca passam do teto total do prompt', () => {
    const maxPromptTokens = 1000; // teto = 4000 chars
    const bigFile = 'L'.repeat(20_000); // arquivo grande → será clampado
    const examples = Array.from({ length: 3 }, (_, i) => ({
      file: `f${i}.ts`,
      symbol: null,
      instruction: `inst ${i}`,
      acceptedEdit: 'E'.repeat(1500),
    }));
    const prompt = buildEditUserPrompt(input({ fileContent: bigFile, examples }), maxPromptTokens);
    // Folga p/ envelope (system/headers somam fora deste user-turn); o ponto é que
    // o arquivo foi clampado levando os exemplos em conta — não soma 98%+15%.
    expect(prompt.length).toBeLessThan(maxPromptTokens * 4 + 600);
  });

  it('com exemplos que cabem, o arquivo recebe MENOS budget (o total não estoura)', () => {
    const maxPromptTokens = 4000; // exampleBudget = 2400 chars
    // '~' não aparece no template do prompt → mede só o conteúdo clampado do arquivo.
    const without = buildEditUserPrompt(
      input({ fileContent: '~'.repeat(40_000) }),
      maxPromptTokens,
    );
    const withEx = buildEditUserPrompt(
      input({
        fileContent: '~'.repeat(40_000),
        examples: [{ file: 'f.ts', symbol: null, instruction: 'i', acceptedEdit: 'E'.repeat(800) }],
      }),
      maxPromptTokens,
    );
    // O exemplo (cabe no budget) aparece, e o arquivo clampado fica MENOR pra
    // compensar — o budget é compartilhado, não somado.
    expect(withEx).toContain('--- example');
    const fileCharsWithout = without.match(/~+/)?.[0].length ?? 0;
    const fileCharsWith = withEx.match(/~+/)?.[0].length ?? 0;
    expect(fileCharsWith).toBeLessThan(fileCharsWithout);
  });
});

describe('parseFastApplyOutput — extrai <updated-code> (kortix fast-apply)', () => {
  it('extrai o arquivo mesclado das tags', () => {
    const out = `<updated-code>\nimport { create } from 'zustand';\nconst x = 1;\n</updated-code>`;
    const res = parseFastApplyOutput(out);
    expect(res.kind).toBe('edit');
    if (res.kind === 'edit') {
      expect(res.update).toContain("import { create } from 'zustand';");
      expect(res.update).not.toContain('updated-code');
    }
  });

  it('tolera tag de fim ausente (saída truncada)', () => {
    const out = `<updated-code>\nconst x = 2;`;
    const res = parseFastApplyOutput(out);
    expect(res.kind).toBe('edit');
    if (res.kind === 'edit') expect(res.update).toContain('const x = 2;');
  });

  it('sem tags → cai no parser de arquivo-inteiro (fence/CANNOT)', () => {
    expect(parseFastApplyOutput('CANNOT_WRITE_SAFELY').kind).toBe('cannot');
    const fenced = parseFastApplyOutput('```ts\nconst y = 3;\n```');
    expect(fenced.kind).toBe('edit');
    if (fenced.kind === 'edit') expect(fenced.update).toBe('const y = 3;');
  });
});
