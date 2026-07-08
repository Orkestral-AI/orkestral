import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueExecutionEvent } from '../../../shared/types';

type StoredEventRow = {
  id: string;
  workspaceId: string;
  issueId: string;
  runId: string | null;
  type: string;
  payloadJson: string;
  createdAt: string;
};

const rows: StoredEventRow[] = [];

vi.mock('../connection', () => ({
  getDatabase: () => ({
    insert: () => ({
      values: (row: StoredEventRow) => ({
        run: () => rows.push(row),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (limit: number) => ({
              all: () =>
                [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit),
            }),
            all: () => [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
          }),
        }),
      }),
    }),
  }),
  getSqlite: () => ({
    prepare: () => ({
      run: (issueId: string, _sameIssueId: string, maxEvents: number) => {
        const keep = rows
          .filter((row) => row.issueId === issueId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, maxEvents);
        const keepIds = new Set(keep.map((row) => row.id));
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].issueId === issueId && !keepIds.has(rows[i].id)) rows.splice(i, 1);
        }
      },
    }),
  }),
}));

function event(input: Partial<IssueExecutionEvent> = {}): IssueExecutionEvent {
  return {
    type: 'phase',
    workspaceId: 'ws-1',
    issueId: 'issue-1',
    issueKey: 1,
    issueTitle: 'Smoke issue',
    issueStatus: 'in_progress',
    parentIssueId: null,
    runId: 'run-1',
    agentId: 'agent-1',
    agentName: 'TechLead',
    sourceId: 'source-1',
    sourceLabel: 'repo',
    message: 'Executando smoke',
    createdAt: new Date().toISOString(),
    ...input,
  };
}

describe('IssueExecutionEventRepository', () => {
  beforeEach(() => {
    rows.length = 0;
  });

  it('persists and replays execution events in chronological order', async () => {
    const { IssueExecutionEventRepository } = await import('./issue-execution-event.repo');
    const repo = new IssueExecutionEventRepository(10);

    repo.record(
      event({ type: 'started', message: 'começou', createdAt: '2026-06-11T10:00:00.000Z' }),
    );
    repo.record(
      event({
        type: 'file-change',
        message: 'Editing src/app.tsx +3 -1',
        filePath: 'src/app.tsx',
        additions: 3,
        deletions: 1,
        createdAt: '2026-06-11T10:00:01.000Z',
      }),
    );

    const replay = repo.listByIssue('issue-1');
    expect(replay.map((item) => item.type)).toEqual(['started', 'file-change']);
    expect(replay[1].filePath).toBe('src/app.tsx');
    expect(repo.listByIssues(['issue-1'])['issue-1']).toHaveLength(2);
  });

  it('keeps only the latest events per issue', async () => {
    const { IssueExecutionEventRepository } = await import('./issue-execution-event.repo');
    const repo = new IssueExecutionEventRepository(2);

    repo.record(event({ message: 'one', createdAt: '2026-06-11T10:00:00.000Z' }));
    repo.record(event({ message: 'two', createdAt: '2026-06-11T10:00:01.000Z' }));
    repo.record(event({ message: 'three', createdAt: '2026-06-11T10:00:02.000Z' }));

    expect(repo.listByIssue('issue-1').map((item) => item.message)).toEqual(['two', 'three']);
  });
});
