import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { validateImports, clearImportValidatorCache } from './import-validator';

/**
 * Fixture hermetico: um projeto temp com um pacote "ui-kit" que exporta Button/Input
 * (mas NAO Label), alias `@/* -> ./src/*`, e um arquivo local real. Reproduz os modos
 * de falha exatos que afundaram o chatbot_v3.
 */
let root: string;
const fileUnder = () => path.join(root, 'src', 'app', 'page.tsx'); // nao precisa existir

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-v2-imp-'));

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { 'ui-kit': '1.0.0' } }),
  );
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { '@/*': ['./src/*'] },
        moduleResolution: 'bundler',
        module: 'esnext',
        target: 'esnext',
        jsx: 'react-jsx',
      },
    }),
  );

  const uiKit = path.join(root, 'node_modules', 'ui-kit');
  fs.mkdirSync(uiKit, { recursive: true });
  fs.writeFileSync(
    path.join(uiKit, 'package.json'),
    JSON.stringify({ name: 'ui-kit', version: '1.0.0', types: './index.d.ts', main: './index.js' }),
  );
  fs.writeFileSync(
    path.join(uiKit, 'index.d.ts'),
    'export declare const Button: unknown;\nexport declare const Input: unknown;\n',
  );
  fs.writeFileSync(path.join(uiKit, 'index.js'), 'module.exports = {};\n');

  fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'lib', 'real.ts'), 'export const real = 1;\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  clearImportValidatorCache();
});

describe('validateImports (anti-hallucination net of engine v2)', () => {
  it('blocks an invented module (the @trello/... from chatbot_v3)', () => {
    const code =
      'import { useWorkspaceDelete } from "@trello/use-workspace-delete-dialog-cancel-mutation";\n';
    const v = validateImports({ filePath: fileUnder(), code, projectRoot: root });
    expect(v.some((x) => x.kind === 'unresolved-module' && x.source.startsWith('@trello/'))).toBe(
      true,
    );
  });

  it('blocks a local alias that does not exist (@/lib/validate gone)', () => {
    const code = 'import { validateEmail } from "@/lib/missing";\n';
    const v = validateImports({ filePath: fileUnder(), code, projectRoot: root });
    expect(v.some((x) => x.kind === 'unresolved-module' && x.source === '@/lib/missing')).toBe(
      true,
    );
  });

  it('blocks a nonexistent export in a real package (Label from @base-ui/react)', () => {
    const code = 'import { Button, Label } from "ui-kit";\n';
    const v = validateImports({ filePath: fileUnder(), code, projectRoot: root });
    const miss = v.find((x) => x.kind === 'missing-export' && x.source === 'ui-kit');
    expect(miss).toBeTruthy();
    expect(miss?.missingExports).toContain('Label');
    expect(miss?.missingExports).not.toContain('Button'); // Button existe, nao acusa
  });

  it('blocks dynamic import() of an invented module (it bypassed the validator)', () => {
    const code = "async function f(){ const m = await import('@trello/fake-dyn'); return m; }\n";
    const v = validateImports({ filePath: fileUnder(), code, projectRoot: root });
    expect(v.some((x) => x.kind === 'unresolved-module' && x.source === '@trello/fake-dyn')).toBe(
      true,
    );
  });

  it('blocks require() of an invented module', () => {
    const code = "const x = require('@trello/fake-req');\n";
    const v = validateImports({ filePath: fileUnder(), code, projectRoot: root });
    expect(v.some((x) => x.kind === 'unresolved-module' && x.source === '@trello/fake-req')).toBe(
      true,
    );
  });

  it('does not false-positive on valid imports (real package + real export + local file)', () => {
    const code = 'import { Button, Input } from "ui-kit";\nimport { real } from "@/lib/real";\n';
    const v = validateImports({ filePath: fileUnder(), code, projectRoot: root });
    expect(v).toHaveLength(0);
  });

  it('does not check named export in a namespace import (import * as X)', () => {
    const code = 'import * as UI from "ui-kit";\nUI.Button;\n';
    const v = validateImports({ filePath: fileUnder(), code, projectRoot: root });
    expect(v).toHaveLength(0);
  });

  it('ignores Node builtins (node:path, fs)', () => {
    const code = 'import * as path from "node:path";\nimport fs from "fs";\n';
    const v = validateImports({ filePath: fileUnder(), code, projectRoot: root });
    expect(v).toHaveLength(0);
  });
});
