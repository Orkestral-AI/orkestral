import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runPlan } from './plan-runner';
import type { PlanModelFn, Plan } from './planner';
import type { GenerateFn } from './execute-checkbox';
import type { ConductFn } from './issue-runner';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-v2-plan-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ dependencies: { next: '15', react: '19' }, scripts: { dev: 'next dev' } }),
  );
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
      include: ['app'],
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
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const goodPlan = (): Plan => ({
  intent: 'cria um chatbot',
  issues: [
    {
      id: 'I1',
      title: 'esqueleto que anda',
      isWalkingSkeleton: true,
      checkboxes: [{ id: 'c1', instruction: 'home', targetFile: 'app/page.tsx' }],
    },
    {
      id: 'I2',
      title: 'tela de chat',
      isWalkingSkeleton: false,
      checkboxes: [{ id: 'c2', instruction: 'chat', targetFile: 'app/chat/page.tsx' }],
    },
  ],
});

describe('runPlan (engine v2 end-to-end)', () => {
  it('plans, runs the slices, releases contextual preview and accounts', async () => {
    const planModel: PlanModelFn = async () => ({
      planJson: JSON.stringify(goodPlan()),
      premiumIn: 4000,
      premiumOut: 1500,
    });
    const generate: GenerateFn = async () => ({
      code: 'import { Button } from "ui-kit";\nexport const value = Button;\n',
      tokensLocal: 150,
    });
    const conduct: ConductFn = async () => ({ code: '', premiumIn: 0, premiumOut: 0 });

    let preview = null as null | { kind: string };
    const res = await runPlan({
      intent: 'cria um chatbot',
      planModel,
      generate,
      conduct,
      projectRoot: root,
      onPreviewReady: (p) => (preview = p),
    });

    expect(res.planned).toBe(true);
    expect(res.totalDone).toBe(2);
    expect(res.totalBlocked).toBe(0);
    // arquivos das duas fatias no disco
    expect(fs.existsSync(path.join(root, 'app', 'page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'app', 'chat', 'page.tsx'))).toBe(true);
    // preview contextual liberado apos o esqueleto (Next = fullstack/browser)
    expect(res.preview?.kind).toBe('fullstack');
    expect(res.preview?.mode).toBe('browser');
    expect(preview).not.toBeNull();
    // ledger: premium do plano + local das fatias
    expect(res.ledger.premiumIn).toBe(4000);
    expect(res.ledger.localTokens).toBeGreaterThan(0);
    expect(typeof res.economyLine).toBe('string');
  });

  it('does NOT run an invalid plan (rejects before spending Forge)', async () => {
    const tooMany: Plan = { intent: 'x', issues: [] };
    for (let i = 0; i < 10; i++) {
      tooMany.issues.push({
        id: `I${i}`,
        title: 't',
        isWalkingSkeleton: i === 0,
        checkboxes: [{ id: `c${i}`, instruction: 'x', targetFile: `app/p${i}.tsx` }],
      });
    }
    const planModel: PlanModelFn = async () => ({
      planJson: JSON.stringify(tooMany),
      premiumIn: 5000,
      premiumOut: 2000,
    });
    let forgeCalled = false;
    const generate: GenerateFn = async () => {
      forgeCalled = true;
      return { code: '', tokensLocal: 0 };
    };
    const conduct: ConductFn = async () => ({ code: '', premiumIn: 0, premiumOut: 0 });

    const res = await runPlan({ intent: 'x', planModel, generate, conduct, projectRoot: root });
    expect(res.planned).toBe(false);
    expect(res.planViolations.length).toBeGreaterThan(0);
    expect(forgeCalled).toBe(false); // nao gastou Forge num plano ruim
  });
});
