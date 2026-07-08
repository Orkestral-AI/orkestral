import { describe, it, expect } from 'vitest';
import { readPlanState, looksLikeEpic, planNeedsApproval } from './plan';

/** Constrói o subconjunto de Issue que essas funções leem. */
function mk(
  planStatus?: 'pending' | 'approved' | 'changes_requested' | 'rejected',
  labels: string[] = [],
  title = 'Task',
): { metadata: Record<string, unknown> | null; labels: string[]; title: string } {
  return {
    metadata: planStatus ? { plan: { status: planStatus } } : null,
    labels,
    title,
  };
}

describe('readPlanState', () => {
  it('lê o status do plano da metadata', () => {
    expect(readPlanState(mk('pending'))?.status).toBe('pending');
    expect(readPlanState(mk('approved'))?.status).toBe('approved');
  });
  it('retorna null quando não há plano', () => {
    expect(readPlanState(mk())).toBeNull();
  });
});

describe('planNeedsApproval (P0-04/07/15 — gating do inbox/botão)', () => {
  it('pede aprovação quando pending (épica com filhos)', () => {
    expect(planNeedsApproval(mk('pending'), 3)).toBe(true);
  });
  it('pending sem filhos → TAMBÉM pede aprovação (issue única via chat)', () => {
    // A submissão (submitPlansCreatedSince) só marca top-level executável; uma
    // issue única pending precisa de aprovação antes de mexer no código.
    expect(planNeedsApproval(mk('pending'), 0)).toBe(true);
  });
  it('aprovado → some do inbox imediatamente (P0-07)', () => {
    expect(planNeedsApproval(mk('approved'), 3)).toBe(false);
  });
  it('rejeitado/changes → não pede aprovação', () => {
    expect(planNeedsApproval(mk('rejected'), 3)).toBe(false);
    expect(planNeedsApproval(mk('changes_requested'), 3)).toBe(false);
  });
  it('sem estado de plano (ainda montando) → não mostra botão', () => {
    expect(planNeedsApproval(mk(), 3)).toBe(false);
  });
});

describe('looksLikeEpic', () => {
  it('épico por filhos, label ou prefixo de título', () => {
    expect(looksLikeEpic(mk(undefined, [], 'X'), 2)).toBe(true);
    expect(looksLikeEpic(mk(undefined, ['epic'], 'X'), 0)).toBe(true);
    expect(looksLikeEpic(mk(undefined, [], '[EPIC] X'), 0)).toBe(true);
    expect(looksLikeEpic(mk(undefined, [], '[ÉPICA] X'), 0)).toBe(true);
  });
  it('task normal não é épico', () => {
    expect(looksLikeEpic(mk(undefined, [], 'normal task'), 0)).toBe(false);
  });
});
