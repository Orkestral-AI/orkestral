import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runIssue, type Issue, type ConductFn } from './issue-runner';
import type { GenerateFn } from './execute-checkbox';

let root: string;

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-v2-issue-'));
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
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
  const uiKit = path.join(dir, 'node_modules', 'ui-kit');
  fs.mkdirSync(uiKit, { recursive: true });
  fs.writeFileSync(
    path.join(uiKit, 'package.json'),
    JSON.stringify({ name: 'ui-kit', version: '1.0.0', types: './index.d.ts', main: './index.js' }),
  );
  fs.writeFileSync(path.join(uiKit, 'index.d.ts'), 'export declare const Button: string;\n');
  fs.writeFileSync(path.join(uiKit, 'index.js'), 'module.exports = {};\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  return dir;
}

const issueWith = (): Issue => ({
  id: 'CHA-1',
  title: 'fatia: duas telas',
  checkboxes: [
    {
      id: 'cb1',
      instruction: 'cria src/a.ts',
      targetFile: path.join(root, 'src', 'a.ts'),
      done: false,
    },
    {
      id: 'cb2',
      instruction: 'cria src/b.ts',
      targetFile: path.join(root, 'src', 'b.ts'),
      done: false,
    },
  ],
});

beforeEach(() => {
  root = fixture();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runIssue (orchestrator of engine v2)', () => {
  it('local resolves one box, premium rescues the other; applies to disk and accounts', async () => {
    const valid = 'import { Button } from "ui-kit";\nexport const X = Button;\n';
    const hallucinated = 'import { z } from "@trello/fake";\nexport const X = z;\n';

    // cb1 converge local; cb2 so aluciná no local (forca a escalada).
    const generate: GenerateFn = async ({ targetFile }) =>
      targetFile.endsWith('a.ts')
        ? { code: valid, tokensLocal: 120 }
        : { code: hallucinated, tokensLocal: 80 };
    // premium resgata o cb2 com codigo valido.
    const conduct: ConductFn = async () => ({ code: valid, premiumIn: 1500, premiumOut: 400 });

    const seen: string[] = [];
    const res = await runIssue({
      issue: issueWith(),
      projectRoot: root,
      generate,
      conduct,
      onCheckpoint: (s) => seen.push(`${s.checkboxId}:${s.status}`),
    });

    expect(res.doneCount).toBe(2);
    expect(res.blockedCount).toBe(0);
    // cb1 nao escalou, cb2 escalou
    expect(res.results[0].escalated).toBe(false);
    expect(res.results[1].escalated).toBe(true);
    // arquivos escritos no disco DE VERDADE
    expect(fs.existsSync(path.join(root, 'src', 'a.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src', 'b.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'src', 'b.ts'), 'utf8')).toContain('ui-kit');
    // boxes marcados
    expect(res.results.every((r) => r.checkbox.done)).toBe(true);
    // ledger: local (cb1+cb2 tentativas) + premium (escalada do cb2)
    expect(res.ledger.localTokens).toBeGreaterThan(0);
    expect(res.ledger.premiumIn).toBe(1500);
    expect(res.ledger.premiumOut).toBe(400);
    expect(res.economy.premiumCostUsd).toBeGreaterThan(0);
    // progresso em tempo real
    expect(seen).toEqual(['cb1:done', 'cb2:done']);
  });

  it('P0: a target outside the project is blocked, never writes to disk', async () => {
    const outside = path.join(os.tmpdir(), 'mv2-evil-outside.ts');
    fs.rmSync(outside, { force: true });
    const generate: GenerateFn = async () => ({ code: 'export const x = 1;\n', tokensLocal: 10 });
    const conduct: ConductFn = async () => ({ code: '', premiumIn: 0, premiumOut: 0 });
    const res = await runIssue({
      issue: {
        id: 'EVIL',
        title: 'path escapando',
        checkboxes: [{ id: 'cb', instruction: 'x', targetFile: outside, done: false }],
      },
      projectRoot: root,
      generate,
      conduct,
    });
    expect(res.results[0].status).toBe('blocked');
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('when not even premium resolves, it stays BLOCKED (honest, not a fake "done")', async () => {
    const hallucinated = 'import { z } from "@trello/fake";\nexport const X = z;\n';
    const generate: GenerateFn = async () => ({ code: hallucinated, tokensLocal: 50 });
    const conduct: ConductFn = async () => ({
      code: hallucinated,
      premiumIn: 1000,
      premiumOut: 200,
    });

    const res = await runIssue({
      issue: {
        id: 'CHA-2',
        title: 'fatia que nao fecha',
        checkboxes: [
          { id: 'cb1', instruction: 'x', targetFile: path.join(root, 'src', 'x.ts'), done: false },
        ],
      },
      projectRoot: root,
      generate,
      conduct,
    });

    expect(res.doneCount).toBe(0);
    expect(res.blockedCount).toBe(1);
    expect(res.results[0].status).toBe('blocked');
    expect(res.results[0].checkbox.done).toBe(false);
    // nao escreveu lixo no disco
    expect(fs.existsSync(path.join(root, 'src', 'x.ts'))).toBe(false);
  });
});
