import { describe, expect, it } from 'vitest';
import { deriveIssueExecutionUiState } from './issue-execution-ui';
import type { IssueRun } from './types';

function run(status: IssueRun['status'], startedAt = '2026-06-07T10:00:00.000Z') {
  return { status, startedAt };
}

describe('deriveIssueExecutionUiState', () => {
  it('destrava issue in_progress quando o run persistido já terminou com sucesso', () => {
    const state = deriveIssueExecutionUiState({
      issueStatus: 'in_progress',
      runs: [run('done')],
    });

    expect(state.effectiveRunning).toBe(false);
    expect(state.hasActiveRun).toBe(false);
    expect(state.displayStatus).toBe('in_review');
  });

  it('não mostra Agent working quando o run mais recente falhou', () => {
    const state = deriveIssueExecutionUiState({
      issueStatus: 'in_progress',
      runs: [run('failed')],
    });

    expect(state.effectiveRunning).toBe(false);
    expect(state.displayStatus).toBe('blocked');
  });

  it('não mostra Agent working quando o run mais recente foi cancelado', () => {
    const state = deriveIssueExecutionUiState({
      issueStatus: 'in_progress',
      runs: [run('cancelled')],
    });

    expect(state.effectiveRunning).toBe(false);
    expect(state.displayStatus).toBe('cancelled');
  });

  it('mantém Agent working para run queued/running mesmo que o status esteja atrasado', () => {
    const queued = deriveIssueExecutionUiState({
      issueStatus: 'todo',
      runs: [run('queued')],
    });
    const running = deriveIssueExecutionUiState({
      issueStatus: 'todo',
      runs: [run('running')],
    });

    expect(queued.effectiveRunning).toBe(true);
    expect(queued.displayStatus).toBe('in_progress');
    expect(running.effectiveRunning).toBe(true);
    expect(running.displayStatus).toBe('in_progress');
  });

  it('mantém display em review durante run ativo de revisão', () => {
    const queuedReview = deriveIssueExecutionUiState({
      issueStatus: 'in_review',
      runs: [run('queued')],
    });
    const runningReview = deriveIssueExecutionUiState({
      issueStatus: 'in_review',
      runs: [run('running')],
    });

    expect(queuedReview.effectiveRunning).toBe(true);
    expect(queuedReview.displayStatus).toBe('in_review');
    expect(runningReview.effectiveRunning).toBe(true);
    expect(runningReview.displayStatus).toBe('in_review');
  });

  it('usa o run mais recente quando há histórico antigo', () => {
    const state = deriveIssueExecutionUiState({
      issueStatus: 'in_progress',
      runs: [run('running', '2026-06-07T09:00:00.000Z'), run('done', '2026-06-07T10:00:00.000Z')],
    });

    expect(state.latestRun?.status).toBe('done');
    expect(state.effectiveRunning).toBe(false);
    expect(state.displayStatus).toBe('in_review');
  });
});
