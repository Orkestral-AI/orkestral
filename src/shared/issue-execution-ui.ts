import type { IssueRun, IssueStatus } from './types';

type RunLike = Pick<IssueRun, 'status' | 'startedAt'>;

export interface IssueExecutionUiState {
  latestRun: RunLike | null;
  hasActiveRun: boolean;
  effectiveRunning: boolean;
  displayStatus: IssueStatus;
}

const ACTIVE_RUN_STATUSES = new Set<IssueRun['status']>(['queued', 'running']);

function latestRunOf(runs: RunLike[]): RunLike | null {
  if (runs.length === 0) return null;
  return [...runs].sort((a, b) => {
    const at = new Date(a.startedAt).getTime();
    const bt = new Date(b.startedAt).getTime();
    return bt - at;
  })[0];
}

export function deriveIssueExecutionUiState(input: {
  issueStatus: IssueStatus;
  runs: RunLike[];
  cancelling?: boolean;
}): IssueExecutionUiState {
  const latestRun = latestRunOf(input.runs);
  const hasActiveRun = latestRun ? ACTIVE_RUN_STATUSES.has(latestRun.status) : false;
  const effectiveRunning = hasActiveRun && input.cancelling !== true;
  let displayStatus = input.issueStatus;

  if (effectiveRunning && input.issueStatus === 'in_review') {
    displayStatus = 'in_review';
  } else if (effectiveRunning) {
    displayStatus = 'in_progress';
  } else if (input.issueStatus === 'in_progress' && latestRun?.status === 'done') {
    displayStatus = 'in_review';
  } else if (input.issueStatus === 'in_progress' && latestRun?.status === 'failed') {
    displayStatus = 'blocked';
  } else if (input.issueStatus === 'in_progress' && latestRun?.status === 'cancelled') {
    displayStatus = 'cancelled';
  }

  return { latestRun, hasActiveRun, effectiveRunning, displayStatus };
}
