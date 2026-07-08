import { describe, expect, it } from 'vitest';
import {
  firstRunnablePlanIssue,
  isReviewLikeIssue,
  isSubEpicIssue,
  nextRunnablePlanIssue,
  orderPlanChildren,
  runnablePlanIssueWave,
} from './issue-plan-sequencing';
import type { Issue } from '../../shared/types';

function child(
  id: string,
  ordinal: number,
  status: Issue['status'],
  overrides: Partial<Pick<Issue, 'title' | 'labels'>> = {},
): Issue {
  return {
    id,
    workspaceId: 'workspace-1',
    issueKey: ordinal,
    title: overrides.title ?? `Task ${ordinal}`,
    description: null,
    status,
    priority: 'medium',
    labels: overrides.labels ?? [],
    assigneeAgentId: 'agent-1',
    reporterAgentId: null,
    parentIssueId: 'epic-1',
    goalId: null,
    displayKey: null,
    childOrdinal: ordinal,
    dueDate: null,
    completedAt: null,
    metadata: null,
    createdAt: `2026-06-08T00:0${ordinal}:00.000Z`,
    updatedAt: `2026-06-08T00:0${ordinal}:00.000Z`,
  };
}

// Sub-issue de revisão/QA (último ordinal) com título reconhecível pelo gate.
function reviewChild(id: string, ordinal: number, status: Issue['status']): Issue {
  return child(id, ordinal, status, { title: 'Revisão de código' });
}

describe('issue plan sequencing smoke', () => {
  it('starts the first child after a plan is approved', () => {
    const children = [child('issue-3', 3, 'todo'), child('issue-1', 1, 'todo')];

    expect(firstRunnablePlanIssue(children)?.id).toBe('issue-1');
  });

  it('can start a wave of independent plan children while respecting explicit blockers', () => {
    const children = [
      child('issue-3', 3, 'todo'),
      child('issue-1', 1, 'todo'),
      child('issue-2', 2, 'todo'),
      child('issue-4', 4, 'in_progress'),
    ];

    const wave = runnablePlanIssueWave(
      children,
      (issue) => issue.id === 'issue-2',
      () => false,
    );

    expect(wave.map((issue) => issue.id)).toEqual(['issue-1', 'issue-3']);
  });

  it('does not skip to a later issue while an earlier sibling is not done', () => {
    const children = [
      child('issue-1', 1, 'in_review'),
      child('issue-2', 2, 'todo'),
      child('issue-3', 3, 'todo'),
    ];

    expect(nextRunnablePlanIssue(child('issue-1', 1, 'in_review'), children)).toBeNull();
  });

  it('moves to the next queued task once the previous one is done', () => {
    const done = child('issue-1', 1, 'done');
    const children = [child('issue-3', 3, 'todo'), done, child('issue-2', 2, 'todo')];

    expect(nextRunnablePlanIssue(done, children)?.id).toBe('issue-2');
  });

  it('advances past a sub-issue that ended blocked (a failed step must not freeze the plan)', () => {
    const blocked = child('issue-1', 1, 'blocked');
    const children = [blocked, child('issue-2', 2, 'todo'), child('issue-3', 3, 'todo')];

    // `blocked` is terminal and must be transparent: the next sibling runs
    // instead of the whole epic stalling forever on a failed step.
    expect(nextRunnablePlanIssue(blocked, children)?.id).toBe('issue-2');
  });

  it('does not let an earlier blocked sibling freeze a later advance (multi-issue plan)', () => {
    const done = child('issue-2', 2, 'done');
    const children = [child('issue-1', 1, 'blocked'), done, child('issue-3', 3, 'todo')];

    // issue-1 blocked earlier; when issue-2 completes, issue-3 must still start
    // (a prior terminal-blocked sibling is transparent, not a hard stop).
    expect(nextRunnablePlanIssue(done, children)?.id).toBe('issue-3');
  });

  it('still blocks later siblings while an earlier in_review is genuinely running', () => {
    const children = [
      child('issue-1', 1, 'in_review'),
      child('issue-2', 2, 'todo'),
      child('issue-3', 3, 'todo'),
    ];

    // No parked-no-actor gate → in_review is treated as "still running" and blocks.
    expect(
      nextRunnablePlanIssue(child('issue-1', 1, 'in_review'), children, undefined, () => false),
    ).toBeNull();
  });

  it('skips an earlier sibling parked in_review with no actor so the next can run', () => {
    const parked = child('issue-1', 1, 'in_review');
    const children = [parked, child('issue-2', 2, 'todo'), child('issue-3', 3, 'todo')];

    // issue-1 is parked (attempts-exhausted / approver-pending) with no run to
    // advance it → it must be transparent, letting issue-2 run instead of stalling.
    expect(
      nextRunnablePlanIssue(parked, children, undefined, (issue) => issue.id === 'issue-1')?.id,
    ).toBe('issue-2');
  });

  it('skips a later sibling parked in_review with no actor and finds the next runnable', () => {
    const done = child('issue-1', 1, 'done');
    const children = [done, child('issue-2', 2, 'in_review'), child('issue-3', 3, 'todo')];

    expect(
      nextRunnablePlanIssue(done, children, undefined, (issue) => issue.id === 'issue-2')?.id,
    ).toBe('issue-3');
  });

  it('keeps a stable order by child ordinal before timestamps', () => {
    const ordered = orderPlanChildren([
      child('issue-2', 2, 'todo'),
      child('issue-1', 1, 'todo'),
      child('issue-3', 3, 'todo'),
    ]);

    expect(ordered.map((issue) => issue.id)).toEqual(['issue-1', 'issue-2', 'issue-3']);
  });

  it('recognizes review/QA issues by title or label (PT/EN, prefixes)', () => {
    expect(isReviewLikeIssue(child('a', 1, 'todo', { title: 'Revisão de código' }))).toBe(true);
    expect(isReviewLikeIssue(child('b', 2, 'todo', { title: '[Review] final pass' }))).toBe(true);
    expect(isReviewLikeIssue(child('c', 3, 'todo', { title: 'QA validation' }))).toBe(true);
    expect(isReviewLikeIssue(child('d', 4, 'todo', { title: 'Validação manual' }))).toBe(true);
    expect(isReviewLikeIssue(child('e', 5, 'todo', { labels: ['qa'] }))).toBe(true);
    expect(isReviewLikeIssue(child('f', 6, 'todo', { title: 'Implement login form' }))).toBe(false);
  });

  it('keeps a review/QA leaf OUT of the wave while an impl sibling is still pending', () => {
    const children = [
      child('impl-1', 1, 'done'),
      child('impl-2', 2, 'todo'), // implementação ainda pendente
      reviewChild('review-3', 3, 'todo'),
    ];

    // Belt-and-suspenders: sem aresta blockedBy, a revisão ainda NÃO entra na onda
    // enquanto impl-2 não assentar. Só impl-2 é executável agora.
    const wave = runnablePlanIssueWave(children);
    expect(wave.map((i) => i.id)).toEqual(['impl-2']);
    expect(firstRunnablePlanIssue(children)?.id).toBe('impl-2');
  });

  it('makes the review/QA leaf runnable once all impl siblings are done', () => {
    const children = [
      child('impl-1', 1, 'done'),
      child('impl-2', 2, 'done'),
      reviewChild('review-3', 3, 'todo'),
    ];

    const wave = runnablePlanIssueWave(children);
    expect(wave.map((i) => i.id)).toEqual(['review-3']);
  });

  it('treats a parked-no-actor impl sibling as settled so the review can run', () => {
    const children = [
      child('impl-1', 1, 'done'),
      child('impl-2', 2, 'in_review'), // estacionada sem ator → assentada
      reviewChild('review-3', 3, 'todo'),
    ];

    const wave = runnablePlanIssueWave(children, undefined, (issue) => issue.id === 'impl-2');
    expect(wave.map((i) => i.id)).toEqual(['review-3']);
  });

  it('does not advance to the review/QA sibling while an impl sibling is unsettled', () => {
    const done = child('impl-1', 1, 'done');
    const children = [done, child('impl-2', 2, 'todo'), reviewChild('review-3', 3, 'todo')];

    // nextRunnablePlanIssue pula a revisão e para na próxima impl pendente.
    expect(nextRunnablePlanIssue(done, children)?.id).toBe('impl-2');
  });

  it('advances to the review/QA sibling once every impl sibling settled', () => {
    const done = child('impl-2', 2, 'done');
    const children = [child('impl-1', 1, 'done'), done, reviewChild('review-3', 3, 'todo')];

    expect(nextRunnablePlanIssue(done, children)?.id).toBe('review-3');
  });
});

