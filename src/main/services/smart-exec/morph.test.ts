import { describe, it, expect } from 'vitest';
import {
  parseEditBlocks,
  applyEditBlocks,
  mergeLazyEdit,
  hasLazyMarkers,
  isLazyEllipsis,
  levenshtein,
  droppedTopLevelImports,
} from './morph';

describe('SEARCH/REPLACE morphism (P0-13 — tier de fallback)', () => {
  it('parseia um bloco SEARCH/REPLACE', () => {
    const raw = `<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE`;
    const blocks = parseEditBlocks(raw);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe('const a = 1;');
    expect(blocks[0].replace).toBe('const a = 2;');
  });

  it('aplica um bloco SEARCH/REPLACE de forma determinística', () => {
    const original = 'const a = 1;\nconst b = 2;\n';
    const blocks = parseEditBlocks(
      `<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 42;\n>>>>>>> REPLACE`,
    );
    const res = applyEditBlocks(original, blocks);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content).toContain('const a = 42;');
      expect(res.content).toContain('const b = 2;');
    }
  });

  it('FALHA claramente quando o SEARCH é ambíguo (casa >1 vez)', () => {
    const blocks = parseEditBlocks(`<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE`);
    expect(applyEditBlocks('x\nx\n', blocks).ok).toBe(false);
  });

  it('FALHA quando o SEARCH não existe (nunca adivinha)', () => {
    const blocks = parseEditBlocks(`<<<<<<< SEARCH\nbar\n=======\nbaz\n>>>>>>> REPLACE`);
    expect(applyEditBlocks('foo\n', blocks).ok).toBe(false);
  });

  it('SEARCH vazio = inserção (prepend)', () => {
    const blocks = parseEditBlocks(`<<<<<<< SEARCH\n=======\n// header\n>>>>>>> REPLACE`);
    const res = applyEditBlocks('body\n', blocks);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.content.startsWith('// header')).toBe(true);
  });
});

