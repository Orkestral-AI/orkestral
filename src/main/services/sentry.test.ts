import { describe, expect, it } from 'vitest';
import { nextCursorFromLink, shouldRunSentryWatcherWorkspace } from './sentry';

describe('sentry service helpers', () => {
  it('extracts the next cursor only when Sentry reports more results', () => {
    const link =
      '<https://sentry.io/api/0/projects/?&cursor=old:0:0>; rel="previous"; results="false", ' +
      '<https://sentry.io/api/0/projects/?&cursor=next:100:1>; rel="next"; results="true"';

    expect(nextCursorFromLink(link)).toBe('next:100:1');
  });

  it('does not extract a next cursor when the next page has no results', () => {
    const link =
      '<https://sentry.io/api/0/projects/?&cursor=next:100:0>; rel="next"; results="false"';

    expect(nextCursorFromLink(link)).toBeNull();
  });

  it('runs the watcher immediately when a workspace has no prior tick', () => {
    expect(
      shouldRunSentryWatcherWorkspace({
        nowMs: 60_000,
        lastRunMs: null,
        refreshIntervalMin: 5,
      }),
    ).toBe(true);
  });

  it('respects the workspace refresh interval for watcher ticks', () => {
    expect(
      shouldRunSentryWatcherWorkspace({
        nowMs: 4 * 60_000,
        lastRunMs: 0,
        refreshIntervalMin: 5,
      }),
    ).toBe(true);
    expect(
      shouldRunSentryWatcherWorkspace({
        nowMs: 4 * 60_000,
        lastRunMs: 60_000,
        refreshIntervalMin: 5,
      }),
    ).toBe(false);
  });

  it('disables watcher ticks when refresh interval is zero', () => {
    expect(
      shouldRunSentryWatcherWorkspace({
        nowMs: 60_000,
        lastRunMs: null,
        refreshIntervalMin: 0,
      }),
    ).toBe(false);
  });
});
