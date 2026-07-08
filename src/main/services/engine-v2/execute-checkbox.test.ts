import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { executeCheckbox, type Checkbox, type GenerateFn } from './execute-checkbox';

let root: string;
const target = () => path.join(root, 'src', 'status.ts');

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-v2-loop-'));
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
        baseUrl: '.',
        paths: { '@/*': ['./src/*'] },
      },
      include: ['src'],
    }),
  );
  const uiKit = path.join(root, 'node_modules', 'ui-kit');
  fs.mkdirSync(uiKit, { recursive: true });
  fs.writeFileSync(
    path.join(uiKit, 'package.json'),
    JSON.stringify({ name: 'ui-kit', version: '1.0.0', types: './index.d.ts', main: './index.js' }),
  );
  fs.writeFileSync(path.join(uiKit, 'index.d.ts'), 'export declare const Button: string;\n');
  fs.writeFileSync(path.join(uiKit, 'index.js'), 'module.exports = {};\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const checkbox = (): Checkbox => ({
  id: 'cb1',
  instruction: 'cria src/status.ts exportando Status a partir do Button do ui-kit',
  targetFile: target(),
  done: false,
});

describe('executeCheckbox (the per-checkbox loop of engine v2)', () => {
  it('rejects hallucination, rejects type error, and converges to green', async () => {
    const scripted = [
      // attempt 1: phantom import -> blocked by the validator
      'import { useX } from "@trello/fake-hook";\nexport const Status = useX;\n',
      // attempt 2: compiles? no, type error -> blocked by the compiler
      'export const Status: number = "not a number";\n',
      // attempt 3: valid -> green
      'import { Button } from "ui-kit";\nexport const Status = Button;\n',
    ];
    const seenFeedback: (string | null)[] = [];
    const generate: GenerateFn = async ({ attempt, feedback }) => {
      seenFeedback.push(feedback);
      return { code: scripted[attempt - 1], tokensLocal: 100 };
    };

    const res = await executeCheckbox({
      checkbox: checkbox(),
      projectRoot: root,
      generate,
      readFile: () => null,
      maxAttempts: 4,
    });

    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(3);
    expect(res.finalCode).toContain('from "ui-kit"');
    expect(res.tokensLocal).toBe(300); // 3 generations x 100
    // attempt 1 had no feedback; attempt 2 got import feedback; attempt 3 got typecheck feedback.
    expect(seenFeedback[0]).toBeNull();
    expect(seenFeedback[1]).toMatch(/do not exist|@trello/i);
    expect(seenFeedback[2]).toMatch(/did not compile|TS\d+/i);
    // trail for the premium snapshot
    expect(res.trail[2]).toMatch(/green/);
  });

  it('P0: file without substance (lone string) does NOT turn green', async () => {
    const generate: GenerateFn = async () => ({
      code: '"sou so uma string solta";\n',
      tokensLocal: 10,
    });
    const res = await executeCheckbox({
      checkbox: checkbox(),
      projectRoot: root,
      generate,
      readFile: () => null,
      maxAttempts: 2,
    });
    expect(res.ok).toBe(false);
  });

  it('P0: a cascade break in another file blocks (onlyFiles was hiding it)', async () => {
    fs.writeFileSync(
      path.join(root, 'src', 'consumer.ts'),
      "import { value } from './status';\nexport const z = value;\n",
    );
    // gera status.ts SEM exportar `value` -> consumer.ts quebra (cascata).
    const generate: GenerateFn = async () => ({
      code: 'export const outro = 1;\n',
      tokensLocal: 10,
    });
    const res = await executeCheckbox({
      checkbox: checkbox(),
      projectRoot: root,
      generate,
      readFile: () => null,
      maxAttempts: 2,
    });
    expect(res.ok).toBe(false);
    fs.rmSync(path.join(root, 'src', 'consumer.ts'), { force: true });
  });

  it('non-TS file (package.json) passes straight through, without typecheck gate', async () => {
    const generate: GenerateFn = async () => ({
      code: '{\n  "name": "x",\n  "type": "module"\n}\n',
      tokensLocal: 40,
    });
    const res = await executeCheckbox({
      checkbox: {
        id: 'pj',
        instruction: 'cria package.json',
        targetFile: path.join(root, 'package.json'),
        done: false,
      },
      projectRoot: root,
      generate,
      readFile: () => null,
      maxAttempts: 2,
    });
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(1);
    expect(res.finalCode).toContain('"name": "x"');
  });

  it('design gate: rejects a new UI lib and converges on the frozen kit', async () => {
    const scripted = [
      // tentativa 1: introduz @mui/material -> barrado pelo gate de design
      'import { Button } from "@mui/material";\nexport const Status = Button;\n',
      // tentativa 2: usa o ui-kit do projeto -> passa design + import + typecheck
      'import { Button } from "ui-kit";\nexport const Status = Button;\n',
    ];
    const seenFeedback: (string | null)[] = [];
    const generate: GenerateFn = async ({ attempt, feedback }) => {
      seenFeedback.push(feedback);
      return { code: scripted[attempt - 1], tokensLocal: 60 };
    };
    const res = await executeCheckbox({
      checkbox: checkbox(),
      projectRoot: root,
      generate,
      readFile: () => null,
      designContract: {
        uiImportPaths: ['@/components/ui'],
        components: ['Button'],
        hasTailwind: true,
        frozen: true,
      },
      maxAttempts: 4,
    });
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(2);
    expect(seenFeedback[1]).toMatch(/design system|@mui/i);
  });

  it('exhausts and signals escalation to premium when the model only hallucinates', async () => {
    const generate: GenerateFn = async () => ({
      code: 'import { z } from "@trello/sempre-fantasma";\nexport const Status = z;\n',
      tokensLocal: 50,
    });
    const res = await executeCheckbox({
      checkbox: checkbox(),
      projectRoot: root,
      generate,
      readFile: () => null,
      maxAttempts: 3,
    });
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(3);
    expect(res.failedAt).toBe('import');
    expect(res.finalCode).toBeNull();
    expect(res.violations.some((v) => v.source.startsWith('@trello/'))).toBe(true);
    expect(res.tokensLocal).toBe(150);
  });
});
