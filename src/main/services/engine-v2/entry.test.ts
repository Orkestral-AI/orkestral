import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createEngineV2, createPlanModel } from './entry';
import type { PremiumChatFn } from './conduct-adapter';
import type { Plan } from './planner';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-v2-entry-'));
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

const plan = (): Plan => ({
  intent: 'cria um chatbot',
  issues: [
    {
      id: 'I1',
      title: 'esqueleto',
      isWalkingSkeleton: true,
      checkboxes: [{ id: 'c1', instruction: 'home', targetFile: 'app/page.tsx' }],
    },
  ],
});

describe('entry (the integration seam of engine v2)', () => {
  it('createPlanModel adapts the premiumChat into the planner', async () => {
    const chat: PremiumChatFn = async (_sys, user) => {
      expect(user).toMatch(/cria um chatbot/);
      return { text: JSON.stringify(plan()), premiumIn: 100, premiumOut: 50 };
    };
    const pm = createPlanModel(chat);
    const out = await pm({ intent: 'cria um chatbot', context: '' });
    expect(out.premiumIn).toBe(100);
    expect(JSON.parse(out.planJson).issues).toHaveLength(1);
  });

  it('createEngineV2 runs end-to-end with premium + forge fakes', async () => {
    // premium so planeja (nao precisa conduzir pq o forge fake converge).
    const premiumChat: PremiumChatFn = async () => ({
      text: JSON.stringify(plan()),
      premiumIn: 3000,
      premiumOut: 1000,
    });
    const forgeChat = async () =>
      'import { Button } from "ui-kit";\nexport const value = Button;\n';

    const motor = createEngineV2({ premiumChat, forgeChat });
    const res = await motor.run({ intent: 'cria um chatbot', projectRoot: root });

    expect(res.planned).toBe(true);
    expect(res.totalDone).toBe(1);
    expect(res.preview?.mode).toBe('browser');
    expect(fs.existsSync(path.join(root, 'app', 'page.tsx'))).toBe(true);
    expect(res.ledger.premiumIn).toBe(3000);
    expect(res.ledger.localTokens).toBeGreaterThan(0);
  });
});
