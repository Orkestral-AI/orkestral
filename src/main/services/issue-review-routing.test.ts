import { describe, expect, it } from 'vitest';
import { decideReviewRun } from './issue-review-routing';

describe('issue review routing smoke', () => {
  it('requires a verdict for an in_review run with no explicit verdict (no approve, no push-back)', () => {
    expect(decideReviewRun({ issueStatus: 'in_review', attempts: 0, maxAttempts: 2 })).toBe(
      'needs_verdict',
    );
  });

  it('approves only when the reviewer affirmatively set status=done', () => {
    expect(decideReviewRun({ issueStatus: 'done', attempts: 0, maxAttempts: 2 })).toBe('approve');
  });

  it('reexecutes when the reviewer pushed the issue back to todo (changes requested, no reassign)', () => {
    expect(decideReviewRun({ issueStatus: 'todo', attempts: 0, maxAttempts: 2 })).toBe('reexecute');
  });

  it('reexecutes when the reviewer pushed back to in_progress', () => {
    expect(decideReviewRun({ issueStatus: 'in_progress', attempts: 0, maxAttempts: 2 })).toBe(
      'reexecute',
    );
  });

  it('reexecutes a push-back even when attempts are exhausted (executor gets the final fix)', () => {
    expect(decideReviewRun({ issueStatus: 'todo', attempts: 2, maxAttempts: 2 })).toBe('reexecute');
  });

  it('does not auto-approve blocked review results', () => {
    expect(decideReviewRun({ issueStatus: 'blocked', attempts: 0, maxAttempts: 2 })).toBe(
      'terminal',
    );
  });
});
