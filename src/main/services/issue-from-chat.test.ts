import { describe, it, expect } from 'vitest';

import { extractChecklist } from './issue-from-chat';
import type { Agent } from '../../shared/types';

const agents = [
  { id: 'a-back', name: 'Backend', role: 'backend' },
  { id: 'a-front', name: 'Frontend', role: 'frontend' },
] as unknown as Agent[];

describe('extractChecklist (regra de criação: poucas issues com checklist)', () => {
  it('extrai tasks markdown do corpo e separa a descrição', () => {
    const body = [
      'Implementa o backend de auth.',
      '- [ ] Criar auth.ts com PrismaAdapter @Backend',
      '- [ ] Adicionar o route handler @Backend',
      '- [x] POST /api/workspaces @Frontend',
    ].join('\n');
    const { description, checkboxes } = extractChecklist(body, agents);
    expect(description).toBe('Implementa o backend de auth.');
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes[0]).toMatchObject({
      instruction: 'Criar auth.ts com PrismaAdapter',
      status: 'pending',
      assigneeAgentId: 'a-back',
    });
    expect(checkboxes[2]).toMatchObject({ status: 'done', assigneeAgentId: 'a-front' });
  });

  it('sem checklist: devolve [] e o corpo inteiro como descrição (comportamento antigo)', () => {
    const { description, checkboxes } = extractChecklist('Só uma descrição normal.', agents);
    expect(checkboxes).toHaveLength(0);
    expect(description).toBe('Só uma descrição normal.');
  });

  it('@Agente desconhecido não atribui (fica sem responsável), mas mantém a task', () => {
    const { checkboxes } = extractChecklist('- [ ] fazer algo @Ninguem', agents);
    expect(checkboxes).toHaveLength(1);
    expect(checkboxes[0].assigneeAgentId).toBeNull();
    expect(checkboxes[0].instruction).toBe('fazer algo @Ninguem');
  });
});
