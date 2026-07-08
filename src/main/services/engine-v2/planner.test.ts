import { describe, it, expect } from 'vitest';

import { validatePlan, parsePlan, planFromIntent, type Plan, type PlanModelFn } from './planner';

const validPlan = (): Plan => ({
  intent: 'cria um chatbot',
  issues: [
    {
      id: 'I1',
      title: 'esqueleto que anda',
      isWalkingSkeleton: true,
      checkboxes: [
        { id: 'c1', instruction: 'scaffold + layout', targetFile: 'app/layout.tsx' },
        { id: 'c2', instruction: 'home que abre', targetFile: 'app/page.tsx' },
      ],
    },
    {
      id: 'I2',
      title: 'tela de chat',
      isWalkingSkeleton: false,
      checkboxes: [{ id: 'c3', instruction: 'pagina /chat', targetFile: 'app/chat/page.tsx' }],
    },
  ],
});

describe('planner (validation of the lean plan of engine v2)', () => {
  it('valid plan = no violations', () => {
    expect(validatePlan(validPlan())).toHaveLength(0);
  });

  it('flag: more than 8 issues', () => {
    const p = validPlan();
    for (let i = 0; i < 9; i++) {
      p.issues.push({
        id: `X${i}`,
        title: 't',
        isWalkingSkeleton: false,
        checkboxes: [{ id: `xc${i}`, instruction: 'x', targetFile: 'a.ts' }],
      });
    }
    expect(validatePlan(p).some((v) => /maximo enxuto/.test(v))).toBe(true);
  });

  it('flag: walking-skeleton is not the first issue', () => {
    const p = validPlan();
    p.issues[0].isWalkingSkeleton = false;
    p.issues[1].isWalkingSkeleton = true;
    expect(validatePlan(p).some((v) => /PRIMEIRA/.test(v))).toBe(true);
  });

  it('flag: checkbox without target file', () => {
    const p = validPlan();
    p.issues[0].checkboxes[0].targetFile = '';
    expect(validatePlan(p).some((v) => /sem arquivo alvo/.test(v))).toBe(true);
  });

  it('flag: issue without checkbox', () => {
    const p = validPlan();
    p.issues[1].checkboxes = [];
    expect(validatePlan(p).some((v) => /sem checkboxes/.test(v))).toBe(true);
  });

  it('parsePlan accepts JSON with markdown fences', () => {
    const json =
      '```json\n{"issues":[{"id":"A","title":"t","isWalkingSkeleton":true,"checkboxes":[{"id":"x","instruction":"i","targetFile":"a.ts"}]}]}\n```';
    const plan = parsePlan('intent', json);
    expect(plan.issues).toHaveLength(1);
    expect(plan.issues[0].isWalkingSkeleton).toBe(true);
  });

  it('parsePlan throws on malformed JSON', () => {
    expect(() => parsePlan('i', 'isso nao e json')).toThrow();
  });

  it('planFromIntent generates + validates + accounts premium', async () => {
    const model: PlanModelFn = async () => ({
      planJson: JSON.stringify(validPlan()),
      premiumIn: 3000,
      premiumOut: 1200,
    });
    const res = await planFromIntent({ intent: 'cria um chatbot' }, model);
    expect(res.violations).toHaveLength(0);
    expect(res.plan.issues).toHaveLength(2);
    expect(res.premiumIn).toBe(3000);
    expect(res.premiumOut).toBe(1200);
  });
});
