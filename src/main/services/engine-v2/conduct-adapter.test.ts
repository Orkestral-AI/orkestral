import { describe, it, expect } from 'vitest';

import { buildConductPrompt, createConduct, type PremiumChatFn } from './conduct-adapter';
import type { ConductInput } from './issue-runner';

const input = (): ConductInput => ({
  checkbox: { id: 'cb', instruction: 'cria a tela', targetFile: '/r/src/a.ts', done: false },
  trail: [
    'tentativa 1: rejeitada (import fantasma: @trello/x)',
    'tentativa 2: rejeitada (typecheck: 1 erro)',
  ],
  violations: [{ source: '@trello/x', kind: 'unresolved-module', detail: 'nao existe' }],
  diagnostics: [{ file: '/r/src/a.ts', line: 2, code: 2304, message: 'Cannot find name foo' }],
  currentCode: null,
});

describe('conduct-adapter (premium in the engine v2 escalation)', () => {
  it('buildConductPrompt brings the trail, the invalid imports and the errors', () => {
    const { user } = buildConductPrompt(input());
    expect(user).toMatch(/cria a tela/);
    expect(user).toMatch(/@trello\/x/);
    expect(user).toMatch(/TS2304/);
    expect(user).toMatch(/tentativa 1/);
  });

  it('createConduct strips fences and uses the tokens reported by premium', async () => {
    const chat: PremiumChatFn = async () => ({
      text: '```ts\nexport const a = 1;\n```',
      premiumIn: 2000,
      premiumOut: 300,
    });
    const conduct = createConduct(chat);
    const out = await conduct(input());
    expect(out.code).toBe('export const a = 1;\n');
    expect(out.premiumIn).toBe(2000);
    expect(out.premiumOut).toBe(300);
  });

  it('estimates tokens when premium does not report', async () => {
    const chat: PremiumChatFn = async () => ({
      text: 'export const a = 1;\n',
      premiumIn: 0,
      premiumOut: 0,
    });
    const out = await createConduct(chat)(input());
    expect(out.premiumIn).toBeGreaterThan(0);
    expect(out.premiumOut).toBeGreaterThan(0);
  });
});
