import { describe, expect, it } from 'vitest';
import { buildSessionCodeChangeSummary, progressStateForIssue } from './session-progress-ui';
import type { Issue } from './types';

function issue(overrides: Partial<Issue>): Issue {
  return {
    id: 'issue-1',
    workspaceId: 'workspace-1',
    issueKey: 1,
    title: 'Task',
    description: null,
    status: 'todo',
    priority: 'medium',
    labels: [],
    assigneeAgentId: 'agent-1',
    reporterAgentId: null,
    parentIssueId: null,
    goalId: null,
    displayKey: null,
    childOrdinal: null,
    dueDate: null,
    completedAt: null,
    metadata: null,
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    ...overrides,
  };
}

function codeChangeBlock(
  files: Array<{ path: string; additions: number; deletions: number }>,
  attrs = '',
): string {
  return [
    `<orkestral:code-changes source_id="source-1" source_label="front" issue_id="issue-1" issue_key="1" issue_title="Task"${attrs ? ` ${attrs}` : ''} files="4" additions="238" deletions="250">`,
    ...files.map(
      (file) =>
        `<file path="${file.path}" additions="${file.additions}" deletions="${file.deletions}" />`,
    ),
    '</orkestral:code-changes>',
  ].join('\n');
}

describe('session progress ui smoke', () => {
  it('aggregates a persisted plan diff into one 4 files changed summary', () => {
    const summary = buildSessionCodeChangeSummary([
      issue({
        metadata: {
          lastCodeChangeBlock: codeChangeBlock([
            { path: 'src/a.ts', additions: 100, deletions: 100 },
            { path: 'src/b.ts', additions: 80, deletions: 60 },
            { path: 'src/c.ts', additions: 40, deletions: 70 },
            { path: 'src/d.ts', additions: 18, deletions: 20 },
          ]),
        },
      }),
    ]);

    expect(summary).toMatchObject({
      additions: 238,
      deletions: 250,
      sourceIds: ['source-1'],
    });
    expect(summary?.files).toHaveLength(4);
  });

  it('dedupes repeated issue snapshots by source and file after leaving and returning to chat', () => {
    const first = issue({
      id: 'issue-1',
      metadata: {
        lastCodeChangeBlock: codeChangeBlock([
          { path: 'index.html', additions: 10, deletions: 0 },
          { path: 'public/robots.txt', additions: 2, deletions: 0 },
        ]),
      },
    });
    const repeated = issue({
      id: 'issue-2',
      metadata: {
        lastCodeChangeBlock: codeChangeBlock([
          { path: 'index.html', additions: 11, deletions: 0 },
          { path: 'public/robots.txt', additions: 2, deletions: 0 },
        ]),
      },
    });

    const summary = buildSessionCodeChangeSummary([first, repeated]);

    expect(summary?.files).toHaveLength(2);
    expect(summary?.additions).toBe(13);
    expect(summary?.deletions).toBe(0);
  });

  it('keeps issue and snapshot metadata so undo can be transactional', () => {
    const summary = buildSessionCodeChangeSummary([
      issue({
        metadata: {
          lastCodeChangeBlock: codeChangeBlock(
            [{ path: 'src/a.ts', additions: 2, deletions: 1 }],
            'snapshot_id="snapshot-1"',
          ),
        },
      }),
    ]);

    expect(summary?.changes).toEqual([
      {
        sourceId: 'source-1',
        sourceLabel: 'front',
        issueId: 'issue-1',
        snapshotId: 'snapshot-1',
        files: ['src/a.ts'],
      },
    ]);
    expect(summary?.files[0]).toMatchObject({
      issueId: 'issue-1',
      snapshotId: 'snapshot-1',
    });
  });

  it('keeps review state after remount but does not count it as fully done', () => {
    const state = progressStateForIssue(issue({ status: 'in_review' }), undefined, {
      status: 'done',
    });

    expect(state.reviewing).toBe(true);
    // in_review ainda aguarda veredito → não conta como concluído/provado.
    expect(state.progressed).toBe(false);
    expect(state.verifiedDone).toBe(false);
    expect(state.done).toBe(false);
    expect(state.running).toBe(false);
  });

  it('marks a completed issue done only when the issue status is done', () => {
    expect(
      progressStateForIssue(issue({ status: 'done' }), undefined, { status: 'done' }).done,
    ).toBe(true);
    expect(
      progressStateForIssue(issue({ status: 'in_review' }), undefined, { status: 'done' }).done,
    ).toBe(false);
  });

  it('counts every done step as progress (verified or not), but not in_review/in_progress', () => {
    const states = [
      progressStateForIssue(issue({ id: 'issue-1', status: 'in_progress' }), undefined, {
        status: 'running',
      }),
      progressStateForIssue(issue({ id: 'issue-2', status: 'in_review' }), undefined, {
        status: 'done',
      }),
      // done mas 'unverified' → CONTA como concluída (status real), com verifiedDone=false.
      progressStateForIssue(
        issue({ id: 'issue-3', status: 'done', metadata: { verification: 'unverified' } }),
        undefined,
        { status: 'done' },
      ),
      // done verificado → conta.
      progressStateForIssue(
        issue({ id: 'issue-4', status: 'done', metadata: { verification: 'verified' } }),
        undefined,
        { status: 'done' },
      ),
      // done sem código a verificar (not_applicable) → conta.
      progressStateForIssue(issue({ id: 'issue-5', status: 'done' }), undefined, {
        status: 'done',
      }),
    ];

    // Os 3 `done` contam (in_progress e in_review não).
    expect(states.filter((state) => state.progressed)).toHaveLength(3);
  });

  it('distinguishes verified-done from unverified-done', () => {
    const verified = progressStateForIssue(
      issue({ status: 'done', metadata: { verification: 'verified' } }),
      undefined,
      { status: 'done' },
    );
    const unverified = progressStateForIssue(
      issue({ status: 'done', metadata: { verification: 'unverified' } }),
      undefined,
      { status: 'done' },
    );

    expect(verified.verifiedDone).toBe(true);
    expect(verified.verification).toBe('verified');
    expect(unverified.done).toBe(true);
    expect(unverified.verifiedDone).toBe(false);
    expect(unverified.verification).toBe('unverified');
  });

  it('does not let queued events override review state', () => {
    const state = progressStateForIssue(
      issue({ status: 'in_review' }),
      [{ kind: 'queued', label: 'aguardando janela', at: Date.now() }],
      { status: 'queued' },
    );

    expect(state.reviewing).toBe(true);
    expect(state.queued).toBe(false);
    expect(state.running).toBe(false);
    // in_review não é "done provado".
    expect(state.progressed).toBe(false);
  });
});
