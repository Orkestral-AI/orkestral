import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { typecheckProject, formatDiagnosticsForModel } from './compiler-check';

let root: string;
const file = (rel: string) => path.join(root, rel);

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-v2-tc-'));
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        moduleResolution: 'bundler',
        module: 'esnext',
        target: 'esnext',
        skipLibCheck: true,
      },
      include: ['src'],
    }),
  );
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('typecheckProject (compiler in the engine v2 loop)', () => {
  it('valid overlay = green', () => {
    const r = typecheckProject({
      projectRoot: root,
      overlay: { [file('src/a.ts')]: 'export const x: number = 1;\n' },
    });
    expect(r.ok).toBe(true);
    expect(r.diagnostics).toHaveLength(0);
  });

  it('overlay with type error = red, without writing to disk', () => {
    const r = typecheckProject({
      projectRoot: root,
      overlay: { [file('src/a.ts')]: 'export const x: number = "nao sou numero";\n' },
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === 2322)).toBe(true); // type not assignable
    // nao deixou rastro no disco (era overlay):
    expect(fs.existsSync(file('src/a.ts'))).toBe(false);
  });

  it('catches a nonexistent symbol in use (not just import)', () => {
    const r = typecheckProject({
      projectRoot: root,
      overlay: { [file('src/b.ts')]: 'export const y = naoExiste + 1;\n' },
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => /naoExiste/.test(d.message))).toBe(true);
  });

  it('onlyFiles filters the diagnostics to the touched files', () => {
    const r = typecheckProject({
      projectRoot: root,
      overlay: {
        [file('src/c.ts')]: 'export const z: number = "errado";\n',
        [file('src/d.ts')]: 'export const w: string = 123;\n',
      },
      onlyFiles: [file('src/c.ts')],
    });
    expect(r.ok).toBe(false);
    expect(
      r.diagnostics.every((d) => d.file === path.resolve(file('src/c.ts')).replace(/\\/g, '/')),
    ).toBe(true);
  });

  it('formats a readable diagnostic for the model', () => {
    const r = typecheckProject({
      projectRoot: root,
      overlay: { [file('src/e.ts')]: 'export const q: number = "x";\n' },
    });
    const txt = formatDiagnosticsForModel(r.diagnostics);
    expect(txt).toMatch(/e\.ts/);
    expect(txt).toMatch(/TS2322/);
  });
});