describe('mergeLazyEdit — morphismo lazy (formato primário)', () => {
  it('detecta marcadores de elipse', () => {
    expect(isLazyEllipsis('// ... existing code ...')).toBe(true);
    expect(hasLazyMarkers('a\n// ... existing code ...\nb')).toBe(true);
    expect(hasLazyMarkers('const a = 1;')).toBe(false);
  });

  it('funde um lazy edit pelas âncoras', () => {
    const original = `function soma(a, b) {\n  const r = a + b;\n  return r;\n}\n`;
    const update = `function soma(a, b) {\n  const r = a * b;\n  return r;\n}`;
    const res = mergeLazyEdit(original, update);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.content).toContain('a * b');
  });

  it('FALHA quando uma âncora não existe (nunca adivinha)', () => {
    expect(mergeLazyEdit('a\nb\nc\n', 'zzz\nnew\nyyy').ok).toBe(false);
  });

  it('tolera âncora quase-igual: import sem chaves/aspas diferentes — não escala, preserva a linha real', () => {
    // Caso real que escalava pro premium: o modelo pequeno reproduziu a âncora do
    // import SEM as chaves de destructuring (e com aspas duplas). Antes: "âncora não
    // encontrada" → escalonamento. Agora: tier tolerante (único) localiza, e o merge
    // PRESERVA a linha real do arquivo (com chaves) — só o miolo muda.
    const original = `import { create } from 'zustand';\nconst x = 0;\nexport default x;\n`;
    const update = `import create from "zustand";\nconst x = 42;\nexport default x;`;
    const res = mergeLazyEdit(original, update);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content).toContain('const x = 42;');
      // a âncora real (com chaves/aspas simples) é preservada — NÃO grava a variação do modelo
      expect(res.content).toContain("import { create } from 'zustand';");
      expect(res.content).not.toContain('import create from "zustand"');
    }
  });

  it('âncora tolerante NÃO casa em empate (duas variações de chaves do mesmo import)', () => {
    // Duas linhas que normalizam IGUAL (mesma origem, chaves diferentes) → o tier
    // tolerante exige unicidade, então NÃO mexe (não adivinha qual) e falha em vez de
    // editar a linha errada.
    const original = `import { create } from 'zustand';\nimport {create} from 'zustand';\nconst z = 1;\nexport default z;\n`;
    const update = `import create from 'zustand';\nconst z = 2;\nexport default z;`;
    const res = mergeLazyEdit(original, update);
    expect(res.ok).toBe(false);
  });

  it('P0-2: REJEITA update sem marcadores cujo span (âncoras curtas/comuns) engole o trecho', () => {
    const original = `const config = {
  alpha: 1,
  beta: 2,
  gamma: 3,
  delta: 4,
  epsilon: 5,
  zeta: 6,
  eta: 7,
  theta: 8,
};

function run() {
  return config.alpha;
}
`;
    // Sem `// ... existing code ...`: trecho verbatim de 3 linhas, mas a âncora de
    // fim `};` só casa a 9 linhas da de início — o merge ingênuo deletaria todo o
    // objeto entre elas e gravaria conteúdo mutilado. A guarda span/segLen rejeita.
    const update = `const config = {
  alpha: 100,
};`;
    const res = mergeLazyEdit(original, update);
    expect(res.ok).toBe(false);
  });

  it('P0-2: aceita trecho verbatim sem marcadores quando o span casa o tamanho do trecho', () => {
    const original = `function soma(a, b) {
  const r = a + b;
  return r;
}
`;
    const update = `function soma(a, b) {
  const r = a * b;
  return r;
}`;
    const res = mergeLazyEdit(original, update);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.content).toContain('a * b');
  });

  it('casa assinatura JS/TS por entidade única e preserva a âncora real', () => {
    const original = `type Props = { children: React.ReactNode };

export default function RootLayout({ children }: Props) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
`;
    const update = `// ... existing code ...
export function RootLayout({ children }: Props) {
  const websiteJsonLd = { '@context': 'https://schema.org' };
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
// ... existing code ...`;
    const res = mergeLazyEdit(original, update);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content).toContain('export default function RootLayout');
      expect(res.content).toContain('websiteJsonLd');
      expect(res.content).not.toContain('export function RootLayout({ children }: Props)');
    }
  });

  it('guarda anti-DELEÇÃO: rejeita lazy edit que encolhe ~50% do arquivo (o controller perdendo código)', () => {
    // 50 linhas; âncoras linha12 e linha38 engoliriam 27 linhas → resultado ~25
    // (50% do original). Passava no limiar antigo (0.4) e gravava a deleção; agora
    // (0.6) é rejeitado — o app NUNCA grava uma deleção em massa não pedida.
    const original = Array.from({ length: 50 }, (_, i) => `linha${i + 1}();`).join('\n') + '\n';
    const update = `// ... existing code ...
linha12();
linha38();
// ... existing code ...`;
    const res = mergeLazyEdit(original, update);
    expect(res.ok).toBe(false);
  });
});

describe('levenshtein (puro)', () => {
  it('computa distância de edição', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
  });
});

describe('droppedTopLevelImports — guard de perda de imports (fast-apply)', () => {
  it('detecta um import removido silenciosamente (JS/TS)', () => {
    const before = `import { create } from 'zustand';\nimport React from 'react';\nconst x = 1;\n`;
    const after = `import React from 'react';\nconst x = 2;\n`; // perdeu o zustand
    expect(droppedTopLevelImports(before, after)).toBe(true);
  });

  it('NÃO acusa quando todos os imports seguem presentes', () => {
    const before = `import { create } from 'zustand';\nconst x = 1;\n`;
    const after = `import { create } from 'zustand';\nconst x = 2;\nconst y = 3;\n`;
    expect(droppedTopLevelImports(before, after)).toBe(false);
  });

  it('cobre PHP `use` e Python `from..import`', () => {
    expect(droppedTopLevelImports('use App\\Models\\User;\n$x=1;', '$x=2;')).toBe(true);
    expect(droppedTopLevelImports('from a import b\nx=1', 'x=2')).toBe(true);
  });

  it('arquivo sem imports → nunca acusa', () => {
    expect(droppedTopLevelImports('const x = 1;\n', 'const x = 2;\n')).toBe(false);
  });
});