describe('isSubEpicIssue (recursão de planos — HORIZON Fase 1)', () => {
  it('trata filha COM filhos como sub-épica (container de fato)', () => {
    expect(isSubEpicIssue(child('sub-1', 1, 'todo'), 2)).toBe(true);
  });

  it('trata filha marcada [EPIC]/[ÉPICA] sem filhos como sub-épica placeholder', () => {
    expect(isSubEpicIssue(child('sub-1', 1, 'todo', { title: '[EPIC] Compute' }), 0)).toBe(true);
    expect(isSubEpicIssue(child('sub-2', 2, 'todo', { title: '[ÉPICA] Storage' }), 0)).toBe(true);
    expect(isSubEpicIssue(child('sub-3', 3, 'todo', { labels: ['epic'] }), 0)).toBe(true);
  });

  it('filha sem filhos e sem marcador é FOLHA executável (bug antigo do label solto)', () => {
    expect(isSubEpicIssue(child('leaf-1', 1, 'todo'), 0)).toBe(false);
    // Menção a "epic" no MEIO do título não marca (só o prefixo).
    expect(isSubEpicIssue(child('leaf-2', 2, 'todo', { title: 'Ajustar epic banner' }), 0)).toBe(
      false,
    );
  });

  it('top-level nunca é SUB-épica (a detecção de épica raiz vive no executor)', () => {
    const topLevel = { ...child('root-1', 1, 'todo', { title: '[EPIC] Plataforma' }) };
    topLevel.parentIssueId = null;
    expect(isSubEpicIssue(topLevel, 0)).toBe(false);
  });
});
