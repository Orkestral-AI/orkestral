import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { validateForgeOutput } from './validate-output';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-v2-vo-'));
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'esnext',
        target: 'esnext',
        moduleResolution: 'bundler',
        skipLibCheck: true,
      },
    }),
  );
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const uiKit = path.join(root, 'node_modules', 'ui-kit');
  fs.mkdirSync(uiKit, { recursive: true });
  fs.writeFileSync(
    path.join(uiKit, 'package.json'),
    JSON.stringify({ name: 'ui-kit', version: '1.0.0', types: './index.d.ts', main: './index.js' }),
  );
  fs.writeFileSync(path.join(uiKit, 'index.d.ts'), 'export declare const Button: string;\n');
  fs.writeFileSync(path.join(uiKit, 'index.js'), 'module.exports = {};\n');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('validateForgeOutput (engine-v2 gate in the live engine)', () => {
  it('fails an applied file with a nonexistent import', () => {
    fs.writeFileSync(
      path.join(root, 'src', 'a.ts'),
      'import { x } from "@trello/fake";\nexport const y = x;\n',
    );
    const v = validateForgeOutput(root, ['src/a.ts']);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/@trello\/fake/);
  });

  it('fails a trivial file (string only)', () => {
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), '"sou so uma string";\n');
    const v = validateForgeOutput(root, ['src/b.ts']);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/trivial/);
  });

  it('passes valid code', () => {
    fs.writeFileSync(
      path.join(root, 'src', 'c.ts'),
      'import { Button } from "ui-kit";\nexport const z = Button;\n',
    );
    const v = validateForgeOutput(root, ['src/c.ts']);
    expect(v.ok).toBe(true);
    expect(v.reasons).toHaveLength(0);
  });

  it('ignores non-TS files (does not block on package.json)', () => {
    fs.writeFileSync(path.join(root, 'package.json.bak'), '{}');
    const v = validateForgeOutput(root, ['package.json', 'README.md']);
    expect(v.ok).toBe(true);
  });

  it('without tsconfig it does not block (cannot validate safely)', () => {
    const noCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-v2-vo-nocfg-'));
    fs.mkdirSync(path.join(noCfg, 'src'), { recursive: true });
    fs.writeFileSync(path.join(noCfg, 'src', 'a.ts'), 'import { x } from "@trello/fake";\n');
    const v = validateForgeOutput(noCfg, ['src/a.ts']);
    expect(v.ok).toBe(true);
    fs.rmSync(noCfg, { recursive: true, force: true });
  });
});
