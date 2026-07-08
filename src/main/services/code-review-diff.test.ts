import { describe, it, expect } from 'vitest';
import { parseDiffNewLines } from './code-review-service';

const DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 111..222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,6 +10,7 @@ export function foo() {
 const a = 1;
 const b = 2;
-const c = 3;
+const c = 30;
+const d = 4;
 return a + b;
 }
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 000..333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
`;

describe('parseDiffNewLines', () => {
  const map = parseDiffNewLines(DIFF);

  it('mapeia as linhas comentáveis (contexto + adicionadas) do lado NEW', () => {
    const foo = map.get('src/foo.ts')!;
    // hunk começa em +10: ctx 10,11; removida (-) não conta; add 12,13; ctx 14,15.
    expect([...foo].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15]);
  });

  it('arquivo novo: só as linhas adicionadas (1,2)', () => {
    expect([...map.get('src/new.ts')!].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('uma linha fora do diff NÃO resolve (vai pro corpo, evita o 422)', () => {
    expect(map.get('src/foo.ts')!.has(99)).toBe(false);
    expect(map.has('src/outro.ts')).toBe(false);
  });
});
